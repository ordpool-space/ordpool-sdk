/**
 * @test-kind unit
 * Real:   executeMint, executeTransfer, createOffer, executeInscribe, selectFunding, recommendFunding,
 *         describeFundingPick, the PSBT builders, FundingSelectionChangedError
 * Faked:  UtxosPort, ContentScanPort, SignPort, BroadcastPort, answering in the ports' own declared types
 *         (`CoreFundingUtxo`, `UtxoClassification`); the inscribe transport is recordingInscribeTransport
 * Proves: a pinned funding coin that the plan dropped (`gone` or `below-requirement`) stops every execute path
 *         with a FundingSelectionChangedError before anything is signed or sent, even where the fallback would
 *         proceed (`asset-notice` on a separate-payment-address wallet); a pinned coin that is still present and
 *         covers is spent; the error survives JSON serialisation with nothing lost
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
import { DroppedSelection } from '../cat21-core/select-funding.js';
import { recordingInscribeTransport } from '../testing/inscribe-transport.js';
import {
  FundingSelectionChangedError,
  FundingSelectionChangedErrorJson,
  isFundingSelectionChangedError,
} from './funding-selection-changed-error.js';
import * as mainEntry from '../index.js';
import * as coreEntry from '../core.js';

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;
const SELLER_CAT_SCRIPT = btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script;

/** Covers every action at 10 sat/vB and carries a named inscription: the fallback would be `asset-notice`. */
const ASSET_COIN: CoreFundingUtxo = { txid: 'b'.repeat(64), vout: 1, value: 400_000 };
const ASSET_DETAIL: UtxoAssetDetail = { inscriptionIds: ['y'.repeat(64) + 'i0'], runeNames: [], catIds: [], rareSat: null };
/** The coin the user confirmed, which has left the wallet by execute time. */
const GONE_PIN: CoreFundingUtxo = { txid: 'a'.repeat(64), vout: 0, value: 300_000 };
/** Present and clean, but covers no action at 10 sat/vB. */
const TIGHT_PIN: CoreFundingUtxo = { txid: 'e'.repeat(64), vout: 0, value: 600 };

const scan: ContentScanPort = {
  classify: async (outpoint): Promise<UtxoClassification> =>
    outpoint === `${ASSET_COIN.txid}:${ASSET_COIN.vout}` ? { verdict: 'has-assets', assets: ASSET_DETAIL } : 'clean',
};
const utxos = { spendableUtxos: async (): Promise<CoreFundingUtxo[]> => [ASSET_COIN, TIGHT_PIN] };

interface Recorder {
  signed: string[];
  sent: string[];
}

/** One execute path, run with an explicit pick. */
interface Flow {
  name: string;
  run(pin: CoreFundingUtxo, rec: Recorder): Promise<unknown>;
}

const sign = (rec: Recorder) => ({ sign: async () => { rec.signed.push('sign'); return { hex: '00', weight: 600 }; } });
const broadcast = (rec: Recorder) => ({
  broadcast: async (h: string) => { rec.sent.push(h); return { txid: 't', channel: 'mempool' as const }; },
});

