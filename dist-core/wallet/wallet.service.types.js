export var KnownOrdinalWalletType;
(function (KnownOrdinalWalletType) {
    KnownOrdinalWalletType["xverse"] = "xverse";
    KnownOrdinalWalletType["leather"] = "leather";
    KnownOrdinalWalletType["unisat"] = "unisat";
    KnownOrdinalWalletType["wizz"] = "wizz";
    KnownOrdinalWalletType["okx"] = "okx";
    KnownOrdinalWalletType["phantom"] = "phantom";
    KnownOrdinalWalletType["oyl"] = "oyl";
    KnownOrdinalWalletType["alby"] = "alby";
    KnownOrdinalWalletType["binance"] = "binance";
    /**
     * CAT-21 wallet — our own Bitcoin-L1 wallet, forked from Leather.
     * The maintainer ships this one. Provider lives at
     * `window.Cat21Provider` (with `isCat21: true`) per
     * INTEGRATION-ORDPOOL-SDK.md in the cat21-wallet repo. Wire
     * protocol matches Leather's Bitcoin RPC subset
     * (getAddresses / signPsbt / etc.) so the connector + signer
     * shape mirrors Leather's. Stacks methods are stripped.
     */
    KnownOrdinalWalletType["cat21wallet"] = "cat21wallet";
    /**
     * Watch-only via BIP-32 xpub paste. Covers Sparrow, Electrum,
     * Coldcard, Ledger, Trezor, Specter, Bitcoin Core — every desktop
     * or hardware wallet that doesn't inject into the browser but
     * speaks PSBT and exports an xpub.
     */
    KnownOrdinalWalletType["xpub"] = "xpub";
})(KnownOrdinalWalletType || (KnownOrdinalWalletType = {}));
import { walletLogos } from './wallet-logos';
export const KnownOrdinalWallets = {
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
        label: 'Unisat',
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
    },
    [KnownOrdinalWalletType.oyl]: {
        type: KnownOrdinalWalletType.oyl,
        label: 'Oyl',
        logo: walletLogos.oyl,
        downloadLink: 'https://oyl.io/',
    },
    [KnownOrdinalWalletType.alby]: {
        type: KnownOrdinalWalletType.alby,
        label: 'Alby',
        subLabel: 'Lightning + Nostr (not on-chain ordinals)',
        logo: walletLogos.alby,
        downloadLink: 'https://getalby.com/',
        onChainOrdinals: false,
    },
    [KnownOrdinalWalletType.binance]: {
        type: KnownOrdinalWalletType.binance,
        label: 'Binance Wallet',
        subLabel: 'API documented but not exposed in v1.17.2 — surfaces only if Binance enables it',
        logo: walletLogos.binance,
        downloadLink: 'https://www.binance.com/en/web3wallet',
    },
    [KnownOrdinalWalletType.cat21wallet]: {
        type: KnownOrdinalWalletType.cat21wallet,
        label: 'CAT-21 wallet',
        subLabel: 'Our own — hot wallet for active cat trading. BTC L1 mainnet.',
        logo: walletLogos.cat21wallet,
        downloadLink: 'https://github.com/ordpool-space/cat21-wallet',
    },
    [KnownOrdinalWalletType.xpub]: {
        type: KnownOrdinalWalletType.xpub,
        label: 'Watch-only (xpub)',
        subLabel: 'Sparrow, Electrum, Coldcard, Ledger, Trezor, …',
        logo: walletLogos.xpub,
        downloadLink: '',
    },
};
//# sourceMappingURL=wallet.service.types.js.map