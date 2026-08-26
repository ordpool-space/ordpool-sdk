import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWalletType } from './wallet.service.types';
import { walletInAppBrowserDeepLink } from './wallet-deeplink';

describe('walletInAppBrowserDeepLink', () => {

  it('Xverse: verified Universal/App Link with the browser param', () => {
    expect(walletInAppBrowserDeepLink(KnownOrdinalWalletType.xverse, 'https://cat21.space/cat/0'))
      .toBe('https://connect.xverse.app/browser?url=https://cat21.space/cat/0');
  });

  it('returns null for every wallet without a docs-verified scheme', () => {
    for (const w of [
      KnownOrdinalWalletType.okx,
      KnownOrdinalWalletType.binance,
      KnownOrdinalWalletType.phantom,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.leather,
      KnownOrdinalWalletType.wizz,
      KnownOrdinalWalletType.alby,
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.xpub,
    ]) {
      expect(walletInAppBrowserDeepLink(w, 'https://cat21.space/cat/0')).toBeNull();
    }
  });
});
