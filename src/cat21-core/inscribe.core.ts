import { firstValueFrom, from } from 'rxjs';

import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
  WalletAddressTopology,
} from '../cat21-fee/funding-safety.js';
import { CandidateFeeRow } from '../cat21-fee/candidate-fees.js';
import {
  InscribeAndBroadcastArgs,
  InscribeAndBroadcastResult,
  inscribeAndBroadcast,
} from '../inscribe/inscribe-orchestrator.js';
import { simulateInscribeFees } from '../inscribe/inscription-fee.helper.js';
import { prepareInscribeFundingInput } from '../inscribe/inscription-input-adapter.js';
import { changeDustFloor } from '../cat21-script/address-format.js';
import { BroadcastPort, ContentScanPort, CoreFundingUtxo, UtxosPort } from './ports.js';
import { resolveFundingPick, selectFunding } from './select-funding.js';

/**
 * Everything the inscribe core needs, framework-agnostic. Reuses the existing
 * commit+reveal engine (`inscribeAndBroadcast`) but selects the funding coin
 * through the SAME content-checked safe-auto path as the other flows — so an
 * inscribe never auto-spends a coin that carries an inscription / rune / cat /
 * rare sat. It is the full `inscribeAndBroadcast` arg set minus the coin (the
 * core selects it) and the transport (injected as ports).
 */
export interface InscribeCoreParams
  extends Omit<InscribeAndBroadcastArgs, 'paymentOutput' | 'broadcast' | 'promptForSignedPsbt'> {
  /** Expert-mode explicit funding pick; omitted ⇒ the safe auto coin. */
  selectedFundingUtxo?: CoreFundingUtxo | null;
  /**
   * How the CALLER's wallet lays out its addresses, from
   * `isOneAddressWallet({ paymentAddress, ordinalsAddress })`.
   *
   * Passed in rather than derived here for two reasons. This layer holds
   * `paymentAddress` but not `ordinalsAddress` (`recipientAddress` is a
   * destination, which may be someone else entirely), so it cannot derive the
   * answer correctly. And the same core serves UI flows and autonomous agent
   * flows: the notice-versus-warning relaxation is a policy about what a HUMAN
   * is shown before clicking, so an unattended caller must be able to decline
   * it by simply not passing anything. Omitted means the blocking branch, which
   * is the correct direction for a caller that forgot.
   */
  fundingTopology?: WalletAddressTopology;
}

/**
 * `asset-notice` is `ready` plus an obligation: a funding coin WAS selected and
 * the flow may proceed, but the coin carries assets, so the caller must show
 * the user what is on it BEFORE they can act. Kept distinct from `ready` so a
 * consumer renders the status instead of re-deriving the distinction from the
 * recommendation, which is how two surfaces drift apart.
 */
export type InscribeStatus = 'ready' | 'asset-notice' | 'expert-required' | 'scanning' | 'insufficient';

export interface InscribeSimulation {
  status: InscribeStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  fundingUtxo: CoreFundingUtxo | null;
  /** commit output + commit fee the funding coin must cover. Null if the content is unbuildable. */
  fundingRequirementSats: number | null;
  /**
   * The CHANGE-HEADROOM target: the requirement plus this payment address's
   * dust floor. Selection PREFERS a candidate clearing it whenever any
   * candidate does, so a coin between the two is fundable in principle and
   * never chosen in a pool where something else clears it. Exposed because a
   * caller sizing a coin from the requirement alone is working from half the
   * rule.
   */
  fundingPreferredSats: number | null;
  /**
   * Why the targets are null, when they are. Null on a healthy plan. A caller
   * seeing `insufficient` with populated targets has a coin problem; one seeing
   * `insufficient` with a message here has a PARAMS problem, and those want
   * opposite fixes.
   */
  fundingTargetError: string | null;
  /**
   * What each candidate coin would cost as the funding input (commit + reveal).
   * Present so a coin picker (a screen or an agent's API) can show the fee per
   * row: the dust-absorb rule makes the realised fee differ between coins, so
   * the cost is part of the choice, not a constant.
   */
  candidateFees: CandidateFeeRow[];
}

interface InscribePlan {
  status: InscribeStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  pick: CoreFundingUtxo | null;
  fundingRequirementSats: number | null;
  /**
   * The CHANGE-HEADROOM target: the requirement plus this payment address's
   * dust floor. Selection PREFERS a candidate clearing it whenever any
   * candidate does, so a coin between the two is fundable in principle and
   * never chosen in a pool where something else clears it. Exposed because a
   * caller sizing a coin from the requirement alone is working from half the
   * rule.
   */
  fundingPreferredSats: number | null;
  /**
   * Why the targets are null, when they are. Null on a healthy plan. A caller
   * seeing `insufficient` with populated targets has a coin problem; one seeing
   * `insufficient` with a message here has a PARAMS problem, and those want
   * opposite fixes.
   */
  fundingTargetError: string | null;
  candidateFees: CandidateFeeRow[];
}

