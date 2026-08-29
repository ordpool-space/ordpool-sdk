import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
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
import { selectFunding } from './select-funding';

/** ~200 vB fee ceiling: the funding budget a transfer coin must cover. */
const TRANSFER_FEE_VBYTE_CEILING = 200;

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
function buildTransfer(
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

/** Pick the funding coin: explicit expert override, else the safe auto coin. */
function resolvePick(
  params: TransferCoreParams,
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>,
  target: number,
): CoreFundingUtxo | null {
  const selected = params.selectedFundingUtxo;
  const stillPresent = selected
    ? recommendation.candidates.find((c) => c.txid === selected.txid && c.vout === selected.vout)
    : undefined;
  if (stillPresent && stillPresent.value >= target) return stillPresent;
  return recommendation.status === 'auto' ? recommendation.recommended : null;
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
  // Cat preserved (funded by input 0); funding covers ONLY the miner fee.
  const target = Math.ceil(params.feeRatePerVbyte * TRANSFER_FEE_VBYTE_CEILING);
  const recommendation = await selectFunding(utxos, target, ports.scan);
  const pick = resolvePick(params, recommendation, target);
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
  try {
    const two = twoPassFeeSimulation({
      simulate: (feeSats) => {
        const built = buildTransfer(params, pick, feeSats, true);
        return { built, vsize: computePsbtVsize({ psbt: built.psbt, network: toScureNetwork(params.network) }) };
      },
      feeRatePerVbyte: params.feeRatePerVbyte,
      // Same fee budget the coin was selected against, so a small-but-viable
      // clean coin isn't falsely rejected in pass-1 at low fee rates.
      placeholderFeeSats: target,
    });
    return {
      status: 'ready',
      recommendation,
      pick,
      built: two.finalSimulation.built,
      vsize: two.vsize,
      buildFeeSats: two.finalFeeSats,
    };
  } catch {
    return { status: 'insufficient', recommendation, pick: null, built: null, vsize: null, buildFeeSats: null };
  }
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
): Promise<BroadcastOutcome> {
  const plan = await planTransfer(params, ports);
  if (plan.status !== 'ready' || !plan.pick || plan.buildFeeSats == null) {
    throw new Error(
      plan.status === 'expert-required'
        ? 'Select a funding UTXO (the available coins carry assets)'
        : 'Insufficient funds for transfer at the current fee rate',
    );
  }
  const built = buildTransfer(params, plan.pick, plan.buildFeeSats, false);
  const signed = await ports.sign.sign(built.psbt, 'all');
  return ports.broadcast.broadcast(signed.hex);
}