const FLOWS: Flow[] = [
  {
    name: 'executeMint',
    run: (pin, rec) => executeMint(
      {
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: Network.Mainnet,
        paymentPublicKey: hex.decode(PAYMENT_PUB),
        paymentAddress: PAYMENT_ADDR,
        recipientAddress: ORDINALS_ADDR,
        feeRatePerVbyte: 10,
        fundingTopology: 'separate-payment-address',
        selectedFundingUtxo: pin,
      },
      { utxos, scan, sign: sign(rec), broadcast: broadcast(rec) },
    ),
  },
  {
    name: 'executeTransfer',
    run: (pin, rec) => executeTransfer(
      {
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: Network.Mainnet,
        ordinalsPublicKey: hex.decode(ORDINALS_XONLY),
        ordinalsAddress: ORDINALS_ADDR,
        paymentPublicKey: hex.decode(PAYMENT_PUB),
        paymentAddress: PAYMENT_ADDR,
        catUtxo: { txid: 'f'.repeat(64), vout: 0, value: 546 },
        recipientAddress: ORDINALS_ADDR,
        feeRatePerVbyte: 10,
        fundingTopology: 'separate-payment-address',
        selectedFundingUtxo: pin,
      },
      { utxos, scan, sign: sign(rec), broadcast: broadcast(rec) },
    ),
  },
  {
    name: 'createOffer',
    run: (pin, rec) => createOffer(
      {
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: Network.Mainnet,
        paymentPublicKey: hex.decode(PAYMENT_PUB),
        paymentAddress: PAYMENT_ADDR,
        buyerReceiveAddress: ORDINALS_ADDR,
        sellerPaymentAddress: PAYMENT_ADDR,
        targetCat: { txid: 'f'.repeat(64), vout: 0, value: 546, scriptPubKey: SELLER_CAT_SCRIPT },
        priceSats: 21_000,
        feeRatePerVbyte: 10,
        fundingTopology: 'separate-payment-address',
        selectedFundingUtxo: pin,
      },
      {
        utxos,
        scan,
        signOffer: { signBuyerInputs: async (psbt) => { rec.signed.push('sign'); return psbt; } },
      },
    ),
  },
  {
    name: 'executeInscribe',
    run: (pin, rec) => {
      const transport = recordingInscribeTransport();
      return executeInscribe(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: Network.Mainnet,
          paymentPublicKey: hex.decode(PAYMENT_PUB),
          paymentAddress: PAYMENT_ADDR,
          recipientAddress: ORDINALS_ADDR,
          body: new TextEncoder().encode('hello cat'),
          contentType: 'text/plain',
          feeRatePerVbyte: 10,
          fundingTopology: 'separate-payment-address',
          selectedFundingUtxo: pin,
        },
        {
          utxos,
          scan,
          transport,
          promptForSignedPsbt: async (unsigned) => { rec.signed.push(unsigned.hex); return 'signed'; },
        },
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

const expectedRecommendation = {
  status: 'asset-notice',
  recommended: { txid: ASSET_COIN.txid, vout: 1, value: 400_000, bucket: 'assets', assets: ASSET_DETAIL },
  candidates: [
    { txid: ASSET_COIN.txid, vout: 1, value: 400_000, bucket: 'assets', assets: ASSET_DETAIL },
    { txid: TIGHT_PIN.txid, vout: 0, value: 600, bucket: 'unscanned', assets: null },
  ],
};

describe.each(FLOWS.map((f) => [f.name, f] as const))('%s with a pinned funding coin', (_name, flow) => {
  it.each([
    ['gone', GONE_PIN],
    ['below-requirement', TIGHT_PIN],
  ] as const)('a %s pin stops with FundingSelectionChangedError, nothing signed, nothing sent', async (reason, pin) => {
    const rec: Recorder = { signed: [], sent: [] };

    const err = await caught(flow.run(pin, rec));

    expect(err).toBeInstanceOf(FundingSelectionChangedError);
    if (!(err instanceof FundingSelectionChangedError)) throw new Error(`expected the error, got ${String(err)}`);
    const dropped: DroppedSelection = { txid: pin.txid, vout: pin.vout, reason };
    expect({ dropped: err.droppedSelection, recommendation: err.recommendation, rec }).toEqual({
      dropped,
      recommendation: expectedRecommendation,
      rec: { signed: [], sent: [] },
    });
  });
});

describe.each(FLOWS.filter((f) => f.name === 'executeMint' || f.name === 'executeTransfer').map((f) => [f.name, f] as const))(
  '%s honours a pin that is still there and covers',
  (_name, flow) => {
    it('spends the pinned asset coin: signed and broadcast once', async () => {
      const rec: Recorder = { signed: [], sent: [] };

      const err = await caught(flow.run(ASSET_COIN, rec));

      expect({ err, signed: rec.signed.length, sent: rec.sent }).toEqual({ err: null, signed: 1, sent: ['00'] });
    });
  },
);

describe('FundingSelectionChangedError as data', () => {
  const dropped: DroppedSelection = { txid: GONE_PIN.txid, vout: 0, reason: 'gone' };

  it('round-trips through JSON with every field intact', async () => {
    const err = await caught(FLOWS[0].run(GONE_PIN, { signed: [], sent: [] }));
    if (!(err instanceof FundingSelectionChangedError)) throw new Error('expected the error');

    const json = JSON.parse(JSON.stringify(err)) as FundingSelectionChangedErrorJson;

    expect(json).toEqual({
      name: 'FundingSelectionChangedError',
      code: 'funding-selection-changed',
      message: `The selected funding UTXO ${GONE_PIN.txid}:0 is no longer available. Confirm a funding UTXO again.`,
      droppedSelection: dropped,
      recommendation: expectedRecommendation,
    });
    expect(isFundingSelectionChangedError(json)).toBe(true);
  });

  it('is recognised by name and code, and not for another error', () => {
    expect(isFundingSelectionChangedError({ name: 'FundingSelectionChangedError', code: 'funding-selection-changed' })).toBe(true);
    expect(isFundingSelectionChangedError({ name: 'FundingBlockedError', code: 'funding-blocked' })).toBe(false);
    expect(isFundingSelectionChangedError(new Error('x'))).toBe(false);
  });

  it('ships on the main and the /core entry', () => {
    expect([mainEntry.FundingSelectionChangedError, coreEntry.FundingSelectionChangedError]).toEqual([
      FundingSelectionChangedError,
      FundingSelectionChangedError,
    ]);
  });
});
