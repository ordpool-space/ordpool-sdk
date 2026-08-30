import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { map, Observable, switchMap, throwError } from 'rxjs';

import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { unsupportedSignMessage } from './unsupported-sign-message';
import { decodePastedPsbt } from '../../cat21-offer/decode-pasted-psbt';

/**
 * Watch-only signer. Covers any wallet that doesn't inject into the
 * browser — Sparrow Desktop, Electrum, Bitcoin Core, Specter,
 * Coldcard, Ledger, Trezor.
 *
 * Flow:
 *  1. We hand the unsigned PSBT to `input.promptForSignedPsbt` —
 *     the frontend renders a download / paste dialog and emits the
 *     user's signed PSBT (base64 or hex).
 *  2. We finalize the signed PSBT via scure.
 *  3. We delegate broadcasting to `input.broadcast(txHex)` — same
 *     mempool-POST path as Leather.
 *
 * One signer implementation, universal reach. PSBT is a spec
 * (BIP-174 / BIP-370); every desktop and hardware wallet speaks it.
 */
const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    if (!input.promptForSignedPsbt) {
      return throwError(() => new Error(
        'Watch-only signing requires a promptForSignedPsbt callback to be provided'
      ));
    }

    return input.promptForSignedPsbt({
      base64: base64.encode(input.psbtBytes),
      hex: hex.encode(input.psbtBytes),
    }).pipe(
      switchMap(signedPsbt => {
        const signedBytes = decodePastedPsbt(signedPsbt, 'Signed PSBT');
        const tx = btc.Transaction.fromPSBT(signedBytes);
        // External wallets may return either shape:
        //   - partial-sig PSBT (inputs have BIP-174 partial sigs but
        //     no final_scriptWitness / final_scriptSig). We finalize.
        //   - fully-finalized PSBT (final_scriptWitness present,
        //     ready to extract). scure rejects a re-finalize attempt
        //     here ("Not enough partial sign"), so we check isFinal
        //     and skip finalize().
        // Both shapes broadcast the same on-chain bytes via tx.hex.
        if (!tx.isFinal) {
          tx.finalize();
        }
        return input.broadcast(tx.hex).pipe(map(txId => ({ txId })));
      })
    );
  },

  /**
   * The watch-only path doesn't differentiate single- vs multi-input
   * because external wallets (Sparrow, Electrum, Coldcard, etc.) read
   * the whole PSBT themselves and sign every input they own. The
   * caller hands them the same unsigned-PSBT-as-base64/hex regardless
   * of which inputs need which keys. We just trust the user's wallet
   * to do the right thing and finalise whatever comes back.
   */
  signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    if (!input.promptForSignedPsbt) {
      return throwError(() => new Error(
        'Watch-only signing requires a promptForSignedPsbt callback to be provided'
      ));
    }
    return input.promptForSignedPsbt({
      base64: base64.encode(input.psbtBytes),
      hex: hex.encode(input.psbtBytes),
    }).pipe(
      switchMap((signedPsbt) => {
        const signedBytes = decodePastedPsbt(signedPsbt, 'Signed PSBT');
        const tx = btc.Transaction.fromPSBT(signedBytes);
        if (!tx.isFinal) tx.finalize();
        return input.broadcast(tx.hex).pipe(map((txId) => ({ txId })));
      }),
    );
  },

  /**
   * Buyer-side offer-create with a watch-only signer: hand the unsigned
   * PSBT to the user, get back a PSBT that carries buyer-side partial
   * signatures but NO finalization on input 0. Return those bytes; the
   * orchestrator surfaces them as the offer artifact.
   */
  signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
    if (!input.promptForSignedPsbt) {
      return throwError(() => new Error(
        'Watch-only signing requires a promptForSignedPsbt callback to be provided'
      ));
    }
    return input.promptForSignedPsbt({
      base64: base64.encode(input.psbtBytes),
      hex: hex.encode(input.psbtBytes),
    }).pipe(map((signedPsbt) => decodePastedPsbt(signedPsbt, 'Signed PSBT')));
  },
};

export const psbtExportSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.xpub,
  ...operationNamedDefaults(legacy),
  signMessage: unsupportedSignMessage('PSBT-export (watch-only)'),
};
