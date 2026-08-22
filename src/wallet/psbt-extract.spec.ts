import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';

import { extractWireTxFromPsbt } from './psbt-extract';

/**
 * Fresh-key builder — sigs verify against the derived pubkey so
 * finalize() can actually combine them. We build minimal 1-input,
 * 1-output P2WPKH txs so the spec pins finalize behaviour without
 * dragging cat-flow shapes into the mix.
 */
function makeSignerAndInput() {
  const privKey = hex.decode('11'.repeat(32));
  const pubKey = secp256k1.getPublicKey(privKey, true);
  const p2wpkh = btc.p2wpkh(pubKey, btc.NETWORK);
  return { privKey, pubKey, p2wpkh };
}

function makeUnsignedPsbt(): Uint8Array {
  const { p2wpkh } = makeSignerAndInput();
  const tx = new btc.Transaction();
  tx.addInput({
    txid: hex.decode('aa'.repeat(32)),
    index: 0,
    witnessUtxo: { script: p2wpkh.script, amount: BigInt(100_000) },
    sighashType: btc.SigHash.ALL,
  });
  tx.addOutputAddress(p2wpkh.address!, BigInt(90_000), btc.NETWORK);
  return tx.toPSBT();
}

function makeSignedPsbt(): Uint8Array {
  const { privKey, p2wpkh } = makeSignerAndInput();
  const tx = new btc.Transaction();
  tx.addInput({
    txid: hex.decode('aa'.repeat(32)),
    index: 0,
    witnessUtxo: { script: p2wpkh.script, amount: BigInt(100_000) },
    sighashType: btc.SigHash.ALL,
  });
  tx.addOutputAddress(p2wpkh.address!, BigInt(90_000), btc.NETWORK);
  tx.sign(privKey);
  return tx.toPSBT();
}

describe('extractWireTxFromPsbt', () => {

  it('happy path: fully-signed PSBT → wire hex', () => {
    const psbt = makeSignedPsbt();
    const hexStr = extractWireTxFromPsbt(psbt);
    // Wire tx is at least a version + input + output + locktime,
    // and its hex must not be empty.
    expect(hexStr.length).toBeGreaterThan(20);
    // Round-trip: the returned hex must parse as a tx.
    const decoded = btc.Transaction.fromRaw(hex.decode(hexStr));
    expect(decoded.inputsLength).toBe(1);
    expect(decoded.outputsLength).toBe(1);
  });

  it('re-throws with input index when a signature is missing (buyer-sigs-stripped case)', () => {
    const psbt = makeUnsignedPsbt();
    expect(() => extractWireTxFromPsbt(psbt)).toThrow(
      /PSBT finalize failed on input\(s\) 0 of 1:.*/,
    );
  });

  it('does not misclassify a pre-finalized legacy input (finalScriptSig, no witness) as missing', () => {
    // A wallet that finalizes a legacy P2PKH input returns a PSBT whose
    // input carries a finalScriptSig and NO witness. On re-parse scure's
    // finalize() throws "Not enough partial sign" (no partialSig fields),
    // so we enter the catch — but the input IS finalized. It must
    // broadcast, not be reported as missing.
    const { privKey, pubKey, p2wpkh } = makeSignerAndInput();
    const p2pkh = btc.p2pkh(pubKey, btc.NETWORK);

    // A funding tx that pays the legacy P2PKH address (its serialized
    // bytes become the spend's nonWitnessUtxo).
    const prev = new btc.Transaction();
    prev.addInput({
      txid: hex.decode('bb'.repeat(32)),
      index: 0,
      witnessUtxo: { script: p2wpkh.script, amount: BigInt(200_000) },
      sighashType: btc.SigHash.ALL,
    });
    prev.addOutput({ script: p2pkh.script, amount: BigInt(100_000) });
    prev.sign(privKey);
    prev.finalize();
    const prevBytes = prev.extract();

    // Spend the legacy output, sign + finalize it (populates finalScriptSig).
    const spend = new btc.Transaction();
    spend.addInput({
      txid: hex.decode(prev.id),
      index: 0,
      nonWitnessUtxo: prevBytes,
      sighashType: btc.SigHash.ALL,
    });
    spend.addOutputAddress(p2wpkh.address!, BigInt(90_000), btc.NETWORK);
    spend.sign(privKey);
    spend.finalize();

    // Round-trip through PSBT so the re-parsed input has finalScriptSig
    // but no partialSig — the exact shape a self-finalizing legacy wallet
    // hands back.
    const psbt = btc.Transaction.fromPSBT(spend.toPSBT()).toPSBT();

    const hexStr = extractWireTxFromPsbt(psbt);
    expect(hexStr.length).toBeGreaterThan(0);
    const decoded = btc.Transaction.fromRaw(hex.decode(hexStr));
    expect(decoded.inputsLength).toBe(1);
  });

  it('preserves scure\'s original error message after our prefix', () => {
    const psbt = makeUnsignedPsbt();
    let thrown: Error | null = null;
    try {
      extractWireTxFromPsbt(psbt);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeTruthy();
    // The message wraps scure's detail — both our prefix AND scure's
    // "Not enough partial sign" (or equivalent) are present. This is
    // what makes the error self-diagnosing for the caller: the
    // scure detail is verbatim, no re-classification.
    expect(thrown!.message).toMatch(/PSBT finalize failed on input\(s\) 0 of 1/);
    expect(thrown!.message.length).toBeGreaterThan('PSBT finalize failed on input(s) 0 of 1: '.length);
  });
});
