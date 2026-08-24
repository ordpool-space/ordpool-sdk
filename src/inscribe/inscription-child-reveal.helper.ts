import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { INSCRIBE_POSTAGE_SATS } from './inscription-commit.helper';
import { Network, toScureNetwork } from '../network';

/**
 * Layer-1 builder for a **child** inscription's reveal transaction —
 * ord provenance (parent/child), the trustless way to prove a child was
 * created by the owner of the parent.
 *
 * # What makes a valid parent link (ord spec, verified against
 * `inscription_updater.rs` + `plan.rs`)
 *
 * ord recognises `P` as the parent of child `C` iff BOTH hold:
 *   1. `C`'s envelope carries the `parent` tag (0x03) = P's inscription
 *      id (this builder's caller emits that via the envelope, same as a
 *      normal inscribe).
 *   2. **P's UTXO is spent as an input of C's reveal transaction.** The
 *      indexer builds `potential_parents` from the inscriptions present
 *      in the tx and drops any declared parent not in that set
 *      (`inscription_updater.rs:253-269`). Emitting the tag WITHOUT
 *      spending P produces a valid child with NO recognised parent.
 *
 * # Topology (matches ord's own wallet, `plan.rs:392-425`)
 *
 * ```
 * Inputs:   [ parent UTXO (0),           commit output (1) ]
 * Outputs:  [ parent RETURN (0, = P val), child recipient (1, 546) , tip? ]
 * ```
 *
 * FIFO sat-tracking makes this correct with NO pointer:
 *   - Input 0 (parent, P sats) → global `[0..P)` → Output 0 → the parent
 *     inscription RETURNS to its owner. Nothing is lost.
 *   - Input 1 (commit) first sat → global `P` → Output 1 → the child
 *     inscription lands on its recipient (the default offset is "first
 *     sat of the inscription's own input", `inscription_updater.rs:207-211`).
 *
 * Because the child's envelope is on a non-first input (input 1), ord
 * marks it `Curse::NotInFirstInput` → **post-jubilee that is a normal,
 * positively-numbered inscription with the `Vindicated` charm** (mainnet
 * + our regtest are post-jubilee). This is exactly how ord's own
 * `wallet inscribe --parent` produces children; the charm is cosmetic and
 * provenance is unaffected.
 *
 * # Two signers
 *
 * The reveal is co-signed:
 *   - **Commit input (1)** — the ephemeral key, script-path via the
 *     envelope leaf, finalized here (SIGHASH_DEFAULT over the whole tx).
 *   - **Parent input (0)** — the parent OWNER's wallet (P2TR key-path).
 *     Left UNSIGNED in the returned PSBT; the orchestrator hands it to
 *     the wallet, which signs input 0, then we finalize + broadcast.
 * Both sign SIGHASH_ALL/DEFAULT over the same fixed inputs+outputs, so
 * order is irrelevant and neither invalidates the other.
 */

/** A parent inscription being spent + returned by the child reveal. */
export interface ChildRevealParent {
  /** The parent inscription's current UTXO (P2TR — an ordinals address). */
  utxo: {
    txid: string;
    vout: number;
    /** Sat value at the parent UTXO; the parent RETURNS with exactly this value. */
    value: number;
    /** scriptPubKey of the parent UTXO (P2TR). */
    scriptPubKey: Uint8Array;
    /** x-only internal key of the parent's P2TR address (for wallet key-path signing). */
    tapInternalKey: Uint8Array;
  };
  /**
   * Where the parent inscription returns to — the owner's ordinals
   * address. For the in-wallet case this is the SAME wallet that owns
   * the parent (the inscription goes back where it came from).
   */
  returnAddress: string;
}

export interface ChildInscribeRevealArgs {
  /** Commit txid (the child's commit; same commit builder as a normal inscribe). */
  commitTxid: string;
  /** Commit output index — always 0. */
  commitVout: number;
  /** Sat value at the commit output (funds child postage + reveal fee + tip). */
  commitOutputValueSats: number;
  /** scriptPubKey of the commit output. */
  commitOutputScript: Uint8Array;
  /** Taptree spend metadata from the commit builder. */
  taproot: {
    internalKey: Uint8Array;
    tapLeafScript: NonNullable<btc.P2TROut['tapLeafScript']>;
  };
  /**
   * 32-byte ephemeral private key (same key embedded in the envelope).
   * Required in the DEFAULT (ephemeral) mode — the SDK script-path-signs
   * input 1 with it. Omitted in OKX-owned-commit mode (`revealKeyXOnly`
   * set), where the WALLET holds the key and signs input 1 itself.
   */
  ephemeralPrivKey?: Uint8Array;
  /**
   * OKX-owned-commit mode. When set (32-byte x-only), the envelope leaf
   * key AND the commit's taproot internal key are the WALLET's OWN
   * ordinals key, so the wallet can script-path-sign input 1 in the same
   * signPsbt call that key-path-signs input 0. The SDK holds no private
   * key for input 1 and leaves it UNSIGNED (witnessUtxo + tapInternalKey
   * = revealKeyXOnly + tapLeafScript). Mutually exclusive with the
   * ephemeral signing path; `ephemeralPrivKey` is ignored when set.
   */
  revealKeyXOnly?: Uint8Array;
  /** The parent inscription spent + returned by this reveal. */
  parent: ChildRevealParent;
  /** Address the CHILD inscription lands on (P2TR recommended). */
  recipientAddress: string;
  /** Optional tip output, appended after the child output. */
  tip?: { address: string; value: number };
  network: Network;
}

