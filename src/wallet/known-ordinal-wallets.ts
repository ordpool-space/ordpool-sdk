/**
 * The wallet registry: label, logo and download link per known wallet.
 *
 * Separated from `wallet.service.types` because it embeds the logo data URIs,
 * roughly 36 kB of base64. While it lived beside the types, importing the
 * `KnownOrdinalWalletType` enum as a VALUE pulled the whole registry in with
 * it, so modules that only decide a sequence number or simulate a fee shipped
 * every wallet icon. `cat21-protocol` measured 39.6 kB, of which 36 kB was
 * logos.
 *
 * Keep it that way: types and enums here stay free of payload.
 */
import { KnownOrdinalWallet, KnownOrdinalWalletType } from './wallet.service.types.js';
import { walletLogos } from './wallet-logos.js';

export const KnownOrdinalWallets: { [K in KnownOrdinalWalletType]: KnownOrdinalWallet } = {
  [KnownOrdinalWalletType.xverse]: {
    type: KnownOrdinalWalletType.xverse,
    label: 'Xverse',
    logo: walletLogos.xverse,
    downloadLink: 'https://www.xverse.app/download'
  },
  [KnownOrdinalWalletType.leather]: {
    type: KnownOrdinalWalletType.leather,
    label: 'Leather',
    logo: walletLogos.leather,
    // Was /install-extension, but that path now 404s — Leather archived it
    // (leather.io/install redirects to /old-page/install-extension).
    // Homepage is the stable CTA.
    downloadLink: 'https://leather.io/'
  },
  [KnownOrdinalWalletType.unisat]: {
    type: KnownOrdinalWalletType.unisat,
    label: 'UniSat',
    // subLabel: '(not fully supported)',
    logo: walletLogos.unisat,
    downloadLink: 'https://unisat.io/download'
  },
  [KnownOrdinalWalletType.wizz]: {
    type: KnownOrdinalWalletType.wizz,
    label: 'Wizz',
    logo: walletLogos.wizz,
    downloadLink: 'https://wizzwallet.io/',
  },
  [KnownOrdinalWalletType.okx]: {
    type: KnownOrdinalWalletType.okx,
    label: 'OKX',
    logo: walletLogos.okx,
    downloadLink: 'https://web3.okx.com/download',
  },
  [KnownOrdinalWalletType.phantom]: {
    type: KnownOrdinalWalletType.phantom,
    label: 'Phantom',
    logo: walletLogos.phantom,
    downloadLink: 'https://phantom.com/download',
    // Phantom v26.14.0+ ships `btc.js` as an inpage script but never
    // registers it as a content script, AND the SW rejects
    // `btc_requestAccounts` with "isn't implemented". Positively
    // pinned by phantom-mint-connect-blocked.spec.ts +
    // phantom-inscribe-connect-blocked.spec.ts +
    // phantom-sdk-handshake.spec.ts:370-476. Hidden until Phantom
    // wires the SW handlers.
  },
  [KnownOrdinalWalletType.alby]: {
    type: KnownOrdinalWalletType.alby,
    label: 'Alby',
    logo: walletLogos.alby,
    downloadLink: 'https://getalby.com/',
  },
  [KnownOrdinalWalletType.binance]: {
    type: KnownOrdinalWalletType.binance,
    label: 'Binance Web3 Wallet',
    logo: walletLogos.binance,
    downloadLink: 'https://www.binance.com/en/web3wallet',
    // Binance Web3 Wallet v1.17.2 (disassembled 2026-06-12) injects
    // only window.binancew3w.{wallet, ethereum, solana, tron, sui,
    // tonconnect} — the documented .bitcoin sub-provider that our
    // connector + signer target isn't wired. Detection returns false
    // on real installs; this wallet's connector + signer + registry
    // entry all ship (per the "ship every signer" HARD RULE) but the
    // wallet is hidden from consumer pickers until Binance enables
    // the documented surface. See honest-wallet-coverage.spec.ts's
    // WALLETS_WITHOUT_PIPELINE_B carve-out for the full trail.
  },
  [KnownOrdinalWalletType.cat21wallet]: {
    type: KnownOrdinalWalletType.cat21wallet,
    label: 'CAT-21 wallet',
    subLabel: 'Our own hot wallet for active cat trading.',
    logo: walletLogos.cat21wallet,
    downloadLink: 'https://github.com/ordpool-space/cat21-wallet',
  },
  [KnownOrdinalWalletType.xpub]: {
    type: KnownOrdinalWalletType.xpub,
    label: 'Watch-only (xpub)',
    subLabel: 'Sparrow, Coldcard, Ledger, …',
    logo: walletLogos.xpub,
    downloadLink: '',
  },
};
