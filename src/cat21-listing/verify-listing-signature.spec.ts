import { describe, expect, it } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

import { Network } from '../network';
import { toOrdinalsAddress, toPaymentAddress } from '../wallet/address-types';
import { buildListingMessage, ListingMessageFields } from './build-listing-message';
import { verifyListingSignature } from './verify-listing-signature';

// ---------------------------------------------------------------------------
// Test key material. Not used for any real address anywhere.
//
// For BIP-341 key-path P2TR spends (what BIP-322 does), the ON-CHAIN
// pubkey is the TWEAKED xonly (Q = P + t*G where t is the taproot
// commitment tweak for an empty script tree). The private-key
// counterpart is `d + t` — scure's `taprootTweakPrivKey` computes it.
// The address bech32-encodes Q, and the schnorr signature must be
// produced under the tweaked key so verify against Q succeeds. Real
// wallets (Xverse / Leather / cat21-wallet) apply this tweak inside
// their signMessage RPC; the test signer mirrors that behaviour.
// ---------------------------------------------------------------------------
const PRIVKEY_RAW = hex.decode('0000000000000000000000000000000000000000000000000000000000000003');
const PRIVKEY = btc.taprootTweakPrivKey(PRIVKEY_RAW);
const XONLY_INTERNAL = schnorr.getPublicKey(PRIVKEY_RAW);
const P2TR = btc.p2tr(XONLY_INTERNAL, undefined, btc.NETWORK);
const XONLY = P2TR.tweakedPubkey;
const P2TR_ADDR = toOrdinalsAddress(P2TR.address!);

// Second key so we can prove "signature by the WRONG key doesn't verify".
const PRIVKEY_OTHER_RAW = hex.decode('0000000000000000000000000000000000000000000000000000000000000005');
const PRIVKEY_OTHER = btc.taprootTweakPrivKey(PRIVKEY_OTHER_RAW);

const PAY_ADDR = toPaymentAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx');
const TXID = 'ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df';

const baseFields = (): ListingMessageFields => ({
  catNumber: 42,
  cats: [42],
  network: Network.Mainnet,
  askSats: 21_000,
  payTo: PAY_ADDR,
  catTxid: TXID,
  catVout: 0,
  ordinalsAddress: P2TR_ADDR,
  signedAt: 1_700_000_000,
});

// ---------------------------------------------------------------------------
// Signing side, inlined for test purposes only. Mirrors the verify
// side's virtual-tx construction — sharing a helper between prod
// verify and test sign would risk hiding a symmetric bug (verifier
// wrong + signer wrong in the same way → tests pass). Keep separate.
// ---------------------------------------------------------------------------
function signBip322Simple(args: {
  message: string;
  xOnlyPubkey: Uint8Array;
  privateKey: Uint8Array;
  sighashType?: number; // 0 = SIGHASH_DEFAULT (raw 64-byte sig), 1 = SIGHASH_ALL explicit
  witnessFormat?: 'raw' | 'serialized';
}): string {
  const scriptPubKey = new Uint8Array(34);
  scriptPubKey[0] = 0x51;
  scriptPubKey[1] = 0x20;
  scriptPubKey.set(args.xOnlyPubkey, 2);

  const tag = 'BIP0322-signed-message';
  const tagHash = sha256(new TextEncoder().encode(tag));
  const msgBytes = new TextEncoder().encode(args.message);
  const preTaggedHash = new Uint8Array(tagHash.length * 2 + msgBytes.length);
  preTaggedHash.set(tagHash, 0);
  preTaggedHash.set(tagHash, tagHash.length);
  preTaggedHash.set(msgBytes, tagHash.length * 2);
  const messageHash = sha256(preTaggedHash);

  // Build to_spend serialization (must match the verify side).
  const scriptSig = new Uint8Array(34);
  scriptSig[0] = 0x00; // OP_0
  scriptSig[1] = 0x20; // PUSH32
  scriptSig.set(messageHash, 2);
  const toSpendParts: Uint8Array[] = [
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),           // version=0
    new Uint8Array([0x01]),                              // 1 input
    new Uint8Array(32),                                  // input[0] txid = 32 zero bytes
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),            // input[0] vout = 0xFFFFFFFF
    new Uint8Array([scriptSig.length]),                  // scriptSig varint (34 < 0xfd)
    scriptSig,
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),            // sequence=0
    new Uint8Array([0x01]),                              // 1 output
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),            // value=0
    new Uint8Array([scriptPubKey.length]),               // scriptPubKey varint
    scriptPubKey,
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),            // locktime=0
  ];
  let total = 0;
  for (const p of toSpendParts) total += p.length;
  const toSpend = new Uint8Array(total);
  let off = 0;
  for (const p of toSpendParts) { toSpend.set(p, off); off += p.length; }
  const toSpendTxid = sha256(sha256(toSpend));

  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 0, lockTime: 0 });
  tx.addInput({
    txid: toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { script: scriptPubKey, amount: BigInt(0) },
  });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: BigInt(0) });
  const sighashType = args.sighashType ?? 0;
  const sighash = tx.preimageWitnessV1(0, [scriptPubKey], sighashType, [BigInt(0)]);
  const sig64 = schnorr.sign(sighash, args.privateKey);

  const witnessFormat = args.witnessFormat ?? 'raw';
  const sigWithSighash = sighashType === 0
    ? sig64
    : new Uint8Array([...sig64, sighashType]);

  if (witnessFormat === 'raw') {
    return base64.encode(sigWithSighash);
  }
  // Serialized witness: [numItems=1, sigLen, sigBytes]
  const out = new Uint8Array(2 + sigWithSighash.length);
  out[0] = 0x01;
  out[1] = sigWithSighash.length;
  out.set(sigWithSighash, 2);
  return base64.encode(out);
}

