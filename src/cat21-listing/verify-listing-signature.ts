import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

import { buildListingMessage, ListingMessageFields } from './build-listing-message';

/**
 * Result of `verifyListingSignature`. On success, `ok: true` — the
 * BIP-322 signature is valid for the given ordinals address AND the
 * message it commits to matches the listing fields byte-for-byte.
 * On failure, `ok: false` with a `reason` code the caller (backend
 * insert path, frontend re-verifier) can log / show.
 */
export type VerifyListingSignatureResult =
  | { ok: true }
  | { ok: false; reason: VerifyListingRejectionReason; detail?: string };

export type VerifyListingRejectionReason =
  | 'malformed-signature'         // base64 / structure decode failed
  | 'unsupported-address-type'    // BIP-322 verify supports P2TR only in v1
  | 'invalid-address'             // ordinalsAddress doesn't decode as a Bitcoin address
  | 'signature-does-not-verify';  // schnorr.verify returned false

/**
 * Verify a BIP-322 "simple" signature over the canonical listing
 * message, for a P2TR ordinals address.
 *
 * P2TR is the only address type supported in v1 — every wallet the
 * SDK integrates today puts ordinals on taproot, so the caller can
 * always match. If a future wallet ever stores cats on a non-taproot
 * address, add a P2WPKH branch here (BIP-322 for P2WPKH is
 * mechanically similar; only the sighash + verify function change).
 *
 * ### The BIP-322 "simple" verification recipe
 *
 * BIP-322 defines two virtual transactions the signature commits to:
 *
 *   `to_spend`: a synthetic tx with input from an all-zeros outpoint
 *   whose scriptSig is `OP_0 PUSH32 tagged_hash("BIP0322-signed-
 *   message", message)`, and output paying to the signer's address.
 *
 *   `to_sign`: a synthetic tx spending `to_spend[0]`, with a single
 *   `OP_RETURN` output and a witness holding the wallet's signature.
 *
 * For a P2TR key-path spend, the witness stack is a single 64- or
 * 65-byte schnorr signature. The verifier:
 *
 *   1. Rebuilds `to_spend` from the message + signer's script.
 *   2. Rebuilds `to_sign` referencing `to_spend[0]`.
 *   3. Computes the BIP-341 taproot sighash for `to_sign` spending
 *      `to_spend[0]` under the wallet-supplied sighash byte.
 *   4. Runs `schnorr.verify(sig, sighash, xonly_pubkey)` where
 *      `xonly_pubkey` comes from decoding the P2TR address's
 *      witness program (bytes 2..34 of the scriptPubKey).
 *
 * See https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 * for the full spec.
 */
