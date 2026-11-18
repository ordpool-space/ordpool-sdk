/**
 * @test-kind unit
 * Real:   InscribeMintOrchestrator, Cat21MintOrchestrator, Cat21TransferOrchestrator,
 *         Cat21CreateOfferOrchestrator, the mint / transfer / create-offer / inscribe cores,
 *         selectFunding, recommendFunding, describeFundingPick, the builders
 * Faked:  the orchestrators' getUtxos / scan / broadcast deps, answering in the ports' own declared
 *         types (`TxnOutput`, `UtxoClassification`); the inscribe transport is
 *         recordingInscribeTransport (ordpool-sdk/testing)
 * Proves: `resolvedFundingUtxo` is typed and filled as an annotated coin, so `.assets` names what the
 *         coin that will be SPENT carries. With two named-asset coins on a separate-payment-address
 *         wallet, the SDK recommends one and the user picks the other: `resolvedFundingUtxo.assets` is
 *         the PICKED coin's, the recommendation's stays the recommended coin's, and a clean pick has
 *         bucket `clean` and no assets.
 */
import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';
import { recordingInscribeTransport } from '../testing/inscribe-transport.js';
import { InscribeMintOrchestrator } from '../inscribe/inscribe-mint-orchestrator.js';
import { Cat21MintOrchestrator } from '../cat21-mint/cat21-mint-orchestrator.js';
import { Cat21TransferOrchestrator } from '../cat21-transfer/cat21-transfer-orchestrator.js';
import { Cat21CreateOfferOrchestrator } from '../cat21-offer/cat21-create-offer-orchestrator.js';
import { ContentScanPort, UtxoAssetDetail, UtxoClassification } from './ports.js';

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

const coin = (id: string, value: number): TxnOutput => ({
  txid: id.repeat(64).slice(0, 64),
  vout: 0,
  status: { confirmed: true },
  value,
});

/** Both cover every action at 10 sat/vB, and each carries a different inscription. */
const COIN_X = coin('a', 300_000);
const COIN_Y = coin('b', 400_000);
const CLEAN = coin('c', 500_000);
const DETAIL_X: UtxoAssetDetail = { inscriptionIds: ['x'.repeat(64) + 'i0'], runeNames: [], catIds: [], rareSat: null };
const DETAIL_Y: UtxoAssetDetail = { inscriptionIds: ['y'.repeat(64) + 'i0'], runeNames: [], catIds: [], rareSat: null };

const scan: ContentScanPort = {
  classify: async (outpoint: string): Promise<UtxoClassification> => {
    if (outpoint === `${COIN_X.txid}:0`) return { verdict: 'has-assets', assets: DETAIL_X };
    if (outpoint === `${COIN_Y.txid}:0`) return { verdict: 'has-assets', assets: DETAIL_Y };
    return 'clean';
  },
};

interface AssetsView {
  status: string | null;
  recommendedTxid: string | null;
  recommendedAssets: UtxoAssetDetail | null;
  resolvedTxid: string | null;
  resolvedBucket: string | null;
  resolvedAssets: UtxoAssetDetail | null;
}

interface Harness {
  name: string;
  start(utxos: TxnOutput[]): Promise<void>;
  select(utxo: TxnOutput): void;
  until(pred: (v: AssetsView) => boolean): Promise<AssetsView>;
}

interface SnapshotLike {
  resolvedFundingStatus: string | null;
  resolvedFundingUtxo: { txid: string; bucket: string; assets?: UtxoAssetDetail } | null;
  fundingRecommendation: { recommended: { txid: string; assets?: UtxoAssetDetail } | null };
}

const read = (s: SnapshotLike): AssetsView => ({
  status: s.resolvedFundingStatus,
  recommendedTxid: s.fundingRecommendation.recommended?.txid ?? null,
  recommendedAssets: s.fundingRecommendation.recommended?.assets ?? null,
  resolvedTxid: s.resolvedFundingUtxo?.txid ?? null,
  resolvedBucket: s.resolvedFundingUtxo?.bucket ?? null,
  resolvedAssets: s.resolvedFundingUtxo?.assets ?? null,
});

function settle<S extends SnapshotLike>(
  o: { subscribe(fn: (s: S) => void): () => void },
  pred: (v: AssetsView) => boolean,
): Promise<AssetsView> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    let done = false;
    unsub = o.subscribe((snap) => {
      const v = read(snap);
      if (!done && pred(v)) {
        done = true;
        queueMicrotask(() => unsub());
        resolve(v);
      }
    });
  });
}

const wallet = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

