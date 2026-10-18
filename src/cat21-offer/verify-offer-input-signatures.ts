import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

/**
 * Cryptographic signature verification for a buy-offer PSBT, the half the
 * structural validator (`validateCat21BuyOfferPsbt`) cannot do on its own.
 *
 * The structural validator only proves a signature is PRESENT and carries a
 * SIGHASH_ALL-equivalent flag. That is not proof the bytes are a real
 * signature: a bid can carry 64 random bytes as `tapKeySig` and a lied-about
 * `witnessUtxo.amount`, pass every structural check, and stand in the orderbook
 * as a top bid it could never actually settle (or overwrite a real bidder's
 * row). This module closes that: given the TRUE prevouts (fetched from the
 * chain by the caller, never trusted from the PSBT), it
 *
 *   1. compares each input's `witnessUtxo` script and amount to the chain
 *      prevout, exactly (a lying witnessUtxo is rejected, not merely ignored);
 *   2. recomputes the BIP-143 / BIP-341 sighash over the CHAIN prevouts and
 *      verifies the embedded signature against it with @noble (ECDSA for
 *      segwit-v0, Schnorr for taproot key-path).
 *
 * It is PURE: the caller supplies the prevouts, so the SDK stays framework- and
 * I/O-free (the backend reads electrs and passes a map; a spec passes a map it
 * built by signing with a known key). Only the inputs that carry a signature
 * are cryptographically checked — in a bid that is the buyer's funding inputs
 * (1..N); input 0 (the seller's cat) is unsigned until the seller accepts, so
 * only its prevout script/amount are pinned here, which is what keeps the
 * net-price gate honest.
 *
 * Taproot key-path verification needs EVERY input's prevout (the v1 sighash
 * commits to all of them), so the map must cover input 0 too, not only the
 * signed buyer inputs.
 */

export interface OfferPrevout {
  /** The prevout's scriptPubKey, exactly as it appears on chain. */
  script: Uint8Array;
  /** The prevout's value in sats. */
  amountSats: number;
}

/** Prevouts keyed by `"<txid>:<vout>"`, txid in display (big-endian) hex. */
export type OfferPrevouts = Map<string, OfferPrevout>;

export type OfferSignatureRejectionReason =
  | 'prevout-missing'          // no chain prevout supplied for an input the sighash needs
  | 'prevout-script-mismatch'  // witnessUtxo.script != the chain prevout
  | 'prevout-amount-mismatch'  // witnessUtxo.amount != the chain prevout
  | 'unsupported-input-type'   // a signed input whose prevout is not P2TR or P2WPKH
  | 'signature-missing'        // a buyer input with no decodable signature bytes
  | 'signature-invalid';       // the signature does not verify against the real sighash

export type OfferSignatureVerification =
  | { ok: true }
  | { ok: false; reason: OfferSignatureRejectionReason; detail: string; inputIndex: number };

/** `"<txid>:<vout>"` from a scure input, txid hex-encoded in display order. */
function outpointKey(input: ReturnType<btc.Transaction['getInput']>): string {
  const txid = input.txid ? hex.encode(input.txid) : '';
  return `${txid}:${input.index}`;
}

function isP2tr(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}

function isP2wpkh(script: Uint8Array): boolean {
  return script.length === 22 && script[0] === 0x00 && script[1] === 0x14;
}

/** The segwit-v0 scriptCode for a P2WPKH prevout: the classic P2PKH script of the key hash. */
function p2wpkhScriptCode(prevoutScript: Uint8Array): Uint8Array {
  const keyHash = prevoutScript.slice(2); // drop OP_0 PUSH20
  const out = new Uint8Array(25);
  out[0] = 0x76; // OP_DUP
  out[1] = 0xa9; // OP_HASH160
  out[2] = 0x14; // PUSH20
  out.set(keyHash, 3);
  out[23] = 0x88; // OP_EQUALVERIFY
  out[24] = 0xac; // OP_CHECKSIG
  return out;
}

function fail(
  reason: OfferSignatureRejectionReason,
  detail: string,
  inputIndex: number,
): OfferSignatureVerification {
  return { ok: false, reason, detail, inputIndex };
}

/**
 * Verify every signed input of a buy-offer transaction against the supplied
 * chain prevouts. Returns `{ ok: true }` only when every input's witnessUtxo
 * matches the chain AND every present signature verifies.
 *
 * @param tx       a parsed buy-offer PSBT (`btc.Transaction.fromPSBT`)
 * @param prevouts the TRUE prevouts for all inputs, keyed `"<txid>:<vout>"`
 */