export function verifyListingSignature(args: {
  fields: ListingMessageFields;
  signatureBase64: string;
}): VerifyListingSignatureResult {
  const { fields, signatureBase64 } = args;
  // Field-shape validation (e.g. cats-bundle sanity, headline
  // membership, MAX_ASK_SATS) lives in buildListingMessage. A
  // caller who hands us structurally-broken fields cannot have a
  // signature that verifies against a canonical rebuild, so we
  // collapse a build-time throw into the same `signature-does-
  // not-verify` reason the caller already handles. Absent this,
  // any post-verify tamper test that changes a single field to an
  // internally-inconsistent value (e.g. the audit's `catNumber=999`
  // when cats=[42]) would throw instead of returning a result.
  let message: string;
  try {
    message = buildListingMessage(fields);
  } catch {
    return { ok: false, reason: 'signature-does-not-verify' };
  }
  const ordinalsAddress = fields.ordinalsAddress;

  // --- Decode the ordinals address to its scriptPubKey -----------------
  // Two SDK-supported networks (mainnet + testnet3); regtest is
  // ops-only. The address's HRP (`bc`/`tb`/`bcrt`) implies the
  // network, so we try mainnet then testnet.
  let scriptPubKey: Uint8Array;
  let xOnlyPubkey: Uint8Array;
  try {
    const decoded = decodeP2TRAddress(ordinalsAddress);
    scriptPubKey = decoded.scriptPubKey;
    xOnlyPubkey = decoded.xOnlyPubkey;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Distinguish "not a valid Bitcoin address" from "valid but not P2TR"
    // so the caller can surface the right message.
    if (/not p2tr|witness program|witness version/i.test(detail)) {
      return { ok: false, reason: 'unsupported-address-type', detail };
    }
    return { ok: false, reason: 'invalid-address', detail };
  }

  // --- Decode the base64 signature witness -----------------------------
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64.decode(signatureBase64);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed-signature',
      detail: `base64 decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Extract the schnorr signature from the wallet-returned bytes.
  // Wallets serialize BIP-322 witness stacks in two shapes:
  //   1. Raw witness: [64-byte or 65-byte sig]. Length is exactly 64
  //      (SIGHASH_DEFAULT) or 65 (explicit sighash byte suffix).
  //   2. Full BIP-322 witness serialization: [numItems=1, sigLen, sigBytes].
  //      Xverse + Leather use this shape; length starts with 0x01 (numItems),
  //      then 0x40 or 0x41 (sig length), then the sig bytes.
  let sig: Uint8Array;
  let sighashType: number;
  const isRawSig = signatureBytes.length === 64 || signatureBytes.length === 65;
  const isSerializedWitness =
    signatureBytes.length >= 3 &&
    signatureBytes[0] === 0x01 &&
    (signatureBytes[1] === 0x40 || signatureBytes[1] === 0x41);
  if (isRawSig) {
    sig = signatureBytes.slice(0, 64);
    sighashType = signatureBytes.length === 65 ? signatureBytes[64] : 0x00;
  } else if (isSerializedWitness) {
    const sigLen = signatureBytes[1]; // 0x40 or 0x41
    if (signatureBytes.length !== 2 + sigLen) {
      return {
        ok: false,
        reason: 'malformed-signature',
        detail: `serialized-witness length mismatch: declared ${sigLen}, got ${signatureBytes.length - 2}`,
      };
    }
    sig = signatureBytes.slice(2, 2 + 64);
    sighashType = sigLen === 0x41 ? signatureBytes[2 + 64] : 0x00;
  } else {
    return {
      ok: false,
      reason: 'malformed-signature',
      detail: `unrecognized signature payload shape (length=${signatureBytes.length})`,
    };
  }

  // --- Build the BIP-322 virtual transactions --------------------------
  const messageHash = bip322TaggedHash('BIP0322-signed-message', new TextEncoder().encode(message));
  const toSpend = buildToSpend(messageHash, scriptPubKey);
  const toSpendTxid = doubleSha256(toSpend);

  // to_sign taproot sighash. sighashType 0x00 = SIGHASH_DEFAULT (BIP-341
  // spec: default is behaviourally SIGHASH_ALL for key-path).
  const sighash = computeToSignTaprootSighash({
    toSpendTxid,
    prevScriptPubKey: scriptPubKey,
    sighashType,
  });

  // --- Verify --------------------------------------------------------
  const verified = schnorr.verify(sig, sighash, xOnlyPubkey);
  if (!verified) {
    return { ok: false, reason: 'signature-does-not-verify' };
  }
  return { ok: true };
}

// ---------- Internals ------------------------------------------------

function decodeP2TRAddress(address: string): { scriptPubKey: Uint8Array; xOnlyPubkey: Uint8Array } {
  // Try mainnet first, then testnet3. scure throws on mismatch; we
  // catch and retry the other network. bcrt addresses (regtest) fall
  // through — cats are mainnet-only in production, and regtest
  // wallets don't produce shareable listings.
  let scriptPubKey: Uint8Array | undefined;
  for (const network of [btc.NETWORK, btc.TEST_NETWORK]) {
    try {
      const decoded = btc.Address(network).decode(address);
      scriptPubKey = btc.OutScript.encode(decoded);
      break;
    } catch {
      // try next network
    }
  }
  if (!scriptPubKey) {
    throw new Error(`address ${JSON.stringify(address)} does not decode against mainnet or testnet3`);
  }
  // A P2TR scriptPubKey is exactly 34 bytes: OP_1 (0x51) + PUSH32 (0x20) + 32-byte xonly.
  if (scriptPubKey.length !== 34 || scriptPubKey[0] !== 0x51 || scriptPubKey[1] !== 0x20) {
    throw new Error(`not p2tr: scriptPubKey is not a taproot witness program`);
  }
  return { scriptPubKey, xOnlyPubkey: scriptPubKey.slice(2, 34) };
}

/**
 * BIP-322 tagged hash: `SHA256(SHA256(tag) || SHA256(tag) || data)`.
 * BIP-322 uses the tag `"BIP0322-signed-message"`.
 */
function bip322TaggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const buf = new Uint8Array(tagHash.length * 2 + data.length);
  buf.set(tagHash, 0);
  buf.set(tagHash, tagHash.length);
  buf.set(data, tagHash.length * 2);
  return sha256(buf);
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Serialize the BIP-322 `to_spend` virtual transaction (no witnesses).
 * The serialized bytes get double-SHA256'd to produce the txid that
 * `to_sign` references as its input.
 *
 * Layout per the BIP:
 *   version=0 (4 bytes LE)
 *   input count=1 (1 byte)
 *   input[0].outpoint.txid=0x00 * 32 (32 bytes)
 *   input[0].outpoint.vout=0xFFFFFFFF (4 bytes LE)
 *   input[0].scriptSig=varint(len) || OP_0 || PUSH32 || messageHash
 *   input[0].sequence=0 (4 bytes LE)
 *   output count=1 (1 byte)
 *   output[0].value=0 (8 bytes LE)
 *   output[0].scriptPubKey=varint(len) || scriptPubKey
 *   locktime=0 (4 bytes LE)
 */
function buildToSpend(messageHash: Uint8Array, scriptPubKey: Uint8Array): Uint8Array {
  // scriptSig = OP_0 (0x00) + PUSH32 (0x20) + 32-byte messageHash = 34 bytes total
  const scriptSig = new Uint8Array(34);
  scriptSig[0] = 0x00; // OP_0
  scriptSig[1] = 0x20; // PUSH 32 bytes
  scriptSig.set(messageHash, 2);

  const scriptSigVarInt = writeVarInt(scriptSig.length);
  const scriptPubKeyVarInt = writeVarInt(scriptPubKey.length);

  const parts: Uint8Array[] = [
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),           // version=0
    new Uint8Array([0x01]),                              // 1 input
    new Uint8Array(32),                                  // input[0] txid = 32 zero bytes
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),            // input[0] vout = 0xFFFFFFFF
    scriptSigVarInt,                                     // scriptSig length
    scriptSig,                                           // scriptSig bytes
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),            // input[0] sequence = 0
    new Uint8Array([0x01]),                              // 1 output
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),            // output[0] value = 0
    scriptPubKeyVarInt,                                  // scriptPubKey length
    scriptPubKey,                                        // scriptPubKey bytes
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),            // locktime = 0
  ];
  return concatBytes(parts);
}

/**
 * BIP-341 taproot key-path sighash for `to_sign` spending
 * `to_spend[0]`. We delegate to scure's `preimageWitnessV1` — the
 * same helper the SDK's other taproot flows use — but need to hand-
 * build a scure `Transaction` shape that mirrors `to_sign`.
 *
 * `to_sign` layout per BIP-322:
 *   version=0, locktime=0
 *   input[0]: prevOut=(to_spend_txid, 0), sequence=0, value=0
 *   output[0]: value=0, scriptPubKey=OP_RETURN
 */
function computeToSignTaprootSighash(args: {
  toSpendTxid: Uint8Array;
  prevScriptPubKey: Uint8Array;
  sighashType: number;
}): Uint8Array {
  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 0, lockTime: 0 });
  tx.addInput({
    txid: args.toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { script: args.prevScriptPubKey, amount: BigInt(0) },
  });
  // OP_RETURN scriptPubKey (single 0x6a byte).
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: BigInt(0) });
  // preimageWitnessV1 args:
  //   idx, prevOutScripts[], hashType, amounts[], ...
  return tx.preimageWitnessV1(
    0,
    [args.prevScriptPubKey],
    args.sighashType,
    [BigInt(0)],
  );
}

function writeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([
      0xfe,
      n & 0xff,
      (n >> 8) & 0xff,
      (n >> 16) & 0xff,
      (n >> 24) & 0xff,
    ]);
  }
  throw new Error(`varint too large for the tiny writer: ${n}`);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
