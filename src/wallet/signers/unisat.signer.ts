import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { walletSidePaymentAddress } from '../network-address-shim';
import { broadcastSignedPsbt } from '../psbt-extract';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMessageArgs,
  SignMessageResult,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
import { wrapSignMessage } from './wrap-sign-message';


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
  /**
   * Sign a message under the currently-selected address. `type =
   * 'bip322-simple'` returns a base64 BIP-322 witness (what we
   * want); `'ecdsa'` returns the older Sparrow-format ECDSA sig
   * that verifyListingSignature does NOT accept.
   */
  signMessage(message: string, type?: 'ecdsa' | 'bip322-simple'): Promise<string>;
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
const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    // Wallet-side address for the toSignInputs address filter.
    // On regtest, the app carries bcrt; Unisat's mainnet wallet
    // refuses those. Shim rewrites to the equivalent bc1q/bc1p.
    const walletAddress = walletSidePaymentAddress(
      KnownOrdinalWalletType.unisat,
      input.paymentAddress,
      input.paymentPublicKey,
    );
    const toSignInputs: UnisatToSignInput[] = [
      { index: 0, address: walletAddress },
    ];

    return from(unisat.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;

    const targets = resolveSigningTargets(input);
    const toSignInputs: UnisatToSignInput[] = [];
    for (const t of targets) {
      const addr = walletSidePaymentAddress(KnownOrdinalWalletType.unisat, t.address, t.publicKey ?? input.paymentPublicKey);
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: addr, sighashTypes: [t.sigHash] });
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
      const addr = walletSidePaymentAddress(KnownOrdinalWalletType.unisat, t.address, t.publicKey ?? input.paymentPublicKey);
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: addr, sighashTypes: [t.sigHash] });
      }
    }

    return from(unisat.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};

/**
 * BIP-322 message signing via `window.unisat.signMessage(msg,
 * 'bip322-simple')`. Signs under the currently-selected address —
 * Unisat's single-address model means the ordinals and payment
 * addresses are the same key, so callers pass either and get the
 * same signature. Returns the base64 BIP-322 witness directly (no
 * envelope).
 */
export const unisatSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.unisat,
  ...operationNamedDefaults(legacy),
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> => {
    const unisat = (window as unknown as { unisat: UnisatRpc }).unisat;
    return wrapSignMessage(() => unisat.signMessage(input.message, 'bip322-simple'));
  },
};
