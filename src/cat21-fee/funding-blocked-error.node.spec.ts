/**
 * @test-kind unit
 * Real:   executeMint, executeTransfer, createOffer, executeInscribe, the four orchestrators (mint, transfer,
 *         create-offer, inscribe), selectFunding, recommendFunding, the PSBT builders, FundingBlockedError
 * Faked:  UtxosPort, ContentScanPort, SignPort, BroadcastPort and the orchestrators' getUtxos / scan / broadcast deps,
 *         answering in the ports' own declared types (`CoreFundingUtxo`, `TxnOutput`, `UtxoClassification`, a rejected
 *         classify for a failed scan); the inscribe transport is recordingInscribeTransport (ordpool-sdk/testing)
 * Proves: every flow that stops on expert-required throws a FundingBlockedError carrying the cause, the recommended
 *         outpoint and the named assets, for each of the three causes, before anything is signed or broadcast;
 *         the error survives JSON serialisation with nothing lost
 */
import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';
import { ContentScanPort, CoreFundingUtxo, UtxoAssetDetail, UtxoClassification } from '../cat21-core/ports.js';
import { executeMint } from '../cat21-core/mint.core.js';
import { executeTransfer } from '../cat21-core/transfer.core.js';
import { createOffer } from '../cat21-core/create-offer.core.js';
import { executeInscribe } from '../cat21-core/inscribe.core.js';
import { Cat21MintOrchestrator, MintSnapshot } from '../cat21-mint/cat21-mint-orchestrator.js';
import { Cat21TransferOrchestrator, TransferSnapshot } from '../cat21-transfer/cat21-transfer-orchestrator.js';
import { Cat21CreateOfferOrchestrator, CreateOfferSnapshot } from '../cat21-offer/cat21-create-offer-orchestrator.js';
import { InscribeMintOrchestrator, InscribeSnapshot } from '../inscribe/inscribe-mint-orchestrator.js';
import { recordingInscribeTransport } from '../testing/inscribe-transport.js';
import { WalletAddressTopology } from './funding-safety.js';
import {
  FundingBlockedCoin,
  FundingBlockedError,
  FundingBlockedErrorJson,
  isFundingBlockedError,
} from './funding-blocked-error.js';
import * as mainEntry from '../index.js';
import * as coreEntry from '../core.js';

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;
const SELLER_PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const SELLER_CAT_SCRIPT = btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script;

/** The covering coin every case blocks on, and a small clean coin that covers nothing. */
const BLOCKED_TXID = 'd'.repeat(64);
const SMALL_TXID = 'e'.repeat(64);
const BLOCKED_VALUE = 100_000;
const SMALL_VALUE = 1_000;
const BLOCKED_VOUT = 3;
const BLOCKED_OUTPOINT = `${BLOCKED_TXID}:${BLOCKED_VOUT}`;

const NAMED_DETAIL: UtxoAssetDetail = {
  inscriptionIds: ['abc123i0'],
  runeNames: ['UNCOMMON•GOODS'],
  catIds: ['cafe00i0'],
  rareSat: { sat: '1953000000000000', block: 390_600, rarity: 'uncommon' },
};

type Cause = 'named-assets' | 'unnamed-assets' | 'unknown-content';

/**
 * One scenario per cause: what the scan port answers for the covering coin,
 * which wallet layout the flow is told about, and what the error must say.
 * The unnamed and unknown cases run on a SEPARATE-payment-address wallet,
 * because they block on every topology and that is the topology where a named
 * coin would not.
 */
interface Scenario {
  cause: Cause;
  topology: WalletAddressTopology;
  scan: ContentScanPort;
  message: string;
  bucket: 'assets' | 'failed';
  assets: UtxoAssetDetail | null;
}

const scanAnswering = (answer: UtxoClassification): ContentScanPort => ({
  classify: async (outpoint) => (outpoint === BLOCKED_OUTPOINT ? answer : 'clean'),
});

