/**
 * @jest-environment node
 *
 * Crypto spec: constructs REAL signed buy-offer PSBTs with scure's own signer
 * (known private keys), then asserts our verifier accepts a genuine signature
 * and rejects every tampering the structural validator would miss. No chain,
 * no fabricated transaction data: the signatures are produced by the real
 * signer, which is exactly what a wallet produces.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import {
  OfferPrevouts,
  verifyOfferInputSignatures,
} from './verify-offer-input-signatures.js';

const NET = btc.NETWORK; // mainnet; the sighash math is network-independent

// Known keys — SPEC ONLY, never broadcast.
const sellerPriv = hex.decode('1'.repeat(64));
const buyerTrPriv = hex.decode('2'.repeat(64));
const buyerWpkhPriv = hex.decode('3'.repeat(64));

const sellerTr = btc.p2tr(schnorr.getPublicKey(sellerPriv), undefined, NET);
const buyerTr = btc.p2tr(schnorr.getPublicKey(buyerTrPriv), undefined, NET);
const buyerWpkh = btc.p2wpkh(secp256k1.getPublicKey(buyerWpkhPriv, true), NET);
const attackerPriv = hex.decode('4'.repeat(64));
const attackerPub = secp256k1.getPublicKey(attackerPriv, true);

const CAT_TXID = 'a'.repeat(64);
const FUND_TXID = 'b'.repeat(64);
const SELLER_SATS = 9000;
const FUND_SATS = 200_000;

function key(txid: string, vout: number) {
  return `${txid}:${vout}`;
}

/**
 * Build a 1-buyer-input buy-offer tx: input 0 = seller cat (P2TR, UNSIGNED),
 * input 1 = buyer funding, signed with its key. Returns the re-parsed PSBT and
 * the matching true-prevout map. `buyerKind` picks the buyer input's address
 * type.
 */
function signedOffer(buyerKind: 'tr' | 'wpkh'): { tx: btc.Transaction; prevouts: OfferPrevouts } {
  const { tx, prevouts } = unsignedOffer(buyerKind);
  tx.signIdx(buyerKind === 'tr' ? buyerTrPriv : buyerWpkhPriv, 1); // buyer signs only their own funding input
  return { tx: btc.Transaction.fromPSBT(tx.toPSBT()), prevouts };
}

/** The same offer before the buyer signs: input 1 carries no signature field. */
function unsignedOffer(buyerKind: 'tr' | 'wpkh'): { tx: btc.Transaction; prevouts: OfferPrevouts } {
  const buyer = buyerKind === 'tr' ? buyerTr : buyerWpkh;

  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  // input 0: seller cat (unsigned)
  tx.addInput({
    txid: CAT_TXID,
    index: 0,
    witnessUtxo: { script: sellerTr.script, amount: BigInt(SELLER_SATS) },
    tapInternalKey: sellerTr.tapInternalKey,
  });
  // input 1: buyer funding (signed below)
  if (buyerKind === 'tr') {
    tx.addInput({
      txid: FUND_TXID,
      index: 0,
      witnessUtxo: { script: buyerTr.script, amount: BigInt(FUND_SATS) },
      tapInternalKey: buyerTr.tapInternalKey,
    });
  } else {
    tx.addInput({
      txid: FUND_TXID,
      index: 0,
      witnessUtxo: { script: buyerWpkh.script, amount: BigInt(FUND_SATS) },
    });
  }
  // outputs: cat to buyer, payment to seller
  tx.addOutputAddress(buyerTr.address!, BigInt(SELLER_SATS), NET);
  tx.addOutputAddress(sellerTr.address!, BigInt(100_000), NET);

  const prevouts: OfferPrevouts = new Map([
    [key(CAT_TXID, 0), { script: sellerTr.script, amountSats: SELLER_SATS }],
    [key(FUND_TXID, 0), { script: buyer.script, amountSats: FUND_SATS }],
  ]);
  return { tx, prevouts };
}

