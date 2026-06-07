import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWallets } from '../wallet.service.types';
import { detectInstalledWallets, walletConnectors } from './index';


describe('walletConnectors registry', () => {

  it('lists Xverse, Leather, Unisat, Wizz, OKX, Phantom, Oyl, Alby in detection order', () => {
    expect(walletConnectors.map(c => c.providerId)).toEqual(['xverse', 'leather', 'unisat', 'wizz', 'okx', 'phantom', 'oyl', 'alby']);
  });

  it('marks seven wallets as signing-supported at the SDK level — Phantom is signingSupported:false (Help Center: "does not support connecting to dApps on Bitcoin")', () => {
    const signingFlags = Object.fromEntries(
      walletConnectors.map(c => [c.providerId, c.signingSupported]),
    );
    expect(signingFlags).toEqual({
      xverse:  true,
      leather: true,
      unisat:  true,
      wizz:    true,
      okx:     true,
      phantom: false,
      oyl:     true,
      alby:    true,
    });
  });
});


describe('detectInstalledWallets', () => {

  it('returns all eight as not-installed when window is undefined', () => {
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(undefined);
    expect(installedWallets).toEqual([]);
    expect(notInstalledWallets).toEqual([
      KnownOrdinalWallets.xverse,
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.unisat,
      KnownOrdinalWallets.wizz,
      KnownOrdinalWallets.okx,
      KnownOrdinalWallets.phantom,
      KnownOrdinalWallets.oyl,
      KnownOrdinalWallets.alby,
    ]);
  });

  it('returns all eight as installed when every extension is present', () => {
    const win = { XverseProviders: {}, LeatherProvider: {}, unisat: {}, wizz: {}, okxwallet: { bitcoin: {} }, phantom: { bitcoin: {} }, oyl: {}, alby: {} };
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([
      KnownOrdinalWallets.xverse,
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.unisat,
      KnownOrdinalWallets.wizz,
      KnownOrdinalWallets.okx,
      KnownOrdinalWallets.phantom,
      KnownOrdinalWallets.oyl,
      KnownOrdinalWallets.alby,
    ]);
    expect(notInstalledWallets).toEqual([]);
  });

  it('partitions correctly when only some are installed', () => {
    const win = { XverseProviders: {}, unisat: {} };
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([KnownOrdinalWallets.xverse, KnownOrdinalWallets.unisat]);
    expect(notInstalledWallets).toEqual([
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.wizz,
      KnownOrdinalWallets.okx,
      KnownOrdinalWallets.phantom,
      KnownOrdinalWallets.oyl,
      KnownOrdinalWallets.alby,
    ]);
  });

  it('keeps a stable detection order matching walletConnectors', () => {
    const { installedWallets } = detectInstalledWallets({ unisat: {}, LeatherProvider: {}, XverseProviders: {}, wizz: {}, okxwallet: { bitcoin: {} }, phantom: { bitcoin: {} }, oyl: {}, alby: {} });
    expect(installedWallets.map(w => w.label)).toEqual([
      KnownOrdinalWallets.xverse.label,
      KnownOrdinalWallets.leather.label,
      KnownOrdinalWallets.unisat.label,
      KnownOrdinalWallets.wizz.label,
      KnownOrdinalWallets.okx.label,
      KnownOrdinalWallets.phantom.label,
      KnownOrdinalWallets.oyl.label,
      KnownOrdinalWallets.alby.label,
    ]);
  });

  it('detects Alby via the standard window.webln binding (used by other Lightning wallets too)', () => {
    const { installedWallets } = detectInstalledWallets({ webln: {} });
    expect(installedWallets).toEqual([KnownOrdinalWallets.alby]);
  });

  it('requires window.phantom.bitcoin (BTC sub-provider) — bare phantom without it is NOT considered installed', () => {
    const { installedWallets: notForBtc } = detectInstalledWallets({ phantom: {} });
    expect(notForBtc).toEqual([]);
    const { installedWallets: forBtc } = detectInstalledWallets({ phantom: { bitcoin: {} } });
    expect(forBtc).toEqual([KnownOrdinalWallets.phantom]);
  });

  it('detects Wizz via the legacy window.atom binding (formerly Atom Wallet)', () => {
    const { installedWallets } = detectInstalledWallets({ atom: {} });
    expect(installedWallets).toEqual([KnownOrdinalWallets.wizz]);
  });

  it('requires window.okxwallet.bitcoin (the BTC sub-provider) — bare okxwallet without it is NOT considered installed', () => {
    // OKX is multi-chain; users may have it installed but without
    // the BTC plugin enabled. Distinguish from "OKX active for BTC".
    const { installedWallets: notForBtc } = detectInstalledWallets({ okxwallet: {} });
    expect(notForBtc).toEqual([]);
    const { installedWallets: forBtc } = detectInstalledWallets({ okxwallet: { bitcoin: {} } });
    expect(forBtc).toEqual([KnownOrdinalWallets.okx]);
  });

  it('accepts the legacy HiroWalletProvider global for Leather detection', () => {
    // Older Leather/Hiro versions only expose `HiroWalletProvider`.
    // We accept that as a fallback so existing users aren't stranded.
    const { installedWallets } = detectInstalledWallets({ HiroWalletProvider: {} });
    expect(installedWallets).toEqual([KnownOrdinalWallets.leather]);
  });

  it('walks a caller-supplied connector list (for tests with stub rosters)', () => {
    const stubConnectors = [walletConnectors[0]]; // Xverse only
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(
      { XverseProviders: {} },
      stubConnectors,
    );
    expect(installedWallets).toEqual([KnownOrdinalWallets.xverse]);
    expect(notInstalledWallets).toEqual([]);
  });
});
