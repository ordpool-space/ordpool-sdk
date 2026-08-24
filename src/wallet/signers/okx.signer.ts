import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { from, map, Observable, switchMap, throwError } from 'rxjs';

import { walletSidePaymentAddress } from '../network-address-shim';
import { broadcastSignedPsbt, extractWireTxFromPsbt } from '../psbt-extract';
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
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';
import { wrapSignMessage } from './wrap-sign-message';


interface OkxToSignInput {
  index: number;
  address?: string;
  /**
   * x-only (or 33-byte compressed) pubkey hex. Names the signing key by
   * key instead of by address — used for a Taproot input the wallet can't
   * match to its address set, i.e. the child reveal's commit input (a
   * SCRIPT-PATH spend of the ord envelope leaf keyed by the wallet's own
   * ordinals key).
   */
  publicKey?: string;
  sighashTypes?: number[];
  /**
   * Leaf hash (hex) OKX signs against for a Taproot SCRIPT-PATH spend. Set
   * on the commit input so OKX produces a tapScriptSig over the envelope
   * leaf rather than a key-path signature.
   */
  tapLeafHashToSign?: string;
  /**
   * `true` → sign with the RAW (untweaked) key. Required for the commit
   * input's script-path spend: the envelope leaf carries the raw x-only
   * key, so the signature must be under the raw key, not the taproot-
   * tweaked one.
   */
  disableTweakSigner?: boolean;
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
        toSignInputs.push({ index: i, address: addr, sighashTypes: keypathSighashWhitelist(t.sigHash, addr) });
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
        toSignInputs.push({ index: i, address: addr, sighashTypes: keypathSighashWhitelist(t.sigHash, addr) });
      }
    }
    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};

/** Drop the parity byte off a 33-byte compressed pubkey; pass x-only through. */
function toXOnlyHex(pubkeyHex: string): string {
  return pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
}

/**
 * `signChildRevealParentInputs` for OKX — the OKX-owned-commit reveal.
 *
 * The child reveal's commit input (index 1) carries the WALLET's OWN
 * ordinals x-only key as its taproot internal key AND envelope-leaf key
 * (see `revealKeyXOnly` in the child builder), so OKX OWNS both inputs and
 * signs them atomically in ONE signPsbt call:
 *   - input 0 (parent P2TR key-path) with the TWEAKED ordinals key;
 *   - input 1 (commit) SCRIPT-PATH over the envelope leaf with the RAW
 *     (untweaked) ordinals key — `disableTweakSigner: true` + the
 *     `tapLeafHashToSign` naming the leaf.
 * SIGHASH_DEFAULT, no ANYONECANPAY. The SDK then finalizes both inputs and
 * broadcasts the wire tx.
 *
 * Why the commit key is OKX's own key and not an ephemeral one: OKX's
 * closed signPsbt preview decodes the whole PSBT and refuses any input it
 * doesn't own, so an ephemeral-keyed commit input can never render the
 * approval popup. Making the commit key OKX's own key is what lets OKX
 * both preview and script-path-sign it.
 *
 * The leaf hash is derived from input 1's tapLeafScript in the PSBT (bare
 * leaf + trailing version byte); OKX's x-only pubkey is the ordinals key
 * carried in `ordinalsPublicKey`.
 */
function signOkxOwnedChildReveal(input: SignChildRevealParentInputsArgs): Observable<{ txId: string }> {
  const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;

  const psbt = btc.Transaction.fromPSBT(input.psbtBytes, { allowUnknownInputs: true });
  const commitLeaf = psbt.getInput(1).tapLeafScript;
  if (!commitLeaf || commitLeaf.length === 0) {
    return throwError(() =>
      new Error('OKX child reveal: input 1 carries no tapLeafScript to script-path-sign'));
  }
  const leafScriptWithVersion = commitLeaf[0][1];
  const bareLeafScript = leafScriptWithVersion.subarray(0, -1);
  const leafVersion = leafScriptWithVersion[leafScriptWithVersion.length - 1] ?? 0xc0;
  const leafHash = btc.tapLeafHash(bareLeafScript, leafVersion);

  const ordinalsXOnlyHex = toXOnlyHex(input.ordinalsPublicKey);
  const ordinalsAddress = walletSidePaymentAddress(
    KnownOrdinalWalletType.okx,
    input.ordinalsAddress,
    input.ordinalsPublicKey,
  );

  return from(okxBtc.signPsbt(hex.encode(input.psbtBytes), {
    autoFinalized: false,
    toSignInputs: [
      // Input 0 — parent P2TR key-path, tweaked ordinals key. BIP-341
      // DEFAULT (0x00) / ALL (0x01) are wire-identical for key-path.
      { index: 0, address: ordinalsAddress, sighashTypes: [...BIP341_KEYPATH_SIGHASHES] },
      // Input 1 — commit SCRIPT-PATH over the envelope leaf, RAW key.
      {
        index: 1,
        publicKey: ordinalsXOnlyHex,
        tapLeafHashToSign: hex.encode(leafHash),
        disableTweakSigner: true,
        sighashTypes: [...BIP341_KEYPATH_SIGHASHES],
      },
    ],
  })).pipe(
    switchMap((signedPsbtHex) => {
      // OKX returns both inputs signed (input 0 tapKeySig, input 1
      // tapScriptSig). Finalize both + broadcast the wire tx (WE broadcast).
      const wireHex = extractWireTxFromPsbt(hex.decode(signedPsbtHex));
      return input.broadcast(wireHex);
    }),
    map((txId) => ({ txId })),
  );
}

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

  // OKX-owned-commit child reveal: OKX owns BOTH inputs (its ordinals key
  // is the commit's internal + envelope-leaf key), so it signs input 0
  // key-path + input 1 script-path in one signPsbt call. See
  // signOkxOwnedChildReveal.
  signChildRevealParentInputs: (input: SignChildRevealParentInputsArgs): Observable<{ txId: string }> =>
    signOkxOwnedChildReveal(input),
};
