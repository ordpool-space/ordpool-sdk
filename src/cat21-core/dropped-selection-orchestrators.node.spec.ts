/**
 * @test-kind unit
 * Real:   InscribeMintOrchestrator, Cat21MintOrchestrator, Cat21TransferOrchestrator,
 *         Cat21CreateOfferOrchestrator, the mint / transfer / create-offer cores, selectFunding,
 *         recommendFunding, describeFundingPick, the commit / reveal, mint, transfer and offer builders
 * Faked:  the orchestrators' getUtxos / scan / broadcast deps, answering in the ports' own declared types
 *         (`TxnOutput`, `UtxoClassification`); the inscribe transport is recordingInscribeTransport
 *         (ordpool-sdk/testing)
 * Proves: every orchestrator that resolves an explicit funding pick names a replaced pick in
 *         `droppedSelection` (with `gone` or `below-requirement`) next to the coin it resolves to in
 *         `resolvedFundingUtxo`; a covering pick is not reported; changing or clearing the pick clears
 *         the report at once; on `expert-required` the stale pick is still named and nothing resolves.
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
import { DroppedSelection } from './select-funding.js';
import { ContentScanPort, UtxoClassification } from './ports.js';

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

/** Two clean coins that each cover every action at 10 sat/vB. */
const PICKED = coin('a', 300_000);
const OTHER = coin('b', 400_000);
/** Clean, but below every action's requirement at 10 sat/vB. */
const TIGHT = coin('e', 600);
/** Covers, and its scan says it carries assets. */
const ASSET = coin('d', 400_000);

const scanAssetsOn = (dirty: TxnOutput) => ({
  classify: async (outpoint: string): Promise<UtxoClassification> =>
    outpoint === `${dirty.txid}:${dirty.vout}` ? 'has-assets' : 'clean',
});
const allClean: ContentScanPort = { classify: async (): Promise<UtxoClassification> => 'clean' };

/** The funding read answers `first` once, then `after` on every refresh. */
const utxoSequence = (first: TxnOutput[], after: TxnOutput[]) => {
  let call = 0;
  return async (): Promise<TxnOutput[]> => (call++ === 0 ? first : after);
};

/** The fields this spec pins, read the same way off every orchestrator. */
interface PickView {
  selected: { txid: string; vout: number } | null;
  resolvedTxid: string | null;
  resolvedStatus: string | null;
  droppedSelection: DroppedSelection | null;
}

/** One orchestrator, driven to the point where a funding pick is decided. */
interface Harness {
  name: string;
  /** Connect with `utxos` and `scan`, fill every input, and set 10 sat/vB. */
  start(getUtxos: () => Promise<TxnOutput[]>, scan: ContentScanPort): Promise<void>;
  select(utxo: TxnOutput | null): void;
  refresh(): Promise<void>;
  reset(): void;
  view(): PickView;
  until(pred: (v: PickView) => boolean): Promise<PickView>;
}

