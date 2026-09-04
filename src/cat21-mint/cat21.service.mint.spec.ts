import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, Observable } from 'rxjs';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

// Mock ONLY the signer registry: the service must run its REAL build
// path (createTransaction) and its REAL broadcast wiring; the fake
// signer stands in for the injected browser wallet.
jest.mock('../wallet/signers', () => {
  const actual = jest.requireActual('../wallet/signers') as Record<string, unknown>;
  return { ...actual, findSignerOrThrow: jest.fn() };
});
import { findSignerOrThrow } from '../wallet/signers';

import { Cat21SdkConfig } from './cat21-sdk-config';
import { Cat21Service } from './cat21.service';
import { TxnOutput } from './cat21.service.types';

/**
 * Happy-path pin for `createCat21Transaction` on the injected
 * browser-wallet path — the PUBLIC mint orchestrator every consumer
 * calls (typed-triple HARD RULE). The Playwright harness re-implements
 * this flow inline for popup-driving reasons, so without this spec a
 * dropped line here (the paymentPublicKey threading, the broadcast
 * wiring) would break cat21.space's real mint while all wallet e2e
 * stayed green against the harness's parallel implementation.
 */
const config: Cat21SdkConfig = {
  mempoolApiUrl: 'https://mempool.test',
  cat21ApiUrl: 'https://api.cat21.test',
  ordApiUrl: '',
  cat21OrdApiUrl: '',
};

const PRIVKEY = hex.decode('22'.repeat(32));
const PUBKEY = secp256k1.getPublicKey(PRIVKEY, true);
const PAYMENT_ADDRESS = btc.p2wpkh(PUBKEY, btc.NETWORK).address!;
const RECIPIENT_ORDINALS = btc.p2tr(PUBKEY.slice(1, 33), undefined, btc.NETWORK).address!;
const FUNDING: TxnOutput = {
  txid: 'ab'.repeat(32),
  vout: 0,
  value: 50_000,
  status: { confirmed: true },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  (findSignerOrThrow as unknown as jest.Mock).mockReset();
});

describe('Cat21Service.createCat21Transaction (injected browser-wallet path)', () => {

  it('builds a real lockTime=21 mint PSBT, hands the signer paymentAddress + hex paymentPublicKey + network, and wires broadcast to POST /api/tx', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true, status: 200,
      json: () => Promise.resolve('BROADCAST-TXID'),
      text: () => Promise.resolve('BROADCAST-TXID'),
    }) as unknown as Response) as jest.MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;

    // Fake injected signer: capture args, then drive the broadcast
    // callback exactly like a real signer does after wallet approval.
    let captured: {
      psbtBytes: Uint8Array;
      paymentAddress: string;
      paymentPublicKey?: string;
      network: Network;
      broadcast(txHex: string): Observable<string>;
    } | undefined;
    const fakeSigner = {
      providerId: KnownOrdinalWalletType.cat21wallet,
      signSingleFundingInput: (input: typeof captured) => {
        captured = input;
        return input!.broadcast('cafe0101').pipe();
      },
    };
    (findSignerOrThrow as unknown as jest.Mock).mockReturnValue(fakeSigner as never);

    const service = new Cat21Service(config, Network.Mainnet);
    const result$ = service.createCat21Transaction(
      KnownOrdinalWalletType.cat21wallet,
      RECIPIENT_ORDINALS,
      FUNDING,
      PAYMENT_ADDRESS,
      PUBKEY,
      1_000n,
    );

    // signSingleFundingInput result becomes the service result. The fake
    // broadcast Observable emits the txid string from POST /api/tx; the
    // signer contract wraps it — here we assert the raw emission since the
    // fake signer returns the broadcast stream directly.
    const txId = await firstValueFrom(result$ as unknown as Observable<string>);
    expect(txId).toBe('BROADCAST-TXID');

    // The signer registry was asked for the RIGHT wallet.
    expect(findSignerOrThrow).toHaveBeenCalledWith(KnownOrdinalWalletType.cat21wallet);

    // The signer got a REAL mint PSBT: parseable, lockTime=21, output 0
    // pays the recipient ordinals address at exactly 546.
    expect(captured).toBeDefined();
    const tx = btc.Transaction.fromPSBT(captured!.psbtBytes);
    expect(tx.lockTime).toBe(21);
    const out0 = tx.getOutput(0);
    expect(out0.amount).toBe(546n);
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(out0.script!))).toBe(RECIPIENT_ORDINALS);

    // The wallet-facing identity fields: app address verbatim + the HEX
    // paymentPublicKey that enables the signer-internal address shim
    // (dropping this line breaks Unisat/Wizz/OKX regtest signing).
    expect(captured!.paymentAddress).toBe(PAYMENT_ADDRESS);
    expect(captured!.paymentPublicKey).toBe(hex.encode(PUBKEY));
    expect(captured!.network).toBe(Network.Mainnet);

    // The broadcast callback POSTs the signer's raw hex to /api/tx.
    const postCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/tx'));
    expect(postCall).toBeDefined();
    expect((postCall![1] as RequestInit).method).toBe('POST');
    expect((postCall![1] as RequestInit).body).toBe('cafe0101');
  });
});