export interface ChildInscribeRevealResult {
  /**
   * The FULL reveal PSBT, used to FINALIZE + broadcast (not to hand to
   * the wallet). Input 0 (parent) is unsigned; input 1 (commit) carries
   * the ephemeral script-path signature as a partial tapScriptSig + the
   * envelope tapLeafScript. After the wallet signs input 0 on
   * `revealPsbtForWallet`, its signature is merged here and BOTH inputs
   * finalize (input 1 from the tapScriptSig).
   */
  revealPsbt: Uint8Array;
  /**
   * The reveal PSBT the WALLET signs. Byte-identical to `revealPsbt` in
   * its consensus fields (inputs, outputs, locktime) so input 0's sighash
   * matches, but input 1 is a BARE Taproot input (witnessUtxo only) — no
   * envelope tapLeafScript, no tapScriptSig. Some wallets' signPsbt hang
   * or reject when a PSBT contains a non-standard tap-leaf script on an
   * input they aren't even asked to sign; stripping it lets every wallet
   * sign input 0 cleanly. Input 0's signature is valid on `revealPsbt`
   * because the sighash commits to input 1's prevout (from witnessUtxo),
   * not its PSBT metadata.
   */
  revealPsbtForWallet: Uint8Array;
  /**
   * OKX-owned-commit mode only (`revealKeyXOnly` set). The single reveal
   * PSBT the wallet signs: BOTH inputs unsigned, input 1 carrying
   * witnessUtxo + tapInternalKey (= the wallet's ordinals key) +
   * tapLeafScript (the envelope leaf). The wallet signs input 0 key-path
   * (tweaked) and input 1 script-path (raw) in one call; the SDK finalizes
   * + broadcasts it directly. `undefined` in the default ephemeral mode.
   * In OKX mode `revealPsbt` and `revealPsbtForWallet` mirror this same
   * PSBT (there is no bare/full split — the wallet owns both inputs).
   */
  revealPsbtForOwnedCommit?: Uint8Array;
  /** Reveal txid (witness-independent; stable before the wallet signs). */
  revealTxid: string;
  /** Reveal vsize (fully-signed) for fee math. */
  revealVsize: number;
}

/**
 * Build the child reveal PSBT: parent input (unsigned) + commit input
 * (ephemeral-finalized), parent-return output + child output.
 */
