import { Observable } from 'rxjs';

import { BIP341_KEYPATH_SIGHASHES } from '../sighash.js';
import {
  KnownOrdinalWalletType,
  SignMessageArgs,
  SignMessageResult,
  WalletSigner,
} from '../wallet.service.types.js';
import { makeUnisatFamilySigner, UnisatFamilyRpc } from './unisat-family-signer.helper.js';
import { wrapSignMessage } from './wrap-sign-message.js';


interface OkxBtcRpc extends UnisatFamilyRpc {
  /**
   * `signMessage(signStr[, type])` per the OKX Bitcoin provider API. `type` is
   * a POSITIONAL string, and OKX DEFAULTS TO 'ecdsa' when it is omitted or
   * unreadable, an ECDSA recoverable signature that does NOT verify against a
   * Taproot address. Taproot (our ordinals key) REQUIRES 'bip322-simple', which
   * returns a base64 BIP-322 witness. OKX has no `from` param; it signs under
   * the active address. (Same class of bug as reown-com/appkit#4162 +
   * okx/js-wallet-sdk#158.)
   */
  signMessage(message: string, type?: 'ecdsa' | 'bip322-simple'): Promise<string>;
}

const getProvider = (): OkxBtcRpc =>
  (window as unknown as { okxwallet: { bitcoin: OkxBtcRpc } }).okxwallet.bitcoin;


/**
 * OKX — `window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized: false})`.
 *
 * OKX is a multi-chain wallet; the BTC sub-provider lives at
 * `window.okxwallet.bitcoin` and speaks the UniSat-family contract (verified by
 * grepping inpage.js v4.1.0). Per the "WE broadcast" convention we skip OKX's
 * `sendPsbt`. Its policy check needs the BIP-341 key-path whitelist on the
 * single funding input, so `firstInputSighashTypes` is set: DEFAULT (0x00) and
 * ALL (0x01) commit to identical wire bytes, and accepting either lets the
 * check pass regardless of which shape the PSBT emits.
 *
 * `signChildRevealParentInputs` falls through to `operationNamedDefaults`: the
 * wallet gets the BARE reveal PSBT and signs ONLY input 0 (the parent, at the
 * ordinals address) via signPsbtOnly, same path UniSat/Wizz use.
 */
export const okxSigner: WalletSigner = makeUnisatFamilySigner({
  walletType: KnownOrdinalWalletType.okx,
  getProvider,
  shimWalletAddress: true,
  firstInputSighashTypes: BIP341_KEYPATH_SIGHASHES,
  /**
   * BIP-322 message signing. The signature type is OKX's POSITIONAL second
   * argument and MUST be 'bip322-simple' for a Taproot ordinals key; anything
   * else makes OKX default to 'ecdsa' (a 65-byte recoverable sig that cannot
   * verify against a bech32m address). OKX signs under its active address.
   */
  signMessage: (input: SignMessageArgs): Observable<SignMessageResult> =>
    wrapSignMessage(() => getProvider().signMessage(input.message, 'bip322-simple')),
});
