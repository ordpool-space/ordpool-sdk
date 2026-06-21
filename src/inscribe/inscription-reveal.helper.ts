import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { Network, toScureNetwork } from '../network';

import { INSCRIBE_POSTAGE_SATS } from './inscription-commit.helper';

/**
 * Layer-1 builder for the **reveal** transaction.
 *
 * The reveal:
 *   - Spends the commit's P2TR output (built by the commit helper)
 *     via the envelope tapscript leaf.
 *   - Witness shape: `[ephemeralSig, envelopeScript, controlBlock]`.
 *   - Has one output at index 0: `recipientAddress` for postage sats.
 *     Per ord theory, the inscription lands on the first sat of the
 *     first output.
 *
 * The reveal hex is self-contained: signed under the ephemeral
 * key, replayable, idempotent, broadcast-from-anywhere. The
 * orchestrator passes the ephemeral key here AND returns it on
 * `CreateInscribeTransactionsResult.ephemeral.privKey` so the
 * consumer can rebuild a different reveal later (redirect, RBF,
 * recover-to-self, bundle) without losing access.
 */

/** Result of `buildInscribeRevealTx`. */
export interface InscribeRevealResult {
  /** Network-serialised, finalized reveal tx (hex). */
  revealHex: string;
  /** Computed txid of the reveal. */
  revealTxid: string;
  /** vsize of the finalized reveal (used by the fee helper). */
  revealVsize: number;
}

export interface InscribeRevealArgs {
  /** Commit txid (caller broadcasts commit later; we just reference it). */
  commitTxid: string;
  /** Commit output index — always 0 for the inscriber. */
  commitVout: number;
  /** Sat value at the commit output (postage + revealFeeReserve). */
  commitOutputValueSats: number;
  /** scriptPubKey bytes of the commit output (output of commit helper). */
  commitOutputScript: Uint8Array;
  /** Taptree spend metadata (output of commit helper). */
  taproot: {
    internalKey: Uint8Array;
    tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
  };
  /**
   * 32-byte ephemeral private key. SAME key whose Schnorr x-only
   * pubkey was embedded in the envelope script the commit helper
   * placed in the taptree. The Layer-4 orchestrator generates this
   * once, hands it to the envelope builder (via `deriveRevealPubkeyXonly`)
   * AND here, then zeros it. Mismatched key → scure rejects finalize.
   */
  ephemeralPrivKey: Uint8Array;
  /** Address the inscription lands on (P2TR recommended). */
  recipientAddress: string;
  /**
   * Optional tip output appended at vout[1] of the reveal. The
   * inscription MUST stay at vout[0] (ord's "first sat of first
   * output" rule), so the tip lives one slot below. When omitted,
   * the reveal has its single recipient output as before.
   *
   * Caller is responsible for ensuring `commitOutputValueSats`
   * carries enough sats to fund postage + reveal fee + tip.value;
   * the fee simulator's `tip` param threads that through.
   */
  tip?: { address: string; value: number };
  /** Network. */
  network: Network;
}

/**
 * Signs the reveal via the envelope tapscript leaf, returns the
 * finalized reveal hex. The caller-supplied ephemeral private key
 * is used for the Schnorr signature; the orchestrator returns this
 * same key on its result so the consumer can rebuild a different
 * reveal later under different parameters.
 */
