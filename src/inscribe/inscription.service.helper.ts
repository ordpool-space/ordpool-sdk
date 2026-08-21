import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { getAddressFormat, isInscribeSupportedPaymentAddress } from '../cat21-script/address-format';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

import {
  INSCRIBE_POSTAGE_SATS,
  buildInscribeCommitPsbt,
} from './inscription-commit.helper';
import {
  ORD_TAGS,
  buildInscriptionEnvelope,
  chunkFieldValue,
  encodeInscriptionId,
  encodeParentInscriptionId,
  encodePointerValue,
  encodeRuneCommitment,
  type OrdEnvelopeField,
} from './inscription-envelope';
import {
  prepareInscribeFundingInput,
} from './inscription-input-adapter';
import {
  buildInscribeRevealTx,
  deriveRevealPubkeyXonly,
} from './inscription-reveal.helper';
import {
  simulateInscribeFees,
  type SimulateInscribeFeesResult,
} from './inscription-fee.helper';

/**
 * Layer-4 orchestration entry: ties the envelope encoder + per-
 * wallet input adapter + commit/reveal builders + fee simulator
 * into a single createTransaction-style entry point.
 *
 * Mirrors `createTransaction` from `cat21.service.helper.ts`. The
 * caller hands in the funding UTXO + wallet payment context + the
 * inscription content + feeRate; we hand back an unsigned commit
 * PSBT + a default signed reveal hex + the **ephemeral key material**
 * needed to build any other reveal shape (redirect, RBF, recover-
 * to-self, bundle).
 *
 * # Free cats (the "ordpool inscribers get cats" design)
 *
 * Both the commit AND the reveal carry `nLockTime=21`, so cat21-ord
 * mints TWO cats per inscription:
 *   - Cat A: `<commitTxid>i0` — minted by the commit; ends up at
 *     the inscription's UTXO via FIFO transitivity through the
 *     reveal's input.
 *   - Cat B: `<revealTxid>i0` — minted by the reveal at the same
 *     satpoint. Post-jubilee chains tag Cat B with the `Vindicated`
 *     charm; it's otherwise a normal cat with a positive number.
 * Both cats stack on the inscription's 546-sat UTXO at the
 * recipient's address. No opt-out. See the commit helper's module
 * doc for the cat21-ord index mechanics.
 *
 * # Lifecycle
 *
 *  1. Generate fresh ephemeral keypair (32 random bytes).
 *  2. Derive Schnorr x-only pubkey — this doubles as the envelope's
 *     `<pubkey> CHECKSIG` prefix AND the taproot internal key of the
 *     commit output.
 *  3. Build envelope with caller's content + auto-prepended fields
 *     (note → tag 0x0f UTF-8; contentEncoding='br' → tag 0x09 "br")
 *     + any caller-supplied `envelopeFields`.
 *  4. Simulate fees (Layer 3): commitFee, revealFee,
 *     commitOutputValueSats (= postage + revealFee + tip.value),
 *     fundingRequirementSats.
 *  5. Build the commit PSBT at the resolved commitFee with
 *     `nLockTime=21` and the per-wallet sequence.
 *  6. Build a default reveal tx at the resolved revealFee using the
 *     ephemeral private key (recipient = `args.recipientAddress`,
 *     optional tip at vout[1], also `nLockTime=21`).
 *  7. Return the ephemeral key material so the caller can re-build
 *     the reveal under different parameters later if it wants to.
 *
 * # Bearer-key semantic
 *
 * `ephemeral.privKey` is a **bearer instrument**: anyone who holds
 * it can spend the commit output (redirect the inscription, RBF the
 * reveal, recover the postage to themselves, ...) until the commit
 * output is spent on chain. Treat it with the same care as any
 * other money-bearing key:
 *
 *   - Phase 1 storage: `localStorage` keyed by `commitTxid` is fine
 *     for typical low-value inscriptions. The key lives only
 *     between commit broadcast and reveal broadcast (seconds to
 *     hours typically).
 *   - For higher-value flows, encrypt at rest with the wallet
 *     password — same posture as any other hot key.
 *   - Lose the key with no reveal broadcast and the postage is
 *     permanently locked. Save it before discarding the result.
 *
 * This is byte-equivalent to the `ord` reference client's design
 * (`src/wallet/batch/plan.rs` lines 367-382 + 676-709) — ord
 * persists the ephemeral key into Bitcoin Core's wallet under a
 * `commit tx recovery key` label; we hand it to the consumer to
 * persist however it wants.
 */