export function verifyOfferInputSignatures(
  tx: btc.Transaction,
  prevouts: OfferPrevouts,
): OfferSignatureVerification {
  const n = tx.inputsLength;

  // Build the per-input prevout script/amount arrays the v1 (taproot) sighash
  // needs. Every input must have a chain prevout: a missing one means we cannot
  // compute the sighash honestly, so fail closed rather than fall back to the
  // PSBT's own (attacker-controlled) witnessUtxo.
  const scripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const input = tx.getInput(i);
    const prevout = prevouts.get(outpointKey(input));
    if (!prevout) {
      return fail('prevout-missing', `no chain prevout for input ${i} (${outpointKey(input)})`, i);
    }
    // Pin the PSBT's declared witnessUtxo to the chain, exactly. A buyer who
    // lies here to inflate the seller's apparent contribution (legacy sighash)
    // or to pass a shape check is rejected before any value is trusted.
    const wu = input.witnessUtxo;
    if (wu) {
      if (!equalBytes(wu.script, prevout.script)) {
        return fail('prevout-script-mismatch', `input ${i} witnessUtxo.script != chain prevout`, i);
      }
      if (Number(wu.amount) !== prevout.amountSats) {
        return fail(
          'prevout-amount-mismatch',
          `input ${i} witnessUtxo.amount ${Number(wu.amount)} != chain ${prevout.amountSats}`,
          i,
        );
      }
    }
    scripts.push(prevout.script);
    amounts.push(BigInt(prevout.amountSats));
  }

  // Verify every input that carries a signature. Input 0 (seller cat) is
  // unsigned in a bid, so it contributes its prevout above but no signature
  // here; the buyer funding inputs (1..N) are the signed ones.
  for (let i = 0; i < n; i++) {
    const input = tx.getInput(i);
    const prevout = prevouts.get(outpointKey(input))!; // present: checked above

    const hasTapKeySig = !!(input.tapKeySig && input.tapKeySig.length > 0);
    const hasPartialSig = !!(input.partialSig && input.partialSig.length > 0);
    if (!hasTapKeySig && !hasPartialSig) {
      continue; // unsigned input (e.g. seller input 0): prevout pinned, nothing to verify
    }

    if (isP2tr(prevout.script)) {
      const sigBytes = input.tapKeySig!;
      // 64-byte sig = SIGHASH_DEFAULT; 65-byte carries the flag in the last byte.
      const sig = sigBytes.length === 65 ? sigBytes.slice(0, 64) : sigBytes;
      const hashType = sigBytes.length === 65 ? sigBytes[64] : btc.SigHash.DEFAULT;
      const msg = tx.preimageWitnessV1(i, scripts, hashType, amounts);
      const xOnlyPubkey = prevout.script.slice(2); // OP_1 PUSH32 <x-only key>
      if (!schnorr.verify(sig, msg, xOnlyPubkey)) {
        return fail('signature-invalid', `input ${i} taproot schnorr signature does not verify`, i);
      }
      continue;
    }

    if (isP2wpkh(prevout.script)) {
      if (!hasPartialSig) {
        return fail('signature-missing', `input ${i} P2WPKH carries no partialSig`, i);
      }
      // partialSig entries are [pubkey, sig||flag] per BIP-174; a single-sig
      // P2WPKH has exactly one.
      for (const [pubKey, sigWithFlag] of input.partialSig!) {
        const der = sigWithFlag.slice(0, -1);
        const hashType = sigWithFlag[sigWithFlag.length - 1];
        const scriptCode = p2wpkhScriptCode(prevout.script);
        const digest = tx.preimageWitnessV0(i, scriptCode, hashType, BigInt(prevout.amountSats));
        let verified: boolean;
        try {
          // scure signs ECDSA as DER; @noble's verify takes the 64-byte
          // compact form, so re-encode before verifying.
          const compact = secp256k1.Signature.fromDER(der).toCompactRawBytes();
          verified = secp256k1.verify(compact, digest, pubKey);
        } catch {
          verified = false;
        }
        if (!verified) {
          return fail('signature-invalid', `input ${i} P2WPKH ECDSA signature does not verify`, i);
        }
      }
      continue;
    }

    // A signed input whose prevout is neither P2TR nor P2WPKH: we cannot
    // recompute its sighash here, so we refuse to bless it. Conservative — a
    // bid on an exotic input type is rejected, never accepted unverified.
    return fail(
      'unsupported-input-type',
      `input ${i} is signed but its prevout is neither P2TR nor P2WPKH`,
      i,
    );
  }

  return { ok: true };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
