import * as btc from '@scure/btc-signer';

import { getDummyKeypair } from './dummy-keypair';

/**
 * Fake 64-byte taproot key-path witness. `.vsize` on a finalized
 * schnorr key-path input measures the same whether the 64 bytes are
 * a real signature or zero-fill, so a module-scoped constant is fine
 * (read-only downstream in scure's `updateInput`).
 */
const DUMMY_TAPROOT_KEYPATH_WITNESS = new Uint8Array(64);

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
      tx.updateInput(i, { finalScriptWitness: [DUMMY_TAPROOT_KEYPATH_WITNESS] });
    } else {
      tx.signIdx(dummyPrivateKey, i, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      tx.finalizeIdx(i);
    }
  }
  return tx.vsize;
}
