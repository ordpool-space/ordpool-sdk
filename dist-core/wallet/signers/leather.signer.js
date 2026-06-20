import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { defer, from, map, switchMap } from 'rxjs';
import { toLeatherNetworkString } from '../../network';
import { broadcastSignedPsbt } from '../psbt-extract';
import { KnownOrdinalWalletType, } from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
/**
 * Leather — `window.LeatherProvider.request('signPsbt', …)`.
 *
 * Leather signs and hands the signed PSBT back to us; broadcasting
 * is our job. The signed PSBT is finalised via @scure/btc-signer,
 * then we delegate the broadcast to the caller's `broadcast`
 * callback (which hits electrs `POST /tx` via the configured
 * HttpClient).
 *
 * Namespace: `window.LeatherProvider`, NOT the historical
 * `window.btc`. The `window.btc` global is the old Hiro namespace
 * that other extensions (Unisat in some versions) have aggressively
 * overwritten; users with multiple wallet extensions installed have
 * hit our code routing to the wrong wallet. See the multi-injection
 * section of PLAN-wallet-roster.md.
 *
 * Multi-input signing: Leather's signPsbt takes a single
 * `signAtIndex`. For flows that need multiple inputs signed the
 * multi method iterates the flat index list, threading the
 * partially-signed PSBT hex through each call. Same pattern as
 * cat21-wallet (which is a Leather fork). Each call surfaces a
 * confirmation dialog in the wallet.
 */
function callLeatherSignPsbt(psbtHex, signAtIndex, network) {
    const win = window;
    const params = {
        hex: psbtHex,
        allowedSighash: [btc.SigHash.ALL],
        signAtIndex,
        network,
        broadcast: false,
    };
    return win.LeatherProvider.request('signPsbt', params).then((resp) => resp.result.hex);
}
const legacy = {
    signAndBroadcast(input) {
        const psbtHex = hex.encode(input.psbtBytes);
        const network = toLeatherNetworkString(input.network);
        return defer(() => from(callLeatherSignPsbt(psbtHex, 0, network))).pipe(switchMap((signedHex) => broadcastSignedPsbt(input, hex.decode(signedHex))));
    },
    signMultiInputAndBroadcast(input) {
        const targets = resolveSigningTargets(input);
        const flatIndexes = [];
        for (const t of targets) {
            for (const i of t.indexes)
                flatIndexes.push(i);
        }
        const network = toLeatherNetworkString(input.network);
        return defer(() => {
            let chain = Promise.resolve(hex.encode(input.psbtBytes));
            for (const i of flatIndexes) {
                chain = chain.then((currentHex) => callLeatherSignPsbt(currentHex, i, network));
            }
            return from(chain);
        }).pipe(switchMap((finalHex) => broadcastSignedPsbt(input, hex.decode(finalHex))));
    },
    signPsbtOnly(input) {
        const targets = resolveSigningTargets(input);
        const flatIndexes = [];
        for (const t of targets) {
            for (const i of t.indexes)
                flatIndexes.push(i);
        }
        const network = toLeatherNetworkString(input.network);
        return defer(() => {
            let chain = Promise.resolve(hex.encode(input.psbtBytes));
            for (const i of flatIndexes) {
                chain = chain.then((currentHex) => callLeatherSignPsbt(currentHex, i, network));
            }
            return from(chain);
        }).pipe(map((finalHex) => hex.decode(finalHex)));
    },
};
export const leatherSigner = {
    providerId: KnownOrdinalWalletType.leather,
    ...operationNamedDefaults(legacy),
};
//# sourceMappingURL=leather.signer.js.map