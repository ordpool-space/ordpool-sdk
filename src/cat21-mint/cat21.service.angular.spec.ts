import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { cat21Config } from './cat21-sdk-config';
import { Cat21Service } from './cat21.service';
import { MempoolTx, RecommendedFees, TxnOutput } from './cat21.service.types';


const mempoolApiUrl = 'https://mempool.test';
const cat21ApiUrl = 'https://api.cat21.test';

type HttpGetResult = TxnOutput[] | string | MempoolTx[] | RecommendedFees;
type MockHttp = {
  get: jest.MockedFunction<(url: string, opts?: { responseType: 'text' }) => Observable<HttpGetResult>>;
  post: jest.MockedFunction<(url: string, body: string, opts?: { responseType: 'text' }) => Observable<string>>;
};

const buildService = (): {
  service: Cat21Service;
  http: MockHttp;
} => {
  const http: MockHttp = {
    get: jest.fn<MockHttp['get']>(),
    post: jest.fn<MockHttp['post']>(),
  };

  const injector = Injector.create({
    providers: [
      { provide: HttpClient, useValue: http },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl, cat21ApiUrl } },
    ],
  });

  const service = runInInjectionContext(injector, () => new Cat21Service());
  return { service, http };
};


describe('Cat21Service.getUtxos', () => {

  it('passes through the UTXO list unchanged for a SegWit address (no hex fan-out)', async () => {
    const { service, http } = buildService();
    const utxos = [
      { txid: 'a'.repeat(64), vout: 0, value: 10000, status: { confirmed: true } },
      { txid: 'b'.repeat(64), vout: 1, value: 5000,  status: { confirmed: true } },
    ];
    http.get.mockReturnValue(of(utxos));

    const result = await firstValueFrom(service.getUtxos('bc1qexample'));

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith(`${mempoolApiUrl}/api/address/bc1qexample/utxo`);
    expect(result).toEqual(utxos);
  });

  it('fans out to /tx/<txid>/hex for each UTXO when the address is legacy', async () => {
    const { service, http } = buildService();
    const utxos = [
      { txid: 'aa'.repeat(32), vout: 0, value: 10000, status: { confirmed: true } },
      { txid: 'bb'.repeat(32), vout: 0, value: 5000,  status: { confirmed: true } },
    ];

    http.get.mockImplementation(url => {
      if (url.endsWith('/utxo')) return of(utxos);
      if (url.includes('/tx/') && url.endsWith('/hex')) {
        const txid = url.split('/tx/')[1].split('/')[0];
        return of(`hex-of-${txid}`);
      }
      return throwError(() => new Error(`unexpected GET: ${url}`));
    });

    const result = await firstValueFrom(service.getUtxos('1LegacyAddress'));

    // 1 UTXO list call + N per-utxo hex calls
    expect(http.get).toHaveBeenCalledTimes(1 + utxos.length);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ txid: utxos[0].txid, transactionHex: `hex-of-${utxos[0].txid}` });
    expect(result[1]).toMatchObject({ txid: utxos[1].txid, transactionHex: `hex-of-${utxos[1].txid}` });
  });

  it('emits an observable-error when address is empty (never throws synchronously)', async () => {
    const { service } = buildService();
    // Must NOT throw at call time — orchestrator pipes catchError on
    // the returned Observable and can't recover from a synchronous
    // throw here. Assert the failure is delivered as an error
    // notification instead.
    const obs = service.getUtxos('');
    await expect(new Promise((resolve, reject) => obs.subscribe({ next: resolve, error: reject })))
      .rejects.toThrow('No wallet connected');
  });
});