function settle<S>(
  o: { subscribe(fn: (s: S) => void): () => void },
  read: (s: S) => PickView,
  pred: (v: PickView) => boolean,
): Promise<PickView> {
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

function inscribeHarness(): Harness {
  let o!: InscribeMintOrchestrator;
  const read = (s: ReturnType<InscribeMintOrchestrator['getSnapshot']>): PickView => ({
    selected: s.selectedUtxo,
    resolvedTxid: s.resolvedFundingUtxo?.txid ?? null,
    resolvedStatus: s.resolvedFundingStatus,
    droppedSelection: s.droppedSelection,
  });
  return {
    name: 'InscribeMintOrchestrator',
    async start(getUtxos, scan) {
      o = new InscribeMintOrchestrator({ getUtxos, scan, transport: recordingInscribeTransport(), network: Network.Mainnet });
      await o.setWallet({
        type: KnownOrdinalWalletType.cat21wallet,
        ordinalsAddress: ORDINALS_ADDR,
        paymentAddress: PAYMENT_ADDR,
        paymentPublicKey: PAYMENT_PUB,
      });
      o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedUtxo(u),
    refresh: () => o.refreshUtxos(),
    reset: () => o.reset(),
    view: () => read(o.getSnapshot()),
    until: (pred) => settle(o, read, pred),
  };
}

function cat21MintHarness(): Harness {
  let o!: Cat21MintOrchestrator;
  const read = (s: ReturnType<Cat21MintOrchestrator['getSnapshot']>): PickView => ({
    selected: s.selectedUtxo,
    resolvedTxid: s.resolvedFundingUtxo?.txid ?? null,
    resolvedStatus: s.resolvedFundingStatus,
    droppedSelection: s.droppedSelection,
  });
  return {
    name: 'Cat21MintOrchestrator',
    async start(getUtxos, scan) {
      o = new Cat21MintOrchestrator({ getUtxos, scan, broadcast: async () => 'unused', network: Network.Mainnet });
      await o.setWallet({
        type: KnownOrdinalWalletType.cat21wallet,
        ordinalsAddress: ORDINALS_ADDR,
        paymentAddress: PAYMENT_ADDR,
        paymentPublicKey: PAYMENT_PUB,
      });
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedUtxo(u),
    refresh: () => o.refreshUtxos(),
    reset: () => o.reset(),
    view: () => read(o.getSnapshot()),
    until: (pred) => settle(o, read, pred),
  };
}

function transferHarness(): Harness {
  let o!: Cat21TransferOrchestrator;
  const read = (s: ReturnType<Cat21TransferOrchestrator['getSnapshot']>): PickView => ({
    selected: s.selectedFundingUtxo,
    resolvedTxid: s.resolvedFundingUtxo?.txid ?? null,
    resolvedStatus: s.resolvedFundingStatus,
    droppedSelection: s.droppedSelection,
  });
  return {
    name: 'Cat21TransferOrchestrator',
    async start(getUtxos, scan) {
      o = new Cat21TransferOrchestrator({ getUtxos, scan, broadcast: async () => 'unused', network: Network.Mainnet });
      await o.setWallet({
        type: KnownOrdinalWalletType.cat21wallet,
        ordinalsAddress: ORDINALS_ADDR,
        ordinalsPublicKey: ORDINALS_XONLY,
        paymentAddress: PAYMENT_ADDR,
        paymentPublicKey: PAYMENT_PUB,
      });
      o.setCatUtxo({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546 });
      o.setRecipientAddress(ORDINALS_ADDR);
      o.setFeeRate(10);
    },
    select: (u) => o.setSelectedFundingUtxo(u),
    refresh: () => o.refreshUtxos(),
    reset: () => o.reset(),
    view: () => read(o.getSnapshot()),
    until: (pred) => settle(o, read, pred),
  };
}

function createOfferHarness(): Harness {
  let o!: Cat21CreateOfferOrchestrator;
  const read = (s: ReturnType<Cat21CreateOfferOrchestrator['getSnapshot']>): PickView => ({
    selected: s.selectedFundingUtxo,
    resolvedTxid: s.resolvedFundingUtxo?.txid ?? null,
    resolvedStatus: s.resolvedFundingStatus,
    droppedSelection: s.droppedSelection,
  });
  return {
    name: 'Cat21CreateOfferOrchestrator',
    async start(getUtxos, scan) {
      o = new Cat21CreateOfferOrchestrator({ getUtxos, scan, network: Network.Mainnet });
      await o.setWallet({
        type: KnownOrdinalWalletType.cat21wallet,
        ordinalsAddress: ORDINALS_ADDR,
        paymentAddress: PAYMENT_ADDR,
        paymentPublicKey: PAYMENT_PUB,
      });
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
    refresh: () => o.refreshUtxos(),
    reset: () => o.reset(),
    view: () => read(o.getSnapshot()),
    until: (pred) => settle(o, read, pred),
  };
}

const harnesses: Array<() => Harness> = [inscribeHarness, cat21MintHarness, transferHarness, createOfferHarness];

describe.each(harnesses.map((make) => [make().name, make] as const))('%s names a replaced funding pick', (_name, make) => {
  it('a covering pick resolves to itself and reports no drop', async () => {
    const h = make();
    await h.start(async () => [PICKED, OTHER], allClean);
    await h.until((v) => v.resolvedStatus === 'ready');

    h.select(PICKED);
    const held = await h.until((v) => v.resolvedStatus === 'ready' && v.resolvedTxid === PICKED.txid);
    expect(held.droppedSelection).toBeNull();
  });

  it('a pick that left the funding set is named as gone, and the recommendation resolves', async () => {
    const h = make();
    await h.start(utxoSequence([PICKED, OTHER], [OTHER]), allClean);
    await h.until((v) => v.resolvedStatus === 'ready');
    h.select(PICKED);
    await h.until((v) => v.resolvedStatus === 'ready' && v.resolvedTxid === PICKED.txid);

    await h.refresh();
    const after = await h.until((v) => v.resolvedStatus === 'ready' && v.droppedSelection !== null);
    expect({ dropped: after.droppedSelection, resolved: after.resolvedTxid, asked: after.selected?.txid }).toEqual({
      dropped: { txid: PICKED.txid, vout: 0, reason: 'gone' },
      resolved: OTHER.txid,
      // What was ASKED for stays recorded; the drop is the explanation.
      asked: PICKED.txid,
    });
  });

  it('clearing the pick clears the drop at once, before the recompute lands', async () => {
    const h = make();
    await h.start(async () => [TIGHT, OTHER], allClean);
    await h.until((v) => v.resolvedStatus === 'ready');
    h.select(TIGHT);
    await h.until((v) => v.droppedSelection !== null && v.resolvedStatus === 'ready');

    h.select(null);
    // Synchronous read: a consumer rendering in the same tick must not show a
    // drop for a pick that no longer exists.
    expect(h.view().droppedSelection).toBeNull();
    const after = await h.until((v) => v.resolvedStatus === 'ready');
    expect({ dropped: after.droppedSelection, resolved: after.resolvedTxid }).toEqual({ dropped: null, resolved: OTHER.txid });
  });

  it('changing the pick to a covering coin replaces the drop with no drop', async () => {
    const h = make();
    await h.start(async () => [TIGHT, OTHER], allClean);
    await h.until((v) => v.resolvedStatus === 'ready');
    h.select(TIGHT);
    await h.until((v) => v.droppedSelection !== null && v.resolvedStatus === 'ready');

    h.select(OTHER);
    expect(h.view().droppedSelection).toBeNull();
    const after = await h.until((v) => v.resolvedStatus === 'ready');
    expect({ dropped: after.droppedSelection, resolved: after.resolvedTxid }).toEqual({ dropped: null, resolved: OTHER.txid });
  });

  it('reset clears the drop together with the pick', async () => {
    const h = make();
    await h.start(async () => [TIGHT, OTHER], allClean);
    await h.until((v) => v.resolvedStatus === 'ready');
    h.select(TIGHT);
    await h.until((v) => v.droppedSelection !== null && v.resolvedStatus === 'ready');

    h.reset();
    expect({ dropped: h.view().droppedSelection, resolved: h.view().resolvedTxid, selected: h.view().selected })
      .toEqual({ dropped: null, resolved: null, selected: null });
  });

  it('expert-required with a stale pick: the pick is named and nothing resolves', async () => {
    // One-address blocking branch (no topology passed): the only covering
    // coin carries assets, and the pick below the requirement cannot stand.
    const h = make();
    await h.start(async () => [TIGHT, ASSET], scanAssetsOn(ASSET));
    await h.until((v) => v.resolvedStatus === 'expert-required');

    h.select(TIGHT);
    const after = await h.until((v) => v.resolvedStatus === 'expert-required' && v.droppedSelection !== null);
    expect({ dropped: after.droppedSelection, resolved: after.resolvedTxid }).toEqual({
      dropped: { txid: TIGHT.txid, vout: 0, reason: 'below-requirement' },
      resolved: null,
    });
  });
});