function inscribeHarness(): Harness {
  let o!: InscribeMintOrchestrator;
  return {
    name: 'InscribeMintOrchestrator',
    async start(utxos) {
      o = new InscribeMintOrchestrator({
        getUtxos: async () => utxos, scan, transport: recordingInscribeTransport(), network: Network.Mainnet,
        fundingTopology: 'derive',
      });
      await o.setWallet(wallet);
      o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedUtxo(u),
    until: (pred) => settle(o, pred),
  };
}

function cat21MintHarness(): Harness {
  let o!: Cat21MintOrchestrator;
  return {
    name: 'Cat21MintOrchestrator',
    async start(utxos) {
      o = new Cat21MintOrchestrator({
        getUtxos: async () => utxos, scan, broadcast: async () => 'unused', network: Network.Mainnet,
        fundingTopology: 'derive',
      });
      await o.setWallet(wallet);
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedUtxo(u),
    until: (pred) => settle(o, pred),
  };
}

function transferHarness(): Harness {
  let o!: Cat21TransferOrchestrator;
  return {
    name: 'Cat21TransferOrchestrator',
    async start(utxos) {
      o = new Cat21TransferOrchestrator({
        getUtxos: async () => utxos, scan, broadcast: async () => 'unused', network: Network.Mainnet,
        fundingTopology: 'derive',
      });
      await o.setWallet({ ...wallet, ordinalsPublicKey: ORDINALS_XONLY });
      o.setCatUtxo({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546 });
      o.setRecipientAddress(ORDINALS_ADDR);
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedFundingUtxo(u),
    until: (pred) => settle(o, pred),
  };
}

function createOfferHarness(): Harness {
  let o!: Cat21CreateOfferOrchestrator;
  return {
    name: 'Cat21CreateOfferOrchestrator',
    async start(utxos) {
      o = new Cat21CreateOfferOrchestrator({
        getUtxos: async () => utxos, scan, network: Network.Mainnet, fundingTopology: 'derive',
      });
      await o.setWallet(wallet);
      o.setTargetCat({
        catNumber: 42,
        txid: 'f'.repeat(64),
        vout: 0,
        value: 546,
        scriptPubKey: btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script,
      });
      o.setSellerPaymentAddress(PAYMENT_ADDR);
      o.setPriceSats(21_000);
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedFundingUtxo(u),
    until: (pred) => settle(o, pred),
  };
}

// The snapshot types themselves must declare the annotation, or a consumer
// cannot read `.assets` without re-deriving it from `candidates`.
type Resolved<O extends { getSnapshot(): { resolvedFundingUtxo: unknown } }> =
  NonNullable<ReturnType<O['getSnapshot']>['resolvedFundingUtxo']>;
const typedAssets: Array<(r: never) => UtxoAssetDetail | undefined> = [
  (r: Resolved<InscribeMintOrchestrator>) => r.assets,
  (r: Resolved<Cat21MintOrchestrator>) => r.assets,
  (r: Resolved<Cat21TransferOrchestrator>) => r.assets,
  (r: Resolved<Cat21CreateOfferOrchestrator>) => r.assets,
];
void typedAssets;

const harnesses: Array<() => Harness> = [inscribeHarness, cat21MintHarness, transferHarness, createOfferHarness];

describe.each(harnesses.map((make) => [make().name, make] as const))(
  '%s: resolvedFundingUtxo.assets names the coin that will be spent',
  (_name, make) => {
    it('recommended X, picked Y: the field carries Y\'s assets, the recommendation still X\'s', async () => {
      const h = make();
      await h.start([COIN_X, COIN_Y]);
      const before = await h.until((v) => v.status === 'asset-notice');
      expect({ recommended: before.recommendedTxid, assets: before.resolvedAssets }).toEqual({
        recommended: COIN_X.txid,
        assets: DETAIL_X,
      });

      h.select(COIN_Y);
      const after = await h.until((v) => v.status === 'asset-notice' && v.resolvedTxid === COIN_Y.txid);

      expect({ resolvedAssets: after.resolvedAssets, recommendedAssets: after.recommendedAssets }).toEqual({
        resolvedAssets: DETAIL_Y,
        recommendedAssets: DETAIL_X,
      });
    });

    it('a clean pick resolves with no assets', async () => {
      const h = make();
      await h.start([COIN_X, CLEAN]);
      await h.until((v) => v.status === 'ready');

      h.select(CLEAN);
      const after = await h.until((v) => v.status === 'ready' && v.resolvedTxid === CLEAN.txid);

      expect({ bucket: after.resolvedBucket, assets: after.resolvedAssets }).toEqual({ bucket: 'clean', assets: null });
    });
  },
);