const SCENARIOS: Scenario[] = [
  {
    cause: 'named-assets',
    topology: 'one-address-for-everything',
    scan: scanAnswering({ verdict: 'has-assets', assets: NAMED_DETAIL }),
    message: 'Select a funding UTXO (the available coins carry assets)',
    bucket: 'assets',
    assets: NAMED_DETAIL,
  },
  {
    cause: 'unnamed-assets',
    topology: 'separate-payment-address',
    scan: scanAnswering('has-assets'),
    message: 'Select a funding UTXO (the covering coins carry assets the scan could not name)',
    bucket: 'assets',
    assets: null,
  },
  {
    cause: 'unknown-content',
    topology: 'separate-payment-address',
    scan: {
      classify: async (outpoint) => {
        if (outpoint === BLOCKED_OUTPOINT) throw new Error('ord unreachable');
        return 'clean';
      },
    },
    message: 'Select a funding UTXO (what the covering coins hold could not be checked)',
    bucket: 'failed',
    assets: null,
  },
];

const expectedRecommended = (s: Scenario): FundingBlockedCoin => ({
  txid: BLOCKED_TXID,
  vout: 3,
  value: BLOCKED_VALUE,
  bucket: s.bucket,
  assets: s.assets,
});

/** The small coin covers no flow's target, so it is never scanned. */
const expectedCandidates = (s: Scenario): FundingBlockedCoin[] => [
  expectedRecommended(s),
  { txid: SMALL_TXID, vout: 0, value: SMALL_VALUE, bucket: 'unscanned', assets: null },
];