describe('verifyOfferInputSignatures', () => {
  it('accepts a genuine Taproot (schnorr) buyer signature', () => {
    const { tx, prevouts } = signedOffer('tr');
    expect(verifyOfferInputSignatures(tx.toPSBT(), prevouts)).toEqual({ ok: true });
  });

  it('accepts a genuine P2WPKH (ECDSA) buyer signature', () => {
    const { tx, prevouts } = signedOffer('wpkh');
    expect(verifyOfferInputSignatures(tx.toPSBT(), prevouts)).toEqual({ ok: true });
  });

  it('rejects random bytes passed off as a Taproot signature', () => {
    const { tx, prevouts } = signedOffer('tr');
    // Overwrite the real tapKeySig with 64 random-looking bytes.
    tx.updateInput(1, { tapKeySig: hex.decode('cd'.repeat(64)) }, true);
    const r = verifyOfferInputSignatures(tx.toPSBT(), prevouts);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'signature-invalid', inputIndex: 1 });
  });

  it('rejects a lied-about witnessUtxo amount', () => {
    const { tx, prevouts } = signedOffer('tr');
    // Chain says the funding coin is 200_000; claim it is 100 BTC.
    const lying: OfferPrevouts = new Map(prevouts);
    lying.set(key(FUND_TXID, 0), { script: buyerTr.script, amountSats: 10_000_000_000 });
    const r = verifyOfferInputSignatures(tx.toPSBT(), lying);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'prevout-amount-mismatch', inputIndex: 1 });
  });

  it('rejects a witnessUtxo script that differs from the chain prevout', () => {
    const { tx, prevouts } = signedOffer('tr');
    const wrong: OfferPrevouts = new Map(prevouts);
    wrong.set(key(FUND_TXID, 0), { script: sellerTr.script, amountSats: FUND_SATS });
    const r = verifyOfferInputSignatures(tx.toPSBT(), wrong);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'prevout-script-mismatch', inputIndex: 1 });
  });

  it('fails closed when a prevout the sighash needs is missing', () => {
    const { tx, prevouts } = signedOffer('tr');
    const missing: OfferPrevouts = new Map(prevouts);
    missing.delete(key(CAT_TXID, 0)); // drop the seller input 0 prevout
    const r = verifyOfferInputSignatures(tx.toPSBT(), missing);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'prevout-missing', inputIndex: 0 });
  });

  it('a genuine signature does NOT verify once an output value is changed (sighash commits outputs)', () => {
    const { tx, prevouts } = signedOffer('tr');
    // Rewrite the seller payment output from 100_000 to 1_000 after signing.
    tx.updateOutput(1, { amount: BigInt(1_000) }, true);
    const r = verifyOfferInputSignatures(tx.toPSBT(), prevouts);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'signature-invalid', inputIndex: 1 });
  });

  it('rejects a P2WPKH signature made with a key that does not own the prevout', () => {
    // The prevout is the victim's real coin (true chain data). The attacker
    // signs the correct BIP-143 digest with their OWN key and carries their own
    // pubkey: the ECDSA math holds, the key hash does not.
    const { tx, prevouts } = unsignedOffer('wpkh');
    const scriptCode = btc.p2pkh(secp256k1.getPublicKey(buyerWpkhPriv, true)).script;
    const digest = tx.preimageWitnessV0(1, scriptCode, btc.SigHash.ALL, BigInt(FUND_SATS));
    const der = secp256k1.sign(digest, attackerPriv, { lowS: true }).toDERRawBytes();
    expect(secp256k1.verify(secp256k1.Signature.fromDER(der).toCompactRawBytes(), digest, attackerPub)).toBe(true);
    tx.updateInput(1, { partialSig: [[attackerPub, new Uint8Array([...der, btc.SigHash.ALL])]] }, true);
    const r = verifyOfferInputSignatures(tx.toPSBT(), prevouts);
    expect(r).toMatchObject({ ok: false, reason: 'signature-invalid', inputIndex: 1 });
  });

  it('rejects a finalised Taproot buyer input whose witness is random bytes', () => {
    const { tx, prevouts } = unsignedOffer('tr');
    tx.updateInput(1, { finalScriptWitness: [hex.decode('cd'.repeat(64))] }, true);
    const r = verifyOfferInputSignatures(tx.toPSBT(), prevouts);
    expect(r).toMatchObject({ ok: false, reason: 'signature-invalid', inputIndex: 1 });
  });

  it('rejects a finalised P2WPKH buyer input whose witness is random bytes', () => {
    const { tx, prevouts } = unsignedOffer('wpkh');
    const buyerPub = secp256k1.getPublicKey(buyerWpkhPriv, true);
    tx.updateInput(1, { finalScriptWitness: [hex.decode('30'.repeat(71)), buyerPub] }, true);
    const r = verifyOfferInputSignatures(tx.toPSBT(), prevouts);
    expect(r).toMatchObject({ ok: false, reason: 'signature-invalid', inputIndex: 1 });
  });

  it.each(['tr', 'wpkh'] as const)('accepts a genuinely signed and finalised %s buyer input', (kind) => {
    const { tx, prevouts } = signedOffer(kind);
    tx.finalizeIdx(1);
    expect(tx.getInput(1).finalScriptWitness?.length).toBeGreaterThan(0);
    expect(verifyOfferInputSignatures(tx.toPSBT(), prevouts)).toEqual({ ok: true });
  });

  it('answers signature-missing, without throwing, for a Taproot prevout that carries only a partialSig', () => {
    const { tx, prevouts } = unsignedOffer('tr');
    tx.updateInput(1, { partialSig: [[attackerPub, hex.decode('30'.repeat(71) + '01')]] }, true);
    const r = verifyOfferInputSignatures(tx.toPSBT(), prevouts);
    expect(r).toMatchObject({ ok: false, reason: 'signature-missing', inputIndex: 1 });
  });
});
