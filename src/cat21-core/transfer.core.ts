import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { resolveCatTxFee } from '../cat21-fee/resolve-cat-tx-fee.helper';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
} from '../cat21-fee/funding-safety';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  BuildCat21TransferResult,
  buildCat21TransferPsbt,
  CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS,
} from '../cat21-transfer/cat21-transfer.helper';
import {
  prepareTransferCatInput,
  prepareTransferFundingInput,
} from '../cat21-transfer/cat21-transfer-input-adapter';
import {
  BroadcastOutcome,
  BroadcastPort,
  ContentScanPort,
  CoreFundingUtxo,
  SignPort,
  UtxosPort,
} from './ports';
import { resolveFundingPick, selectFunding } from './select-funding';


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
  /** Optional resize (GROW/SHRINK); omitted ⇒ PRESERVE the cat UTXO size. */
  targetPostageSats?: number;
}

export type TransferStatus = 'ready' | 'expert-required' | 'scanning' | 'insufficient';

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
}

interface TransferPlan {
  status: TransferStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  pick: CoreFundingUtxo | null;
  /** Pass-2 build result (size numbers) + the fee to feed the real build. */
  built: BuildCat21TransferResult | null;
  vsize: number | null;
  buildFeeSats: number | null;
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
    return { status: 'insufficient', recommendation: empty, pick: null, built: null, vsize: null, buildFeeSats: null };
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
    return { status: 'insufficient', recommendation: empty, pick: null, built: null, vsize: null, buildFeeSats: null };
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
    CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS;
  const recommendation = await selectFunding(utxos, target, ports.scan, preferredTarget);
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
    return { status: 'insufficient', recommendation, pick: null, built: null, vsize: null, buildFeeSats: null };
  }
  return {
    status: 'ready',
    recommendation,
    pick,
    built: resolved.built,
    vsize: resolved.vsize,
    buildFeeSats: resolved.finalFeeSats,
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
  if (plan.status !== 'ready' || !plan.pick || plan.buildFeeSats == null || plan.built == null) {
    throw new Error(
      plan.status === 'expert-required'
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
