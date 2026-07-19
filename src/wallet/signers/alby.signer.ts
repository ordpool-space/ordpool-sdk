import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { BIP341_KEYPATH_SIGHASHES } from '../sighash';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { unsupportedSignMessage } from './unsupported-sign-message';


interface WebBtcApi {
  enable?(): Promise<void>;
  signPsbt(psbt: string, opts?: { sighashTypes?: number[] }): Promise<{ signed: string }>;
}

interface AlbyApi {
  enable(): Promise<void>;
  webbtc: WebBtcApi;
}


/**
 * Alby — `window.alby.webbtc.signPsbt(psbtHex, { sighashTypes })`.
 *
 * Alby's BTC sub-provider sits at `alby.webbtc` (verified iter 99
 * against background.bundle.js v3.14.2). signPsbt accepts the PSBT
 * as hex and returns `{ signed: <wire-tx-hex> }` — the wire-format
 * raw transaction hex, already finalised by Alby's internal
 * bitcoinjs-lib `extractTransaction().toHex()`. NOT a signed PSBT.
 * We broadcast that wire-tx directly.
 *
 * **Alby quirk every caller must respect** (verified iter 108
 * against background.bundle.js): Alby signs EVERY input in the
 * PSBT, no opt-in. The background-script's `bitcoin.signPsbt` does
 * `psbt.data.inputs.forEach(i => psbt.signTaprootInput(i, key))`
 * with the user's single key at `m/86'/1'/0'/0/0`. There is no
 * `signInputs` / `toSignInputs` knob — those args are dropped on
 * the floor. Caller MUST only hand Alby a PSBT whose inputs are
 * all the user's own UTXOs. For our cat21 mint (1 input, owner's
 * own UTXO, owner-pays-fee) this is fine.
 *
 * The `sighashTypes` whitelist IS forwarded to bitcoinjs-lib's
 * `signTaprootInput` `allowedSighashTypes` arg. Alby's default
 * whitelist (when the option is omitted) accepts only
 * SIGHASH_DEFAULT, so PSBTs with explicit SIGHASH_ALL get rejected.
 * We pass both DEFAULT (0x00) and ALL (0x01) so Alby accepts
 * whichever shape the SDK emits — per BIP-341 they're wire-
 * equivalent on key-path spends.
 *
 * Targets the Alby Browser Extension. Alby Go (mobile) doesn't
 * inject in-page providers — it uses NWC deeplinks, a completely
 * different integration model that this signer doesn't cover.
 */
const legacy = {

  signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
    const psbtHex = hex.encode(input.psbtBytes);
    const alby = (window as unknown as { alby: AlbyApi }).alby;

    const p = (async () => {
      await alby.enable();
      if (alby.webbtc.enable) await alby.webbtc.enable();
      const { signed } = await alby.webbtc.signPsbt(psbtHex, {
        sighashTypes: [...BIP341_KEYPATH_SIGHASHES],
      });
      return signed;
    })();

    return from(p).pipe(
      // Alby returns wire-tx hex (already finalised), not a signed
      // PSBT. Broadcast the hex directly — no extract step.
      switchMap(txHex => input.broadcast(txHex)),
      map(txId => ({ txId })),
    );
  },

  /**
   * Multi-input flows (transfer, offer-create, offer-accept) cannot
   * be driven against Alby's current API: `signPsbt` signs every
   * input in the PSBT unconditionally (verified iter 108 against
   * background.bundle.js). That breaks offer-create where the buyer
   * must NOT sign input 0 (the seller's cat UTXO).
   *
   * For transfer specifically, where the user signs both the cat and
   * funding inputs but they're all the user's UTXOs, Alby's "sign
   * everything" would work — but Alby uses a single Taproot key at
   * `m/86'/1'/0'/0/0` for every signature, so a transfer that mixes
   * scriptTypes (cat at the user's taproot, funding at the user's
   * legacy address) would fail anyway. Until Alby exposes per-input
   * key derivation, multi-input flows raise here so the consumer
   * surfaces an unambiguous "this wallet doesn't support that flow yet".
   */
  signMultiInputAndBroadcast(_input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
    return new Observable((observer) => {
      observer.error(new Error(
        'Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for transfer / offer flows.',
      ));
    });
  },

  signPsbtOnly(_input: SignPsbtOnlyInput): Observable<Uint8Array> {
    return new Observable((observer) => {
      observer.error(new Error(
        'Alby does not support per-input signing yet (no toSignInputs / signInputs knob in current webbtc API). Use Xverse, Leather, Unisat, or CAT-21 wallet for offer-create.',
      ));
    });
  },
};

export const albySigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.alby,
  ...operationNamedDefaults(legacy),
  signMessage: unsupportedSignMessage('Alby'),
};
