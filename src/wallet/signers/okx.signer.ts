import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract';
import { BIP341_KEYPATH_SIGHASHES } from '../sighash';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
} from '../wallet.service.types';
import { operationNamedDefaults } from './operation-named-defaults';
import { resolveSigningTargets } from './signing-targets.helper';


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
        address: input.paymentAddress,
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
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
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
      for (const i of t.indexes) {
        toSignInputs.push({ index: i, address: t.address, sighashTypes: [t.sigHash] });
      }
    }
    return from(okxBtc.signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
      map((signedPsbtHex) => hex.decode(signedPsbtHex)),
    );
  },
};

export const okxSigner: WalletSigner = {
  providerId: KnownOrdinalWalletType.okx,
  ...legacy,
  ...operationNamedDefaults(legacy),
};
