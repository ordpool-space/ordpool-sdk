import { describe, expect, it } from '@jest/globals';
import { firstValueFrom } from 'rxjs';

import { Network } from '../../network';
import { albySigner } from './alby.signer';
import { binanceSigner } from './binance.signer';
import { phantomSigner } from './phantom.signer';
import { psbtExportSigner } from './psbt-export.signer';
import { unsupportedSignMessage } from './unsupported-sign-message';
import { wizzSigner } from './wizz.signer';

describe('unsupportedSignMessage — shared "wallet cannot sign a BIP-322 message yet" stub', () => {

  const args = { address: 'bc1p-x', message: 'hi', network: Network.Mainnet };

  it('emits an observable error naming the wallet in the message', async () => {
    const impl = unsupportedSignMessage('MyWallet');
    let caught: Error | null = null;
    try {
      await firstValueFrom(impl(args));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('MyWallet');
    expect(caught!.message).toContain('BIP-322');
  });

  it('recommends the wallets that DO support signMessage today', async () => {
    const impl = unsupportedSignMessage('X');
    let caught: Error | null = null;
    try {
      await firstValueFrom(impl(args));
    } catch (e) {
      caught = e as Error;
    }
    // The error surfaces to the seller in a "connect a supported wallet"
    // banner; make sure it names the alternatives we actually have.
    for (const supported of ['cat21-wallet', 'Xverse', 'Leather', 'Unisat', 'OKX']) {
      expect(caught!.message).toContain(supported);
    }
  });

  // Every stubbed signer's signMessage errors with a wallet-name-carrying
  // message. Pins the "you can still see this wallet in the picker for
  // other cat flows, you just can't list on the orderbook yet" contract.
  it.each([
    ['alby', albySigner, 'Alby'],
    ['binance', binanceSigner, 'Binance'],
    ['phantom', phantomSigner, 'Phantom'],
    ['wizz', wizzSigner, 'Wizz'],
    ['psbt-export', psbtExportSigner, 'PSBT-export (watch-only)'],
  ])('%s signMessage errors with a wallet-named message', async (_label, signer, expectedName) => {
    let caught: Error | null = null;
    try {
      await firstValueFrom(signer.signMessage(args));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain(expectedName);
  });
});
