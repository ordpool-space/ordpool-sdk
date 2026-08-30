import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import {
  AnnotatedFundingUtxo,
  FundingRecommendation,
  recommendFunding,
} from '../cat21-fee/funding-safety';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { buildCat21BuyOfferPsbt } from '../cat21-offer/cat21-offer.helper';
import { prepareBuyOfferBuyerInput } from '../cat21-offer/cat21-offer-input-adapter';
import {
  ContentScanPort,
  CoreFundingUtxo,
  OfferCreateSignPort,
  UtxosPort,
} from './ports';
import { resolveFundingPick, selectFunding } from './select-funding';

/** ~220 vB fee ceiling for the buy-offer fee component. */
const OFFER_FEE_VBYTE_CEILING = 220;

/**
 * Everything the create-offer core needs, framework-agnostic. The BUYER builds
 * and buyer-signs a buy-offer PSBT for a specific cat; the seller later signs
 * input 0 and broadcasts. The buyer funds `price + cat value + fee`; the cat's
 * whole UTXO value is preserved to output 0 (ord parity).
 */
export interface CreateOfferCoreParams {
  walletType: KnownOrdinalWalletType;
  network: Network;
  /** Buyer's payment identity — funds the offer + receives change. */
  paymentPublicKey: Uint8Array;
  paymentAddress: string;
  /** Where the cat lands for the buyer (their ordinals address). */
  buyerReceiveAddress: string;
  /** Seller's payment address (paid `price + sellerInput.value`). */
  sellerPaymentAddress: string;
  /** The cat being bought — the seller's cat UTXO (its whole value is preserved). */
  targetCat: { txid: string; vout: number; value: number; scriptPubKey: Uint8Array };
  priceSats: number;
  feeRatePerVbyte: number;
  /** Expert-mode explicit funding pick; omitted ⇒ the safe auto coin. */
  selectedFundingUtxo?: CoreFundingUtxo | null;
}

export type CreateOfferStatus = 'ready' | 'expert-required' | 'insufficient';

export interface CreateOfferSimulationResult {
  status: CreateOfferStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  buyerFundingUtxo: CoreFundingUtxo | null;
  vsize: number | null;
  feeSats: number | null;
  changeSats: number | null;
}

export interface CreateOfferArtifact {
  /** Buyer-signed buy-offer PSBT bytes — the bid. Input 0 stays for the seller. */
  offerPsbt: Uint8Array;
  buyerFundingUtxo: CoreFundingUtxo;
  feeSats: number;
  changeSats: number;
}

interface OfferPlan {
  status: CreateOfferStatus;
  recommendation: FundingRecommendation<CoreFundingUtxo & AnnotatedFundingUtxo>;
  pick: CoreFundingUtxo | null;
  vsize: number | null;
  /** Two-pass miner fee (fed to the real build). */
  feeSats: number | null;
  changeSats: number | null;
}

/**
 * Build the buy-offer PSBT for one buyer funding pick + fee. Exported so the
 * framework-agnostic create-offer orchestrator reuses it instead of
 * duplicating the prepare-inputs + `buildCat21BuyOfferPsbt` composition.
 */
