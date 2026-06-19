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


interface UnisatToSignInput {
  index: number;
  address?: string;
  sighashTypes?: number[];
}

interface UnisatRpc {
  signPsbt(
    psbtHex: string,
    options?: { autoFinalized?: boolean; toSignInputs?: UnisatToSignInput[] }
  ): Promise<string>;
}


/**
 * Unisat — `window.unisat.signPsbt(hex, {autoFinalized: false})`.
 *
 * Per the SDK-wide "WE broadcast" convention (see
 * `/Work/ordpool/WALLETS.md`): the wallet signs and hands back a
 * partial-sig PSBT; the SDK finalises and broadcasts via the
 * caller-supplied `input.broadcast` callback. We deliberately
 * SKIP `window.unisat.pushPsbt` — that would route to Unisat's
 * vendor backend (api.unisat.io), which takes broadcast-endpoint
 * choice away from the SDK and breaks regtest / Mara / accelerator
 * scenarios.
 *
 * Multi-input signing: Unisat's signPsbt accepts an optional
 * `toSignInputs: [{index, address, sighashTypes}]` list. The multi
 * method projects `signingMap` onto it so the wallet only signs the
 * inputs we asked for (important for buy-offer flows where the
 * buyer must NOT sign input 0, the seller's cat UTXO). Without
 * `toSignInputs`, Unisat tries to sign every input whose UTXO data
 * it owns — fine for mint, breaks offer-create.
 *
 * Caveat (CLAUDE.md): Unisat uses one address for both payments and
 * ordinals — easy to spend cat sats by accident. Mint flow surfaces
 * this in UI text. The signer itself can't help that.
 */
export const unisatSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.unisat,

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    return from(unisat.signPsbt(psbtHex, { autoFinalized: false })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    const targets = resolveSigningTargets(input);
    const toSignInputs: UnisatToSignInput[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }

    return from(unisat.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const psbtHex = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    const targets = resolveSigningTargets(input);
    const toSignInputs: UnisatToSignInput[] = [];
    for (const t of targets) {
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }

    return from(unisat.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};
