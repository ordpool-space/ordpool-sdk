import { describe, expect, it, jest } from '@jest/globals';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { storage } from '../storage-like';
import { cat21Config } from './cat21-sdk-config';
import { Cat21Service, LAST_CAT21_MINTS } from './cat21.service';
import { Cat21Mint } from './cat21.service.types';


const mempoolApiUrl = 'https://mempool.test';
const cat21ApiUrl = 'https://api.cat21.test';

type MockHttp = { get: jest.Mock; post: jest.Mock };
type MockStorage = { getValue: jest.Mock; setValue: jest.Mock; removeItem: jest.Mock };

const buildService = (storedMints: string | null = null): {
  service: Cat21Service;
  http: MockHttp;
  store: MockStorage;
} => {
  const http: MockHttp = {
    get: jest.fn(),
    post: jest.fn(),
  };
  const store: MockStorage = {
    getValue: jest.fn().mockImplementation(((key: unknown) => key === LAST_CAT21_MINTS ? storedMints : null) as never),
    setValue: jest.fn(),
    removeItem: jest.fn(),
  };

  const injector = Injector.create({
    providers: [
      { provide: HttpClient, useValue: http },
      { provide: storage,   useValue: store },
      { provide: bitcoinNetwork, useValue: Network.Mainnet },
      { provide: cat21Config, useValue: { mempoolApiUrl, cat21ApiUrl } },
    ],
  });

  const service = runInInjectionContext(injector, () => new Cat21Service());
  return { service, http, store };
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

    http.get.mockImplementation(((url: string) => {
      if (url.endsWith('/utxo')) return of(utxos);
      if (url.includes('/tx/') && url.endsWith('/hex')) {
        const txid = url.split('/tx/')[1].split('/')[0];
        return of(`hex-of-${txid}`);
      }
      return throwError(() => new Error(`unexpected GET: ${url}`));
    }) as never);

    const result = await firstValueFrom(service.getUtxos('1LegacyAddress'));

    // 1 UTXO list call + N per-utxo hex calls
    expect(http.get).toHaveBeenCalledTimes(1 + utxos.length);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ txid: utxos[0].txid, transactionHex: `hex-of-${utxos[0].txid}` });
    expect(result[1]).toMatchObject({ txid: utxos[1].txid, transactionHex: `hex-of-${utxos[1].txid}` });
  });

  it('throws when address is empty', () => {
    const { service } = buildService();
    expect(() => service.getUtxos('')).toThrow('No wallet connected');
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
    http.get.mockImplementation(((url: string) => {
      if (url.includes('/tx/aaa/')) return of('hex-a');
      if (url.includes('/tx/bbb/')) return of('hex-b');
      return throwError(() => new Error('unexpected'));
    }) as never);

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


describe('Cat21Service localStorage round-trip', () => {

  it('hydrates allMints$ from storage on construction', () => {
    const stored: Cat21Mint[] = [
      { txId: 't1', paymentAddress: 'p1', recipientAddress: 'r1', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const { service, store } = buildService(JSON.stringify(stored));

    expect(store.getValue).toHaveBeenCalledWith(LAST_CAT21_MINTS);
    expect(service.allMints$.value).toEqual(stored);
  });

  it('returns an empty array when nothing is stored', () => {
    const { service } = buildService(null);
    expect(service.allMints$.value).toEqual([]);
    expect(service.getAllMints()).toEqual([]);
  });

  it('saveNewMint persists, updates allMints$, and includes a created-at timestamp', () => {
    const { service, store } = buildService(null);

    service.saveNewMint('new-tx', 'pay-addr', 'recv-addr');

    expect(store.setValue).toHaveBeenCalledWith(
      LAST_CAT21_MINTS,
      expect.any(String),
    );
    const persisted: Cat21Mint[] = JSON.parse((store.setValue.mock.calls[0] as unknown as [string, string])[1]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      txId: 'new-tx',
      paymentAddress: 'pay-addr',
      recipientAddress: 'recv-addr',
    });
    expect(persisted[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(service.allMints$.value).toEqual(persisted);
  });

  it('appends to existing mints rather than replacing', () => {
    const existing: Cat21Mint[] = [
      { txId: 'old', paymentAddress: 'old-pay', recipientAddress: 'old-rec', createdAt: '2025-12-01T00:00:00Z' },
    ];
    const { service, store } = buildService(JSON.stringify(existing));

    service.saveNewMint('new-tx', 'new-pay', 'new-rec');

    const persisted: Cat21Mint[] = JSON.parse((store.setValue.mock.calls[0] as unknown as [string, string])[1]);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].txId).toBe('old');
    expect(persisted[1].txId).toBe('new-tx');
  });
});
