"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnownOrdinalWallets = exports.KnownOrdinalWalletType = void 0;
var KnownOrdinalWalletType;
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
})(KnownOrdinalWalletType || (exports.KnownOrdinalWalletType = KnownOrdinalWalletType = {}));
const wallet_logos_1 = require("./wallet-logos");
exports.KnownOrdinalWallets = {
    [KnownOrdinalWalletType.xverse]: {
        type: KnownOrdinalWalletType.xverse,
        label: 'Xverse',
        logo: wallet_logos_1.walletLogos.xverse,
        downloadLink: 'https://www.xverse.app/download'
    },
    [KnownOrdinalWalletType.leather]: {
        type: KnownOrdinalWalletType.leather,
        label: 'Leather',
        logo: wallet_logos_1.walletLogos.leather,
        // Was /install-extension, but that path now 404s — Leather archived it
        // (leather.io/install redirects to /old-page/install-extension).
        // Homepage is the stable CTA.
        downloadLink: 'https://leather.io/'
    },
    [KnownOrdinalWalletType.unisat]: {
        type: KnownOrdinalWalletType.unisat,
        label: 'Unisat',
        // subLabel: '(not fully supported)',
        logo: wallet_logos_1.walletLogos.unisat,
        downloadLink: 'https://unisat.io/download'
    },
    [KnownOrdinalWalletType.wizz]: {
        type: KnownOrdinalWalletType.wizz,
        label: 'Wizz',
        logo: wallet_logos_1.walletLogos.wizz,
        downloadLink: 'https://wizzwallet.io/',
    },
    [KnownOrdinalWalletType.okx]: {
        type: KnownOrdinalWalletType.okx,
        label: 'OKX',
        logo: wallet_logos_1.walletLogos.okx,
        downloadLink: 'https://web3.okx.com/download',
    },
    [KnownOrdinalWalletType.phantom]: {
        type: KnownOrdinalWalletType.phantom,
        label: 'Phantom',
        logo: wallet_logos_1.walletLogos.phantom,
        downloadLink: 'https://phantom.com/download',
    },
    [KnownOrdinalWalletType.oyl]: {
        type: KnownOrdinalWalletType.oyl,
        label: 'Oyl',
        logo: wallet_logos_1.walletLogos.oyl,
        downloadLink: 'https://oyl.io/',
    },
    [KnownOrdinalWalletType.alby]: {
        type: KnownOrdinalWalletType.alby,
        label: 'Alby',
        subLabel: 'Lightning + Nostr (not on-chain ordinals)',
        logo: wallet_logos_1.walletLogos.alby,
        downloadLink: 'https://getalby.com/',
        onChainOrdinals: false,
    },
    [KnownOrdinalWalletType.binance]: {
        type: KnownOrdinalWalletType.binance,
        label: 'Binance Wallet',
        subLabel: 'API documented but not exposed in v1.17.2 — surfaces only if Binance enables it',
        logo: wallet_logos_1.walletLogos.binance,
        downloadLink: 'https://www.binance.com/en/web3wallet',
    },
    [KnownOrdinalWalletType.cat21wallet]: {
        type: KnownOrdinalWalletType.cat21wallet,
        label: 'CAT-21 wallet',
        subLabel: 'Our own — hot wallet for active cat trading. BTC L1 mainnet.',
        logo: wallet_logos_1.walletLogos.cat21wallet,
        downloadLink: 'https://github.com/ordpool-space/cat21-wallet',
    },
    [KnownOrdinalWalletType.xpub]: {
        type: KnownOrdinalWalletType.xpub,
        label: 'Watch-only (xpub)',
        subLabel: 'Sparrow, Electrum, Coldcard, Ledger, Trezor, …',
        logo: wallet_logos_1.walletLogos.xpub,
        downloadLink: '',
    },
};
//# sourceMappingURL=wallet.service.types.js.map