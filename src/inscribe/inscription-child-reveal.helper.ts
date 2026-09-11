import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { CAT21_LOCK_TIME, assertCat21LockTime } from '../cat21-protocol/cat21-lock-time';
import { getMinimumUtxoSize } from '../cat21-script/address-format';
import { resolveInscribePostage } from './inscription-commit.helper';
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
  /** Postage for the CHILD inscription output. MUST equal the commit's. Default 546. */
  postageSats?: number;
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
  /** 32-byte ephemeral private key (same key embedded in the envelope). */
  ephemeralPrivKey: Uint8Array;
  /** The parent inscription spent + returned by this reveal. One of `parent` / `parents`. */
  parent?: ChildRevealParent;
  /**
   * Several parents, spent at inputs 0..N-1 in this order and returned at
   * outputs 0..N-1 with their own values, as ord's batch does. One of
   * `parent` / `parents`.
   */
  parents?: ReadonlyArray<ChildRevealParent>;
  /** Address the CHILD inscription lands on (P2TR recommended). Required unless `inscriptionOutputs` is given. */
  recipientAddress?: string;
  /**
   * The child outputs after the parent returns, replacing the single
   * `recipientAddress` output at `postageSats` (a batch of children).
   */
  inscriptionOutputs?: ReadonlyArray<{ address: string; value: number }>;
  /**
   * UTXOs the reveal also spends, after the parents and before the commit,
   * whose value funds the inscription outputs instead of the commit: ord's
   * `satpoints` batch mode, where each inscription lands on the first sat of
   * one of these (plan.rs, `reveal_satpoints`). Signed by the wallet like the
   * parents, and not returned.
   */
  satpointInputs?: ReadonlyArray<ChildRevealParent['utxo']>;
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
  const tipValueSats = args.tip?.value ?? 0;
  if (tipValueSats < 0 || !Number.isInteger(tipValueSats)) {
    throw new Error('tip.value must be a non-negative integer');
  }
  if (args.ephemeralPrivKey.length !== 32) {
    throw new Error(`ephemeralPrivKey must be 32 bytes; got ${args.ephemeralPrivKey.length}`);
  }
  if (args.parent !== undefined && args.parents !== undefined) {
    throw new Error('pass one of parent / parents, not both');
  }
  const parents = args.parents ?? (args.parent !== undefined ? [args.parent] : []);
  const satpointInputs = args.satpointInputs ?? [];
  if (parents.length === 0 && satpointInputs.length === 0) {
    throw new Error('a child reveal spends at least one parent or satpoint input');
  }
  let outputs: ReadonlyArray<{ address: string; value: number }>;
  if (args.inscriptionOutputs !== undefined) {
    if (args.inscriptionOutputs.length === 0) throw new Error('inscriptionOutputs must not be empty');
    outputs = args.inscriptionOutputs;
  } else {
    if (args.recipientAddress === undefined) {
      throw new Error('recipientAddress is required unless inscriptionOutputs is given');
    }
    outputs = [{ address: args.recipientAddress, value: resolveInscribePostage(args.postageSats) }];
  }
  const postageSats = outputs.reduce((sum, o) => sum + o.value, 0);
  for (const parent of parents) {
    // The parent returns with exactly its value, as its own reveal output,
    // so it must clear that output's dust limit (ord refuses a dust reveal
    // output: "commit transaction output would be dust").
    const dust = getMinimumUtxoSize(parent.returnAddress);
    if (!Number.isInteger(parent.utxo.value) || parent.utxo.value < dust) {
      throw new Error(
        `parent.utxo.value must be an integer >= ${dust}, the dust limit of its return address ` +
        `(its sats are preserved on return); got ${parent.utxo.value}`,
      );
    }
    if (parent.utxo.tapInternalKey.length !== 32) {
      throw new Error('parent.utxo.tapInternalKey must be a 32-byte x-only key (P2TR parent)');
    }
  }

  for (const utxo of satpointInputs) {
    if (!Number.isInteger(utxo.value) || utxo.value <= 0) {
      throw new Error(`satpoint input value must be a positive integer; got ${utxo.value}`);
    }
    if (utxo.tapInternalKey.length !== 32) {
      throw new Error('satpoint input tapInternalKey must be a 32-byte x-only key (P2TR)');
    }
  }

  // The reveal miner fee is what the commit and the satpoint inputs bring in,
  // minus the children and the tip. The parents' sats pass straight through
  // (input i -> output i), so they never enter the fee arithmetic.
  const satpointSats = satpointInputs.reduce((sum, u) => sum + u.value, 0);
  const revealFeeSats = args.commitOutputValueSats + satpointSats - postageSats - tipValueSats;
  if (revealFeeSats < 0) {
    throw new Error(
      `commitOutputValueSats (${args.commitOutputValueSats}) + satpoint inputs (${satpointSats}) ` +
      `< postage (${postageSats}) + tip (${tipValueSats})`,
    );
  }

  // Inputs 0..N-1: the parents, then the commit; outputs 0..N-1: the parent
  // returns, then the children, then the tip. `bare` leaves the commit input
  // without its envelope leaf, for the wallet-facing copy.
  // Wallet-signed inputs: the parents, then the satpoint inputs.
  const walletUtxos = [...parents.map(p => p.utxo), ...satpointInputs];
  const commitInputIndex = walletUtxos.length;
  const assemble = (bare: boolean): btc.Transaction => {
    const t = new btc.Transaction({ disableScriptCheck: true, lockTime: CAT21_LOCK_TIME });
    // Parent inputs (P2TR key-path). Left UNSIGNED: the wallet signs them.
    // witnessUtxo + tapInternalKey are what a wallet needs to produce the
    // key-path signature. SIGHASH_DEFAULT (omit sighashType) per the
    // SDK-wide BIP-341 wire-equivalent rule.
    for (const utxo of walletUtxos) {
      t.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script: utxo.scriptPubKey, amount: BigInt(utxo.value) },
        tapInternalKey: utxo.tapInternalKey,
      });
    }
    // Commit P2TR output, spent script-path via the envelope leaf.
    t.addInput({
      txid: args.commitTxid,
      index: args.commitVout,
      witnessUtxo: { script: args.commitOutputScript, amount: BigInt(args.commitOutputValueSats) },
      ...(bare ? {} : { tapInternalKey: args.taproot.internalKey, tapLeafScript: args.taproot.tapLeafScript }),
    });
    // Parent RETURNS: each parent goes back to its owner with exactly its
    // incoming value (FIFO: input i -> output i).
    for (const parent of parents) {
      t.addOutputAddress(parent.returnAddress, BigInt(parent.utxo.value), scureNetwork);
    }
    // Children. FIFO puts the first child at the commit input's first sat,
    // global offset = sum of parent values = the start of the first child
    // output; batch children carry pointers to their own outputs.
    for (const output of outputs) {
      t.addOutputAddress(output.address, BigInt(output.value), scureNetwork);
    }
    // Tip, after the children.
    if (args.tip !== undefined && tipValueSats > 0) {
      t.addOutputAddress(args.tip.address, BigInt(tipValueSats), scureNetwork);
    }
    return t;
  };
  const tx = assemble(false);

  // Ephemeral script-path finalization of the COMMIT input. SIGHASH_DEFAULT
  // commits to ALL inputs + outputs, so the sighash needs every prevout
  // script + amount (parents AND commit). Manual finalize mirrors the
  // single-input reveal helper; see its comment for the trailing-version-
  // byte handling on the leaf script.
  const [cbStruct, leafScriptWithVersion] = args.taproot.tapLeafScript[0];
  const bareLeafScript = leafScriptWithVersion.subarray(0, -1);
  const leafVersion = leafScriptWithVersion[leafScriptWithVersion.length - 1] ?? 0xc0;
  const sighash = tx.preimageWitnessV1(
    commitInputIndex,
    [...walletUtxos.map(u => u.scriptPubKey), args.commitOutputScript],
    btc.SignatureHash.DEFAULT,
    [...walletUtxos.map(u => BigInt(u.value)), BigInt(args.commitOutputValueSats)],
    undefined,
    bareLeafScript,
    leafVersion,
  );
  const signature = schnorr.sign(sighash, args.ephemeralPrivKey);
  const controlBlock = btc.TaprootControlBlock.encode(cbStruct);
  // Attach the ephemeral script-path signature as a PARTIAL sig
  // (tapScriptSig), NOT a finalScriptWitness. A PSBT that hands a wallet
  // an already-FINALIZED sibling input is rejected by the address-filter
  // signers (Unisat/Wizz/OKX) — their signPsbt won't produce a signing
  // prompt for such a PSBT. Left partial, every input is unfinalized when
  // the wallet sees it; the wallet signs the parent inputs, and the shared
  // extract-wire-tx step finalizes every input (the parents from the
  // wallet's key-path sigs, the commit from this tapScriptSig via the
  // tapLeafScript set above). Index-based signers (Leather / cat21-wallet)
  // reach the same finalized witness. The measurement clone below still
  // finalizes the commit input directly so revealTxid / revealVsize are exact.
  const leafHash = btc.tapLeafHash(bareLeafScript, leafVersion);
  tx.updateInput(commitInputIndex, {
    tapScriptSig: [[{ pubKey: args.taproot.internalKey, leafHash }, signature]],
  }, true);

  assertCat21LockTime(tx.lockTime);

  // Measure vsize + txid on a fully-signed CLONE: set a dummy 64-byte
  // key-path witness on each parent input (a SIGHASH_DEFAULT P2TR witness is
  // exactly a 64-byte Schnorr sig, so the size is exact regardless of the
  // real signature). The txid is witness-independent, so the clone's id
  // equals what the wallet-signed reveal will produce.
  const clone = btc.Transaction.fromPSBT(tx.toPSBT(0), { allowUnknownInputs: true });
  for (let i = 0; i < walletUtxos.length; i++) {
    clone.updateInput(i, { finalScriptWitness: [new Uint8Array(64)] }, true);
  }
  clone.updateInput(commitInputIndex, {
    finalScriptWitness: [signature, bareLeafScript, controlBlock],
  }, true);

  // Wallet-facing PSBT: same consensus tx (inputs/outputs/locktime), but the
  // commit input is a BARE Taproot input — witnessUtxo only, no
  // tapLeafScript / tapScriptSig. The wallet signs the parent inputs here
  // without ever parsing the ord envelope tap-leaf (which hangs / is
  // rejected by some signPsbt implementations). Built fresh because scure's
  // updateInput merges and cannot clear an already-set field.
  const walletFacing = assemble(true);

  return {
    revealPsbt: tx.toPSBT(0),
    revealPsbtForWallet: walletFacing.toPSBT(0),
    revealTxid: clone.id,
    revealVsize: clone.vsize,
  };
}