describe('Cat21Service.getTransactionHex', () => {

  it('GETs /api/tx/<id>/hex with responseType text and returns the hex string', async () => {
    const { service, http } = buildService();
    http.get.mockReturnValue(of('0200000001abcdef'));

    const result = await firstValueFrom(service.getTransactionHex('deadbeef'));

    expect(http.get).toHaveBeenCalledWith(
      `${mempoolApiUrl}/api/tx/deadbeef/hex`,
      { responseType: 'text' },
    );
    expect(result).toBe('0200000001abcdef');
  });

  it('caches the hex by txid — second call does not re-fetch', async () => {
    const { service, http } = buildService();
    http.get.mockReturnValue(of('cached-hex'));

    const first = await firstValueFrom(service.getTransactionHex('cafe'));
    const second = await firstValueFrom(service.getTransactionHex('cafe'));

    expect(first).toBe('cached-hex');
    expect(second).toBe('cached-hex');
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('caches per-txid independently', async () => {
    const { service, http } = buildService();
    http.get.mockImplementation(url => {
      if (url.includes('/tx/aaa/')) return of('hex-a');
      if (url.includes('/tx/bbb/')) return of('hex-b');
      return throwError(() => new Error('unexpected'));
    });

    expect(await firstValueFrom(service.getTransactionHex('aaa'))).toBe('hex-a');
    expect(await firstValueFrom(service.getTransactionHex('bbb'))).toBe('hex-b');
    expect(await firstValueFrom(service.getTransactionHex('aaa'))).toBe('hex-a');
    expect(http.get).toHaveBeenCalledTimes(2);
  });
});


describe('Cat21Service.postTransaction', () => {

  it('POSTs to /api/tx with the raw hex payload and text responseType', async () => {
    const { service, http } = buildService();
    http.post.mockReturnValue(of('returned-txid'));

    const result = await firstValueFrom(service.postTransaction('0200beef'));

    expect(http.post).toHaveBeenCalledWith(
      `${mempoolApiUrl}/api/tx`,
      '0200beef',
      { responseType: 'text' },
    );
    expect(result).toBe('returned-txid');
  });
});


describe('Cat21Service.pendingMints$', () => {

  // The polling chain uses RxJS `interval(30_000)`. Fake timers let us
  // advance through poll cycles synchronously without sleeping the
  // test suite for 30 seconds per tick.
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const ORDINALS = 'bc1ptrrx4duc8afs4ye63xgcyf6d7kg29a4myay4nqxmd04zx8j9jers899d0x';
  const PAYMENT  = 'bc1qexample';

  const sampleMint = (overrides: Partial<MempoolTx> = {}): MempoolTx => ({
    txid: 'a'.repeat(64),
    locktime: 21,
    weight: 704,
    fee: 880,
    vout: [
      { scriptpubkey_address: ORDINALS, value: 546 },
      { scriptpubkey_address: PAYMENT,  value: 9000 },
    ],
    ...overrides,
  });

  it('returns of([]) without polling when given an empty address list', async () => {
    const { service, http } = buildService();
    const value = await firstValueFrom(service.pendingMints$([]));
    expect(value).toEqual([]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('polls electrs mempool for each supplied address on subscribe and emits the filtered union', async () => {
    const { service, http } = buildService();
    http.get.mockReturnValueOnce(of([sampleMint()]));
    http.get.mockReturnValueOnce(of([])); // payment-address mempool empty

    const value = await firstValueFrom(service.pendingMints$([ORDINALS, PAYMENT]));

    expect(http.get).toHaveBeenCalledWith(`${mempoolApiUrl}/api/address/${ORDINALS}/txs/mempool`);
    expect(http.get).toHaveBeenCalledWith(`${mempoolApiUrl}/api/address/${PAYMENT}/txs/mempool`);
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({
      txid: 'a'.repeat(64),
      vsize: 176,
      fee: 880,
      feeRate: 5,
      recipientAddress: ORDINALS,
    });
  });

  it('keeps polling every 30 seconds while subscribed (cross-device mint scenario)', async () => {
    const { service, http } = buildService();
    // Three polling cycles' worth of responses: empty, empty, then a mint
    // shows up (e.g. user minted from another device).
    http.get
      .mockReturnValueOnce(of([])) // poll 1, addr 1
      .mockReturnValueOnce(of([])) // poll 1, addr 2
      .mockReturnValueOnce(of([])) // poll 2, addr 1
      .mockReturnValueOnce(of([])) // poll 2, addr 2
      .mockReturnValueOnce(of([sampleMint({ txid: 'b'.repeat(64) })])) // poll 3, addr 1
      .mockReturnValueOnce(of([])); // poll 3, addr 2

    const emissions: number[] = [];
    const sub = service.pendingMints$([ORDINALS, PAYMENT]).subscribe((mints) => {
      emissions.push(mints.length);
    });

    // Poll 1 fires synchronously via startWith(0).
    expect(emissions).toEqual([0]);

    // Advance to poll 2.
    jest.advanceTimersByTime(30_000);
    expect(emissions).toEqual([0, 0]);

    // Advance to poll 3 — the new mint surfaces.
    jest.advanceTimersByTime(30_000);
    expect(emissions).toEqual([0, 0, 1]);

    sub.unsubscribe();
  });

  it('stamps seenAt with the first-sight time, not the most-recent poll time', async () => {
    const { service, http } = buildService();
    const tx = sampleMint({ txid: 'c'.repeat(64) });
    // Same tx returned across three poll cycles.
    http.get.mockReturnValue(of([tx]));

    // Pin Date.now so the ISO timestamp is deterministic.
    const start = new Date('2026-06-08T12:00:00.000Z').getTime();
    jest.setSystemTime(start);

    const emissions: string[] = [];
    const sub = service.pendingMints$([ORDINALS]).subscribe((mints) => {
      if (mints.length) emissions.push(mints[0].seenAt);
    });

    expect(emissions).toEqual(['2026-06-08T12:00:00.000Z']);

    jest.setSystemTime(start + 30_000);
    jest.advanceTimersByTime(30_000);
    expect(emissions).toEqual([
      '2026-06-08T12:00:00.000Z',
      '2026-06-08T12:00:00.000Z', // still first-sight time
    ]);

    jest.setSystemTime(start + 60_000);
    jest.advanceTimersByTime(30_000);
    expect(emissions).toEqual([
      '2026-06-08T12:00:00.000Z',
      '2026-06-08T12:00:00.000Z',
      '2026-06-08T12:00:00.000Z',
    ]);

    sub.unsubscribe();
  });

  it('survives a per-address electrs failure by treating it as an empty list (one address down does not kill the chain)', async () => {
    const { service, http } = buildService();
    // ORDINALS endpoint returns a mint; PAYMENT endpoint errors out.
    http.get.mockReturnValueOnce(of([sampleMint()]));
    http.get.mockReturnValueOnce(throwError(() => new Error('electrs is grumpy')));

    const value = await firstValueFrom(service.pendingMints$([ORDINALS, PAYMENT]));

    expect(value).toHaveLength(1);
    expect(value[0].txid).toBe('a'.repeat(64));
  });
});


describe('Cat21Service.recommendedFees$', () => {

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const fees = (overrides: Partial<RecommendedFees> = {}): RecommendedFees => ({
    fastestFee: 12,
    halfHourFee: 8,
    hourFee: 5,
    economyFee: 2,
    minimumFee: 1,
    ...overrides,
  });

  it('hits /api/v1/fees/recommended on the configured mempoolApiUrl and emits the full tier set', async () => {
    const { service, http } = buildService();
    http.get.mockReturnValueOnce(of(fees()));

    const value = await firstValueFrom(service.recommendedFees$);

    expect(http.get).toHaveBeenCalledWith(`${mempoolApiUrl}/api/v1/fees/recommended`);
    expect(value).toEqual({
      fastestFee: 12,
      halfHourFee: 8,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1,
    });
  });

  it('re-polls every 30 seconds and emits each fresh response (fee rates change while user lingers on the form)', async () => {
    const { service, http } = buildService();
    http.get
      .mockReturnValueOnce(of(fees({ hourFee: 5 })))
      .mockReturnValueOnce(of(fees({ hourFee: 7 })))
      .mockReturnValueOnce(of(fees({ hourFee: 6 })));

    const emissions: number[] = [];
    const sub = service.recommendedFees$.subscribe((f) => emissions.push(f.hourFee));

    expect(emissions).toEqual([5]);

    jest.advanceTimersByTime(30_000);
    expect(emissions).toEqual([5, 7]);

    jest.advanceTimersByTime(30_000);
    expect(emissions).toEqual([5, 7, 6]);

    sub.unsubscribe();
  });

  it('shares one polling chain across multiple subscribers (refCount semantics)', async () => {
    const { service, http } = buildService();
    http.get.mockReturnValue(of(fees()));

    const subA = service.recommendedFees$.subscribe();
    const subB = service.recommendedFees$.subscribe();

    // Two subscribers on the same observable — only one HTTP call.
    expect(http.get).toHaveBeenCalledTimes(1);

    subA.unsubscribe();
    subB.unsubscribe();
  });
});


describe('Cat21Service.createCat21Transaction — watch-only promptForSignedPsbt threading', () => {

  // A valid Taproot payment identity so createTransaction builds a real
  // P2TR-funded mint PSBT (the xpub/watch-only funding shape).
  const paymentPublicKey = hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const xOnly = paymentPublicKey.slice(1, 33);
  const paymentAddress = btc.p2tr(xOnly, undefined, btc.NETWORK, true).address!;
  const recipientAddress = paymentAddress; // self-recipient is fine for a build test
  const paymentOutput: TxnOutput = {
    txid: 'c'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true },
  };

  it('threads promptForSignedPsbt to the watch-only signer (the callback fires)', async () => {
    const { service } = buildService();
    // The bridge: the SDK builds the PSBT and hands it here. We assert only
    // that the orchestrator reached the signer and invoked the callback;
    // returning the unsigned PSBT lets finalize fail AFTER the call, which is
    // irrelevant to the threading assertion.
    const prompt = jest.fn((unsigned: { base64: string; hex: string }) => of(unsigned.base64));

    await firstValueFrom(service.createCat21Transaction(
      KnownOrdinalWalletType.xpub,
      recipientAddress,
      paymentOutput,
      paymentAddress,
      paymentPublicKey,
      BigInt(2_000),
      prompt,
    )).catch(() => undefined); // finalize/broadcast may fail; the callback already fired

    expect(prompt).toHaveBeenCalledTimes(1);
    // It was handed the built PSBT to sign.
    const arg = prompt.mock.calls[0][0];
    expect(typeof arg.base64).toBe('string');
    expect(typeof arg.hex).toBe('string');
  });

  it('a watch-only mint WITHOUT the callback throws the load-bearing error', async () => {
    const { service } = buildService();
    await expect(firstValueFrom(service.createCat21Transaction(
      KnownOrdinalWalletType.xpub,
      recipientAddress,
      paymentOutput,
      paymentAddress,
      paymentPublicKey,
      BigInt(2_000),
      // no promptForSignedPsbt
    ))).rejects.toThrow(/promptForSignedPsbt/);
  });
});
