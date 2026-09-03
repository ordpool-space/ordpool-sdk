import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';

/**
 * Result of `verifyBip322Signature`. On success, `ok: true` — the
 * BIP-322 "simple" signature is valid for the given P2TR ordinals
 * address over the given UTF-8 message. On failure, `ok: false`
 * with a reason code the caller can log / surface.
 *
 * The reasons intentionally match the shape used by
 * `verifyListingSignature` so backend rejection error codes stay
 * uniform across every BIP-322 verification path.
 */
export type VerifyBip322SignatureResult =
  | { ok: true }
  | { ok: false; reason: VerifyBip322RejectionReason; detail?: string };

export type VerifyBip322RejectionReason =
  | 'malformed-signature'
  | 'unsupported-address-type'
  | 'invalid-address'
  | 'signature-does-not-verify';

/**
 * Verify a BIP-322 "simple" signature over an arbitrary UTF-8
 * message, for a P2TR ordinals address.
 *
 * P2TR is the only address type supported today — every wallet the
 * SDK integrates puts ordinals on taproot. If a future wallet stores
 * cats on a non-taproot address, add a P2WPKH branch here.
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
 *   4. Runs `schnorr.verify(sig, sighash, xonly_pubkey)`.
 *
 * See https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 * for the full spec.
 */
export function verifyBip322Signature(args: {
  address: string;
  message: string;
  signatureBase64: string;
}): VerifyBip322SignatureResult {
  const { address, message, signatureBase64 } = args;

  // Decode the address to its scriptPubKey. Two SDK-supported
  // networks (mainnet + testnet3); the HRP (`bc`/`tb`) implies the
  // network. bcrt (regtest) falls through — cats are mainnet-only
  // in production, and regtest wallets don't produce shareable
  // artifacts.
  let scriptPubKey: Uint8Array;
  let xOnlyPubkey: Uint8Array;
  try {
    const decoded = decodeP2TRAddress(address);
    scriptPubKey = decoded.scriptPubKey;
    xOnlyPubkey = decoded.xOnlyPubkey;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/not p2tr|witness program|witness version/i.test(detail)) {
      return { ok: false, reason: 'unsupported-address-type', detail };
    }
    return { ok: false, reason: 'invalid-address', detail };
  }

  // Decode the base64 signature payload.
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
  //   1. Raw witness: [64-byte or 65-byte sig].
  //   2. Full BIP-322 witness serialization: [numItems=1, sigLen, sig].
  //      Xverse + Leather use this shape.
  let sig: Uint8Array;
  // A taproot signature only carries an explicit sighash-type byte when it is
  // 65 bytes long (raw 64+1) or a serialized witness with sigLen 0x41. A bare
  // 64-byte sig is AMBIGUOUS: BIP-322 "simple" convention drops the trailing
  // byte for SIGHASH_DEFAULT, but Leather (and its forks, incl. cat21wallet)
  // compute the taproot sighash with SIGHASH_ALL (0x01) and still return the
  // bare 64 bytes. Both commit to the same single-input / single-output
  // BIP-322 virtual tx, so when the byte is absent we try BOTH sighash types —
  // there is no other input or output for them to disagree on, so accepting
  // either cannot verify a different message.
  let explicitSighashType: number | null;
  const isRawSig = signatureBytes.length === 64 || signatureBytes.length === 65;
  const isSerializedWitness =
    signatureBytes.length >= 3 &&
    signatureBytes[0] === 0x01 &&
    (signatureBytes[1] === 0x40 || signatureBytes[1] === 0x41);
  if (isRawSig) {
    sig = signatureBytes.slice(0, 64);
    explicitSighashType = signatureBytes.length === 65 ? signatureBytes[64] : null;
  } else if (isSerializedWitness) {
    const sigLen = signatureBytes[1];
    if (signatureBytes.length !== 2 + sigLen) {
      return {
        ok: false,
        reason: 'malformed-signature',
        detail: `serialized-witness length mismatch: declared ${sigLen}, got ${signatureBytes.length - 2}`,
      };
    }
    sig = signatureBytes.slice(2, 2 + 64);
    explicitSighashType = sigLen === 0x41 ? signatureBytes[2 + 64] : null;
  } else {
    return {
      ok: false,
      reason: 'malformed-signature',
      detail: `unrecognized signature payload shape (length=${signatureBytes.length})`,
    };
  }

  // Build the BIP-322 virtual transactions.
  const messageHash = bip322TaggedHash('BIP0322-signed-message', new TextEncoder().encode(message));
  const toSpend = buildToSpend(messageHash, scriptPubKey);
  const toSpendTxid = doubleSha256(toSpend);

  // With an explicit byte, verify exactly that sighash type; without one, the
  // sig is ambiguous, so try SIGHASH_DEFAULT (0x00) then SIGHASH_ALL (0x01).
  const candidateSighashTypes = explicitSighashType !== null ? [explicitSighashType] : [0x00, 0x01];
  for (const sighashType of candidateSighashTypes) {
    const sighash = computeToSignTaprootSighash({
      toSpendTxid,
      prevScriptPubKey: scriptPubKey,
      sighashType,
    });
    if (schnorr.verify(sig, sighash, xOnlyPubkey)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature-does-not-verify' };
}

// ---------- Internals (shared with verifyListingSignature) ---------------

function decodeP2TRAddress(address: string): { scriptPubKey: Uint8Array; xOnlyPubkey: Uint8Array } {
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
  if (scriptPubKey.length !== 34 || scriptPubKey[0] !== 0x51 || scriptPubKey[1] !== 0x20) {
    throw new Error(`not p2tr: scriptPubKey is not a taproot witness program`);
  }
  return { scriptPubKey, xOnlyPubkey: scriptPubKey.slice(2, 34) };
}

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

function buildToSpend(messageHash: Uint8Array, scriptPubKey: Uint8Array): Uint8Array {
  const scriptSig = new Uint8Array(34);
  scriptSig[0] = 0x00;
  scriptSig[1] = 0x20;
  scriptSig.set(messageHash, 2);
  const scriptSigVarInt = writeVarInt(scriptSig.length);
  const scriptPubKeyVarInt = writeVarInt(scriptPubKey.length);
  const parts: Uint8Array[] = [
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    new Uint8Array([0x01]),
    new Uint8Array(32),
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    scriptSigVarInt,
    scriptSig,
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    new Uint8Array([0x01]),
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
    scriptPubKeyVarInt,
    scriptPubKey,
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
  ];
  return concatBytes(...parts);
}

function computeToSignTaprootSighash(args: {
  toSpendTxid: Uint8Array;
  prevScriptPubKey: Uint8Array;
  sighashType: number;
}): Uint8Array {
  const tx = new btc.Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    version: 0,
    lockTime: 0,
  });
  tx.addInput({
    txid: args.toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { script: args.prevScriptPubKey, amount: BigInt(0) },
  });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: BigInt(0) });
  return tx.preimageWitnessV1(0, [args.prevScriptPubKey], args.sighashType, [BigInt(0)]);
}

function writeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  }
  throw new Error(`varint too large for the tiny writer: ${n}`);
}
