import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper.js';
import { resolveCatTxFee } from '../cat21-fee/resolve-cat-tx-fee.helper.js';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
  WalletAddressTopology,
} from '../cat21-fee/funding-safety.js';
import { CandidateFeeRow, resolveCandidateFees } from '../cat21-fee/candidate-fees.js';
import { Network, toScureNetwork } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import {
  BuildCat21TransferResult,
  buildCat21TransferPsbt,
} from '../cat21-transfer/cat21-transfer.helper.js';
import { changeDustFloor } from '../cat21-script/address-format.js';
import {
  prepareTransferCatInput,
  prepareTransferFundingInput,
} from '../cat21-transfer/cat21-transfer-input-adapter.js';
import {
  BroadcastOutcome,
  BroadcastPort,
  ContentScanPort,
  CoreFundingUtxo,
  SignPort,
  UtxosPort,
} from './ports.js';
import { resolveFundingPick, selectFunding } from './select-funding.js';


/**
 * Everything the transfer core needs, framework-agnostic. Pubkeys are raw bytes
 * (no wallet-object dependency). The cat rides input 0 (at `ordinalsAddress`);
 * funding rides inputs 1+ (at `paymentAddress`).
 */
export interface TransferCoreParams {
  walletType: KnownOrdinalWalletType;
  network: Network;
  ordinalsPublicKey: Uint8Array;
  ordinalsAddress: string;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  /** The cat-bearing UTXO to move (preserved whole at output 0 by default). */
  catUtxo: { txid: string; vout: number; value: number };
  recipientAddress: string;
  feeRatePerVbyte: number;
  /**
   * Expert-mode explicit funding pick — spent even if it carries assets (the
   * user chose it). Omitted ⇒ the safe auto-recommendation is used.
   */
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
  /** Optional resize (GROW/SHRINK); omitted ⇒ PRESERVE the cat UTXO size. */
  targetPostageSats?: number;
}

/**
 * `asset-notice` is `ready` plus an obligation: a funding coin WAS selected and
 * the flow may proceed, but the coin carries assets, so the caller must show
 * the user what is on it BEFORE they can act. Kept distinct from `ready` so a
 * consumer renders the status instead of re-deriving the distinction from the
 * recommendation, which is how two surfaces drift apart.
 */
export type TransferStatus = 'ready' | 'asset-notice' | 'expert-required' | 'scanning' | 'insufficient';

export interface TransferSimulationResult {
  status: TransferStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  fundingUtxo: CoreFundingUtxo | null;
  vsize: number | null;
  /** Realised miner fee (incl. absorbed sub-dust change). */
  feeSats: number | null;
  changeSats: number | null;
  /** Output-0 size actually emitted (the recipient's cat UTXO). */
  catOutputSats: number | null;
  /**
   * The two targets selection actually uses. `fundingRequirementSats` is the
   * feasibility floor: a coin below it cannot fund the transfer at all.
   * `fundingPreferredSats` is the change-headroom target, and selection PREFERS
   * a candidate clearing it whenever any does. Anyone choosing a coin size from
   * the requirement alone is working from half the rule.
   */
  fundingRequirementSats: number;
  fundingPreferredSats: number;
  /**
   * What each candidate coin would cost as the funding input. Present so a coin
   * picker (a screen or an agent's API) can show the fee per row: the
   * dust-absorb rule makes the realised fee differ between coins, so the cost
   * is part of the choice, not a constant.
   */
  candidateFees: CandidateFeeRow[];
}

interface TransferPlan {
  status: TransferStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  pick: CoreFundingUtxo | null;
  /** Pass-2 build result (size numbers) + the fee to feed the real build. */
  built: BuildCat21TransferResult | null;
  vsize: number | null;
  buildFeeSats: number | null;
  requirementSats: number;
  preferredSats: number;
  candidateFees: CandidateFeeRow[];
}

/** Build the transfer PSBT for one funding pick + fee (sim or real). */
/**
 * Build the transfer PSBT for one funding pick + fee (simulation or real).
 * Exported so the framework-agnostic transfer orchestrator reuses it instead
 * of duplicating the prepare-inputs + `buildCat21TransferPsbt` composition.
 */
