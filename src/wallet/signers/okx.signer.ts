import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { walletSidePaymentAddress } from '../network-address-shim';
import { broadcastSignedPsbt } from '../psbt-extract';
import { BIP341_KEYPATH_SIGHASHES, keypathSighashWhitelist } from '../sighash';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignChildRevealParentInputsArgs,
  SignMessageArgs,
  SignMessageResult,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { signChildRevealViaFinalizedForeignInput } from './child-reveal-finalize.helper';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
import { wrapSignMessage } from './wrap-sign-message';


interface OkxToSignInput {
  index: number;
  address?: string;
  sighashTypes?: number[];
}

interface OkxBtcRpc {
  signPsbt(
    psbtHex: string,
    options?: { autoFinalized?: boolean; from?: string; toSignInputs?: OkxToSignInput[] }
  ): Promise<string>;
  /**
   * `signMessage(message, {from, protocol})`. `protocol =
   * 'bip322-simple'` returns a base64 BIP-322 witness. Without
   * `from`, OKX signs under the selected address (usually taproot
   * for ordinals users, but caller passes explicitly to be safe).
   */
  signMessage(
    message: string,
    options?: { from?: string; protocol?: 'ecdsa' | 'bip322-simple' }
  ): Promise<string>;
}


/**
 * OKX — `window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized:
 * false})`.
 *
 * OKX is a multi-chain wallet; the BTC sub-provider lives at
 * `window.okxwallet.bitcoin`. Its signPsbt accepts the same
 * `autoFinalized` option as Unisat (verified by grepping
 * inpage.js v4.1.0). Per the SDK-wide "WE broadcast" convention,
 * we skip OKX's `sendPsbt` and broadcast via the caller-supplied
 * `input.broadcast` callback.
 *
 * Multi-input signing: OKX follows the Unisat-derived
 * `toSignInputs` convention. Same mapping as the unisat signer.
 */
const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;
    // OKX validates `toSignInputs[i].address` against its own wallet
    // address-set. Passing the input.paymentAddress lets the caller
    // (orchestrator or Pipeline B harness in cross-network mode) tell
    // OKX exactly which address to sign with, instead of OKX trying
    // to infer from the PSBT's scriptPubKey (which won't match its
    // mainnet view on a regtest PSBT).
    return from(okxBtc.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: [{
        index: 0,
        address: walletSidePaymentAddress(
          KnownOrdinalWalletType.okx,
          input.paymentAddress,
          input.paymentPublicKey,
        ),
        // BIP-341 key-path DEFAULT (0x00) and ALL (0x01) commit to
        // identical wire bytes; accept either so OKX's policy check
        // passes regardless of which shape the PSBT emits.
        sighashTypes: [...BIP341_KEYPATH_SIGHASHES],
      }],
    })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;

    const targets = resolveSigningTargets(input);
    const toSignInputs: OkxToSignInput[] = [];
    for (const t of targets) {
      const addr = walletSidePaymentAddress(KnownOrdinalWalletType.okx, t.address, t.publicKey ?? input.paymentPublicKey);
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: addr, sighashTypes: keypathSighashWhitelist(t.sigHash) });
      }
    }

    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      switchMap(signedPsbtHex => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
    );
  },

  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    const psbtHex = hex.encode(input.psbtBytes);
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;
    const targets = resolveSigningTargets(input);
    const toSignInputs: OkxToSignInput[] = [];
    for (const t of targets) {
      const addr = walletSidePaymentAddress(KnownOrdinalWalletType.okx, t.address, t.publicKey ?? input.paymentPublicKey);
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: addr, sighashTypes: keypathSighashWhitelist(t.sigHash) });
      }
    }
    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};

/**
 * BIP-322 message signing via `window.okxwallet.bitcoin.signMessage(
 * message, {from, protocol: 'bip322-simple'})`. Returns base64
 * witness bytes directly (no envelope). `from` pins the signing
 * address to the ordinals key so OKX doesn't fall back to a
 * different address when the user has multiple.
 */
export const okxSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.okx,
  ...operationNamedDefaults(legacy),
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> => {
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;
    return wrapSignMessage(() =>
      okxBtc.signMessage(input.message, { from: input.address, protocol: 'bip322-simple' }),
    );
  },

  // Address-filtering wallet: present the ephemeral-commit input finalized
  // so its pre-sign decode enables Sign; sign only input 0.
  signChildRevealParentInputs: (input: SignChildRevealParentInputsArgs): Observable<{ txId: string }> =>
    signChildRevealViaFinalizedForeignInput((i) => legacy.signPsbtOnly(i), input),
};