const signBase = (over: Partial<Parameters<typeof signBip322Simple>[0]> = {}): string =>
  signBip322Simple({
    message: buildListingMessage(baseFields()),
    xOnlyPubkey: XONLY,
    privateKey: PRIVKEY,
    ...over,
  });

// ---------------------------------------------------------------------------

describe('verifyListingSignature — round-trip against a fresh signature', () => {

  it('accepts a signature we just produced (raw 64-byte witness, SIGHASH_DEFAULT)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: signBase(),
    });
    expect(result).toEqual({ ok: true });
  });

  it('accepts a signature in serialized-witness format (Xverse / Leather shape)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: signBase({ witnessFormat: 'serialized' }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('accepts a signature with SIGHASH_ALL explicit (65-byte sig)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: signBase({ sighashType: 0x01 }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('accepts SIGHASH_ALL + serialized-witness combined (0x41 length prefix)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: signBase({ sighashType: 0x01, witnessFormat: 'serialized' }),
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('verifyListingSignature — field tampering (the whole point of the signature)', () => {

  // Sign the original message, then verify against fields with ONE
  // value changed. The signature commits to the original message bytes;
  // any drift MUST fail verification.
  const originalSig = signBase();

  it('rejects when catNumber changed', () => {
    const result = verifyListingSignature({
      fields: { ...baseFields(), catNumber: 999 },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects when askSats changed', () => {
    const result = verifyListingSignature({
      fields: { ...baseFields(), askSats: 1 },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects when payTo changed (attacker rerouting sale proceeds)', () => {
    const OTHER_PAY = toPaymentAddress('bc1qgc0m7cd9s3z9wmpc9djcygxzr9s5s9rlaqlfr9');
    const result = verifyListingSignature({
      fields: { ...baseFields(), payTo: OTHER_PAY },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects when catTxid changed (attacker relisting a different cat)', () => {
    const OTHER_TXID = 'bb'.repeat(32);
    const result = verifyListingSignature({
      fields: { ...baseFields(), catTxid: OTHER_TXID },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects when catVout changed', () => {
    const result = verifyListingSignature({
      fields: { ...baseFields(), catVout: 1 },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects when signedAt changed (any replay-window shift breaks the sig)', () => {
    const result = verifyListingSignature({
      fields: { ...baseFields(), signedAt: 1_700_000_001 },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects when cats bundle changed (extra cat appeared on the UTXO between sign and verify)', () => {
    // Seller signed for cats=[42]; UTXO now carries {42, 99} — the
    // bundle drifted. This is the "someone consolidated" stale case
    // that the v3 cats-line was added to catch.
    const result = verifyListingSignature({
      fields: { ...baseFields(), cats: [42, 99] },
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('collapses a fields-shape throw (e.g. catNumber not in cats) into signature-does-not-verify', () => {
    // The tamper here breaks buildListingMessage's own validation
    // (headline catNumber must be a member of cats). Without the
    // verify-side try/catch this would raise; with it, we return
    // the same rejection reason the caller already handles.
    const result = verifyListingSignature({
      fields: { ...baseFields(), catNumber: 12345 }, // cats stays [42], mismatch
      signatureBase64: originalSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });
});

describe('verifyListingSignature — key rejection (attacker cannot forge)', () => {

  it('rejects a signature by a DIFFERENT key (attacker signs but does not own the cat)', () => {
    // Sign the SAME message with the wrong key. The wallet-address
    // check would catch this at the app layer (attacker would need
    // the actual owner's ordinals address to submit the listing);
    // this test proves that even if they get past that gate, the
    // schnorr verify fails.
    const attackerSig = signBip322Simple({
      message: buildListingMessage(baseFields()),
      xOnlyPubkey: XONLY, // claim to be XONLY
      privateKey: PRIVKEY_OTHER, // but sign with a different key
    });
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: attackerSig,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });

  it('rejects an all-zeros signature (raw 64 bytes of zero)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: base64.encode(new Uint8Array(64)),
    });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });
});

describe('verifyListingSignature — signature format rejection', () => {

  it('rejects malformed base64', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: 'not-valid-base64!@#$',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-signature');
  });

  it('rejects empty payload (zero-length after base64 decode)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: base64.encode(new Uint8Array(0)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-signature');
  });

  it('rejects truncated sig (30 bytes — neither raw nor serialized-witness)', () => {
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: base64.encode(new Uint8Array(30)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-signature');
  });

  it('rejects serialized-witness with wrong declared length (0x01 0x40 <only 32 bytes>)', () => {
    // numItems=1, sigLen=0x40 (declares 64), but we only supply 32
    const bad = new Uint8Array(2 + 32);
    bad[0] = 0x01;
    bad[1] = 0x40;
    // remaining bytes stay 0
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: base64.encode(bad),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-signature');
  });

  it('rejects unrecognized payload shape (100 bytes starting with 0xff)', () => {
    const bad = new Uint8Array(100).fill(0xff);
    const result = verifyListingSignature({
      fields: baseFields(),
      signatureBase64: base64.encode(bad),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed-signature');
  });
});

describe('verifyListingSignature — address rejection', () => {

  it('rejects a garbage address string', () => {
    const result = verifyListingSignature({
      fields: { ...baseFields(), ordinalsAddress: 'not-an-address' as never },
      signatureBase64: signBase(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-address');
  });

  it('rejects a valid P2WPKH address (unsupported for BIP-322 v1 — cats live on P2TR only)', () => {
    // A real bech32 P2WPKH mainnet address (valid checksum) derived
    // via scure — decodes as a legit witness program, but has the
    // wrong witness-version byte for taproot.
    const result = verifyListingSignature({
      fields: {
        ...baseFields(),
        ordinalsAddress: 'bc1qz69ej270c3q9qvgt822t6pm3zdksk2x35j2jlm' as never,
      },
      signatureBase64: signBase(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-address-type');
  });

  it('rejects a legacy P2PKH address (unsupported)', () => {
    // A real P2PKH mainnet address (valid base58check) — decodes as
    // an address, but the scriptPubKey is OP_DUP OP_HASH160 …, not
    // a taproot witness program.
    const result = verifyListingSignature({
      fields: {
        ...baseFields(),
        ordinalsAddress: '134D6gYy8DsR5m4416BnmgASuMBqKvogQh' as never,
      },
      signatureBase64: signBase(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-address-type');
  });
});

describe('verifyListingSignature — cross-network replay is blocked by v2 network binding', () => {
  it('signature for network=mainnet does NOT verify against fields claiming network=testnet3', () => {
    // Attacker records a legit mainnet signature, then replays it
    // against the same payload with network flipped to testnet3.
    // The message the verifier rebuilds now includes `network=testnet3`
    // — different bytes → schnorr sig no longer verifies.
    const mainnetSig = signBase({ message: buildListingMessage(baseFields()) });
    const testnetFields: ListingMessageFields = { ...baseFields(), network: Network.Testnet3 };
    const result = verifyListingSignature({ fields: testnetFields, signatureBase64: mainnetSig });
    expect(result).toEqual({ ok: false, reason: 'signature-does-not-verify' });
  });
});

describe('verifyListingSignature — testnet3 works too', () => {
  it('verifies a P2TR listing on testnet3 (tb1p… address)', () => {
    // p2tr() takes the INTERNAL xonly and applies the taproot tweak
    // itself, so we hand it XONLY_INTERNAL (not the already-tweaked
    // mainnet XONLY reused across tests) — otherwise the tweak would
    // land twice and mainnet's tweakedPubkey would drift from what
    // decoding a tb1p address emits.
    const p2trTestnet = btc.p2tr(XONLY_INTERNAL, undefined, btc.TEST_NETWORK);
    const testnetAddr = toOrdinalsAddress(p2trTestnet.address!);
    const fields: ListingMessageFields = { ...baseFields(), network: Network.Testnet3, ordinalsAddress: testnetAddr };
    const sig = signBip322Simple({
      message: buildListingMessage(fields),
      xOnlyPubkey: p2trTestnet.tweakedPubkey,
      privateKey: PRIVKEY,
    });
    expect(verifyListingSignature({ fields, signatureBase64: sig })).toEqual({ ok: true });
  });
});