export interface CreateInscribeTransactionsArgs {
  /** Funding UTXO. */
  paymentOutput: TxnOutput;
  /** Wallet's payment public key (33-byte compressed). */
  paymentPublicKey: Uint8Array;
  /** Wallet's payment address (where change returns). */
  paymentAddress: string;
  /** Where the inscription lands (P2TR recommended for ord theory). */
  recipientAddress: string;
  /** Inscription body bytes. */
  body: Uint8Array;
  /** MIME type. */
  contentType?: string;
  /** Optional extra ord tags (parent, metaprotocol, metadata...). */
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  /** sat/vB target. Applied identically to commit + reveal. */
  feeRatePerVbyte: number;
  /**
   * Which wallet will sign the commit. Drives the funding-input
   * sequence number on the commit (cat21wallet → RBF allowed; every
   * other wallet → RBF disabled). Optional; the safer non-RBF
   * sequence applies when omitted, which is what every third-party
   * wallet should ship anyway.
   *
   * Ordpool inscriptions ALWAYS build the commit with
   * `nLockTime=21` regardless of wallet — see the module-level
   * docstring for the "free cat for inscribers" design.
   */
  walletType?: KnownOrdinalWalletType;
  /**
   * Optional tip output appended at vout[1] of the reveal tx. The
   * inscription stays at vout[0] per ord's first-sat-of-first-output
   * rule. The commit's funding requirement grows by `tip.value` so
   * the reveal has the sats to fund the extra output.
   *
   * The SDK ships no default tip address — consumers (ordpool.space,
   * cat21.space, future inscribers) wire their own default. Pattern
   * mirrors `0xFlicker/ordinals`' `feeDestinations`, simplified to
   * one recipient and a fixed sats amount.
   */
  tip?: { address: string; value: number };
  /**
   * Optional Tag::Note (0x0f) string. Emitted as a UTF-8 envelope
   * field; ordpool-parser surfaces it on the inscription record.
   * The de-facto inscriber-tool watermark slot.
   *
   * When set, the SDK auto-builds the `{ tag: 0x0f, value: utf8(note) }`
   * field and prepends it to `envelopeFields`.
   */
  note?: string;
  /**
   * Optional parent inscription id (`<txid>i<index>`) for provenance
   * chains. Emitted as a Tag::Parent (0x03) envelope field.
   *
   * IMPORTANT: setting this ONLY emits the envelope tag. Ord treats
   * an inscription as a genuine child only when the reveal tx ALSO
   * spends the parent's UTXO as an input — which requires the
   * parent owner co-signing the reveal, a topology change this
   * builder does not model. Consumers using `parent` today get the
   * annotation (ordpool-parser surfaces the parent id), not the
   * provenance link. Full parent/child support needs its own
   * orchestrator.
   */
  parent?: string;
  /**
   * Optional body-encoding hint. When set to `'br'`, the SDK emits
   * the `content_encoding: br` envelope tag — signalling to indexers
   * that the body is brotli-compressed. The body must already be
   * brotli-compressed by the caller (use `compressBrotli` from
   * `inscribe-brotli.helper.ts`); this flag only emits the tag.
   *
   * Split between caller-side compression and SDK-side tag emission
   * because brotli encoders are environment-specific (Node `zlib`
   * vs browser `CompressionStream`) and benefit from being async,
   * but the inscribe builder is sync.
   */
  contentEncoding?: 'br';
  /**
   * Optional pointer (tag 0x02): the sat offset, within the reveal's
   * concatenated outputs, the inscription is assigned to. Emitted as
   * minimal little-endian bytes.
   *
   * TOPOLOGY CAVEAT: this builder's reveal has the inscription's own
   * 546-sat recipient output at vout[0] (plus an optional tip at
   * vout[1]). A pointer only lands on the inscription's UTXO when it
   * points inside that first output, i.e. `pointer < 546`. A larger
   * offset would move the inscription onto the tip output or past the
   * end of the outputs — unreachable / not what any single-inscription
   * caller wants — so values `>= 546` are rejected rather than
   * silently emitted. Default (unset) behaves like pointer 0.
   */
  pointer?: number;
  /**
   * Optional CBOR metadata (tag 0x05). Pass the ALREADY-CBOR-ENCODED
   * bytes — use the exported `encodeCborDeterministic(value)` helper
   * to turn a structured value into canonical CBOR first. Values over
   * 520 bytes are split across repeated tag-5 fields automatically
   * (ord concatenates them before decoding). Must be non-empty.
   */
  metadata?: Uint8Array;
  /**
   * Optional metaprotocol identifier (tag 0x07). Emitted as UTF-8
   * bytes (e.g. `'brc-20'`).
   */
  metaprotocol?: string;
  /**
   * Optional delegate inscription id (`<txid>i<index>`, tag 0x0b).
   * A delegate inscription typically carries an EMPTY body and points
   * at another inscription's content; ord serves the delegate's
   * content in its place. Unlike `parent`, this is functional with no
   * extra tx topology — the delegate link resolves purely from the
   * envelope tag. A body alongside a delegate is allowed (ord ignores
   * it when the delegate resolves) but the canonical shape is an
   * empty body.
   */
  delegate?: string;
  /**
   * Optional rune-name commitment (tag 0x0d) as the rune's u128 value.
   * Emitted as minimal little-endian bytes. The etching transaction
   * must later spend this inscription's UTXO. A pre-computed byte
   * value can go through `envelopeFields` instead.
   */
  rune?: bigint;
  /**
   * Optional CBOR properties (tag 0x11): gallery items + attributes.
   * Same contract as `metadata` — pass ALREADY-CBOR-ENCODED bytes
   * (`encodeCborDeterministic`), chunked automatically over 520 bytes.
   */
  properties?: Uint8Array;
  /**
   * Optional properties-encoding hint (tag 0x13). When `'br'`, signals
   * that the `properties` bytes are brotli-compressed. Only emitted
   * alongside `properties`.
   */
  propertyEncoding?: 'br';
  /** Network. */
  network: Network;
}