/** Assert the full contract of the thrown error for one scenario. */
async function expectBlocked(run: Promise<unknown>, s: Scenario): Promise<FundingBlockedError> {
  let caught: unknown = null;
  try {
    await run;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(FundingBlockedError);
  if (!(caught instanceof FundingBlockedError)) {
    throw new Error(`expected a FundingBlockedError, got ${String(caught)}`);
  }
  expect(isFundingBlockedError(caught)).toBe(true);
  expect({
    name: caught.name,
    code: caught.code,
    message: caught.message,
    cause: caught.cause,
    recommendation: caught.recommendation,
  }).toEqual({
    name: 'FundingBlockedError',
    code: 'funding-blocked',
    message: s.message,
    cause: s.cause,
    recommendation: {
      status: 'expert-required',
      recommended: expectedRecommended(s),
      candidates: expectedCandidates(s),
    },
  });
  return caught;
}

// ---------------------------------------------------------------------------
// Core flows (what cat21-wallet's `/core` path calls)
// ---------------------------------------------------------------------------

const corePool = (): CoreFundingUtxo[] => [
  { txid: BLOCKED_TXID, vout: BLOCKED_VOUT, value: BLOCKED_VALUE },
  { txid: SMALL_TXID, vout: 0, value: SMALL_VALUE },
];
const utxos = { spendableUtxos: async () => corePool() };

describe.each(SCENARIOS)('core flows throw FundingBlockedError, cause $cause', (s) => {
  it('executeMint: typed error, nothing signed, nothing broadcast', async () => {
    const signed: string[] = [];
    const broadcast: string[] = [];
    await expectBlocked(
      executeMint(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: Network.Mainnet,
          paymentPublicKey: hex.decode(PAYMENT_PUB),
          paymentAddress: PAYMENT_ADDR,
          recipientAddress: ORDINALS_ADDR,
          feeRatePerVbyte: 10,
          fundingTopology: s.topology,
        },
        {
          utxos,
          scan: s.scan,
          sign: { sign: async () => { signed.push('sign'); return { hex: 'signed', weight: 500 }; } },
          broadcast: { broadcast: async (h) => { broadcast.push(h); return { txid: 't', channel: 'mempool' }; } },
        },
      ),
      s,
    );
    expect({ signed, broadcast }).toEqual({ signed: [], broadcast: [] });
  });

  it('executeTransfer: typed error, nothing signed, nothing broadcast', async () => {
    const signed: string[] = [];
    const broadcast: string[] = [];
    await expectBlocked(
      executeTransfer(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: Network.Mainnet,
          ordinalsPublicKey: hex.decode(ORDINALS_XONLY),
          ordinalsAddress: ORDINALS_ADDR,
          paymentPublicKey: hex.decode(PAYMENT_PUB),
          paymentAddress: PAYMENT_ADDR,
          catUtxo: { txid: 'a'.repeat(64), vout: 0, value: 546 },
          recipientAddress: ORDINALS_ADDR,
          feeRatePerVbyte: 10,
          fundingTopology: s.topology,
        },
        {
          utxos,
          scan: s.scan,
          sign: { sign: async () => { signed.push('sign'); return { hex: 'signed', weight: 600 }; } },
          broadcast: { broadcast: async (h) => { broadcast.push(h); return { txid: 't', channel: 'mempool' }; } },
        },
      ),
      s,
    );
    expect({ signed, broadcast }).toEqual({ signed: [], broadcast: [] });
  });

  it('createOffer: typed error, no buyer input signed', async () => {
    const signed: number[][] = [];
    await expectBlocked(
      createOffer(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: Network.Mainnet,
          paymentPublicKey: hex.decode(PAYMENT_PUB),
          paymentAddress: PAYMENT_ADDR,
          buyerReceiveAddress: ORDINALS_ADDR,
          sellerPaymentAddress: SELLER_PAYMENT_ADDR,
          targetCat: { txid: 'a'.repeat(64), vout: 0, value: 546, scriptPubKey: SELLER_CAT_SCRIPT },
          priceSats: 21_000,
          feeRatePerVbyte: 10,
          fundingTopology: s.topology,
        },
        {
          utxos,
          scan: s.scan,
          signOffer: { signBuyerInputs: async (_psbt, indexes) => { signed.push(indexes); return new Uint8Array([1]); } },
        },
      ),
      s,
    );
    expect(signed).toEqual([]);
  });

  it('executeInscribe: typed error, no prompt, nothing reaches the transport', async () => {
    const transport = recordingInscribeTransport();
    const prompts: string[] = [];
    await expectBlocked(
      executeInscribe(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: Network.Mainnet,
          paymentPublicKey: hex.decode(PAYMENT_PUB),
          paymentAddress: PAYMENT_ADDR,
          recipientAddress: ORDINALS_ADDR,
          body: new TextEncoder().encode('hello cat'),
          contentType: 'text/plain',
          feeRatePerVbyte: 10,
          fundingTopology: s.topology,
        },
        {
          utxos,
          scan: s.scan,
          transport,
          promptForSignedPsbt: async (unsigned) => { prompts.push(unsigned.hex); return 'signed'; },
        },
      ),
      s,
    );
    expect({ prompts, calls: transport.calls }).toEqual({ prompts: [], calls: [] });
  });
});

// ---------------------------------------------------------------------------
// Orchestrators (what cat21.space and cubes call)
// ---------------------------------------------------------------------------

const txnPool = async (): Promise<TxnOutput[]> => [
  { txid: BLOCKED_TXID, vout: BLOCKED_VOUT, status: { confirmed: true }, value: BLOCKED_VALUE },
  { txid: SMALL_TXID, vout: 0, status: { confirmed: true }, value: SMALL_VALUE },
];

/** Resolve on the first snapshot satisfying `pred` (the async recompute). */
function settled<S>(o: { subscribe(fn: (s: S) => void): () => void }, pred: (s: S) => boolean): Promise<S> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((snap) => {
      if (pred(snap)) {
        unsub();
        resolve(snap);
      }
    });
  });
}