export function buildChildInscribeRevealTx(args: ChildInscribeRevealArgs): ChildInscribeRevealResult {
  const scureNetwork = toScureNetwork(args.network);
  const postageSats = INSCRIBE_POSTAGE_SATS;
  const tipValueSats = args.tip?.value ?? 0;
  if (tipValueSats < 0 || !Number.isInteger(tipValueSats)) {
    throw new Error('tip.value must be a non-negative integer');
  }
  // Two build modes:
  //   - DEFAULT (ephemeral): the SDK holds a throwaway key, embeds its
  //     x-only pubkey in the envelope + commit internal key, and
  //     script-path-signs input 1 itself (partial tapScriptSig).
  //   - OKX-owned-commit (`revealKeyXOnly` set): the envelope + commit
  //     internal key ARE the wallet's own ordinals key, so the wallet
  //     script-path-signs input 1 in the SAME signPsbt call that key-path-
  //     signs input 0. The SDK holds no private key for input 1 and leaves
  //     it UNSIGNED (witnessUtxo + tapInternalKey + tapLeafScript).
  const okxOwnedCommitMode = args.revealKeyXOnly !== undefined;
  if (args.revealKeyXOnly !== undefined) {
    if (args.revealKeyXOnly.length !== 32) {
      throw new Error(`revealKeyXOnly must be a 32-byte x-only key; got ${args.revealKeyXOnly.length}`);
    }
  } else if (args.ephemeralPrivKey === undefined || args.ephemeralPrivKey.length !== 32) {
    throw new Error(`ephemeralPrivKey must be 32 bytes; got ${args.ephemeralPrivKey?.length}`);
  }
  if (!Number.isInteger(args.parent.utxo.value) || args.parent.utxo.value < postageSats) {
    throw new Error(
      `parent.utxo.value must be an integer >= ${postageSats} (its sats are preserved on return); ` +
      `got ${args.parent.utxo.value}`,
    );
  }
  if (args.parent.utxo.tapInternalKey.length !== 32) {
    throw new Error('parent.utxo.tapInternalKey must be a 32-byte x-only key (P2TR parent)');
  }

  const parentValue = args.parent.utxo.value;
  // The reveal miner fee is the leftover after the parent returns its own
  // sats and the child + tip are funded. commitOutputValue funds child
  // postage + reveal fee + tip; the parent's sats pass straight through.
  const revealFeeSats = (parentValue + args.commitOutputValueSats)
    - parentValue - postageSats - tipValueSats;
  if (revealFeeSats < 0) {
    throw new Error(
      `commitOutputValueSats (${args.commitOutputValueSats}) < postage (${postageSats}) + tip (${tipValueSats})`,
    );
  }

  const tx = new btc.Transaction({ disableScriptCheck: true, lockTime: CAT21_LOCK_TIME });

  // Input 0: parent UTXO (P2TR key-path). Left UNSIGNED — the wallet
  // signs it. witnessUtxo + tapInternalKey are what a wallet needs to
  // produce the key-path signature. SIGHASH_DEFAULT (omit sighashType)
  // per the SDK-wide BIP-341 wire-equivalent rule.
  tx.addInput({
    txid: args.parent.utxo.txid,
    index: args.parent.utxo.vout,
    witnessUtxo: {
      script: args.parent.utxo.scriptPubKey,
      amount: BigInt(parentValue),
    },
    tapInternalKey: args.parent.utxo.tapInternalKey,
  });

  // Input 1: commit P2TR output, spent script-path via the envelope leaf.
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

  // Output 0: parent RETURN — the parent inscription goes back to its
  // owner with exactly its incoming value (FIFO: input 0 → output 0).
  tx.addOutputAddress(args.parent.returnAddress, BigInt(parentValue), scureNetwork);

  // Output 1: child recipient (546). FIFO puts the child here (the commit
  // input's first sat is global `parentValue`, which lands in output 1).
  tx.addOutputAddress(args.recipientAddress, BigInt(postageSats), scureNetwork);

  // Output 2 (optional): tip, after the child.
  if (args.tip !== undefined && tipValueSats > 0) {
    tx.addOutputAddress(args.tip.address, BigInt(tipValueSats), scureNetwork);
  }

  // Leaf spend metadata (shared by both modes). The trailing-version-byte
  // handling mirrors the single-input reveal helper.
  const [cbStruct, leafScriptWithVersion] = args.taproot.tapLeafScript[0];
  const bareLeafScript = leafScriptWithVersion.subarray(0, -1);
  const leafVersion = leafScriptWithVersion[leafScriptWithVersion.length - 1] ?? 0xc0;
  const controlBlock = btc.TaprootControlBlock.encode(cbStruct);
  const commitInputIndex = 1;

  // Commit-input (index 1) signing differs by mode. `commitWitnessSig` is
  // the 64-byte Schnorr script-path signature that goes into the witness;
  // in OKX mode it is a placeholder used only to size the measurement clone.
  let commitWitnessSig: Uint8Array;
  if (okxOwnedCommitMode) {
    // OKX-owned-commit: the SDK cannot sign input 1 — it holds no private
    // key for `revealKeyXOnly` (the wallet's own ordinals key). Leave input
    // 1 UNSIGNED, carrying its witnessUtxo + tapInternalKey + tapLeafScript
    // (added above), so the wallet script-path-signs it in the same signPsbt
    // call that key-path-signs input 0. The dummy 64-byte sig is used ONLY
    // to size the measurement clone below: a SIGHASH_DEFAULT P2TR
    // script-path witness carries exactly a 64-byte Schnorr sig, so the
    // vsize is exact regardless of the real (wallet-produced) signature.
    commitWitnessSig = new Uint8Array(64);
  } else {
    // Ephemeral script-path signing of the COMMIT input. SIGHASH_DEFAULT
    // commits to ALL inputs + outputs, so the sighash needs every prevout
    // script + amount (parent AND commit). Manual finalize mirrors the
    // single-input reveal helper.
    const ephemeralPrivKey = args.ephemeralPrivKey;
    if (ephemeralPrivKey === undefined) {
      throw new Error('ephemeralPrivKey is required when revealKeyXOnly is not set');
    }
    const sighash = tx.preimageWitnessV1(
      commitInputIndex,
      [args.parent.utxo.scriptPubKey, args.commitOutputScript],
      btc.SignatureHash.DEFAULT,
      [BigInt(parentValue), BigInt(args.commitOutputValueSats)],
      undefined,
      bareLeafScript,
      leafVersion,
    );
    commitWitnessSig = schnorr.sign(sighash, ephemeralPrivKey);
    // Attach the ephemeral script-path signature as a PARTIAL sig
    // (tapScriptSig), NOT a finalScriptWitness. A PSBT that hands a wallet
    // an already-FINALIZED sibling input is rejected by the address-filter
    // signers (Unisat/Wizz) — their signPsbt won't produce a signing prompt
    // for such a PSBT. Left partial, every input is unfinalized when the
    // wallet sees it; the wallet signs input 0, and the shared
    // extract-wire-tx step finalizes BOTH inputs (input 0 from the wallet's
    // key-path sig, input 1 from this tapScriptSig via the tapLeafScript
    // set above). Index-based signers (Leather / cat21-wallet) reach the
    // same finalized witness. The measurement clone below still finalizes
    // input 1 directly so revealTxid / revealVsize are exact.
    const leafHash = btc.tapLeafHash(bareLeafScript, leafVersion);
    tx.updateInput(commitInputIndex, {
      tapScriptSig: [[{ pubKey: args.taproot.internalKey, leafHash }, commitWitnessSig]],
    }, true);
  }

  assertCat21LockTime(tx.lockTime);

  // Measure vsize + txid on a fully-signed CLONE: dummy 64-byte key-path
  // witness on the parent input + the script-path witness on the commit
  // (real ephemeral sig, or a dummy in OKX mode). A SIGHASH_DEFAULT P2TR
  // witness is exactly a 64-byte Schnorr sig, so the size is exact
  // regardless of the real signature. The txid is witness-independent, so
  // the clone's id equals what the signed reveal will produce.
  const clone = btc.Transaction.fromPSBT(tx.toPSBT(0), { allowUnknownInputs: true });
  clone.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] }, true);
  clone.updateInput(commitInputIndex, {
    finalScriptWitness: [commitWitnessSig, bareLeafScript, controlBlock],
  }, true);

  const revealPsbt = tx.toPSBT(0);

  if (okxOwnedCommitMode) {
    // `tx` already carries both inputs UNSIGNED, input 1 with its
    // tapLeafScript + tapInternalKey — exactly the PSBT the wallet signs
    // AND the SDK finalizes. No bare/full split: the wallet owns both
    // inputs, so it signs input 0 key-path and input 1 script-path in one
    // call.
    return {
      revealPsbt,
      revealPsbtForWallet: revealPsbt,
      revealPsbtForOwnedCommit: revealPsbt,
      revealTxid: clone.id,
      revealVsize: clone.vsize,
    };
  }

  // Wallet-facing PSBT (ephemeral mode): same consensus tx (inputs/outputs/
  // locktime), but input 1 is a BARE Taproot input — witnessUtxo only, no
  // tapLeafScript / tapScriptSig. The wallet signs input 0 here without ever
  // parsing the ord envelope tap-leaf (which hangs / is rejected by some
  // signPsbt implementations). Rebuilt fresh because scure's updateInput
  // merges and cannot clear an already-set field.
  const walletFacing = new btc.Transaction({ disableScriptCheck: true, lockTime: CAT21_LOCK_TIME });
  walletFacing.addInput({
    txid: args.parent.utxo.txid,
    index: args.parent.utxo.vout,
    witnessUtxo: { script: args.parent.utxo.scriptPubKey, amount: BigInt(parentValue) },
    tapInternalKey: args.parent.utxo.tapInternalKey,
  });
  walletFacing.addInput({
    txid: args.commitTxid,
    index: args.commitVout,
    witnessUtxo: { script: args.commitOutputScript, amount: BigInt(args.commitOutputValueSats) },
  });
  walletFacing.addOutputAddress(args.parent.returnAddress, BigInt(parentValue), scureNetwork);
  walletFacing.addOutputAddress(args.recipientAddress, BigInt(postageSats), scureNetwork);
  if (args.tip !== undefined && tipValueSats > 0) {
    walletFacing.addOutputAddress(args.tip.address, BigInt(tipValueSats), scureNetwork);
  }

  return {
    revealPsbt,
    revealPsbtForWallet: walletFacing.toPSBT(0),
    revealPsbtForOwnedCommit: undefined,
    revealTxid: clone.id,
    revealVsize: clone.vsize,
  };
}
