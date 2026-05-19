import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWallets } from '../wallet.service.types';
import { detectInstalledWallets, walletConnectors } from './index';


describe('walletConnectors registry', () => {

  it('lists Xverse, Leather, Unisat in detection order', () => {
    expect(walletConnectors.map(c => c.providerId)).toEqual(['xverse', 'leather', 'unisat']);
  });

  it('marks all three as signing-supported (matching signer exists today)', () => {
    expect(walletConnectors.every(c => c.signingSupported)).toBe(true);
  });
});


describe('detectInstalledWallets', () => {

  it('returns all three as not-installed when window is undefined', () => {
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(undefined);
    expect(installedWallets).toEqual([]);
    expect(notInstalledWallets).toEqual([
      KnownOrdinalWallets.xverse,
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.unisat,
    ]);
  });

  it('returns all three as installed when every extension is present', () => {
    const win = { XverseProviders: {}, LeatherProvider: {}, unisat: {} };
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([
      KnownOrdinalWallets.xverse,
      KnownOrdinalWallets.leather,
      KnownOrdinalWallets.unisat,
    ]);
    expect(notInstalledWallets).toEqual([]);
  });

  it('partitions correctly when only some are installed', () => {
    const win = { XverseProviders: {}, unisat: {} }; // Leather missing
    const { installedWallets, notInstalledWallets } = detectInstalledWallets(win);
    expect(installedWallets).toEqual([KnownOrdinalWallets.xverse, KnownOrdinalWallets.unisat]);
    expect(notInstalledWallets).toEqual([KnownOrdinalWallets.leather]);
  });

  it('keeps a stable detection order matching walletConnectors', () => {
    const { installedWallets } = detectInstalledWallets({ unisat: {}, LeatherProvider: {}, XverseProviders: {} });
    expect(installedWallets.map(w => w.label)).toEqual([
      KnownOrdinalWallets.xverse.label,
      KnownOrdinalWallets.leather.label,
      KnownOrdinalWallets.unisat.label,
    ]);
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