describe.each(SCENARIOS)('orchestrators throw FundingBlockedError, cause $cause', (s) => {
  it('Cat21MintOrchestrator.mint: typed error, nothing broadcast', async () => {
    const broadcast: string[] = [];
    const o = new Cat21MintOrchestrator({
      getUtxos: txnPool,
      scan: s.scan,
      broadcast: async (h) => { broadcast.push(h); return 't'; },
      network: Network.Mainnet,
      fundingTopology: s.topology,
    });
    await o.setWallet({
      type: KnownOrdinalWalletType.cat21wallet,
      ordinalsAddress: ORDINALS_ADDR,
      paymentAddress: PAYMENT_ADDR,
      paymentPublicKey: PAYMENT_PUB,
    });
    o.setFeeRate(10);
    await settled<MintSnapshot>(o, (x) => x.fundingRecommendation.status === 'expert-required');
    await expectBlocked(o.mint(), s);
    expect({ broadcast, state: o.getSnapshot().state }).toEqual({ broadcast: [], state: 'ready' });
  });

  it('Cat21TransferOrchestrator.transfer: typed error, nothing broadcast', async () => {
    const broadcast: string[] = [];
    const o = new Cat21TransferOrchestrator({
      getUtxos: txnPool,
      scan: s.scan,
      broadcast: async (h) => { broadcast.push(h); return 't'; },
      network: Network.Mainnet,
      fundingTopology: s.topology,
    });
    await o.setWallet({
      type: KnownOrdinalWalletType.cat21wallet,
      ordinalsAddress: ORDINALS_ADDR,
      ordinalsPublicKey: ORDINALS_XONLY,
      paymentAddress: PAYMENT_ADDR,
      paymentPublicKey: PAYMENT_PUB,
    });
    o.setCatUtxo({ catNumber: 42, txid: 'a'.repeat(64), vout: 0, value: 546 });
    o.setRecipientAddress(ORDINALS_ADDR);
    o.setFeeRate(10);
    await settled<TransferSnapshot>(o, (x) => x.fundingRecommendation.status === 'expert-required');
    await expectBlocked(o.transfer(), s);
    expect({ broadcast, state: o.getSnapshot().state }).toEqual({ broadcast: [], state: 'ready' });
  });

  it('Cat21CreateOfferOrchestrator.createOffer: typed error, no bid', async () => {
    const o = new Cat21CreateOfferOrchestrator({
      getUtxos: txnPool,
      scan: s.scan,
      network: Network.Mainnet,
      fundingTopology: s.topology,
    });
    await o.setWallet({
      type: KnownOrdinalWalletType.cat21wallet,
      ordinalsAddress: ORDINALS_ADDR,
      paymentAddress: PAYMENT_ADDR,
      paymentPublicKey: PAYMENT_PUB,
    });
    o.setTargetCat({ catNumber: 42, txid: 'a'.repeat(64), vout: 0, value: 546, scriptPubKey: SELLER_CAT_SCRIPT });
    o.setSellerPaymentAddress(SELLER_PAYMENT_ADDR);
    o.setPriceSats(21_000);
    o.setFeeRate(10);
    await settled<CreateOfferSnapshot>(o, (x) => x.fundingRecommendation.status === 'expert-required');
    await expectBlocked(o.createOffer(), s);
    expect({ bid: o.getSnapshot().bid, state: o.getSnapshot().state }).toEqual({ bid: null, state: 'ready' });
  });

  it('InscribeMintOrchestrator.mint: typed error, nothing reaches the transport', async () => {
    const transport = recordingInscribeTransport();
    const o = new InscribeMintOrchestrator({
      getUtxos: txnPool,
      scan: s.scan,
      transport,
      network: Network.Mainnet,
      fundingTopology: s.topology,
    });
    await o.setWallet({
      type: KnownOrdinalWalletType.cat21wallet,
      ordinalsAddress: ORDINALS_ADDR,
      paymentAddress: PAYMENT_ADDR,
      paymentPublicKey: PAYMENT_PUB,
    });
    o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
    o.setFeeRate(10);
    await settled<InscribeSnapshot>(o, (x) => x.fundingRecommendation.status === 'expert-required');
    await expectBlocked(o.mint(), s);
    expect({ calls: transport.calls, state: o.getSnapshot().state }).toEqual({ calls: [], state: 'ready' });
  });
});

