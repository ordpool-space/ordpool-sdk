/**
 * @test-kind unit
 * Real:   executeMint, executeTransfer, createOffer, executeInscribe, selectFunding, recommendFunding,
 *         describeFundingPick, the PSBT builders, AssetSpendNotPermittedError
 * Faked:  UtxosPort, ContentScanPort, SignPort, BroadcastPort, answering in the ports' own declared types
 *         (`CoreFundingUtxo`, `UtxoClassification`); the inscribe transport is recordingInscribeTransport
 * Proves: under `assetSpend: 'refuse'` every execute path stops before anything is signed when the coin it
 *         would spend carries assets, both the asset-notice auto-pick on a separate-payment-address wallet and an
 *         explicit pin shown with its assets; the error names that coin and what the scan found on it (the
 *         justification, its own assertion), survives JSON, and is told apart by its guard; the same call under
 *         `'after-notice'` takes the coin to the signer, and so does a clean coin under `'refuse'`.
 */
import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { ContentScanPort, CoreFundingUtxo, UtxoAssetDetail, UtxoClassification } from '../cat21-core/ports.js';
import { executeMint } from '../cat21-core/mint.core.js';
import { executeTransfer } from '../cat21-core/transfer.core.js';
import { createOffer } from '../cat21-core/create-offer.core.js';
import { executeInscribe } from '../cat21-core/inscribe.core.js';
import { FundingPinContent } from '../cat21-core/select-funding.js';
import { recordingInscribeTransport } from '../testing/inscribe-transport.js';
import {
  AssetSpendNotPermittedError,
  AssetSpendNotPermittedErrorJson,
  AssetSpendPolicy,
  isAssetSpendNotPermittedError,
} from './asset-spend-not-permitted-error.js';
import { isFundingBlockedError } from './funding-blocked-error.js';
import * as mainEntry from '../index.js';
import * as coreEntry from '../core.js';

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;
const SELLER_CAT_SCRIPT = btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script;

/** The only coin, covering every action at 10 sat/vB and carrying a named inscription. */
const ASSET_COIN: CoreFundingUtxo = { txid: 'b'.repeat(64), vout: 1, value: 400_000 };
const ASSET_DETAIL: UtxoAssetDetail = { inscriptionIds: ['y'.repeat(64) + 'i0'], runeNames: [], catIds: [], cats: [], catSat: null, rareSat: null };
const CLEAN_COIN: CoreFundingUtxo = { txid: 'c'.repeat(64), vout: 0, value: 400_000 };

const scan: ContentScanPort = {
  classify: async (outpoint): Promise<UtxoClassification> =>
    outpoint === `${ASSET_COIN.txid}:1` ? { verdict: 'has-assets', assets: ASSET_DETAIL } : 'clean',
};

interface Recorder { signed: string[]; sent: string[] }
type Pin = (CoreFundingUtxo & FundingPinContent) | undefined;

interface Flow {
  name: string;
  run(coin: CoreFundingUtxo, pin: Pin, assetSpend: AssetSpendPolicy, rec: Recorder): Promise<unknown>;
}

const utxosOf = (coin: CoreFundingUtxo) => ({ spendableUtxos: async (): Promise<CoreFundingUtxo[]> => [coin] });
const sign = (rec: Recorder) => ({ sign: async () => { rec.signed.push('sign'); return { hex: '00', weight: 600 }; } });
const broadcast = (rec: Recorder) => ({
  broadcast: async (h: string) => { rec.sent.push(h); return { txid: 't', channel: 'mempool' as const }; },
});
const base = {
  walletType: KnownOrdinalWalletType.cat21wallet,
  network: Network.Mainnet,
  paymentPublicKey: hex.decode(PAYMENT_PUB),
  paymentAddress: PAYMENT_ADDR,
  feeRatePerVbyte: 10,
  fundingTopology: 'separate-payment-address' as const,
};