export interface CreateInscribeTransactionsResult {
  /** Unsigned commit PSBT — hand to the user's wallet for signing. */
  commitPsbt: Uint8Array;
  /**
   * Computed txid of the commit. SegWit txids are witness-independent,
   * so this matches what the wallet-signed commit will produce.
   */
  commitTxid: string;
  /** Signed, finalized reveal-tx hex. Self-contained; broadcast as-is. */
  revealHex: string;
  /** Computed txid of the reveal (lets consumers display/track before broadcast). */
  revealTxid: string;
  /** Commit-tx P2TR address (bech32m). */
  commitAddress: string;
  /** Final fees (sats), vsizes, and the funding requirement. */
  fees: SimulateInscribeFeesResult;
  /**
   * Ephemeral bearer key for the commit output. Authorises any
   * reveal-tx shape (default reveal, redirect, RBF, recover-to-
   * self, bundle) until the commit output is spent. SAVE BEFORE
   * DISCARDING THIS RESULT — losing the key with no reveal
   * broadcast locks the postage forever.
   */
  ephemeral: {
    /** 32-byte Schnorr private key. */
    privKey: Uint8Array;
    /** 32-byte x-only public key. Same key embedded in the envelope. */
    pubkeyXonly: Uint8Array;
  };
  /** Material the caller needs to rebuild the reveal tx under different parameters. */
  commit: {
    /** Commit output scriptPubKey. */
    outputScript: Uint8Array;
    /** Postage + revealFeeReserve at the commit output. */
    outputValueSats: number;
    /** Envelope tapscript bytes (the leaf the reveal spends through). */
    envelopeScript: Uint8Array;
  };
}

