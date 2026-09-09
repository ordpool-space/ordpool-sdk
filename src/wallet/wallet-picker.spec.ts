import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWalletType, WindowLike } from './wallet.service.types';
import { WalletCapability, WalletPlatform } from './wallet-capabilities';
import { detectWalletPlatform, walletPickerRows } from './wallet-picker';

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

  it('never lets one button be wider than the rest by repeating the row name', () => {
    const rows = walletPickerRows({ platform: WalletPlatform.Desktop });
    for (const r of rows) {
      const rowName = r.label.toLowerCase();
      const buttonExtras = r.actionLabel.toLowerCase().replace(/^(connect|install|open in )/, '');
      if (buttonExtras.trim()) {
        expect(rowName).not.toContain(buttonExtras.trim());
      }
    }
  });

  it('offers the watch-only row as a plain Connect, with nothing to install', () => {
    const xpub = row(walletPickerRows({ platform: WalletPlatform.Desktop }), KnownOrdinalWalletType.xpub);
    expect(xpub?.action).toBe('connect-xpub');
    // The row name carries "(xpub)"; the button repeating it made this the
    // widest button in the list and wrapped the name to three lines at 390.
    expect(xpub?.actionLabel).toBe('Connect');
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
      expect(['Connect', 'Install']).toContain(
        r.actionLabel.startsWith('Open in ') ? 'Connect' : r.actionLabel,
      );
    }
  });
});

describe('detectWalletPlatform', () => {
  const withUserAgent = (userAgent: string, maxTouchPoints = 0): WindowLike =>
    ({ navigator: { userAgent, maxTouchPoints } }) as unknown as WindowLike;

  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', WalletPlatform.Mobile],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', WalletPlatform.Mobile],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120', WalletPlatform.Desktop],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', WalletPlatform.Desktop],
  ])('reads %s as %s', (userAgent, expected) => {
    expect(detectWalletPlatform(withUserAgent(userAgent))).toBe(expected);
  });

  it('reads an iPad as mobile despite its desktop user agent', () => {
    const iPad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
    expect(detectWalletPlatform(withUserAgent(iPad, 5))).toBe(WalletPlatform.Mobile);
    expect(detectWalletPlatform(withUserAgent(iPad, 0))).toBe(WalletPlatform.Desktop);
  });

  it('answers Desktop when it cannot tell, so nobody is sent to an in-app browser they have no way to open', () => {
    expect(detectWalletPlatform(undefined)).toBe(WalletPlatform.Desktop);
    expect(detectWalletPlatform({} as WindowLike)).toBe(WalletPlatform.Desktop);
  });

  it('does not change the wallets on offer when a desktop window is narrow', () => {
    // The viewport is not an input here; a resized desktop keeps its extensions.
    const desktop = withUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120');
    expect(walletPickerRows({ win: desktop }).map(r => r.wallet))
      .toEqual(walletPickerRows({ win: desktop, platform: WalletPlatform.Desktop }).map(r => r.wallet));
  });

  it('picker rows follow the detected platform without the caller passing one', () => {
    const phone = withUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(walletPickerRows({ win: phone }).map(r => r.wallet))
      .toContain(KnownOrdinalWalletType.phantom);
    expect(walletPickerRows({ win: phone }).map(r => r.wallet))
      .not.toContain(KnownOrdinalWalletType.leather);
  });
});
