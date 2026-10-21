import { hex } from '@scure/base';
import { from, map, Observable, switchMap } from 'rxjs';

import { walletSidePaymentAddress } from '../network-address-shim.js';
import { broadcastSignedPsbt } from '../psbt-extract.js';
import { keypathSighashWhitelist } from '../sighash.js';
import {
  KnownOrdinalWalletType,
  SignAndBroadcastInput,
  SignMultiInputAndBroadcastInput,
  SignPsbtOnlyInput,
  WalletSigner,
  WalletSignerInternalImpls,
} from '../wallet.service.types.js';
import { operationNamedDefaults } from './operation-named-defaults.js';
import { resolveSigningTargets } from './signing-targets.helper.js';

/**
 * The `signPsbt(hex, {autoFinalized, toSignInputs})` provider contract that
 * UniSat and its forks (Wizz, OKX, Binance) all expose. `autoFinalized: false`
 * is the SDK-wide "WE broadcast" convention: the wallet returns a partial-sig
 * PSBT and the SDK finalises and broadcasts via the caller's `broadcast`
 * callback, so the wallet's own `pushPsbt` / vendor backend is never used.
 */
interface UnisatFamilyToSignInput {
  index: number;
  address?: string;
  sighashTypes?: number[];
}
export interface UnisatFamilyRpc {
  signPsbt(
    psbtHex: string,
    options?: { autoFinalized?: boolean; toSignInputs?: UnisatFamilyToSignInput[] },
  ): Promise<string>;
}

export interface UnisatFamilyConfig {
  walletType: KnownOrdinalWalletType;
  /**
   * Reads the wallet's BTC provider off `window` at call time. A missing
   * provider is gated upstream by detect-by-signature (the connector), so this
   * is only invoked once the wallet is known present.
   */
  getProvider: () => UnisatFamilyRpc;
  /**
   * Whether to rewrite the row address to the wallet-side equivalent via
   * `walletSidePaymentAddress`. UniSat/Wizz/OKX run a mainnet-only wallet that
   * refuses the app's regtest (bcrt) address, so they shim it to the matching
   * bc1q/bc1p. Binance takes the address as-is.
   */
  shimWalletAddress: boolean;
  /**
   * `sighashTypes` for the single funding input of `signSingleFundingInput`.
   * OKX and Binance validate the Taproot key-path input against a policy and
   * need the BIP-341 DEFAULT/ALL whitelist; UniSat/Wizz accept the row without
   * it (leave undefined to omit the key entirely).
   */
  firstInputSighashTypes?: readonly number[];
  /** Per-wallet message signer (BIP-322 where supported, unsupported otherwise). */
  signMessage: WalletSigner['signMessage'];
}

/**
 * Build a `WalletSigner` for a wallet speaking the UniSat `signPsbt` contract.
 * The signing SCOPE stays central: the operation-named methods come from
 * `operationNamedDefaults`, which derives the inputs to sign from the operation
 * (never a caller-supplied list), and the per-row sighash from
 * `keypathSighashWhitelist`. Only the provider accessor, the regtest
 * address-shim and the Taproot first-input whitelist vary per wallet.
 */
export function makeUnisatFamilySigner(config: UnisatFamilyConfig): WalletSigner {
  const rowAddress = (
    address: string,
    publicKey: string | undefined,
    network: SignAndBroadcastInput['network'],
  ): string =>
    config.shimWalletAddress
      ? walletSidePaymentAddress(config.walletType, address, publicKey, network)
      : address;

  const toSignInputsFromTargets = (
    input: SignMultiInputAndBroadcastInput | SignPsbtOnlyInput,
    targets: ReadonlyArray<{ address: string; indexes: number[]; sigHash: number; publicKey?: string }>,
  ): UnisatFamilyToSignInput[] => {
    const rows: UnisatFamilyToSignInput[] = [];
    for (const t of targets) {
      const addr = rowAddress(t.address, t.publicKey ?? input.paymentPublicKey, input.network);
      for (const i of t.indexes) {
        rows.push({ index: i, address: addr, sighashTypes: keypathSighashWhitelist(t.sigHash, addr) });
      }
    }
    return rows;
  };

  const legacy: WalletSignerInternalImpls = {
    signAndBroadcast(input: SignAndBroadcastInput): Observable<{ txId: string }> {
      const psbtHex = hex.encode(input.psbtBytes);
      const row: UnisatFamilyToSignInput = {
        index: 0,
        address: rowAddress(input.paymentAddress, input.paymentPublicKey, input.network),
      };
      if (config.firstInputSighashTypes) {
        row.sighashTypes = [...config.firstInputSighashTypes];
      }
      return from(config.getProvider().signPsbt(psbtHex, { autoFinalized: false, toSignInputs: [row] })).pipe(
        switchMap((signedPsbtHex) => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
      );
    },

    signMultiInputAndBroadcast(input: SignMultiInputAndBroadcastInput): Observable<{ txId: string }> {
      const psbtHex = hex.encode(input.psbtBytes);
      const toSignInputs = toSignInputsFromTargets(input, resolveSigningTargets(input));
      return from(config.getProvider().signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
        switchMap((signedPsbtHex) => broadcastSignedPsbt(input, hex.decode(signedPsbtHex))),
      );
    },

    signPsbtOnly(input: SignPsbtOnlyInput): Observable<Uint8Array> {
      const psbtHex = hex.encode(input.psbtBytes);
      const toSignInputs = toSignInputsFromTargets(input, resolveSigningTargets(input));
      return from(config.getProvider().signPsbt(psbtHex, { autoFinalized: false, toSignInputs })).pipe(
        map((signedPsbtHex) => hex.decode(signedPsbtHex)),
      );
    },
  };

  return {
    providerId: config.walletType,
    ...operationNamedDefaults(legacy),
    signMessage: config.signMessage,
  };
}
