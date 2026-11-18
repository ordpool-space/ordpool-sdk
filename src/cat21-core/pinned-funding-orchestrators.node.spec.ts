/**
 * @test-kind unit
 * Real:   InscribeMintOrchestrator, Cat21MintOrchestrator, Cat21TransferOrchestrator,
 *         Cat21CreateOfferOrchestrator, the cores, selectFunding, recommendFunding, describeFundingPick,
 *         assertPinnedFundingResolved, FundingSelectionChangedError
 * Faked:  the orchestrators' getUtxos / scan / broadcast deps, answering in the ports' own declared types
 *         (`TxnOutput`, `UtxoClassification`); the inscribe transport is recordingInscribeTransport
 * Proves: every orchestrator's execute method refuses to spend the fallback when the user's pinned coin no
 *         longer covers after a fee change: it throws FundingSelectionChangedError (reason
 *         `below-requirement`, the fallback named in the recommendation) before any signer or prompt runs,
 *         even though the snapshot would let the CTA proceed on the asset-notice fallback; transfer and
 *         create-offer, which spend the previewed coin, refuse a preview that predates a new pin with a
 *         typed FundingPreviewStaleError that its guard tells apart from a changed selection.
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
import {
  FundingPreviewStaleError,
  FundingPreviewStaleErrorJson,
  FundingSelectionChangedError,
  isFundingPreviewStaleError,
  isFundingSelectionChangedError,
} from '../cat21-fee/funding-selection-changed-error.js';
import * as mainEntry from '../index.js';
import * as coreEntry from '../core.js';
import { ContentScanPort, UtxoClassification } from './ports.js';

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

/** Clean, covers every action at 1 sat/vB and none at 300 sat/vB. */
const PIN: TxnOutput = { txid: 'a'.repeat(64), vout: 0, status: { confirmed: true }, value: 25_000 };
/** Covers every action at both rates and carries a named inscription: the asset-notice fallback. */
const FALLBACK: TxnOutput = { txid: 'b'.repeat(64), vout: 1, status: { confirmed: true }, value: 1_000_000 };
const LOW = 1;
const HIGH = 300;

const scan: ContentScanPort = {
  classify: async (outpoint): Promise<UtxoClassification> =>
    outpoint === `${FALLBACK.txid}:1`
      ? { verdict: 'has-assets', assets: { inscriptionIds: ['c'.repeat(64) + 'i0'], runeNames: [], catIds: [], cats: [], catSat: null, rareSat: null } }
      : 'clean',
};
const getUtxos = async (): Promise<TxnOutput[]> => [PIN, FALLBACK];
const wallet = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

interface View {
  status: string | null;
  resolvedTxid: string | null;
  dropped: string | null;
}

interface SnapLike {
  resolvedFundingStatus: string | null;
  resolvedFundingUtxo: { txid: string } | null;
  droppedSelection: { reason: string } | null;
}

interface Harness {
  name: string;
  start(): Promise<void>;
  pin(): void;
  setFeeRate(rate: number): void;
  execute(prompt: (u: { base64: string; hex: string }) => Promise<string>): Promise<unknown>;
  until(pred: (v: View) => boolean): Promise<View>;
}

function settle(o: { subscribe(fn: (s: SnapLike) => void): () => void }, pred: (v: View) => boolean): Promise<View> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => {
      const v = {
        status: s.resolvedFundingStatus,
        resolvedTxid: s.resolvedFundingUtxo?.txid ?? null,
        dropped: s.droppedSelection?.reason ?? null,
      };
      if (!done && pred(v)) {
        done = true;
        queueMicrotask(() => unsub());
        resolve(v);
      }
    });
  });
}