export function buildTransfer(
  params: TransferCoreParams,
  funding: CoreFundingUtxo,
  feeSats: number,
  isSimulation: boolean,
): BuildCat21TransferResult {
  const catInput = prepareTransferCatInput({
    utxo: {
      txid: params.catUtxo.txid,
      vout: params.catUtxo.vout,
      value: params.catUtxo.value,
      status: { confirmed: true },
    },
    paymentPublicKey: params.ordinalsPublicKey,
    paymentAddress: params.ordinalsAddress,
    isSimulation,
    network: params.network,
  });
  const fundingInput = prepareTransferFundingInput({
    utxo: {
      txid: funding.txid,
      vout: funding.vout,
      value: funding.value,
      status: { confirmed: true },
      transactionHex: funding.transactionHex,
    },
    paymentPublicKey: params.paymentPublicKey,
    paymentAddress: params.paymentAddress,
    isSimulation,
    network: params.network,
  });
  return buildCat21TransferPsbt({
    walletType: params.walletType,
    network: params.network,
    catUtxo: catInput,
    fundingInputs: [fundingInput],
    destinations: {
      recipientAddress: params.recipientAddress,
      senderChangeAddress: params.paymentAddress,
    },
    feeSats,
    targetPostageSats: params.targetPostageSats,
  });
}

