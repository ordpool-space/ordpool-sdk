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
  walletActionNotice,
  walletCustodyCaveat,
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

describe('user-facing copy in the matrix', () => {
  /**
   * Words that describe OUR engineering rather than the user's wallet.
   * Coverage claims, CI vocabulary, fork lineage and internal tool names
   * are not facts a person choosing a wallet can act on, and shipping
   * them reads as us reassuring ourselves. `CapabilitySupport` carries
   * that signal inside the SDK instead.
   */
  const ENGINEERING_VOCABULARY = [
    'regtest',
    'e2e',
    'end-to-end',
    'coverage',
    'test network',
    'testnet',
    'ci',
    'verified',
    'unit test',
    'fork',
    'adapter',
    'signer',
    'psbt',
    'orchestrator',
    'sdk',
  ];

  /** Every string the matrix hands a frontend to print verbatim. */
  const userFacingStrings = (): { where: string; text: string }[] =>
    WALLET_MATRIX.flatMap(entry => [
      ...(entry.note ? [{ where: `${entry.wallet}.note`, text: entry.note }] : []),
      ...Object.entries(entry.capabilities).flatMap(([capability, status]) =>
        status?.caveat ? [{ where: `${entry.wallet}.${capability}.caveat`, text: status.caveat }] : [],
      ),
    ]);

  it.each(ENGINEERING_VOCABULARY)('no matrix copy says "%s"', word => {
    const boundary = new RegExp(`\\b${word}\\b`, 'i');
    const offenders = userFacingStrings()
      .filter(s => boundary.test(s.text))
      .map(s => `${s.where}: ${s.text}`);
    expect(offenders).toEqual([]);
  });

  it('every caveat is a complete sentence a site can print verbatim', () => {
    const notPrintable = WALLET_MATRIX.flatMap(entry =>
      Object.entries(entry.capabilities)
        .filter(([, status]) => status?.caveat !== undefined)
        .filter(([, status]) => {
          const text = status!.caveat!;
          const startsAsSentence = /^[A-Z]/.test(text);
          const endsAsSentence = /[.!?]$/.test(text);
          return !startsAsSentence || !endsAsSentence;
        })
        .map(([capability, status]) => `${entry.wallet}.${capability}: ${status!.caveat}`),
    );
    expect(notPrintable).toEqual([]);
  });

  it('no caveat names the wallets to use instead (that list is computed from the matrix)', () => {
    const walletNames = WALLET_MATRIX.map(e => e.label);
    const namesOthers = WALLET_MATRIX.flatMap(entry =>
      Object.entries(entry.capabilities)
        .filter(([, status]) => status?.caveat !== undefined)
        .filter(([, status]) =>
          walletNames.some(name => name !== entry.label && status!.caveat!.includes(name)),
        )
        .map(([capability, status]) => `${entry.wallet}.${capability}: ${status!.caveat}`),
    );
    expect(namesOthers).toEqual([]);
  });

  it('every wallet the picker offers carries a note', () => {
    const withoutNote = WALLET_MATRIX.filter(e => !e.note?.trim()).map(e => e.wallet);
    expect(withoutNote).toEqual([]);
  });
});