// ---------------------------------------------------------------------------
// The error as data
// ---------------------------------------------------------------------------

describe('FundingBlockedError as data', () => {
  const named = SCENARIOS[0];

  const blockedError = async (): Promise<FundingBlockedError> =>
    expectBlocked(
      executeMint(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: Network.Mainnet,
          paymentPublicKey: hex.decode(PAYMENT_PUB),
          paymentAddress: PAYMENT_ADDR,
          recipientAddress: ORDINALS_ADDR,
          feeRatePerVbyte: 10,
          fundingTopology: named.topology,
        },
        {
          utxos,
          scan: named.scan,
          sign: { sign: async () => ({ hex: 'signed', weight: 500 }) },
          broadcast: { broadcast: async () => ({ txid: 't', channel: 'mempool' }) },
        },
      ),
      named,
    );

  it('JSON round-trip keeps name, code, message, cause, recommended outpoint and the named assets', async () => {
    const err = await blockedError();
    const parsed: unknown = JSON.parse(JSON.stringify(err));
    const expected: FundingBlockedErrorJson = {
      name: 'FundingBlockedError',
      code: 'funding-blocked',
      message: 'Select a funding UTXO (the available coins carry assets)',
      cause: 'named-assets',
      recommendation: {
        status: 'expert-required',
        recommended: {
          txid: BLOCKED_TXID,
          vout: 3,
          value: BLOCKED_VALUE,
          bucket: 'assets',
          assets: {
            inscriptionIds: ['abc123i0'],
            runeNames: ['UNCOMMON•GOODS'],
            catIds: ['cafe00i0'],
            rareSat: { sat: '1953000000000000', block: 390_600, rarity: 'uncommon' },
          },
        },
        candidates: [
          {
            txid: BLOCKED_TXID,
            vout: 3,
            value: BLOCKED_VALUE,
            bucket: 'assets',
            assets: {
              inscriptionIds: ['abc123i0'],
              runeNames: ['UNCOMMON•GOODS'],
              catIds: ['cafe00i0'],
              rareSat: { sat: '1953000000000000', block: 390_600, rarity: 'uncommon' },
            },
          },
          { txid: SMALL_TXID, vout: 0, value: SMALL_VALUE, bucket: 'unscanned', assets: null },
        ],
      },
    };
    expect(parsed).toEqual(expected);
    // A parsed copy is still recognised, which is the cross-realm case.
    expect(isFundingBlockedError(parsed)).toBe(true);
  });

  it('the recommendation is a copy, so mutating the scanner detail later does not rewrite the error', async () => {
    const err = await blockedError();
    NAMED_DETAIL.inscriptionIds.push('later000i0');
    try {
      expect(err.recommendation.recommended.assets?.inscriptionIds).toEqual(['abc123i0']);
    } finally {
      NAMED_DETAIL.inscriptionIds.pop();
    }
  });

  it('isFundingBlockedError answers false for a plain Error carrying the same message', () => {
    expect(isFundingBlockedError(new Error('Select a funding UTXO (the available coins carry assets)'))).toBe(false);
  });

  it('refuses to describe a recommendation that does not block', () => {
    expect(
      () => new FundingBlockedError({ status: 'auto', recommended: { txid: SMALL_TXID, vout: 0, value: 1, bucket: 'clean' }, candidates: [] }),
    ).toThrow('FundingBlockedError needs an expert-required recommendation with a non-clean recommended coin, got status auto');
  });

  it('the main entry and /core export the error and its guard', () => {
    expect({
      mainError: mainEntry.FundingBlockedError,
      mainGuard: mainEntry.isFundingBlockedError,
      coreError: coreEntry.FundingBlockedError,
      coreGuard: coreEntry.isFundingBlockedError,
    }).toEqual({
      mainError: FundingBlockedError,
      mainGuard: isFundingBlockedError,
      coreError: FundingBlockedError,
      coreGuard: isFundingBlockedError,
    });
  });
});
