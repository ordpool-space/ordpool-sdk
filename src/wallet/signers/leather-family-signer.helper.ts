import { hex } from '@scure/base';
import { defer, from, map, Observable, switchMap } from 'rxjs';

import { broadcastSignedPsbt } from '../psbt-extract.js';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
  WalletSignerInternalImpls,
} from '../wallet.service.types.js';
import { operationNamedDefaults } from './operation-named-defaults.js';
import { flattenSigningIndexes } from './signing-targets.helper.js';

export interface LeatherFamilyConfig {
  walletType: KnownOrdinalWalletType;
  /**
   * Sign the given input index(es) of the PSBT hex and return the signed PSBT
   * hex. The closure owns provider access (`window.LeatherProvider` vs
   * `window.Cat21Provider`) and the network-string mapping, which differ per
   * wallet; everything else in the Leather signPsbt contract is shared.
   */
  signPsbt: (
    psbtHex: string,
    signAtIndex: number | number[],
    network: SignAndBroadcastInput['network'],
  ) => Promise<string>;
  /**
   * How a multi-input flow is signed. 'array' sends every index in one
   * signPsbt call (one approval popup); 'chain' threads the partially-signed
   * hex through one call per index (one popup each). Leather's signPsbt takes a
   * single `signAtIndex` so it chains; cat21-wallet accepts an array so it signs
   * them in a single popup.
   */
  multiInput: 'array' | 'chain';
  signMessage: WalletSigner['signMessage'];
}

/** The signed PSBT bytes for a multi-input flow, shared by the broadcasting and
 *  the return-only paths so the Observable plumbing lives in one place. */
function signedMultiInputPsbt(
  config: LeatherFamilyConfig,
  input: SignMultiInputAndBroadcastInput | SignPsbtOnlyInput,
): Observable<Uint8Array> {
  const flatIndexes = flattenSigningIndexes(input);
  return defer(() => {
    if (config.multiInput === 'array') {
      return from(config.signPsbt(hex.encode(input.psbtBytes), flatIndexes, input.network));
    }
    let chain: Promise<string> = Promise.resolve(hex.encode(input.psbtBytes));
    for (const i of flatIndexes) {
      chain = chain.then((currentHex) => config.signPsbt(currentHex, i, input.network));
    }
    return from(chain);
  }).pipe(map((finalHex) => hex.decode(finalHex)));
}

/**
 * Build a `WalletSigner` for a wallet speaking Leather's signPsbt JSON-RPC.
 * cat21-wallet is a Leather fork and inherits the shape verbatim; only the
 * provider accessor, the network-string mapping and the multi-input mode vary.
 * Signing scope stays central (operationNamedDefaults), so the signingMap ban
 * is untouched; only the signPsbt plumbing is shared.
 */
export function makeLeatherFamilySigner(config: LeatherFamilyConfig): WalletSigner {
  const legacy: WalletSignerInternalImpls = {
    signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
      return defer(() => from(config.signPsbt(hex.encode(input.psbtBytes), 0, input.network))).pipe(
        switchMap((signedHex) => broadcastSignedPsbt(input, hex.decode(signedHex))),
      );
    },

    signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
      return signedMultiInputPsbt(config, input).pipe(
        switchMap((signedBytes) => broadcastSignedPsbt(input, signedBytes)),
      );
    },

    signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
      return signedMultiInputPsbt(config, input);
    },
  };

  return {
    providerId: config.walletType,
    ...operationNamedDefaults(legacy),
    signMessage: config.signMessage,
  };
}
