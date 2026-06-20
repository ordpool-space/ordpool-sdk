import * as btc from '@scure/btc-signer';
import { DummyKeypairResult, TxnOutput } from '../cat21-mint/cat21.service.types';
/**
 * Deterministic dummy keypair for SIMULATION only. Private key is
 * the hardcoded constant `0x0101…01`; addresses for P2PKH,
 * P2SH-P2WPKH, P2WPKH, P2TR are pre-derived so every Layer-2 input
 * adapter can dummy-sign its matching shape. Cached per network
 * bech32 prefix.
 *
 * **Never broadcast** — the private key is publicly known, so
 * signatures provide zero security.
 *
 * For Taproot inputs use `xOnlyDummyPublicKey`; the ECDSA
 * `dummyPublicKey` will not work.
 */
export declare function getDummyKeypair(network: typeof btc.NETWORK): DummyKeypairResult;
/**
 * Generates a dummy legacy (P2PKH) transaction for the
 * simulation pass. Used to construct a `nonWitnessUtxo` field on
 * legacy P2PKH funding inputs (scure requires the full previous-tx
 * bytes for legacy inputs, see paulmillr/scure-btc-signer README).
 *
 * The transaction includes a number of outputs equal to the `vout`
 * of the provided `TxnOutput`, each output carrying the same value.
 */
export declare function getDummyLegacyTransaction(txnOutput: TxnOutput, network: typeof btc.NETWORK): btc.Transaction;
//# sourceMappingURL=dummy-keypair.d.ts.map