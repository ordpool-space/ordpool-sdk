import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { resolveSigningTargets } from './signing-targets.helper';


interface WizzToSignInput {
  index: number;
  address?: string;
  sighashTypes?: number[];
}

interface WizzRpc {
  signPsbt(
    psbtHex: string,
    options?: { autoFinalized?: boolean; toSignInputs?: WizzToSignInput[] }
  ): Promise<string>;
}


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
export const wizzSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.wizz,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex: string = hex.encode(input.psbtBytes);
    const wizz = (window as unknown as { wizz: WizzRpc }).wizz;

    return from(wizz.signPsbt(psbtHex, { autoFinalized: false })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const wizz = (window as unknown as { wizz: WizzRpc }).wizz;

    const targets = resolveSigningTargets(input);
    const toSignInputs: WizzToSignInput[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }

    return from(wizz.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const psbtHex = hex.encode(input.psbtBytes);
    const wizz = (window as unknown as { wizz: WizzRpc }).wizz;
    const targets = resolveSigningTargets(input);
    const toSignInputs: WizzToSignInput[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }
    return from(wizz.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};
