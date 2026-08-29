import { describe, expect, it } from '@jest/globals';

import { KnownOrdinalWalletType, KnownOrdinalWallets } from './wallet.service.types';
import { walletSigners } from './signers';
import {
  WALLET_MATRIX,
  WalletCapability,
  WalletPlatform,
  CapabilitySupport,
  capabilityOf,
  supportsCapability,
  walletsSupporting,
  walletsForPlatform,
  walletMatrixEntry,
} from './wallet-capabilities';

const ids = (entries: readonly { wallet: KnownOrdinalWalletType }[]): KnownOrdinalWalletType[] =>
  entries.map(e => e.wallet).sort();

describe('WALLET_MATRIX / signer registry consistency', () => {
  it('has exactly one matrix row per shipped signer (no drift in either direction)', () => {
    const matrixWallets = WALLET_MATRIX.map(e => e.wallet).sort();
    const signerWallets = walletSigners.map(s => s.providerId).sort();
    expect(matrixWallets).toEqual(signerWallets);
  });

  it('lists all ten wallets exactly once', () => {
    expect(ids(WALLET_MATRIX)).toEqual([
      KnownOrdinalWalletType.alby,
      KnownOrdinalWalletType.binance,
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.leather,
      KnownOrdinalWalletType.okx,
      KnownOrdinalWalletType.phantom,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.wizz,
      KnownOrdinalWalletType.xpub,
      KnownOrdinalWalletType.xverse,
    ]);
  });
});

describe('hiddenFromPicker is consistent with the matrix platforms (single authority)', () => {
  // The matrix `platforms` list is the single source of truth for where a
  // wallet is reachable. `hiddenFromPicker` is only a desktop-detection-
  // bucket convenience (wallet.service.ts filters `wallets$` by it so a
  // desktop-broken binary never surfaces in the "install this" list). The
  // two must never disagree: a wallet is hidden IFF it is not
  // desktop-reachable per the matrix. A mobile-in-app picker reads
  // `walletsForPlatform(Mobile)` and ignores hiddenFromPicker.
  it('a wallet is hiddenFromPicker IFF the matrix says it is not Desktop-reachable', () => {
    for (const entry of WALLET_MATRIX) {
      const hidden = KnownOrdinalWallets[entry.wallet].hiddenFromPicker === true;
      const desktopReachable = entry.platforms.includes(WalletPlatform.Desktop);
      expect(hidden).toBe(!desktopReachable);
    }
  });
});

describe('capabilityOf', () => {
  it('cat21wallet mint is Proven', () => {
    expect(capabilityOf(KnownOrdinalWalletType.cat21wallet, WalletCapability.Cat21Mint).support)
      .toBe(CapabilitySupport.Proven);
  });

  it('OKX parent-child is Proven (regtest child roundtrip signs the reveal parent input)', () => {
    expect(capabilityOf(KnownOrdinalWalletType.okx, WalletCapability.InscriptionParentChild).support)
      .toBe(CapabilitySupport.Proven);
  });

  it('UniSat and Wizz parent-child are Proven but carry the active-Taproot-address caveat', () => {
    for (const w of [KnownOrdinalWalletType.unisat, KnownOrdinalWalletType.wizz]) {
      const status = capabilityOf(w, WalletCapability.InscriptionParentChild);
      expect(status.support).toBe(CapabilitySupport.Proven);
      expect(status.caveat).toMatch(/Taproot/);
    }
  });

  it('is a total function: an unknown wallet resolves to Unsupported', () => {
    expect(capabilityOf('made-up-wallet' as KnownOrdinalWalletType, WalletCapability.Cat21Mint).support)
      .toBe(CapabilitySupport.Unsupported);
  });
});

describe('supportsCapability (platform-aware)', () => {
  it('Phantom mint is false on desktop, true on mobile (desktop provider dormant)', () => {
    expect(supportsCapability(KnownOrdinalWalletType.phantom, WalletCapability.Cat21Mint, WalletPlatform.Desktop))
      .toBe(false);
    expect(supportsCapability(KnownOrdinalWalletType.phantom, WalletCapability.Cat21Mint, WalletPlatform.Mobile))
      .toBe(true);
  });

  it('OKX parent-child is true (proven on regtest)', () => {
    expect(supportsCapability(KnownOrdinalWalletType.okx, WalletCapability.InscriptionParentChild))
      .toBe(true);
    expect(supportsCapability(KnownOrdinalWalletType.okx, WalletCapability.InscriptionParentChild, WalletPlatform.Desktop))
      .toBe(true);
  });

  it('UniSat parent-child is true on desktop', () => {
    expect(supportsCapability(KnownOrdinalWalletType.unisat, WalletCapability.InscriptionParentChild, WalletPlatform.Desktop))
      .toBe(true);
  });
});