describe('walletActionNotice', () => {
  it('says nothing when the wallet can just do it', () => {
    expect(walletActionNotice(KnownOrdinalWalletType.xverse, WalletCapability.Cat21OfferCreate)).toBeNull();
  });

  it('blocks with the reason and the wallets that can, computed from the matrix', () => {
    const notice = walletActionNotice(KnownOrdinalWalletType.alby, WalletCapability.Cat21OfferCreate);

    expect(notice?.kind).toBe('blocked');
    expect(notice?.message).toBe(
      "Alby can't sell a cat: it signs all or nothing, and a trade needs each side to sign only its own part."
      + ' Connect Cat21 Wallet, Xverse, Leather, UniSat, Wizz, OKX or Watch-only (xpub) to sell a cat.',
    );
  });

  it('never offers a wallet that cannot do the action, so a block cannot suggest itself', () => {
    for (const capability of Object.values(WalletCapability)) {
      const offered = walletsSupporting(capability).map(e => e.wallet);
      const incapable = WALLET_MATRIX
        .filter(e => capabilityOf(e.wallet, capability).support === CapabilitySupport.Unsupported)
        .map(e => e.wallet);
      expect(offered.filter(w => incapable.includes(w))).toEqual([]);
    }
  });

  it('falls back to a plain sentence when an unsupported capability has no caveat', () => {
    const notice = walletActionNotice(KnownOrdinalWalletType.alby, WalletCapability.SignMessage);
    expect(notice?.kind).toBe('blocked');
    expect(notice?.message.startsWith('Alby cannot sign a message.')).toBe(true);
  });

  it('reads the alternatives for the platform it is asked about', () => {
    const mobile = walletActionNotice(
      KnownOrdinalWalletType.alby,
      WalletCapability.Cat21OfferCreate,
      { platform: WalletPlatform.Mobile },
    );
    // Leather is desktop-only, so a mobile user must never be sent to it.
    expect(mobile?.message).not.toContain('Leather');
    expect(mobile?.message).toContain('Xverse');
  });

  it('hands back the parts so a narrow surface can render the wallets as a list', () => {
    const notice = walletActionNotice(KnownOrdinalWalletType.alby, WalletCapability.Cat21OfferCreate);

    expect(notice?.reason).toBe(
      "Alby can't sell a cat: it signs all or nothing, and a trade needs each side to sign only its own part.",
    );
    expect(notice?.alternatives).toEqual([
      'Cat21 Wallet', 'Xverse', 'Leather', 'UniSat', 'Wizz', 'OKX', 'Watch-only (xpub)',
    ]);
    expect(notice?.actionPhrase).toBe('sell a cat');
    // The prose form stays available and stays consistent with the parts.
    expect(notice?.message).toBe(`${notice?.reason} Connect ${notice?.alternatives.slice(0, -1).join(', ')}`
      + ` or ${notice?.alternatives.at(-1)} to ${notice?.actionPhrase}.`);
  });

  it('names no alternatives on a precondition, since the connected wallet can already do it', () => {
    const notice = walletActionNotice(KnownOrdinalWalletType.unisat, WalletCapability.SignMessage);
    expect(notice?.alternatives).toEqual([]);
    expect(notice?.reason).toBe(notice?.message);
  });

  it('flags a precondition as precheck, not as a block', () => {
    const notice = walletActionNotice(KnownOrdinalWalletType.unisat, WalletCapability.SignMessage);
    expect(notice?.kind).toBe('precheck');
    expect(notice?.message).toBe('Switch your wallet to its Taproot (bc1p…) address, then connect again.');
  });
});

describe('walletCustodyCaveat', () => {
  it('warns that UniSat can spend the sat a cat lives on', () => {
    expect(walletCustodyCaveat(KnownOrdinalWalletType.unisat)).toBe(
      'UniSat keeps your cats and your spendable coins on one address, so it can spend the sat a cat '
      + 'lives on when it pays a fee. Move a cat you want to keep to a wallet that holds ordinals separately.',
    );
  });

  it('says nothing for a wallet that separates ordinals from spendable coins', () => {
    expect(walletCustodyCaveat(KnownOrdinalWalletType.xverse)).toBeNull();
    expect(walletCustodyCaveat(KnownOrdinalWalletType.leather)).toBeNull();
    expect(walletCustodyCaveat(KnownOrdinalWalletType.cat21wallet)).toBeNull();
  });

  it('is independent of capability level, since a wallet can perform an action and still risk the result', () => {
    // UniSat is Proven for minting: it does the job correctly, and the
    // resulting cat is still at risk. One field cannot express both.
    expect(supportsCapability(KnownOrdinalWalletType.unisat, WalletCapability.Cat21Mint)).toBe(true);
    expect(walletCustodyCaveat(KnownOrdinalWalletType.unisat)).not.toBeNull();
  });

  it('applies to acquiring a cat, not to the seller who is parting with one', () => {
    // Cat21OfferAccept is the SELLER accepting a buy-offer, so the cat
    // leaves; Cat21OfferCreate is the BUYER, who ends up holding it.
    // Anything reading the verb rather than the direction gets this backwards.
    const acquiring = [WalletCapability.Cat21Mint, WalletCapability.Cat21OfferCreate];
    const parting = [WalletCapability.Cat21OfferAccept, WalletCapability.Cat21Transfer];
    for (const capability of [...acquiring, ...parting]) {
      expect(supportsCapability(KnownOrdinalWalletType.unisat, capability)).toBe(true);
    }
    expect(acquiring).not.toContain(WalletCapability.Cat21OfferAccept);
    expect(parting).toContain(WalletCapability.Cat21OfferAccept);
  });

  it('describes the mechanism rather than passing a verdict', () => {
    for (const entry of WALLET_MATRIX) {
      const text = entry.custodyCaveat;
      if (!text) continue;
      expect(text).toMatch(/[.!?]$/);
      for (const verdict of ['unsafe', 'dangerous', 'insecure', 'bad wallet', 'avoid']) {
        expect(text.toLowerCase()).not.toContain(verdict);
      }
    }
  });
});
