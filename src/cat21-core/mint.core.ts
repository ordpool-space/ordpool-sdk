import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
} from '../cat21-fee/funding-safety';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import {
  BuildCat21MintResult,
  buildCat21MintPsbt,
} from '../cat21-mint/cat21-mint.helper';
import { prepareMintInputForWallet } from '../cat21-mint/cat21-mint-input-adapter';
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
 * Conservative vB ceiling for a CAT-21 mint (1 funding input + 1 P2TR cat
 * output + 1 change output; the largest such tx measures well under this).
 * Used only as a coverage over-estimate + two-pass seed — never a charged fee;
 * the real fee is the two-pass `finalFeeSats`. Exported as the single source
 * of truth so the framework-agnostic mint orchestrator's per-UTXO grid seeds
 * its two-pass from the same value instead of re-declaring it.
 */
export const MINT_FEE_VBYTE_CEILING = 200;

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
}

export type MintStatus = 'ready' | 'expert-required' | 'insufficient';

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
  const feeCeiling = Math.ceil(params.feeRatePerVbyte * MINT_FEE_VBYTE_CEILING);
  // Funding covers the fresh cat's postage + tip + the miner fee.
  const target = CAT21_POSTAGE_SATS + tipValue + feeCeiling;
  const recommendation = await selectFunding(utxos, target, ports.scan);
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
  try {
    const two = twoPassFeeSimulation({
      simulate: (feeSats) => {
        const built = buildMint(params, pick, feeSats, true);
        return { built, vsize: computePsbtVsize({ psbt: built.psbt, network: toScureNetwork(params.network) }) };
      },
      feeRatePerVbyte: params.feeRatePerVbyte,
      // Seed pass-1 with the fee component of the selection budget, not a flat
      // 1000, so a small-but-viable clean coin isn't rejected at low fee rates.
      placeholderFeeSats: feeCeiling,
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
