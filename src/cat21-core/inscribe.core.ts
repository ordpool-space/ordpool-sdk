import { firstValueFrom, from } from 'rxjs';

import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
} from '../cat21-fee/funding-safety';
import {
  InscribeAndBroadcastArgs,
  InscribeAndBroadcastResult,
  inscribeAndBroadcast,
} from '../inscribe/inscribe-orchestrator';
import { simulateInscribeFees } from '../inscribe/inscription-fee.helper';
import { prepareInscribeFundingInput } from '../inscribe/inscription-input-adapter';
import { changeDustFloor } from '../cat21-script/address-format';
import { BroadcastPort, ContentScanPort, CoreFundingUtxo, UtxosPort } from './ports';
import { resolveFundingPick, selectFunding } from './select-funding';

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
}

export type InscribeStatus = 'ready' | 'expert-required' | 'insufficient';

export interface InscribeSimulation {
  status: InscribeStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  fundingUtxo: CoreFundingUtxo | null;
  /** commit output + commit fee the funding coin must cover. Null if the content is unbuildable. */
  fundingRequirementSats: number | null;
}

interface InscribePlan {
  status: InscribeStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  pick: CoreFundingUtxo | null;
  fundingRequirementSats: number | null;
}

/**
 * The inscription's funding requirement (commit output + commit fee), derived
 * from the content + fee rate via `simulateInscribeFees` against a
 * wallet-default-shaped dummy funding input — known before any coin is chosen.
 * Returns null when the content can't be simulated (unbuildable).
 */
function inscribeFundingTarget(params: InscribeCoreParams): number | null {
  if (!params.feeRatePerVbyte || params.feeRatePerVbyte <= 0) return null;
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
      network: params.network,
    });
    return sim.fundingRequirementSats;
  } catch {
    return null;
  }
}

async function planInscribe(
  params: InscribeCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<InscribePlan> {
  const empty = recommendFunding<CoreFundingUtxo & AnnotatedFundingUtxo>([], 0);
  const target = inscribeFundingTarget(params);
  if (target == null) {
    return { status: 'insufficient', recommendation: empty, pick: null, fundingRequirementSats: null };
  }
  const utxos = await ports.utxos.spendableUtxos(params.paymentAddress);
  // `target` already reflects the WITH-CHANGE commit fee (simulated against a
  // large synthetic funding input). Adding the change address's dust floor gives
  // the change-headroom preferred target: a coin >= this keeps its commit change
  // above dust, so the realised commit fee-rate lands on the typed rate instead
  // of a sub-dust leftover being absorbed into the fee. selectFunding falls back
  // to a tight coin when none has headroom — never a false insufficient.
  const preferredTarget = target + changeDustFloor(params.paymentAddress);
  const recommendation = await selectFunding(utxos, target, ports.scan, preferredTarget);
  const pick = resolveFundingPick(recommendation, target, params.selectedFundingUtxo);
  if (!pick) {
    return {
      status: recommendation.status === 'insufficient' ? 'insufficient' : 'expert-required',
      recommendation,
      pick: null,
      fundingRequirementSats: target,
    };
  }
  return { status: 'ready', recommendation, pick, fundingRequirementSats: target };
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
  if (plan.status !== 'ready' || !plan.pick) {
    throw new Error(
      plan.status === 'expert-required'
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
