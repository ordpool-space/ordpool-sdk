import * as btc from '@scure/btc-signer';

import { getDummyKeypair } from './dummy-keypair.js';

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

/** Longest DER ECDSA signature plus sighash byte a real signer can emit. */
const MAX_ECDSA_SIG_BYTES = 72;

/**
 * `tx.vsize` with every ECDSA signature counted at 72 bytes.
 *
 * A DER signature is 70 to 72 bytes depending on r and s, so a dummy
 * signature's length depends on the message, and the wallet that really signs
 * emits its own (Core grinds low-R; `@scure` does not). Where the weight sits
 * on a `ceil(weight / 4)` boundary one byte moves the vsize, so a preview
 * measured on the dummy can under-state the broadcast tx. Counting the maximum
 * makes the measurement independent of the dummy and an upper bound on any real
 * signature. Covers P2WPKH, P2SH-P2WPKH (witness bytes, weight 1) and P2PKH
 * (scriptSig bytes, weight 4). Schnorr signatures are fixed-length and untouched.
 */
export function vsizeWithMaxSignatures(tx: btc.Transaction): number {
  let extraWeight = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const w = input.finalScriptWitness;
    if (w && w.length === 2 && w[1].length === 33 && w[0].length < MAX_ECDSA_SIG_BYTES) {
      extraWeight += MAX_ECDSA_SIG_BYTES - w[0].length;
      continue;
    }
    if (!w && input.finalScriptSig) {
      const ops = btc.Script.decode(input.finalScriptSig);
      const sig = ops[0];
      if (ops.length === 2 && sig instanceof Uint8Array && ops[1] instanceof Uint8Array
        && ops[1].length === 33 && sig.length < MAX_ECDSA_SIG_BYTES) {
        extraWeight += 4 * (MAX_ECDSA_SIG_BYTES - sig.length);
      }
    }
  }
  return extraWeight === 0 ? tx.vsize : Math.ceil((tx.weight + extraWeight) / 4);
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
  return vsizeWithMaxSignatures(tx);
}