/**
 * The inscription's funding requirement (commit output + commit fee), derived
 * from the content + fee rate via `simulateInscribeFees` against a
 * wallet-default-shaped dummy funding input — known before any coin is chosen.
 * Returns null when the content can't be simulated (unbuildable).
 */
/**
 * The feasibility target, plus WHY when it cannot be computed.
 *
 * Everything here runs inside a try, because a malformed param set throws deep
 * in address or key handling rather than returning anything. Swallowing that
 * into a bare null is what made a caller's `insufficient` unexplainable: a
 * missing `network`, an address that does not match its network, or a pubkey
 * that is not a curve point all looked identical to "your coin is too small".
 * So the reason travels with the null.
 */
function inscribeFundingTarget(params: InscribeCoreParams): { target: number | null; error: string | null } {
  if (!params.feeRatePerVbyte || params.feeRatePerVbyte <= 0) {
    return { target: null, error: `feeRatePerVbyte must be positive; got ${String(params.feeRatePerVbyte)}` };
  }
  try {
    const fundingInput = prepareInscribeFundingInput({
      utxo: { txid: '0'.repeat(64), vout: 0, value: 100_000_000, status: { confirmed: true } },
      paymentPublicKey: params.paymentPublicKey,
      paymentAddress: params.paymentAddress,
      isSimulation: true,
      network: params.network,
    });
    const sim = simulateInscribeFees({
      feeRatePerVbyte: params.feeRatePerVbyte,
      body: params.body,
      contentType: params.contentType,
      envelopeFields: params.envelopeFields,
      minimalTagPush: params.minimalTagPush,
      fundingInput,
      senderChangeAddress: params.paymentAddress,
      recipientAddress: params.recipientAddress,
      ephemeralPubkeyXonly: new Uint8Array(32).fill(0x02),
      tip: params.tip,
      walletType: params.walletType,
      // Same floor as the real build, so target and transaction agree.
      changeDustLimitSats: changeDustFloor(params.paymentAddress),
      network: params.network,
    });
    return { target: sim.fundingRequirementSats, error: null };
  } catch (e) {
    return {
      target: null,
      error:
        `could not measure the inscribe target: ${(e as Error).message}. ` +
        'Check that `network` is set and that paymentAddress / recipientAddress belong to it, ' +
        'and that paymentPublicKey is the key for paymentAddress.',
    };
  }
}

/**
 * What each candidate coin would cost to inscribe with: the commit + reveal
 * package fee, measured per coin.
 *
 * Unlike the single-tx flows this is a two-transaction package, so the cost is
 * `totalFeeSats` (commit + reveal) and the size is `combinedVsize`. The commit
 * half already reflects the dust-absorb rule, which is why the number differs
 * between coins rather than being one figure for the whole pool.
 *
 * A coin below the feasibility target cannot fund the commit at all and is
 * reported unfundable without simulating. For the rest, a throw is
 * COIN-specific: the caller only reaches here once `inscribeFundingTarget`
 * measured successfully, so a malformed param set has already been reported as
 * `fundingTargetError` rather than being hidden behind a row of nulls.
 */
function inscribeCandidateFees(
  params: InscribeCoreParams,
  candidates: readonly CoreFundingUtxo[],
  targetSats: number,
): CandidateFeeRow[] {
  return candidates.map((candidate) => {
    const unfundable = {
      txid: candidate.txid, vout: candidate.vout,
      finalFeeSats: null, vsize: null, absorbedSubDustSats: null,
    };
    if (candidate.value < targetSats) return unfundable;
    try {
      const fundingInput = prepareInscribeFundingInput({
        utxo: { txid: candidate.txid, vout: candidate.vout, value: candidate.value, status: { confirmed: true } },
        paymentPublicKey: params.paymentPublicKey,
        paymentAddress: params.paymentAddress,
        isSimulation: true,
        network: params.network,
      });
      const sim = simulateInscribeFees({
        feeRatePerVbyte: params.feeRatePerVbyte,
        body: params.body,
        contentType: params.contentType,
        envelopeFields: params.envelopeFields,
        minimalTagPush: params.minimalTagPush,
        fundingInput,
        senderChangeAddress: params.paymentAddress,
        recipientAddress: params.recipientAddress,
        ephemeralPubkeyXonly: new Uint8Array(32).fill(0x02),
        tip: params.tip,
        walletType: params.walletType,
        // Per-address floor, the same one the real build passes.
        changeDustLimitSats: changeDustFloor(params.paymentAddress),
        network: params.network,
      });
      return {
        txid: candidate.txid,
        vout: candidate.vout,
        finalFeeSats: sim.totalFeeSats,
        vsize: sim.combinedVsize,
        // The commit's own fold. The reveal has no equivalent: its fee is
        // reserved inside the commit output rather than funded by a coin whose
        // change could fall below dust.
        absorbedSubDustSats: sim.commitAbsorbedSubDustSats,
      };
    } catch {
      return unfundable;
    }
  });
}