/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function modulo `randomPrivateKey`.
 *
 * The returned `ephemeral.privKey` is the bearer instrument for
 * the commit output — see the module-level lifecycle note for the
 * storage semantic.
 */
export function createInscribeTransactions(
  args: CreateInscribeTransactionsArgs,
): CreateInscribeTransactionsResult {
  if (args.feeRatePerVbyte <= 0) {
    throw new Error('feeRatePerVbyte must be positive');
  }
  // Refuse P2PKH funding inputs. The reveal is pre-built against the
  // commit's SIMULATION txid — witness-independent for segwit inputs
  // but NOT for legacy P2PKH, where the real signature lives in
  // `scriptSig` and changes the txid. A P2PKH inscribe would land
  // the commit but the reveal would broadcast against a non-existent
  // txid, locking the postage in the commit output forever (the
  // ephemeral reveal key is not returned to the caller). Consumers
  // should gate the UI with `isInscribeSupportedPaymentAddress` so
  // this throw is unreachable in practice.
  if (!isInscribeSupportedPaymentAddress(args.paymentAddress)) {
    throw new Error(
      `Legacy P2PKH payment addresses are not supported for inscribing ` +
      `(would lock the postage — see isInscribeSupportedPaymentAddress). ` +
      `Switch the wallet to Native SegWit or Taproot and retry.`,
    );
  }
  if (args.tip !== undefined) {
    if (!Number.isInteger(args.tip.value) || args.tip.value < 0) {
      throw new Error('tip.value must be a non-negative integer');
    }
    if (typeof args.tip.address !== 'string' || args.tip.address.length === 0) {
      throw new Error('tip.address must be a non-empty string');
    }
  }

  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPubkeyXonly = deriveRevealPubkeyXonly(ephemeralPrivKey);

  // Synthesise envelope fields from the convenience args and prepend
  // to the caller-supplied envelopeFields. On duplicate tags (e.g.
  // caller also supplies a parent entry) BOTH entries are emitted in
  // order — ord's decoder handles multiple instances per tag according
  // to that tag's semantics: `parent` / `delegate` accumulate,
  // `content_type` / `content_encoding` first-wins (so caller-supplied
  // values behind an auto-field are ignored by downstream indexers).
  // Caller-side dedup is the consumer's responsibility.
  const autoFields = synthesizeEnvelopeFields(args);
  const mergedFields: ReadonlyArray<OrdEnvelopeField> = autoFields.length === 0
    ? (args.envelopeFields ?? [])
    : [...autoFields, ...(args.envelopeFields ?? [])];

  const envelope = buildInscriptionEnvelope({
    revealPubkeyXonly: ephemeralPubkeyXonly,
    contentType: args.contentType,
    body: args.body,
    fields: mergedFields,
  });

  // Layer-2: convert raw UTXO into the funding-input shape the
  // commit helper expects. Real-mode (not simulation) so the
  // funding gets signed by the real wallet later.
  const realFundingInput = prepareInscribeFundingInput({
    utxo: args.paymentOutput,
    paymentPublicKey: args.paymentPublicKey,
    paymentAddress: args.paymentAddress,
    isSimulation: false,
    network: args.network,
  });

  // Layer-3: simulate fees. Layer 3 uses its own simulation-mode
  // funding input via the dummy keypair pattern.
  const simulationFundingInput = prepareInscribeFundingInput({
    utxo: args.paymentOutput,
    paymentPublicKey: args.paymentPublicKey,
    paymentAddress: args.paymentAddress,
    isSimulation: true,
    network: args.network,
  });
  let fees: SimulateInscribeFeesResult;
  try {
    fees = simulateInscribeFees({
      feeRatePerVbyte: args.feeRatePerVbyte,
      body: args.body,
      contentType: args.contentType,
      envelopeFields: mergedFields,
      fundingInput: simulationFundingInput,
      senderChangeAddress: args.paymentAddress,
      recipientAddress: args.recipientAddress,
      ephemeralPubkeyXonly,
      tip: args.tip,
      walletType: args.walletType,
      network: args.network,
    });
  } catch (err) {
    // The commit helper throws `Funding insufficient: ...` when the
    // funding UTXO is below the postage + fees floor. Re-cast to
    // the orchestrator's typed message so consumers can branch on it
    // (same translation pattern cat21's createTransaction uses).
    if (err instanceof Error && /Funding insufficient/.test(err.message)) {
      throw new Error('Insufficient funds for inscribe');
    }
    throw err;
  }

  if (args.paymentOutput.value < fees.fundingRequirementSats) {
    throw new Error(
      `Insufficient funds for inscribe: funding UTXO has ${args.paymentOutput.value} ` +
      `sats, need ${fees.fundingRequirementSats} ` +
      `(commit fee ${fees.commitFeeSats} + commit output value ` +
      `${fees.commitOutputValueSats})`
    );
  }

  // Layer-1 build at resolved fees.
  const changeDustLimitSats = changeDustLimitFor(args.paymentAddress);
  const commit = buildInscribeCommitPsbt({
    fundingInput: realFundingInput,
    senderChangeAddress: args.paymentAddress,
    envelopeScript: envelope,
    ephemeralPubkeyXonly,
    commitFeeSats: fees.commitFeeSats,
    revealFeeReserveSats: fees.revealFeeSats,
    tipValueSats: args.tip?.value,
    walletType: args.walletType,
    changeDustLimitSats,
    network: args.network,
  });

  // The reveal's input outpoint references the commit's txid.
  // scure 1.2.x's `.id` requires a finalized tx; the real commit
  // is unsigned because the user's wallet hasn't signed yet. We
  // build a SIMULATION-mode commit at the same fees against the
  // dummy-keyed funding input, dummy-sign it, finalize, read its
  // txid. SegWit txid is witness-independent, so the sim txid
  // equals what the wallet-signed real commit will produce
  // byte-for-byte at the same inputs/outputs.
  const simCommit = buildInscribeCommitPsbt({
    fundingInput: simulationFundingInput,
    senderChangeAddress: args.paymentAddress,
    envelopeScript: envelope,
    ephemeralPubkeyXonly,
    commitFeeSats: fees.commitFeeSats,
    revealFeeReserveSats: fees.revealFeeSats,
    tipValueSats: args.tip?.value,
    walletType: args.walletType,
    changeDustLimitSats,
    network: args.network,
  });
  const simTx = btc.Transaction.fromPSBT(simCommit.commitPsbt);
  const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(args.network));
  simTx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
  simTx.finalize();
  const commitTxidUnsigned = simTx.id;

  const reveal = buildInscribeRevealTx({
    commitTxid: commitTxidUnsigned,
    commitVout: 0,
    commitOutputValueSats: commit.commitOutputValueSats,
    commitOutputScript: commit.commitOutputScript,
    taproot: {
      internalKey: commit.taproot.internalKey,
      tapLeafScript: commit.taproot.tapLeafScript,
    },
    ephemeralPrivKey,
    recipientAddress: args.recipientAddress,
    tip: args.tip,
    network: args.network,
  });

  return {
    commitPsbt: commit.commitPsbt,
    commitTxid: commitTxidUnsigned,
    revealHex: reveal.revealHex,
    revealTxid: reveal.revealTxid,
    commitAddress: commit.commitAddress,
    fees,
    ephemeral: {
      privKey: ephemeralPrivKey,
      pubkeyXonly: ephemeralPubkeyXonly,
    },
    commit: {
      outputScript: commit.commitOutputScript,
      outputValueSats: commit.commitOutputValueSats,
      envelopeScript: envelope,
    },
  };
}