const HARNESSES: Array<() => Harness> = [
  () => {
    let o!: Cat21MintOrchestrator;
    return {
      name: 'Cat21MintOrchestrator.mint',
      async start() {
        o = new Cat21MintOrchestrator({ getUtxos, scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive' });
        await o.setWallet(wallet);
        o.setFeeRate(LOW);
      },
      pin: () => o.setSelectedUtxo(PIN),
      setFeeRate: (r) => o.setFeeRate(r),
      execute: (prompt) => o.mint(prompt),
      until: (pred) => settle(o, pred),
    };
  },
  () => {
    let o!: InscribeMintOrchestrator;
    return {
      name: 'InscribeMintOrchestrator.mint',
      async start() {
        o = new InscribeMintOrchestrator({
          getUtxos, scan, transport: recordingInscribeTransport(), network: Network.Mainnet, fundingTopology: 'derive',
        });
        await o.setWallet(wallet);
        o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
        o.setFeeRate(LOW);
      },
      pin: () => o.setSelectedUtxo(PIN),
      setFeeRate: (r) => o.setFeeRate(r),
      execute: (prompt) => o.mint(prompt),
      until: (pred) => settle(o, pred),
    };
  },
  () => {
    let o!: Cat21TransferOrchestrator;
    return {
      name: 'Cat21TransferOrchestrator.transfer',
      async start() {
        o = new Cat21TransferOrchestrator({ getUtxos, scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive' });
        await o.setWallet({ ...wallet, ordinalsPublicKey: ORDINALS_XONLY });
        o.setCatUtxo({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546 });
        o.setRecipientAddress(ORDINALS_ADDR);
        o.setFeeRate(LOW);
      },
      pin: () => o.setSelectedFundingUtxo(PIN),
      setFeeRate: (r) => o.setFeeRate(r),
      execute: (prompt) => o.transfer(prompt),
      until: (pred) => settle(o, pred),
    };
  },
  () => {
    let o!: Cat21CreateOfferOrchestrator;
    return {
      name: 'Cat21CreateOfferOrchestrator.createOffer',
      async start() {
        o = new Cat21CreateOfferOrchestrator({ getUtxos, scan, network: Network.Mainnet, fundingTopology: 'derive' });
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
        o.setFeeRate(LOW);
      },
      pin: () => o.setSelectedFundingUtxo(PIN),
      setFeeRate: (r) => o.setFeeRate(r),
      execute: (prompt) => o.createOffer(prompt),
      until: (pred) => settle(o, pred),
    };
  },
];

describe.each(HARNESSES.map((make) => [make().name, make] as const))('%s with a pin the fee outgrew', (_name, make) => {
  it('throws FundingSelectionChangedError before any prompt, instead of spending the asset-notice fallback', async () => {
    const h = make();
    await h.start();
    h.pin();
    await h.until((v) => v.status === 'ready' && v.resolvedTxid === PIN.txid);

    h.setFeeRate(HIGH);
    const after = await h.until((v) => v.dropped !== null);
    // The snapshot alone would let the CTA proceed: the fallback is an enabled asset-notice.
    expect(after).toEqual({ status: 'asset-notice', resolvedTxid: FALLBACK.txid, dropped: 'below-requirement' });

    const prompts: string[] = [];
    let err: unknown = null;
    try {
      await h.execute(async (u) => { prompts.push(u.hex); return 'signed'; });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(FundingSelectionChangedError);
    expect(isFundingPreviewStaleError(err)).toBe(false);
    if (!(err instanceof FundingSelectionChangedError)) throw new Error(`expected the error, got ${String(err)}`);
    expect({
      dropped: err.droppedSelection,
      fallback: err.recommendation.recommended?.txid,
      prompts,
    }).toEqual({
      dropped: { txid: PIN.txid, vout: 0, reason: 'below-requirement' },
      fallback: FALLBACK.txid,
      prompts: [],
    });
  });
});

describe('an execute call that races the recompute after a new pin', () => {
  /** Clean and covering, so it is a valid pin that the previous preview did not price. */
  const OTHER: TxnOutput = { txid: 'd'.repeat(64), vout: 0, status: { confirmed: true }, value: 30_000 };

  it.each([
    ['Cat21TransferOrchestrator.transfer', async () => {
      const o = new Cat21TransferOrchestrator({
        getUtxos: async () => [PIN, OTHER], scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive',
      });
      await o.setWallet({ ...wallet, ordinalsPublicKey: ORDINALS_XONLY });
      o.setCatUtxo({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546 });
      o.setRecipientAddress(ORDINALS_ADDR);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'ready' && v.resolvedTxid === PIN.txid);
      return { pin: () => o.setSelectedFundingUtxo(OTHER), run: (p: (u: { base64: string; hex: string }) => Promise<string>) => o.transfer(p) };
    }],
    ['Cat21CreateOfferOrchestrator.createOffer', async () => {
      const o = new Cat21CreateOfferOrchestrator({
        getUtxos: async () => [PIN, OTHER], scan, network: Network.Mainnet, fundingTopology: 'derive',
      });
      await o.setWallet(wallet);
      o.setTargetCat({
        catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546,
        scriptPubKey: btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script,
      });
      o.setSellerPaymentAddress(PAYMENT_ADDR);
      o.setPriceSats(21_000);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'ready' && v.resolvedTxid === PIN.txid);
      return { pin: () => o.setSelectedFundingUtxo(OTHER), run: (p: (u: { base64: string; hex: string }) => Promise<string>) => o.createOffer(p) };
    }],
  ] as const)('%s refuses to spend the previously priced coin, before any prompt', async (_name, make) => {
    const h = await make();
    h.pin();
    const prompts: string[] = [];

    const err: unknown = await h.run(async (u) => { prompts.push(u.hex); return 'signed'; }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(FundingPreviewStaleError);
    expect({
      stale: isFundingPreviewStaleError(err),
      changed: isFundingSelectionChangedError(err),
      json: JSON.parse(JSON.stringify(err)) as FundingPreviewStaleErrorJson,
      prompts,
    }).toEqual({
      stale: true,
      changed: false,
      json: {
        name: 'FundingPreviewStaleError',
        code: 'funding-preview-stale',
        message: 'The funding preview is still being updated for the selected UTXO. Try again in a moment.',
        selected: { txid: OTHER.txid, vout: 0 },
      },
      prompts: [],
    });
  });
});

describe('isFundingPreviewStaleError', () => {
  it('recognises the error by name and code across a realm, and nothing else', () => {
    expect([
      isFundingPreviewStaleError({ name: 'FundingPreviewStaleError', code: 'funding-preview-stale' }),
      isFundingPreviewStaleError({ name: 'FundingSelectionChangedError', code: 'funding-selection-changed' }),
      isFundingPreviewStaleError(new Error('The funding preview is still being updated for the selected UTXO. Try again in a moment.')),
      isFundingPreviewStaleError(null),
    ]).toEqual([true, false, false, false]);
  });

  it('ships on the main and the /core entry', () => {
    expect([mainEntry.isFundingPreviewStaleError, coreEntry.FundingPreviewStaleError]).toEqual([
      isFundingPreviewStaleError,
      FundingPreviewStaleError,
    ]);
  });
});

describe('a pin whose coin gains assets after it was picked', () => {
  /** The only covering coin; it carries inscription X, and later the scan also names Y. */
  const COIN: TxnOutput = { txid: '9'.repeat(64), vout: 2, status: { confirmed: true }, value: 1_000_000 };
  const X = 'a'.repeat(64) + 'i0';
  const Y = 'b'.repeat(64) + 'i0';
  const detail = (ids: string[]) => ({ inscriptionIds: ids, runeNames: [], catIds: [], cats: [], catSat: null, rareSat: null });

  /** A scan whose answer for COIN is switched by the test. */
  function mutableScan() {
    let ids = [X];
    const port: ContentScanPort = {
      classify: async (): Promise<UtxoClassification> => ({ verdict: 'has-assets', assets: detail(ids) }),
    };
    return { port, reveal: (next: string[]) => { ids = next; } };
  }

  /** The coin as a picker row hands it over: the bare wallet UTXO, no scan fields. */
  const pickerRow = (): TxnOutput => ({ ...COIN });

  const ONE_ADDRESS_WALLET = { ...wallet, ordinalsAddress: PAYMENT_ADDR };

  const cases: Array<[string, (scan: ContentScanPort) => Promise<{
    pick(): void;
    refresh(): Promise<void>;
    run(p: (u: { base64: string; hex: string }) => Promise<string>): Promise<unknown>;
    view(): View;
    until(pred: (v: View) => boolean): Promise<View>;
  }>]> = [
    ['Cat21MintOrchestrator (one address)', async (scan) => {
      const o = new Cat21MintOrchestrator({ getUtxos: async () => [COIN], scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet(ONE_ADDRESS_WALLET);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'expert-required');
      return { pick: () => o.setSelectedUtxo(pickerRow()), refresh: () => o.refreshUtxos(), run: (p) => o.mint(p), view: () => ({ status: o.getSnapshot().resolvedFundingStatus, resolvedTxid: o.getSnapshot().resolvedFundingUtxo?.txid ?? null, dropped: o.getSnapshot().droppedSelection?.reason ?? null }), until: (pred) => settle(o, pred) };
    }],
    ['InscribeMintOrchestrator (one address)', async (scan) => {
      const o = new InscribeMintOrchestrator({ getUtxos: async () => [COIN], scan, transport: recordingInscribeTransport(), network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet(ONE_ADDRESS_WALLET);
      o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'expert-required');
      return { pick: () => o.setSelectedUtxo(pickerRow()), refresh: () => o.refreshUtxos(), run: (p) => o.mint(p), view: () => ({ status: o.getSnapshot().resolvedFundingStatus, resolvedTxid: o.getSnapshot().resolvedFundingUtxo?.txid ?? null, dropped: o.getSnapshot().droppedSelection?.reason ?? null }), until: (pred) => settle(o, pred) };
    }],
    ['Cat21TransferOrchestrator (separate address)', async (scan) => {
      const o = new Cat21TransferOrchestrator({ getUtxos: async () => [COIN], scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet({ ...wallet, ordinalsPublicKey: ORDINALS_XONLY });
      o.setCatUtxo({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546 });
      o.setRecipientAddress(ORDINALS_ADDR);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'asset-notice');
      return { pick: () => o.setSelectedFundingUtxo(pickerRow()), refresh: () => o.refreshUtxos(), run: (p) => o.transfer(p), view: () => ({ status: o.getSnapshot().resolvedFundingStatus, resolvedTxid: o.getSnapshot().resolvedFundingUtxo?.txid ?? null, dropped: o.getSnapshot().droppedSelection?.reason ?? null }), until: (pred) => settle(o, pred) };
    }],
    ['Cat21CreateOfferOrchestrator (separate address)', async (scan) => {
      const o = new Cat21CreateOfferOrchestrator({ getUtxos: async () => [COIN], scan, network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet(wallet);
      o.setTargetCat({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546, scriptPubKey: btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script });
      o.setSellerPaymentAddress(PAYMENT_ADDR);
      o.setPriceSats(21_000);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'asset-notice');
      return { pick: () => o.setSelectedFundingUtxo(pickerRow()), refresh: () => o.refreshUtxos(), run: (p) => o.createOffer(p), view: () => ({ status: o.getSnapshot().resolvedFundingStatus, resolvedTxid: o.getSnapshot().resolvedFundingUtxo?.txid ?? null, dropped: o.getSnapshot().droppedSelection?.reason ?? null }), until: (pred) => settle(o, pred) };
    }],
  ];

  it.each(cases)('%s: the picked coin resolves as shown, and once the scan names more it is dropped and execute throws before any prompt', async (_name, make) => {
    const scan = mutableScan();
    const h = await make(scan.port);

    h.pick();
    const held = await h.until((v) => v.status === 'asset-notice' && v.resolvedTxid === COIN.txid);
    expect(held.dropped).toBeNull();

    scan.reveal([X, Y]);
    await h.refresh();
    const after = await h.until((v) => v.dropped !== null);
    expect(after.dropped).toBe('contents-changed');

    const prompts: string[] = [];
    const err = await h.run(async (u) => { prompts.push(u.hex); return 'signed'; }).then(() => null, (e: unknown) => e);
    expect({
      reason: err instanceof FundingSelectionChangedError ? err.droppedSelection.reason : String(err),
      prompts,
    }).toEqual({ reason: 'contents-changed', prompts: [] });
  });
});

describe('a pin made on a failed scan, after a retry scan finds an inscription', () => {
  /** The only covering coin. Its first scan fails; a retry finds inscription X. */
  const COIN: TxnOutput = { txid: '8'.repeat(64), vout: 1, status: { confirmed: true }, value: 1_000_000 };
  const X = 'e'.repeat(64) + 'i0';

  /** A scan port whose answer the test flips, the way a consumer's own retry changes the shared scanner. */
  function retryableScan() {
    let found = false;
    const port: ContentScanPort = {
      classify: async (): Promise<UtxoClassification> => {
        if (!found) throw new Error('ord unreachable');
        return { verdict: 'has-assets', assets: { inscriptionIds: [X], runeNames: [], catIds: [], cats: [], catSat: null, rareSat: null } };
      },
    };
    return { port, retryFinds: () => { found = true; } };
  }

  const pickerRow = (): TxnOutput => ({ ...COIN });

  type Driver = {
    pick(): void;
    rescan(): Promise<void>;
    run(p: (u: { base64: string; hex: string }) => Promise<string>): Promise<unknown>;
    view(): View;
    until(pred: (v: View) => boolean): Promise<View>;
  };
  const viewOf = (s: SnapLike): View => ({
    status: s.resolvedFundingStatus, resolvedTxid: s.resolvedFundingUtxo?.txid ?? null, dropped: s.droppedSelection?.reason ?? null,
  });

  const cases: Array<[string, (scan: ContentScanPort) => Promise<Driver>]> = [
    ['Cat21MintOrchestrator.mint', async (scan) => {
      const o = new Cat21MintOrchestrator({ getUtxos: async () => [COIN], scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet(wallet);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'expert-required');
      return { pick: () => o.setSelectedUtxo(pickerRow()), rescan: () => o.rescanFunding(), run: (p) => o.mint(p), view: () => viewOf(o.getSnapshot()), until: (pred) => settle(o, pred) };
    }],
    ['InscribeMintOrchestrator.mint', async (scan) => {
      const o = new InscribeMintOrchestrator({ getUtxos: async () => [COIN], scan, transport: recordingInscribeTransport(), network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet(wallet);
      o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'expert-required');
      return { pick: () => o.setSelectedUtxo(pickerRow()), rescan: () => o.rescanFunding(), run: (p) => o.mint(p), view: () => viewOf(o.getSnapshot()), until: (pred) => settle(o, pred) };
    }],
    ['Cat21TransferOrchestrator.transfer', async (scan) => {
      const o = new Cat21TransferOrchestrator({ getUtxos: async () => [COIN], scan, broadcast: async () => 'unused', network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet({ ...wallet, ordinalsPublicKey: ORDINALS_XONLY });
      o.setCatUtxo({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546 });
      o.setRecipientAddress(ORDINALS_ADDR);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'expert-required');
      return { pick: () => o.setSelectedFundingUtxo(pickerRow()), rescan: () => o.rescanFunding(), run: (p) => o.transfer(p), view: () => viewOf(o.getSnapshot()), until: (pred) => settle(o, pred) };
    }],
    ['Cat21CreateOfferOrchestrator.createOffer', async (scan) => {
      const o = new Cat21CreateOfferOrchestrator({ getUtxos: async () => [COIN], scan, network: Network.Mainnet, fundingTopology: 'derive' });
      await o.setWallet(wallet);
      o.setTargetCat({ catNumber: 42, txid: 'f'.repeat(64), vout: 0, value: 546, scriptPubKey: btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script });
      o.setSellerPaymentAddress(PAYMENT_ADDR);
      o.setPriceSats(21_000);
      o.setFeeRate(LOW);
      await settle(o, (v) => v.status === 'expert-required');
      return { pick: () => o.setSelectedFundingUtxo(pickerRow()), rescan: () => o.rescanFunding(), run: (p) => o.createOffer(p), view: () => viewOf(o.getSnapshot()), until: (pred) => settle(o, pred) };
    }],
  ];

  const execute = async (h: Driver) => {
    const prompts: string[] = [];
    const err = await h.run(async (u) => { prompts.push(u.hex); return 'signed'; }).then(() => null, (e: unknown) => e);
    return { reason: err instanceof FundingSelectionChangedError ? err.droppedSelection.reason : String(err), prompts };
  };

  it.each(cases)('%s: execute without a recompute re-checks the pin on a fresh scan and refuses', async (_name, make) => {
    const scan = retryableScan();
    const h = await make(scan.port);
    h.pick();
    // The pin holds, shown as unchecked, and the stale recommendation still lists the coin as failed.
    const pinned = await h.until((v) => v.resolvedTxid === COIN.txid);
    expect(pinned.dropped).toBeNull();

    scan.retryFinds();
    expect(h.view().dropped).toBeNull();

    expect(await execute(h)).toEqual({ reason: 'contents-changed', prompts: [] });
    // The refusal also started a recompute, so the snapshot names the drop.
    expect((await h.until((v) => v.dropped !== null)).dropped).toBe('contents-changed');
  });

  it.each(cases)('%s: rescanFunding brings the snapshot up to the new scan before anyone clicks', async (_name, make) => {
    const scan = retryableScan();
    const h = await make(scan.port);
    h.pick();
    await h.until((v) => v.resolvedTxid === COIN.txid);

    scan.retryFinds();
    await h.rescan();

    expect(h.view().dropped).toBe('contents-changed');
  });
});