async function planInscribe(
  params: InscribeCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<InscribePlan> {
  const empty = recommendFunding<CoreFundingUtxo & AnnotatedFundingUtxo>([], 0);
  const { target, error: targetError } = inscribeFundingTarget(params);
  if (target == null) {
    return {
      status: 'insufficient', recommendation: empty, pick: null,
      fundingRequirementSats: null, fundingPreferredSats: null, fundingTargetError: targetError,
      candidateFees: [],
    };
  }
  const utxos = await ports.utxos.spendableUtxos(params.paymentAddress);
  // `target` already reflects the WITH-CHANGE commit fee (simulated against a
  // large synthetic funding input). Adding the change address's dust floor gives
  // the change-headroom preferred target: a coin >= this keeps its commit change
  // above dust, so the realised commit fee-rate lands on the typed rate instead
  // of a sub-dust leftover being absorbed into the fee. selectFunding falls back
  // to a tight coin when none has headroom — never a false insufficient.
  const preferredTarget = target + changeDustFloor(params.paymentAddress);
  const recommendation = await selectFunding(utxos, target, ports.scan, preferredTarget, params.fundingTopology);
  const candidateFees = inscribeCandidateFees(params, recommendation.candidates, target);
  const pick = resolveFundingPick(recommendation, target, params.selectedFundingUtxo);
  if (!pick) {
    return {
      status: recommendation.status === 'insufficient' ? 'insufficient' : 'expert-required',
      recommendation,
      pick: null,
      fundingRequirementSats: target,
      fundingPreferredSats: preferredTarget,
      fundingTargetError: null,
      candidateFees,
    };
  }
  // Reads the PICK's content bucket, not the recommendation's topology-shaped
  // status, so the same action answers the same way on every wallet.
  // 'asset-notice' is enabled-with-warning; the blocking answers return above
  // with pick === null.
  return {
    status: pick.bucket === 'clean' ? 'ready' : 'asset-notice',
    recommendation,
    pick,
    fundingRequirementSats: target,
    fundingPreferredSats: preferredTarget,
    fundingTargetError: null,
    candidateFees,
  };
}

/**
 * Preview an inscribe: the funding requirement + content-checked selection, no
 * signing. `ready` = a safe funding coin covers the requirement.
 */
export async function simulateInscribe(
  params: InscribeCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<InscribeSimulation> {
  const plan = await planInscribe(params, ports);
  return {
    status: plan.status,
    recommendation: plan.recommendation,
    fundingUtxo: plan.pick,
    fundingRequirementSats: plan.fundingRequirementSats,
    fundingPreferredSats: plan.fundingPreferredSats,
    fundingTargetError: plan.fundingTargetError,
    candidateFees: plan.candidateFees,
  };
}

/**
 * Execute an inscribe end-to-end: safe-auto funding selection, then the
 * existing commit+reveal engine (build commit → sign → broadcast commit → build
 * reveal → sign → broadcast reveal). Throws when only asset coins cover
 * (`expert-required`) or nothing covers. `promptForSignedPsbt` is the
 * watch-only signing bridge (Promise form; adapted internally).
 */
export async function executeInscribe(
  params: InscribeCoreParams,
  ports: {
    utxos: UtxosPort;
    scan: ContentScanPort;
    broadcast: BroadcastPort;
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>;
  },
): Promise<InscribeAndBroadcastResult> {
  const plan = await planInscribe(params, ports);
  // 'asset-notice' executes: a coin will be spent and it carries assets, which
  // the money-path rule calls an enabled CTA with a notice. Requiring 'ready'
  // refused the separate-payment-address auto-pick.
  const proceeds = plan.status === 'ready' || plan.status === 'asset-notice';
  if (!proceeds || !plan.pick) {
    throw new Error(
      plan.status === 'scanning'
        ? 'Still checking what the funding coins hold. Try again in a moment.'
        : plan.status === 'expert-required'
        ? 'Select a funding UTXO (the available coins carry assets)'
        : 'Insufficient funds for inscribe at the current fee rate',
    );
  }
  const { selectedFundingUtxo: _ignored, ...inscribeArgs } = params;
  const prompt = ports.promptForSignedPsbt;
  return firstValueFrom(
    inscribeAndBroadcast({
      ...inscribeArgs,
      paymentOutput: {
        txid: plan.pick.txid,
        vout: plan.pick.vout,
        value: plan.pick.value,
        status: { confirmed: true },
        transactionHex: plan.pick.transactionHex,
      },
      broadcast: (txHex) => from(ports.broadcast.broadcast(txHex).then((r) => r.txid)),
      promptForSignedPsbt: prompt ? (unsigned) => from(prompt(unsigned)) : undefined,
    }),
  );
}
