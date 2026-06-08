import { describe, expect, it, jest } from '@jest/globals';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';

import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { cat21Config } from './cat21-sdk-config';
import { Cat21Service } from './cat21.service';
import { TxnOutput } from './cat21.service.types';


const mempoolApiUrl = 'https://mempool.test';
const cat21ApiUrl = 'https://api.cat21.test';

type HttpGetResult = TxnOutput[] | string;
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