describe('walletsSupporting', () => {
  it('parent-child, proven only: cat21wallet, xverse, leather, unisat, wizz, okx, xpub', () => {
    expect(ids(walletsSupporting(WalletCapability.InscriptionParentChild, { minSupport: CapabilitySupport.Proven })))
      .toEqual([
        KnownOrdinalWalletType.cat21wallet,
        KnownOrdinalWalletType.leather,
        KnownOrdinalWalletType.okx,
        KnownOrdinalWalletType.unisat,
        KnownOrdinalWalletType.wizz,
        KnownOrdinalWalletType.xpub,
        KnownOrdinalWalletType.xverse,
      ]);
  });

  it('parent-child, adapter+ (default): all except Alby (the only Unsupported)', () => {
    expect(ids(walletsSupporting(WalletCapability.InscriptionParentChild)))
      .toEqual([
        KnownOrdinalWalletType.binance,
        KnownOrdinalWalletType.cat21wallet,
        KnownOrdinalWalletType.leather,
        KnownOrdinalWalletType.okx,
        KnownOrdinalWalletType.phantom,
        KnownOrdinalWalletType.unisat,
        KnownOrdinalWalletType.wizz,
        KnownOrdinalWalletType.xpub,
        KnownOrdinalWalletType.xverse,
      ]);
  });

  it('parent-child on mobile: xverse, okx, phantom, binance, xpub', () => {
    expect(ids(walletsSupporting(WalletCapability.InscriptionParentChild, { platform: WalletPlatform.Mobile })))
      .toEqual([
        KnownOrdinalWalletType.binance,
        KnownOrdinalWalletType.okx,
        KnownOrdinalWalletType.phantom,
        KnownOrdinalWalletType.xpub,
        KnownOrdinalWalletType.xverse,
      ]);
  });

  it('mint on mobile: xverse, okx, phantom, binance, xpub (the five mobile-reachable wallets)', () => {
    expect(ids(walletsSupporting(WalletCapability.Cat21Mint, { platform: WalletPlatform.Mobile })))
      .toEqual([
        KnownOrdinalWalletType.binance,
        KnownOrdinalWalletType.okx,
        KnownOrdinalWalletType.phantom,
        KnownOrdinalWalletType.xpub,
        KnownOrdinalWalletType.xverse,
      ]);
  });

  it('transfer proven: cat21wallet, xverse, leather, unisat, wizz, okx, xpub (alby transfer unsupported: no per-input signing)', () => {
    expect(ids(walletsSupporting(WalletCapability.Cat21Transfer, { minSupport: CapabilitySupport.Proven })))
      .toEqual([
        KnownOrdinalWalletType.cat21wallet,
        KnownOrdinalWalletType.leather,
        KnownOrdinalWalletType.okx,
        KnownOrdinalWalletType.unisat,
        KnownOrdinalWalletType.wizz,
        KnownOrdinalWalletType.xpub,
        KnownOrdinalWalletType.xverse,
      ]);
  });

  it('offer-accept proven: cat21wallet, leather, unisat, wizz, xverse, okx, xpub (alby offers unsupported)', () => {
    expect(ids(walletsSupporting(WalletCapability.Cat21OfferAccept, { minSupport: CapabilitySupport.Proven })))
      .toEqual([
        KnownOrdinalWalletType.cat21wallet,
        KnownOrdinalWalletType.leather,
        KnownOrdinalWalletType.okx,
        KnownOrdinalWalletType.unisat,
        KnownOrdinalWalletType.wizz,
        KnownOrdinalWalletType.xpub,
        KnownOrdinalWalletType.xverse,
      ]);
  });
});

describe('walletsForPlatform', () => {
  it('desktop: cat21wallet, xverse, leather, unisat, wizz, okx, alby, xpub (Phantom + Binance are mobile-only)', () => {
    expect(ids(walletsForPlatform(WalletPlatform.Desktop))).toEqual([
      KnownOrdinalWalletType.alby,
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.leather,
      KnownOrdinalWalletType.okx,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.wizz,
      KnownOrdinalWalletType.xpub,
      KnownOrdinalWalletType.xverse,
    ]);
  });

  it('mobile: xverse, okx, phantom, binance, xpub', () => {
    expect(ids(walletsForPlatform(WalletPlatform.Mobile))).toEqual([
      KnownOrdinalWalletType.binance,
      KnownOrdinalWalletType.okx,
      KnownOrdinalWalletType.phantom,
      KnownOrdinalWalletType.xpub,
      KnownOrdinalWalletType.xverse,
    ]);
  });
});

describe('watch-only entry', () => {
  it('xpub is signingMode watch-only and reachable on both platforms', () => {
    const entry = walletMatrixEntry(KnownOrdinalWalletType.xpub);
    expect(entry?.signingMode).toBe('watch-only');
    expect([...(entry?.platforms ?? [])].sort()).toEqual([WalletPlatform.Desktop, WalletPlatform.Mobile]);
  });

  it('every injected wallet is signingMode injected', () => {
    const injected = WALLET_MATRIX.filter(e => e.wallet !== KnownOrdinalWalletType.xpub);
    expect(injected.every(e => e.signingMode === 'injected')).toBe(true);
  });
});