/**
 * Turn the convenience args (pointer, metadata, metaprotocol, parent,
 * delegate, rune, note, contentEncoding, properties, propertyEncoding)
 * into ord envelope fields in the exact byte form ord expects. Each
 * value is validated here; large CBOR payloads (metadata / properties)
 * are chunked across repeated same-tag fields so no single push
 * exceeds the 520-byte cap. Field ORDER doesn't affect the resolved
 * inscription (ord indexes by tag), but a stable order keeps the
 * encoded envelope diff-friendly.
 */
function synthesizeEnvelopeFields(args: CreateInscribeTransactionsArgs): OrdEnvelopeField[] {
  const fields: OrdEnvelopeField[] = [];

  if (args.pointer !== undefined) {
    // Topology gate: this builder places the inscription's 546-sat
    // recipient output at vout[0]. A pointer must point inside that
    // output to land on the inscription's own UTXO. Reject an
    // unreachable offset rather than emit a pointer that silently
    // moves the inscription off its cat-bearing UTXO.
    if (args.pointer >= INSCRIBE_POSTAGE_SATS) {
      throw new Error(
        `pointer ${args.pointer} is unreachable: this builder's reveal has a single ` +
        `${INSCRIBE_POSTAGE_SATS}-sat inscription output at vout[0], so pointer must be < ${INSCRIBE_POSTAGE_SATS}.`,
      );
    }
    fields.push({ tag: ORD_TAGS.pointer, value: encodePointerValue(args.pointer) });
  }

  if (args.contentEncoding === 'br') {
    fields.push({ tag: ORD_TAGS.content_encoding, value: new TextEncoder().encode('br') });
  }

  if (args.metaprotocol !== undefined) {
    fields.push({ tag: ORD_TAGS.metaprotocol, value: new TextEncoder().encode(args.metaprotocol) });
  }

  if (args.parent !== undefined) {
    fields.push({ tag: ORD_TAGS.parent, value: encodeParentInscriptionId(args.parent) });
  }

  if (args.delegate !== undefined) {
    fields.push({ tag: ORD_TAGS.delegate, value: encodeInscriptionId(args.delegate) });
  }

  if (args.metadata !== undefined) {
    if (!ArrayBuffer.isView(args.metadata)) {
      throw new Error('metadata must be a Uint8Array of pre-encoded CBOR (use encodeCborDeterministic)');
    }
    if (args.metadata.length === 0) {
      throw new Error('metadata must be non-empty CBOR bytes');
    }
    fields.push(...chunkFieldValue(ORD_TAGS.metadata, args.metadata));
  }

  if (args.rune !== undefined) {
    fields.push({ tag: ORD_TAGS.rune, value: encodeRuneCommitment(args.rune) });
  }

  if (args.properties !== undefined) {
    if (!ArrayBuffer.isView(args.properties)) {
      throw new Error('properties must be a Uint8Array of pre-encoded CBOR (use encodeCborDeterministic)');
    }
    if (args.properties.length === 0) {
      throw new Error('properties must be non-empty CBOR bytes');
    }
    fields.push(...chunkFieldValue(ORD_TAGS.properties, args.properties));
  }

  if (args.propertyEncoding === 'br') {
    if (args.properties === undefined) {
      throw new Error('propertyEncoding is only valid alongside properties');
    }
    fields.push({ tag: ORD_TAGS.property_encoding, value: new TextEncoder().encode('br') });
  }

  if (args.note !== undefined) {
    fields.push({ tag: ORD_TAGS.note, value: new TextEncoder().encode(args.note) });
  }

  return fields;
}

/** Per-address-type dust limit, mirroring `getMinimumUtxoSize`. */
function changeDustLimitFor(address: string): number {
  const fmt = getAddressFormat(address);
  switch (fmt) {
    case 'P2TR': return 330;
    case 'P2WPKH': return 294;
    case 'P2SH???':
    case 'P2PKH': return 546;
  }
}