const FLOWS: Flow[] = [
  {
    name: 'executeMint',
    run: (coin, pin, assetSpend, rec) => executeMint(
      { ...base, recipientAddress: ORDINALS_ADDR, selectedFundingUtxo: pin },
      { utxos: utxosOf(coin), scan, sign: sign(rec), broadcast: broadcast(rec) },
      { assetSpend },
    ),
  },
  {
    name: 'executeTransfer',
    run: (coin, pin, assetSpend, rec) => executeTransfer(
      {
        ...base,
        ordinalsPublicKey: hex.decode(ORDINALS_XONLY),
        ordinalsAddress: ORDINALS_ADDR,
        catUtxo: { txid: 'f'.repeat(64), vout: 0, value: 546 },
        recipientAddress: ORDINALS_ADDR,
        selectedFundingUtxo: pin,
      },
      { utxos: utxosOf(coin), scan, sign: sign(rec), broadcast: broadcast(rec) },
      { assetSpend },
    ),
  },
  {
    name: 'createOffer',
    run: (coin, pin, assetSpend, rec) => createOffer(
      {
        ...base,
        buyerReceiveAddress: ORDINALS_ADDR,
        sellerPaymentAddress: PAYMENT_ADDR,
        targetCat: { txid: 'f'.repeat(64), vout: 0, value: 546, scriptPubKey: SELLER_CAT_SCRIPT },
        priceSats: 21_000,
        selectedFundingUtxo: pin,
      },
      { utxos: utxosOf(coin), scan, signOffer: { signBuyerInputs: async (psbt) => { rec.signed.push('sign'); return psbt; } } },
      { assetSpend },
    ),
  },
  {
    name: 'executeInscribe',
    run: (coin, pin, assetSpend, rec) => {
      const transport = recordingInscribeTransport();
      return executeInscribe(
        {
          ...base,
          // Watch-only, so signing goes through the prompt this spec records.
          walletType: KnownOrdinalWalletType.xpub,
          recipientAddress: ORDINALS_ADDR,
          body: new TextEncoder().encode('hello cat'),
          contentType: 'text/plain',
          selectedFundingUtxo: pin,
        },
        { utxos: utxosOf(coin), scan, transport, promptForSignedPsbt: async (u) => { rec.signed.push(u.hex); return 'signed'; } },
        { assetSpend },
      ).finally(() => rec.sent.push(...transport.calls));
    },
  },
];

async function caught(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return null;
  } catch (err) {
    return err;
  }
}

const SHOWN_PIN: Pin = { ...ASSET_COIN, bucket: 'assets', assets: ASSET_DETAIL };

describe.each(FLOWS.map((f) => [f.name, f] as const))('%s under assetSpend', (_name, flow) => {
  it.each([
    ['the asset-notice auto-pick', undefined],
    ['an explicit pin shown with its assets', SHOWN_PIN],
  ] as const)('refuse: %s stops before anything is signed (the gate)', async (_label, pin) => {
    const rec: Recorder = { signed: [], sent: [] };

    const err = await caught(flow.run(ASSET_COIN, pin, 'refuse', rec));

    expect({ refused: isAssetSpendNotPermittedError(err), blocked: isFundingBlockedError(err), rec }).toEqual({
      refused: true,
      blocked: false,
      rec: { signed: [], sent: [] },
    });
  });

  it('refuse: the error names the coin and what sits on it (the justification)', async () => {
    const err = await caught(flow.run(ASSET_COIN, undefined, 'refuse', { signed: [], sent: [] }));
    if (!(err instanceof AssetSpendNotPermittedError)) throw new Error(`expected the error, got ${String(err)}`);

    const json = JSON.parse(JSON.stringify(err)) as AssetSpendNotPermittedErrorJson;

    const coin = { txid: ASSET_COIN.txid, vout: 1, value: 400_000, bucket: 'assets', assets: ASSET_DETAIL };
    expect(json).toEqual({
      name: 'AssetSpendNotPermittedError',
      code: 'asset-spend-not-permitted',
      message: `The funding UTXO ${ASSET_COIN.txid}:1 carries assets, and this caller may not spend an asset coin. Nothing was signed.`,
      coin,
      recommendation: { status: 'asset-notice', recommended: coin, candidates: [coin] },
    });
    expect(isAssetSpendNotPermittedError(json)).toBe(true);
  });

  // These two stop at the signer: the fakes do not produce a signature every
  // flow can finalise, so what they pin is that the gate let the coin through
  // to signing, which is the one thing the gate decides.
  it('after-notice: the same asset-notice coin goes to the signer', async () => {
    const rec: Recorder = { signed: [], sent: [] };

    const err = await caught(flow.run(ASSET_COIN, undefined, 'after-notice', rec));

    expect({ refused: isAssetSpendNotPermittedError(err), signed: rec.signed.length }).toEqual({ refused: false, signed: 1 });
  });

  it('refuse: a clean coin goes to the signer', async () => {
    const rec: Recorder = { signed: [], sent: [] };

    const err = await caught(flow.run(CLEAN_COIN, undefined, 'refuse', rec));

    expect({ refused: isAssetSpendNotPermittedError(err), signed: rec.signed.length }).toEqual({ refused: false, signed: 1 });
  });
});

describe('isAssetSpendNotPermittedError', () => {
  it('recognises the error by name and code, and nothing else', () => {
    expect([
      isAssetSpendNotPermittedError({ name: 'AssetSpendNotPermittedError', code: 'asset-spend-not-permitted' }),
      isAssetSpendNotPermittedError({ name: 'FundingBlockedError', code: 'funding-blocked' }),
      isAssetSpendNotPermittedError(new Error('carries assets')),
      isAssetSpendNotPermittedError(null),
    ]).toEqual([true, false, false, false]);
  });

  it('ships on the main and the /core entry', () => {
    expect([mainEntry.AssetSpendNotPermittedError, coreEntry.isAssetSpendNotPermittedError]).toEqual([
      AssetSpendNotPermittedError,
      isAssetSpendNotPermittedError,
    ]);
  });
});
