import { from, switchMap } from 'rxjs';
import { broadcastSignedPsbt } from '../psbt-extract';
import { KnownOrdinalWalletType, } from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
/**
 * Phantom — `window.phantom.bitcoin.signPSBT(psbtBytes,
 * {inputsToSign, finalize: false})`.
 *
 * Shape per docs.phantom.com/bitcoin/sending-a-transaction and
 * confirmed by disassembling btc.js v26.14.0: class Lh defines
 * `signPSBT = async (e, t) => (t.finalize = t.finalize ?? false,
 * await this.#s({method:"btc_signPSBT", params:[e, t]}))` at byte
 * ~471900. The "btc_signPSBT" JSON-RPC name is internal to the
 * in-page proxy; the page-level API takes the bytes + opts
 * directly, NOT through a generic `request({method, params})`
 * indirection.
 *
 * **Runtime reality:** the current Phantom desktop extension
 * (v26.14.0 + v26.16.0 confirmed) ships btc.js as dead code —
 * it's in the bundle but never registered as a content script,
 * and the SW lacks `btc_*` handlers. So
 * `window.phantom.bitcoin` doesn't exist on desktop today and
 * this signer can't be called. Pipeline B (e2e) skips with
 * empirical proof of the dormancy; see phantom-sdk-handshake
 * .spec.ts. Per docs, Phantom mobile in-app browser is meant
 * to expose this surface — we'd auto-pick it up there via
 * detect-by-signature with no code change, but we have no
 * device-side test to confirm.
 *
 * This file stays as readable code-as-documentation against
 * the docs page (which itself carries a Wallet-Standard
 * migration banner). If Phantom flips the new surface on with
 * a different shape, expect to rewrite this.
 *
 * Per the SDK-wide "WE broadcast" convention, we pass `finalize:
 * false` and route through the shared broadcastSignedPsbt helper.
 *
 * SIGHASH_ALL = 1.
 */
const legacy = {
    signAndBroadcast(input) {
        const phantomBtc = window.phantom.bitcoin;
        const signPromise = phantomBtc.signPSBT(input.psbtBytes, {
            inputsToSign: [{ address: input.paymentAddress, signingIndexes: [0], sigHash: 0x01 }],
            finalize: false,
        });
        return from(signPromise).pipe(switchMap((signedPsbtBytes) => broadcastSignedPsbt(input, signedPsbtBytes)));
    },
    signMultiInputAndBroadcast(input) {
        const phantomBtc = window.phantom.bitcoin;
        const targets = resolveSigningTargets(input);
        const inputsToSign = targets.map((t) => ({
            address: t.address,
            signingIndexes: t.indexes,
            sigHash: t.sigHash,
        }));
        const signPromise = phantomBtc.signPSBT(input.psbtBytes, { inputsToSign, finalize: false });
        return from(signPromise).pipe(switchMap((signedPsbtBytes) => broadcastSignedPsbt(input, signedPsbtBytes)));
    },
    signPsbtOnly(input) {
        const phantomBtc = window.phantom.bitcoin;
        const targets = resolveSigningTargets(input);
        const inputsToSign = targets.map((t) => ({
            address: t.address,
            signingIndexes: t.indexes,
            sigHash: t.sigHash,
        }));
        return from(phantomBtc.signPSBT(input.psbtBytes, { inputsToSign, finalize: false }));
    },
};
export const phantomSigner = {
    providerId: KnownOrdinalWalletType.phantom,
    ...operationNamedDefaults(legacy),
};
//# sourceMappingURL=phantom.signer.js.map