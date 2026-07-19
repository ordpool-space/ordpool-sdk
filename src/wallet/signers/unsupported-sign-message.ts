import { Observable } from 'rxjs';

import { SignMessageArgs, SignMessageResult } from '../wallet.service.types';

/**
 * Shared "signMessage is not wired for this wallet yet" implementation.
 * Every WalletSigner MUST expose `signMessage` (interface contract);
 * wallets whose signMessage RPC isn't wired yet return this stub so
 * the picker can still surface them for OTHER cat flows (mint /
 * transfer / offer) without breaking the type contract. The listing
 * flow catches the error and surfaces "your wallet doesn't support
 * message signing yet — use cat21-wallet / xverse / leather / unisat
 * / okx to list on the orderbook".
 *
 * NEVER used to hide a missing RPC — only for wallets where the
 * upstream signMessage endpoint genuinely isn't available (legacy
 * wallets, watch-only signers, wallets focused on non-Bitcoin
 * surfaces like Lightning).
 */
export function unsupportedSignMessage(walletName: string): (input: SignMessageArgs) => Observable<SignMessageResult> {
  return (_input: SignMessageArgs) => new Observable<SignMessageResult>((observer) => {
    observer.error(new Error(
      `${walletName} does not support BIP-322 message signing yet. ` +
      `Use cat21-wallet, Xverse, Leather, Unisat, or OKX to list on the CAT-21 orderbook.`,
    ));
  });
}