async function planTransfer(
  params: TransferCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<TransferPlan> {
  const empty = recommendFunding<CoreFundingUtxo & AnnotatedFundingUtxo>([], 0);
  if (!params.feeRatePerVbyte || params.feeRatePerVbyte <= 0) {
    return {
      status: 'insufficient', recommendation: empty, pick: null, built: null, vsize: null, buildFeeSats: null,
      // Not measurable on this path: the targets come from a real build, and
      // there is either no fee rate or no coin to build against. 0 says
      // "unknown" honestly rather than implying a floor nobody computed.
      requirementSats: 0, preferredSats: 0, candidateFees: [],
    };
  }
  const utxos = await ports.utxos.spendableUtxos(params.paymentAddress);
  const measureVsize = (built: { psbt: Uint8Array }) =>
    computePsbtVsize({ psbt: built.psbt, network: toScureNetwork(params.network) });
  // Cat preserved (funded by input 0); funding covers ONLY the miner fee. GROW
  // spends some funding on the padded cat output; SHRINK frees the cat's surplus
  // into the fee budget. `feeBudget(coinValue)` is the max fee a given funding
  // value can pay (whole coin, no change).
  const catOutputSats = params.targetPostageSats ?? params.catUtxo.value;
  const feeBudget = (coinValue: number) => coinValue + params.catUtxo.value - catOutputSats;

  // Guess-free coverage target: the no-change transfer fee, measured from a real
  // build (vsize depends on input/output TYPES, not values).
  const largest = utxos.reduce<CoreFundingUtxo | null>((a, b) => (a && a.value >= b.value ? a : b), null);
  if (!largest) {
    return {
      status: 'insufficient', recommendation: empty, pick: null, built: null, vsize: null, buildFeeSats: null,
      // Not measurable on this path: the targets come from a real build, and
      // there is either no fee rate or no coin to build against. 0 says
      // "unknown" honestly rather than implying a floor nobody computed.
      requirementSats: 0, preferredSats: 0, candidateFees: [],
    };
  }
  const noChangeVsize = measureVsize(buildTransfer(params, largest, feeBudget(largest.value), true));
  const target = Math.ceil(noChangeVsize * params.feeRatePerVbyte);
  // Preferred (change-headroom) target: a coin >= this leaves an above-dust
  // change at the requested rate, so the realised fee-rate lands on the typed
  // rate instead of a sub-dust leftover being absorbed into the fee. Expressed
  // as a delta over the feasibility `target` so it inherits target's exact
  // (preserve / grow / shrink) semantics. selectFunding biases the auto-pick
  // toward such a coin, falling back to a tight coin when none exists.
  const withChangeVsize = measureVsize(buildTransfer(params, largest, 0, true));
  const preferredTarget =
    target +
    Math.ceil(withChangeVsize * params.feeRatePerVbyte) -
    Math.ceil(noChangeVsize * params.feeRatePerVbyte) +
    changeDustFloor(params.paymentAddress);
  const recommendation = await selectFunding(utxos, target, ports.scan, preferredTarget, params.fundingTopology);
  // Per-coin cost for the picker, on every status: the surface that renders a
  // choice needs the fee for each row, not only for the row we would have
  // picked. Same two-pass resolution the chosen coin goes through.
  const candidateFees = resolveCandidateFees(recommendation.candidates, {
    simulate: (candidate, feeSats) => {
      const built = buildTransfer(params, candidate, feeSats, true);
      return {
        vsize: measureVsize(built),
        finalFeeSats: built.finalFeeSats,
        absorbedSubDustSats: built.finalFeeSats - feeSats,
      };
    },
    feeBudgetFor: (candidate) => feeBudget(candidate.value),
    feeRatePerVbyte: params.feeRatePerVbyte,
  });
  const pick = resolveFundingPick(recommendation, target, params.selectedFundingUtxo);
  if (!pick) {
    return {
      status: recommendation.status === 'insufficient' ? 'insufficient' : 'expert-required',
      recommendation,
      pick: null,
      built: null,
      vsize: null,
      buildFeeSats: null,
      requirementSats: target,
      preferredSats: preferredTarget,
      candidateFees,
    };
  }
  // Guess-free per-coin fee: with-change form, falling back to no-change/absorb.
  const resolved = resolveCatTxFee({
    simulate: (feeSats) => {
      const built = buildTransfer(params, pick, feeSats, true);
      return { built, vsize: measureVsize(built), finalFeeSats: built.finalFeeSats };
    },
    feeRatePerVbyte: params.feeRatePerVbyte,
    feeBudgetSats: feeBudget(pick.value),
  });
  if (!resolved) {
    return {
      status: 'insufficient', recommendation, pick: null, built: null, vsize: null, buildFeeSats: null,
      requirementSats: target, preferredSats: preferredTarget, candidateFees,
    };
  }
  // The verdict is about the coin that WILL be spent, so it reads the pick's
  // own content bucket rather than the recommendation's topology-shaped
  // status. Reading the recommendation made the same user action answer
  // differently per wallet: an explicit "use anyway" pick of an asset coin
  // reported 'asset-notice' on a separate-payment-address wallet and 'ready'
  // on a one-address one, so a consumer gating its notice on the status hid
  // the warning exactly where the SDK was strictest.
  //
  // 'asset-notice' is an ENABLED state with a warning, never a block. The
  // blocking answers are 'expert-required', 'insufficient' and 'scanning',
  // and they all return above this with pick === null.
  return {
    status: pick.bucket === 'clean' ? 'ready' : 'asset-notice',
    recommendation,
    pick,
    built: resolved.built,
    vsize: resolved.vsize,
    buildFeeSats: resolved.finalFeeSats,
    requirementSats: target,
    preferredSats: preferredTarget,
    candidateFees,
  };
}

/**
 * Preview a transfer: content-checked funding selection + two-pass fee, no
 * signing or broadcast. `status: 'ready'` means a safe funding coin was found
 * and the tx is buildable; `expert-required` means only asset coins cover (the
 * UI must surface the picker); `insufficient` means nothing covers.
 */
export async function simulateTransfer(
  params: TransferCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<TransferSimulationResult> {
  const plan = await planTransfer(params, ports);
  return {
    status: plan.status,
    recommendation: plan.recommendation,
    fundingUtxo: plan.pick,
    vsize: plan.vsize,
    feeSats: plan.built ? plan.built.finalFeeSats : null,
    changeSats: plan.built ? plan.built.changeSats : null,
    catOutputSats: plan.built ? plan.built.catOutputSats : null,
    fundingRequirementSats: plan.requirementSats,
    fundingPreferredSats: plan.preferredSats,
    candidateFees: plan.candidateFees,
  };
}

/**
 * Execute a transfer end-to-end: select → fee → build → sign → broadcast. The
 * cat UTXO is preserved whole; the fee comes from the safe-auto-selected
 * funding coin (or the explicit expert pick). Throws with a clear message when
 * only asset coins cover (`expert-required`) or nothing covers.
 */
export async function executeTransfer(
  params: TransferCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort; sign: SignPort; broadcast: BroadcastPort },
): Promise<BroadcastOutcome & { feeSats: number }> {
  const plan = await planTransfer(params, ports);
  // 'asset-notice' EXECUTES. It means a coin will be spent and it carries
  // assets, which the money-path rule calls an enabled CTA with a visible
  // notice, not a block. The blocking answers are 'expert-required',
  // 'insufficient' and 'scanning', and all three arrive with pick === null.
  // Requiring 'ready' here refused the separate-payment-address auto-pick,
  // the one topology where the rule says to proceed.
  const proceeds = plan.status === 'ready' || plan.status === 'asset-notice';
  if (!proceeds || !plan.pick || plan.buildFeeSats == null || plan.built == null) {
    throw new Error(
      plan.status === 'scanning'
        ? 'Still checking what the funding coins hold. Try again in a moment.'
        : plan.status === 'expert-required'
        ? 'Select a funding UTXO (the available coins carry assets)'
        : 'Insufficient funds for transfer at the current fee rate',
    );
  }
  const built = buildTransfer(params, plan.pick, plan.buildFeeSats, false);
  const signed = await ports.sign.sign(built.psbt, 'all');
  const outcome = await ports.broadcast.broadcast(signed.hex);
  // Realised miner fee (incl. absorbed sub-dust change) for spend recording.
  return { ...outcome, feeSats: built.finalFeeSats };
}
