import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper.js';
import { resolveCatTxFee } from '../cat21-fee/resolve-cat-tx-fee.helper.js';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
  WalletAddressTopology,
} from '../cat21-fee/funding-safety.js';
import { Network, toScureNetwork } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage.js';
import {
  BuildCat21MintResult,
  buildCat21MintPsbt,
  CAT21_MINT_CHANGE_DUST_LIMIT_SATS,
} from '../cat21-mint/cat21-mint.helper.js';
import { prepareMintInputForWallet } from '../cat21-mint/cat21-mint-input-adapter.js';
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
 * Everything the mint core needs, framework-agnostic. A mint CREATES a fresh
 * cat at 546 sats (`CAT21_POSTAGE_SATS`) at `recipientAddress`; the funding coin
 * (at `paymentAddress`) covers the postage + optional tip + miner fee.
 */
export interface MintCoreParams {
  walletType: KnownOrdinalWalletType;
  network: Network;
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  /** Where the fresh cat lands (typically the wallet's ordinals address). */
  recipientAddress: string;
  feeRatePerVbyte: number;
  /** Optional developer-tip output. */
  tip?: { address: string; valueSats: number };
  /**
   * Expert-mode explicit funding pick — spent even if it carries assets.
   * Omitted ⇒ the safe auto-recommendation is used.
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
}

/**
 * `asset-notice` is `ready` plus an obligation: a funding coin WAS selected and
 * the flow may proceed, but the coin carries assets, so the caller must show
 * the user what is on it BEFORE they can act. Kept distinct from `ready` so a
 * consumer renders the status instead of re-deriving the distinction from the
 * recommendation, which is how two surfaces drift apart.
 */
export type MintStatus = 'ready' | 'asset-notice' | 'expert-required' | 'insufficient';

export interface MintSimulationResult {
  status: MintStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  fundingUtxo: CoreFundingUtxo | null;
  vsize: number | null;
  /** Realised miner fee (incl. absorbed sub-dust change). */
  feeSats: number | null;
  changeSats: number | null;
}

interface MintPlan {
  status: MintStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  pick: CoreFundingUtxo | null;
  built: BuildCat21MintResult | null;
  vsize: number | null;
  buildFeeSats: number | null;
}

function buildMint(
  params: MintCoreParams,
  funding: CoreFundingUtxo,
  feeSats: number,
  isSimulation: boolean,
): BuildCat21MintResult {
  const fundingInput = prepareMintInputForWallet(
    {
      txid: funding.txid,
      vout: funding.vout,
      value: funding.value,
      status: { confirmed: true },
      transactionHex: funding.transactionHex,
    },
    params.paymentPublicKey,
    params.paymentAddress,
    isSimulation,
    params.network,
  );
  return buildCat21MintPsbt({
    walletType: params.walletType,
    network: params.network,
    fundingInput,
    destinations: {
      recipientAddress: params.recipientAddress,
      senderChangeAddress: params.paymentAddress,
      tip: params.tip ? { address: params.tip.address, valueSats: params.tip.valueSats } : undefined,
    },
    feeSats,
  });
}

async function planMint(
  params: MintCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<MintPlan> {
  const empty = recommendFunding<CoreFundingUtxo & AnnotatedFundingUtxo>([], 0);
  if (!params.feeRatePerVbyte || params.feeRatePerVbyte <= 0) {
    return { status: 'insufficient', recommendation: empty, pick: null, built: null, vsize: null, buildFeeSats: null };
  }
  const utxos = await ports.utxos.spendableUtxos(params.paymentAddress);
  const tipValue = params.tip?.valueSats ?? 0;
  const fixedOutputs = CAT21_POSTAGE_SATS + tipValue;
  const measureVsize = (built: { psbt: Uint8Array }) =>
    computePsbtVsize({ psbt: built.psbt, network: toScureNetwork(params.network) });

  // Guess-free coverage target: cat postage + tip + the NO-CHANGE miner fee,
  // measured from a real build (no vB estimate). The no-change form is the
  // cheapest a mint can be, so any coin >= this target can mint and any coin
  // below it cannot — the exact feasibility threshold.
  const largest = utxos.reduce<CoreFundingUtxo | null>((a, b) => (a && a.value >= b.value ? a : b), null);
  if (!largest || largest.value < fixedOutputs) {
    return { status: 'insufficient', recommendation: empty, pick: null, built: null, vsize: null, buildFeeSats: null };
  }
  const noChangeVsize = measureVsize(buildMint(params, largest, largest.value - fixedOutputs, true));
  const target = fixedOutputs + Math.ceil(noChangeVsize * params.feeRatePerVbyte);
  // Preferred (change-headroom) target: cat postage + tip + the WITH-CHANGE
  // miner fee + a dust floor. A coin >= this leaves an above-dust change at the
  // requested rate, so the realised fee-rate lands on the typed rate instead of
  // a sub-dust leftover being absorbed into the fee (a 7-13% over-pay in the
  // dust-cliff band). selectFunding biases the auto-pick toward such a coin and
  // falls back to a feasibility-only (tight) coin when none exists — bounded
  // over-pay, never a false insufficient. The dust floor is 546 (the mint
  // builder's change dust limit).
  const withChangeVsize = measureVsize(buildMint(params, largest, 0, true));
  const preferredTarget =
    fixedOutputs +
    Math.ceil(withChangeVsize * params.feeRatePerVbyte) +
    CAT21_MINT_CHANGE_DUST_LIMIT_SATS;

  const recommendation = await selectFunding(utxos, target, ports.scan, preferredTarget, params.fundingTopology);
  const pick = resolveFundingPick(recommendation, target, params.selectedFundingUtxo);
  if (!pick) {
    return {
      status: recommendation.status === 'insufficient' ? 'insufficient' : 'expert-required',
      recommendation,
      pick: null,
      built: null,
      vsize: null,
      buildFeeSats: null,
    };
  }
  // Guess-free per-coin fee: measures the with-change form, falls back to the
  // no-change (absorb-all) form when it doesn't fit — so a coin that genuinely
  // fits is never falsely rejected.
  const resolved = resolveCatTxFee({
    simulate: (feeSats) => {
      const built = buildMint(params, pick, feeSats, true);
      return { built, vsize: measureVsize(built), finalFeeSats: built.finalFeeSats };
    },
    feeRatePerVbyte: params.feeRatePerVbyte,
    feeBudgetSats: pick.value - fixedOutputs,
  });
  if (!resolved) {
    return { status: 'insufficient', recommendation, pick: null, built: null, vsize: null, buildFeeSats: null };
  }
  return {
    status: recommendation.status === 'asset-notice' ? 'asset-notice' : 'ready',
    recommendation,
    pick,
    built: resolved.built,
    vsize: resolved.vsize,
    buildFeeSats: resolved.finalFeeSats,
  };
}

/**
 * Preview a mint: content-checked funding selection + two-pass fee, no signing.
 * `ready` = a safe funding coin covers postage + tip + fee; `expert-required` =
 * only asset coins cover; `insufficient` = nothing covers.
 */
export async function simulateMint(
  params: MintCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<MintSimulationResult> {
  const plan = await planMint(params, ports);
  return {
    status: plan.status,
    recommendation: plan.recommendation,
    fundingUtxo: plan.pick,
    vsize: plan.vsize,
    feeSats: plan.built ? plan.built.finalFeeSats : null,
    changeSats: plan.built ? plan.built.changeSats : null,
  };
}

/**
 * Execute a mint end-to-end: select → fee → build → sign → broadcast. Creates a
 * fresh 546-sat cat at `recipientAddress`, funded by the safe-auto-selected coin
 * (or the explicit expert pick). Throws with a clear message when only asset
 * coins cover or nothing covers.
 */
export async function executeMint(
  params: MintCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort; sign: SignPort; broadcast: BroadcastPort },
): Promise<BroadcastOutcome & { feeSats: number }> {
  const plan = await planMint(params, ports);
  if (plan.status !== 'ready' || !plan.pick || plan.buildFeeSats == null) {
    throw new Error(
      plan.status === 'expert-required'
        ? 'Select a funding UTXO (the available coins carry assets)'
        : 'Insufficient funds for mint at the current fee rate',
    );
  }
  const built = buildMint(params, plan.pick, plan.buildFeeSats, false);
  const signed = await ports.sign.sign(built.psbt, 'all');
  const outcome = await ports.broadcast.broadcast(signed.hex);
  // Realised miner fee (incl. absorbed sub-dust change) so consumers can record
  // the spend / display the fee without re-simulating.
  return { ...outcome, feeSats: built.finalFeeSats };
}
