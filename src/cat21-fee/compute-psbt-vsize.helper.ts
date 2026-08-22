import * as btc from '@scure/btc-signer';

import { getDummyKeypair } from './dummy-keypair';

/**
 * Fake taproot key-path witness: a single 64-byte schnorr signature.
 * `.vsize` measures the same whether the bytes are a real signature or
 * zero-fill, so a module-scoped constant is fine (read-only downstream
 * in scure's `updateInput`).
 */
const DUMMY_TAPROOT_KEYPATH_WITNESS = new Uint8Array(64);

/**
 * Fake P2WPKH witness: `<sig ~72><pubkey 33>`. Used as the fallback
 * for any non-taproot non-signable input. A DER-encoded ECDSA sig with
 * a sighash byte is up to ~72 bytes; erring on the larger side means we
 * over- rather than under-estimate the fee for that input.
 */
const DUMMY_P2WPKH_WITNESS = [new Uint8Array(72), new Uint8Array(33)];

/**
 * Size the dummy witness for a non-signable input by its scriptPubKey.
 * A cat can be held on a taproot (Xverse/Leather) OR a native-segwit
 * (Unisat/Wizz) ordinals address; faking a taproot 64-byte witness on a
 * real P2WPKH input under-counts ~11 vB and underpays the fee. Read the
 * input's own scriptPubKey (from its witnessUtxo) and match the witness
 * shape. Unknown/absent script falls back to the larger P2WPKH shape.
 */
function dummyWitnessForNonSignable(script: Uint8Array | undefined): Uint8Array[] {
  // P2TR scriptPubKey: OP_1 (0x51) PUSH32 (0x20) <32-byte key> = 34 bytes.
  if (script && script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return [DUMMY_TAPROOT_KEYPATH_WITNESS];
  }
  return DUMMY_P2WPKH_WITNESS;
}

export interface ComputePsbtVsizeArgs {
  /** PSBT bytes returned by a `buildCat21…Psbt` helper. */
  psbt: Uint8Array;
  /** scure network (mainnet/testnet/regtest) — for the dummy keypair lookup. */
  network: typeof btc.NETWORK;
  /**
   * Input indices whose signature will be provided by another party
   * (e.g. the seller's input 0 in a buyer-initiated offer). scure
   * refuses `.vsize` on any unfinalized input, so we attach a
   * `DUMMY_TAPROOT_KEYPATH_WITNESS` there instead of trying to sign
   * with our dummy key (wrong key → `finalize/taproot: unknown input`).
   */
  nonSignableInputs?: readonly number[];
}

/**
 * Return `tx.vsize` for a freshly-built PSBT by dummy-signing every
 * signable input and attaching a fake witness to any `nonSignableInputs`.
 *
 * scure's `.vsize` throws "Transaction is not finalized" on any input
 * that isn't finalized; this helper handles both the "we're the signer
 * of everything" case (mint, transfer) and the "we're the buyer, seller
 * signs later" case (buy-offer create).
 */
export function computePsbtVsize(args: ComputePsbtVsizeArgs): number {
  const tx = btc.Transaction.fromPSBT(args.psbt);
  const { dummyPrivateKey } = getDummyKeypair(args.network);
  const nonSignable = args.nonSignableInputs ? new Set(args.nonSignableInputs) : null;
  for (let i = 0; i < tx.inputsLength; i++) {
    if (nonSignable?.has(i)) {
      const script = tx.getInput(i).witnessUtxo?.script;
      tx.updateInput(i, { finalScriptWitness: dummyWitnessForNonSignable(script) });
    } else {
      tx.signIdx(dummyPrivateKey, i, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      tx.finalizeIdx(i);
    }
  }
  return tx.vsize;
}
