import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { walletSidePaymentAddress } from '../network-address-shim';
import { broadcastSignedPsbt } from '../psbt-extract';
import { BIP341_KEYPATH_SIGHASHES, keypathSighashWhitelist } from '../sighash';
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
   * `signMessage(signStr[, type])` per the OKX Bitcoin provider API
   * (https://web3.okx.com/build/docs/sdks/chains/bitcoin/provider).
   * `type` is a POSITIONAL string, not an options object, and OKX
   * DEFAULTS TO 'ecdsa' when it is omitted or unreadable — an ECDSA
   * recoverable signature that does NOT verify against a Taproot
   * address. Taproot (our ordinals key) REQUIRES 'bip322-simple',
   * which returns a base64 BIP-322 witness. OKX has no `from` param;
   * it signs under the active address. (Same class of bug as
   * reown-com/appkit#4162 + okx/js-wallet-sdk#158.)
   */
  signMessage(
    message: string,
    type?: 'ecdsa' | 'bip322-simple'
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
          input.network,
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
      const addr = walletSidePaymentAddress(KnownOrdinalWalletType.okx, t.address, t.publicKey ?? input.paymentPublicKey, input.network);
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
      const addr = walletSidePaymentAddress(KnownOrdinalWalletType.okx, t.address, t.publicKey ?? input.paymentPublicKey, input.network);
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: addr, sighashTypes: keypathSighashWhitelist(t.sigHash, addr) });
      }
    }
    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};

/**
 * BIP-322 message signing via `window.okxwallet.bitcoin.signMessage(
 * message, 'bip322-simple')`. The signature type is OKX's POSITIONAL
 * second argument; it MUST be the string 'bip322-simple' for a Taproot
 * ordinals key. Passing anything else (an omitted arg, or an options
 * object) makes OKX default to 'ecdsa', which returns a 65-byte
 * recoverable signature that cannot verify against a bech32m address.
 * OKX signs under its active address (Taproot by default), so there is
 * no `from` argument to pin. Returns base64 BIP-322 witness bytes.
 */
export const okxSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.okx,
  ...operationNamedDefaults(legacy),
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> => {
    const okxBtc = (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;
    return wrapSignMessage(() =>
      okxBtc.signMessage(input.message, 'bip322-simple'),
    );
  },

  // signChildRevealParentInputs falls through to operationNamedDefaults:
  // the wallet is handed the BARE reveal PSBT (input 1 stripped of the ord
  // envelope tap-leaf, so it is a plain witnessUtxo, not a script-path
  // spend) and signs ONLY input 0 (the parent, at the ordinals address) via
  // signPsbtOnly; the SDK merges that signature into the full PSBT. Same
  // path Unisat/Wizz use, and the same "sign my input, leave the foreign
  // one" shape as the offer flows that pass on OKX.
};