export function buildOffer(
  params: CreateOfferCoreParams,
  funding: CoreFundingUtxo,
  feeSats: number,
  isSimulation: boolean,
): { psbt: Uint8Array } {
  const buyerInput = prepareBuyOfferBuyerInput({
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
  const built = buildCat21BuyOfferPsbt({
    walletType: params.walletType,
    network: params.network,
    sellerInput: {
      txid: params.targetCat.txid,
      vout: params.targetCat.vout,
      value: params.targetCat.value,
      scriptPubKey: params.targetCat.scriptPubKey,
    },
    buyerInputs: [buyerInput],
    destinations: {
      buyerReceiveAddress: params.buyerReceiveAddress,
      sellerPaymentAddress: params.sellerPaymentAddress,
      buyerChangeAddress: params.paymentAddress,
    },
    priceSats: params.priceSats,
    feeSats,
  });
  return { psbt: built.psbt };
}

async function planOffer(
  params: CreateOfferCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<OfferPlan> {
  const empty = recommendFunding<CoreFundingUtxo & AnnotatedFundingUtxo>([], 0);
  if (!params.feeRatePerVbyte || params.feeRatePerVbyte <= 0 || !params.priceSats || params.priceSats <= 0) {
    return { status: 'insufficient', recommendation: empty, pick: null, vsize: null, feeSats: null, changeSats: null };
  }
  const utxos = await ports.utxos.spendableUtxos(params.paymentAddress);
  const feeCeiling = Math.ceil(params.feeRatePerVbyte * OFFER_FEE_VBYTE_CEILING);
  // Buyer funds price + the cat's REAL UTXO value (output 0, ord parity) + fee.
  const target = params.priceSats + params.targetCat.value + feeCeiling;
  const recommendation = await selectFunding(utxos, target, ports.scan);
  const pick = resolveFundingPick(recommendation, target, params.selectedFundingUtxo);
  if (!pick) {
    return {
      status: recommendation.status === 'insufficient' ? 'insufficient' : 'expert-required',
      recommendation,
      pick: null,
      vsize: null,
      feeSats: null,
      changeSats: null,
    };
  }
  try {
    const two = twoPassFeeSimulation({
      simulate: (feeSats) => ({
        vsize: computePsbtVsize({
          psbt: buildOffer(params, pick, feeSats, true).psbt,
          network: toScureNetwork(params.network),
          // Input 0 is the seller's cat UTXO (they sign later); fake its witness.
          nonSignableInputs: [0],
        }),
      }),
      feeRatePerVbyte: params.feeRatePerVbyte,
      placeholderFeeSats: feeCeiling,
    });
    // Buyer must cover price + cat value + the REAL fee; if the tightened fee
    // pushed the requirement past the pick, surface insufficient explicitly.
    const requiredBuyerFunding = params.priceSats + params.targetCat.value + two.finalFeeSats;
    if (pick.value < requiredBuyerFunding) {
      return { status: 'insufficient', recommendation, pick: null, vsize: null, feeSats: null, changeSats: null };
    }
    return {
      status: 'ready',
      recommendation,
      pick,
      vsize: two.vsize,
      feeSats: two.finalFeeSats,
      changeSats: pick.value - requiredBuyerFunding,
    };
  } catch {
    return { status: 'insufficient', recommendation, pick: null, vsize: null, feeSats: null, changeSats: null };
  }
}

/**
 * Preview a buy-offer: content-checked buyer-funding selection + two-pass fee,
 * no signing. `ready` = a safe funding coin covers price + cat value + fee.
 */
export async function simulateCreateOffer(
  params: CreateOfferCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort },
): Promise<CreateOfferSimulationResult> {
  const plan = await planOffer(params, ports);
  return {
    status: plan.status,
    recommendation: plan.recommendation,
    buyerFundingUtxo: plan.pick,
    vsize: plan.vsize,
    feeSats: plan.feeSats,
    changeSats: plan.changeSats,
  };
}

/**
 * Build + buyer-sign a buy-offer and return the bid artifact (the partial PSBT;
 * input 0 stays unsigned for the seller). Does NOT broadcast. Throws when only
 * asset coins cover (`expert-required`) or nothing covers.
 */
export async function createOffer(
  params: CreateOfferCoreParams,
  ports: { utxos: UtxosPort; scan: ContentScanPort; signOffer: OfferCreateSignPort },
): Promise<CreateOfferArtifact> {
  const plan = await planOffer(params, ports);
  if (plan.status !== 'ready' || !plan.pick || plan.feeSats == null || plan.changeSats == null) {
    throw new Error(
      plan.status === 'expert-required'
        ? 'Select a funding UTXO (the available coins carry assets)'
        : 'Insufficient funds for buy-offer at the current price + fee rate',
    );
  }
  const { psbt } = buildOffer(params, plan.pick, plan.feeSats, false);
  // Buyer inputs are 1..N (input 0 is the seller's cat). One funding coin => [1].
  const offerPsbt = await ports.signOffer.signBuyerInputs(psbt, [1]);
  return { offerPsbt, buyerFundingUtxo: plan.pick, feeSats: plan.feeSats, changeSats: plan.changeSats };
}