export function buildInscribeRevealTx(args: InscribeRevealArgs): InscribeRevealResult {
  const scureNetwork = toScureNetwork(args.network);
  const postageSats = INSCRIBE_POSTAGE_SATS;
  const tipValueSats = args.tip?.value ?? 0;
  if (tipValueSats < 0) throw new Error('tip.value must be non-negative');
  if (!Number.isInteger(tipValueSats)) throw new Error('tip.value must be an integer');
  // The reveal's miner fee equals the leftover: commit output sats
  // minus the postage going to the recipient minus any tip output
  // going to the tip address.
  const revealFeeReserveSats = args.commitOutputValueSats - postageSats - tipValueSats;
  if (revealFeeReserveSats < 0) {
    throw new Error(
      `commitOutputValueSats (${args.commitOutputValueSats}) < postage (${postageSats}) + tip (${tipValueSats})`
    );
  }
  if (args.ephemeralPrivKey.length !== 32) {
    throw new Error(`ephemeralPrivKey must be 32 bytes; got ${args.ephemeralPrivKey.length}`);
  }

  const tx = new btc.Transaction({ disableScriptCheck: true });

  // Input 0: commit P2TR output, spent via the envelope leaf.
  // Envelope leaf is index 0 of the args.taproot.tapLeafScript array.
  tx.addInput({
    txid: args.commitTxid,
    index: args.commitVout,
    witnessUtxo: {
      script: args.commitOutputScript,
      amount: BigInt(args.commitOutputValueSats),
    },
    tapInternalKey: args.taproot.internalKey,
    tapLeafScript: args.taproot.tapLeafScript,
  });

  // Output 0: recipient address, postage sats. The inscription
  // lands on the first sat of this output (ord-theory FIFO).
  tx.addOutputAddress(args.recipientAddress, BigInt(postageSats), scureNetwork);

  // Output 1 (optional): tip output. ord's first-sat-of-first-output
  // rule pins the inscription to vout[0]; the tip lives at vout[1].
  // Pattern matches `0xFlicker/ordinals` packages/inscriptions/src/
  // reveal.ts (the only OSS inscriber with a tip primitive — see
  // /Work/ordpool/OSS-INSCRIBERS.md). We diverge in that we ship a
  // single fixed-sats tip, not a weighted multi-recipient split.
  if (args.tip !== undefined && tipValueSats > 0) {
    tx.addOutputAddress(args.tip.address, BigInt(tipValueSats), scureNetwork);
  }

  // Manual taproot tapscript-path finalization.
  //
  // scure 1.2.x's automatic finalize rejects our envelope tapscript
  // pattern (`<pubkey> CHECKSIG OP_FALSE OP_IF "ord" ... OP_ENDIF`)
  // because it's not one of the known `pk` / `ms` patterns — it
  // throws "Finalize: Unknown tapLeafScript". scure 2.x added
  // `customScripts` to register handlers; we don't have that.
  //
  // Manual path mirrors what scure's finalize would do for a `pk`
  // leaf: compute the BIP-341 tapscript sighash, sign with the
  // ephemeral Schnorr key, assemble `[sig, script, controlBlock]`
  // as the witness, write it via updateInput. The output is
  // byte-identical to what a scure-2.x customScripts handler
  // would produce.
  const [cbStruct, leafScript] = args.taproot.tapLeafScript[0];
  const leafVersion = cbStruct.version ?? 0xc0;
  const sighash = tx.preimageWitnessV1(
    0,
    [args.commitOutputScript],
    btc.SignatureHash.DEFAULT,
    [BigInt(args.commitOutputValueSats)],
    undefined,
    leafScript,
    leafVersion,
  );
  const signature = schnorr.sign(sighash, args.ephemeralPrivKey);
  const controlBlock = btc.TaprootControlBlock.encode(cbStruct);
  tx.updateInput(0, {
    finalScriptWitness: [signature, leafScript, controlBlock],
  }, true);

  return {
    revealHex: tx.hex,
    revealTxid: tx.id,
    revealVsize: tx.vsize,
  };
}

/**
 * Derives the x-only Schnorr pubkey from a private key. The pubkey
 * is what gets embedded in the envelope tapscript via
 * `<revealPubkeyXonly> OP_CHECKSIG`, so the caller can pre-compute
 * the envelope independently of the actual reveal call. The same
 * pubkey is fed to both the commit helper (via envelopeScript) and
 * the reveal helper (implicitly via the regenerated private key).
 *
 * Returns the 32-byte x-only Schnorr pubkey.
 */
export function deriveRevealPubkeyXonly(privKey: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(privKey);
}
