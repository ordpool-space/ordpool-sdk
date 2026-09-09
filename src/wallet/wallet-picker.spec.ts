import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWalletType, WindowLike } from './wallet.service.types';
import { WalletCapability, WalletPlatform } from './wallet-capabilities';
import { walletPickerRows } from './wallet-picker';

/** A window with only the named providers injected. */
const windowWith = (...providers: string[]): WindowLike => {
  const win: Record<string, unknown> = {};
  for (const p of providers) {
    if (p === 'unisat') win['unisat'] = { requestAccounts: () => undefined, signPsbt: () => undefined };
    if (p === 'LeatherProvider') win['LeatherProvider'] = { request: () => undefined };
  }
  return win as unknown as WindowLike;
};

const row = (rows: ReturnType<typeof walletPickerRows>, wallet: KnownOrdinalWalletType) =>
  rows.find(r => r.wallet === wallet);

describe('walletPickerRows', () => {
  it('labels a detected wallet Connect and an undetected one Install', () => {
    const rows = walletPickerRows({ win: windowWith('unisat'), platform: WalletPlatform.Desktop });

    expect(row(rows, KnownOrdinalWalletType.unisat)?.actionLabel).toBe('Connect');
    expect(row(rows, KnownOrdinalWalletType.unisat)?.action).toBe('connect');
    expect(row(rows, KnownOrdinalWalletType.unisat)?.installed).toBe(true);

    expect(row(rows, KnownOrdinalWalletType.leather)?.actionLabel).toBe('Install');
    expect(row(rows, KnownOrdinalWalletType.leather)?.action).toBe('install');
    expect(row(rows, KnownOrdinalWalletType.leather)?.installed).toBe(false);
    expect(row(rows, KnownOrdinalWalletType.leather)?.installUrl).toBe('https://leather.io/');
  });

  it('never labels a button Download or Get wallet', () => {
    const labels = walletPickerRows({ platform: WalletPlatform.Desktop }).map(r => r.actionLabel);
    expect(labels).not.toContain('Download');
    expect(labels).not.toContain('Get wallet');
  });

  it('offers the watch-only row as Connect (xpub), with nothing to install', () => {
    const xpub = row(walletPickerRows({ platform: WalletPlatform.Desktop }), KnownOrdinalWalletType.xpub);
    expect(xpub?.action).toBe('connect-xpub');
    expect(xpub?.actionLabel).toBe('Connect (xpub)');
    expect(xpub?.installUrl).toBeUndefined();
  });

  it('sends a mobile user into the wallet browser instead of an install page', () => {
    const rows = walletPickerRows({
      platform: WalletPlatform.Mobile,
      currentUrl: 'https://cat21.space/cat/42',
    });
    const xverse = row(rows, KnownOrdinalWalletType.xverse);

    expect(xverse?.action).toBe('open-in-app');
    expect(xverse?.actionLabel).toBe('Open in Xverse');
    // Unencoded on purpose: Xverse's own docs show `url=www.gamma.io`.
    expect(xverse?.deepLink).toBe('https://connect.xverse.app/browser?url=https://cat21.space/cat/42');
  });

  it('hides a wallet unreachable on this platform rather than badging it', () => {
    const desktop = walletPickerRows({ platform: WalletPlatform.Desktop }).map(r => r.wallet);
    const mobile = walletPickerRows({ platform: WalletPlatform.Mobile }).map(r => r.wallet);

    expect(desktop).not.toContain(KnownOrdinalWalletType.phantom);
    expect(mobile).toContain(KnownOrdinalWalletType.phantom);
    expect(mobile).not.toContain(KnownOrdinalWalletType.leather);
  });

  it('drops wallets that cannot do the action when the picker serves one action', () => {
    const selling = walletPickerRows({
      platform: WalletPlatform.Desktop,
      capability: WalletCapability.Cat21OfferCreate,
    }).map(r => r.wallet);

    expect(selling).not.toContain(KnownOrdinalWalletType.alby);
    expect(selling).toContain(KnownOrdinalWalletType.xverse);
  });

  it('carries exactly logo, name and one button per row', () => {
    const rows = walletPickerRows({ win: windowWith('LeatherProvider'), platform: WalletPlatform.Desktop });
    for (const r of rows) {
      expect(r.logo.startsWith('data:image/svg+xml;base64,')).toBe(true);
      expect(r.label.length).toBeGreaterThan(0);
      expect(['Connect', 'Install', 'Connect (xpub)']).toContain(
        r.actionLabel.startsWith('Open in ') ? 'Connect' : r.actionLabel,
      );
    }
  });
});
