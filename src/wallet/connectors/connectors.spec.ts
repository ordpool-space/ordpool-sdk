import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWallets } from '../wallet.service.types';
import { detectInstalledWallets, walletConnectors } from './index';


describe('walletConnectors registry', () => {

  it('lists Cat21 Wallet first (our own wallet), then Xverse + the rest in detection order', () => {
    expect(walletConnectors.map(c => c.providerId)).toEqual(['cat21wallet', 'xverse', 'leather', 'unisat', 'wizz', 'okx', 'phantom', 'oyl', 'alby', 'binance']);
  });

  it('marks every wallet as signing-supported at the SDK level (runtime detect-by-signature gates surface visibility — see CLAUDE.md "Ship every signer we have code for")', () => {
    expect(walletConnectors.every(c => c.signingSupported)).toBe(true);
  });
});


describe('detectInstalledWallets', () => {

  it('returns all ten as not-installed when window is undefined', () => {
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(undefined);
    expect(installedWallets).toEqual([]);
    expect(notInstalledWallets).toEqual([
      KnownOrdinalWallets.cat21wallet,
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

  it('returns all ten as installed when every extension is present', () => {
    const win = { Cat21Provider: { isCat21: true }, XverseProviders: {}, LeatherProvider: {}, unisat: {}, wizz: {}, okxwallet: { bitcoin: {} }, phantom: { bitcoin: {} }, oyl: {}, alby: {}, binancew3w: { bitcoin: {} } };
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([
      KnownOrdinalWallets.cat21wallet,
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
      KnownOrdinalWallets.cat21wallet,
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
    const { installedWallets } = detectInstalledWallets({ unisat: {}, LeatherProvider: {}, XverseProviders: {}, wizz: {}, okxwallet: { bitcoin: {} }, phantom: { bitcoin: {} }, oyl: {}, alby: {}, binancew3w: { bitcoin: {} }, Cat21Provider: { isCat21: true } });
    expect(installedWallets.map(w => w.label)).toEqual([
      KnownOrdinalWallets.cat21wallet.label,
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

  it('detects Cat21 Wallet via window.Cat21Provider.isCat21', () => {
    const { installedWallets } = detectInstalledWallets({ Cat21Provider: { isCat21: true } });
    expect(installedWallets).toEqual([KnownOrdinalWallets.cat21wallet]);
  });

  it('detects Cat21 Wallet via the WBIP004 btc_providers array (works when window.Cat21Provider was overwritten by another extension racing to inject)', () => {
    const { installedWallets } = detectInstalledWallets({ btc_providers: [{ id: 'Cat21Provider', name: 'Cat21 Wallet' }] });
    expect(installedWallets).toEqual([KnownOrdinalWallets.cat21wallet]);
  });

  it('rejects window.Cat21Provider without isCat21 (an unrelated extension squatted the slot — without the marker we must not trust it)', () => {
    const { installedWallets } = detectInstalledWallets({ Cat21Provider: {} });
    expect(installedWallets).toEqual([]);
  });

  it('shows Cat21 Wallet via the canonical Cat21Provider slot even when the wallet has ALSO politely backfilled LeatherProvider (no real Leather installed) — never doubled up', () => {
    // Cat21 Wallet always populates window.Cat21Provider AND
    // backfills window.LeatherProvider when real Leather isn't
    // installed (politeness model). The backfilled LeatherProvider
    // carries isCat21:true; isLeatherInstalled filters those out so
    // we never surface Cat21 Wallet twice in the picker.
    const provider = { isCat21: true, isLeather: true };
    const { installedWallets } = detectInstalledWallets({
      Cat21Provider: provider,
      LeatherProvider: provider,
    });
    expect(installedWallets).toEqual([KnownOrdinalWallets.cat21wallet]);
  });

  it('shows BOTH Cat21 Wallet and real Leather when both are co-installed (real Leather keeps its LeatherProvider slot per the politeness model)', () => {
    const { installedWallets } = detectInstalledWallets({
      Cat21Provider: { isCat21: true, isLeather: true },
      // Real Leather — no isCat21 marker.
      LeatherProvider: {},
    });
    expect(installedWallets).toEqual([
      KnownOrdinalWallets.cat21wallet,
      KnownOrdinalWallets.leather,
    ]);
  });

  it('walks a caller-supplied connector list (for tests with stub rosters)', () => {
    // Pick Xverse explicitly so the test is stable even when the
    // roster head changes (Cat21 Wallet leads as of iter 119).
    const stubConnectors = walletConnectors.filter(c => c.providerId === 'xverse');
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(
      { XverseProviders: {} },
      stubConnectors,
    );
    expect(installedWallets).toEqual([KnownOrdinalWallets.xverse]);
    expect(notInstalledWallets).toEqual([]);
  });
});
