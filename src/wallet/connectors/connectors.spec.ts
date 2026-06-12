import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWallets } from '../wallet.service.types';
import { detectInstalledWallets, walletConnectors } from './index';


describe('walletConnectors registry', () => {

  it('lists Xverse, Leather, Unisat, Wizz, OKX, Phantom, Oyl, Alby, Binance in detection order', () => {
    expect(walletConnectors.map(c => c.providerId)).toEqual(['xverse', 'leather', 'unisat', 'wizz', 'okx', 'phantom', 'oyl', 'alby', 'binance']);
  });

  it('marks every wallet as signing-supported at the SDK level (runtime detect-by-signature gates surface visibility — see CLAUDE.md "Ship every signer we have code for")', () => {
    expect(walletConnectors.every(c => c.signingSupported)).toBe(true);
  });
});


describe('detectInstalledWallets', () => {

  it('returns all nine as not-installed when window is undefined', () => {
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
      KnownOrdinalWallets.binance,
    ]);
  });

  it('returns all nine as installed when every extension is present', () => {
    const win = { XverseProviders: {}, LeatherProvider: {}, unisat: {}, wizz: {}, okxwallet: { bitcoin: {} }, phantom: { bitcoin: {} }, oyl: {}, alby: {}, binancew3w: { bitcoin: {} } };
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
      KnownOrdinalWallets.binance,
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
      KnownOrdinalWallets.binance,
    ]);
  });

  it('keeps a stable detection order matching walletConnectors', () => {
    const { installedWallets } = detectInstalledWallets({ unisat: {}, LeatherProvider: {}, XverseProviders: {}, wizz: {}, okxwallet: { bitcoin: {} }, phantom: { bitcoin: {} }, oyl: {}, alby: {}, binancew3w: { bitcoin: {} } });
    expect(installedWallets.map(w => w.label)).toEqual([
      KnownOrdinalWallets.xverse.label,
      KnownOrdinalWallets.leather.label,
      KnownOrdinalWallets.unisat.label,
      KnownOrdinalWallets.wizz.label,
      KnownOrdinalWallets.okx.label,
      KnownOrdinalWallets.phantom.label,
      KnownOrdinalWallets.oyl.label,
      KnownOrdinalWallets.alby.label,
      KnownOrdinalWallets.binance.label,
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

  it('requires window.binancew3w.bitcoin (the BTC sub-provider) — bare binancew3w without it is NOT considered installed', () => {
    // Binance Web3 Wallet is multi-chain (wallet / ethereum / solana
    // / tron / sui / tonconnect on current v1.17.2 binaries). The
    // documented .bitcoin sub-provider isn't injected yet; this
    // assertion captures the "ready when Binance exposes it" state.
    const { installedWallets: notForBtc } = detectInstalledWallets({ binancew3w: {} });
    expect(notForBtc).toEqual([]);
    const { installedWallets: forBtc } = detectInstalledWallets({ binancew3w: { bitcoin: {} } });
    expect(forBtc).toEqual([KnownOrdinalWallets.binance]);
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
