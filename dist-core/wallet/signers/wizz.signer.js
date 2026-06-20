import { hex } from '@scure/base';
import { from, map, switchMap } from 'rxjs';
import { broadcastSignedPsbt } from '../psbt-extract';
import { KnownOrdinalWalletType, } from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
/**
 * Wizz — `window.wizz.signPsbt(hex, {autoFinalized: false})`.
 *
 * Wizz is a fork of Unisat (formerly Atom Wallet) and exposes the
 * same provider contract. Per the SDK-wide "WE broadcast" convention
 * (see `/Work/ordpool/WALLETS.md`): the wallet signs and hands back
 * a partial-sig PSBT; the SDK finalises and broadcasts via the
 * caller-supplied `input.broadcast` callback. We deliberately SKIP
 * `pushPsbt` — that would route to Wizz's vendor backend and take
 * broadcast-endpoint choice away from the SDK.
 *
 * Wizz also injects itself as `window.atom` (legacy Atom Wallet
 * namespace) for backwards compatibility; both bindings reference
 * the same provider via Proxy. Prefer `window.wizz`.
 */
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = hex.encode(input.psbtBytes);
        const wizz = window.wizz;
        return from(wizz.signPsbt(psbtHex, { autoFinalized: false })).pipe(switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))));
    },
    signMultiInputAndBroadcast(input) {
        const psbtHex = hex.encode(input.psbtBytes);
        const wizz = window.wizz;
        const targets = resolveSigningTargets(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return from(wizz.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))));
    },
    signPsbtOnly(input) {
        const psbtHex = hex.encode(input.psbtBytes);
        const wizz = window.wizz;
        const targets = resolveSigningTargets(input);
        const toSignInputs = [];
        for (const t of targets) {
            for (const i of t.indexes) {
                toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
            }
        }
        return from(wizz.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(map((signedPsbtHex) => hex.decode(signedPsbtHex)));
    },
};
export const wizzSigner = {
    providerId: KnownOrdinalWalletType.wizz,
    ...operationNamedDefaults(legacy),
};
//# sourceMappingURL=wizz.signer.js.map