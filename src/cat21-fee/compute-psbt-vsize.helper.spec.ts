import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { computePsbtVsize } from './compute-psbt-vsize.helper';

const PRIV = hex.decode('11'.repeat(32));
const NETWORK = btc.NETWORK;

/**
 * Build a 1-input, 1-output PSBT whose sole input is non-signable and
 * carries the given scriptPubKey as its witnessUtxo. `computePsbtVsize`
 * then sizes the input's fake witness by that script.
 */
function psbtWithNonSignableInput(script: Uint8Array): Uint8Array {
  const out = btc.p2wpkh(secp256k1.getPublicKey(PRIV, true), NETWORK);
  const tx = new btc.Transaction({ allowUnknownInputs: true });
  tx.addInput({
    txid: hex.decode('aa'.repeat(32)),
    index: 0,
    witnessUtxo: { script, amount: BigInt(546) },
    sighashType: btc.SigHash.ALL,
  });
  tx.addOutputAddress(out.address!, BigInt(500), NETWORK);
  return tx.toPSBT();
}

describe('computePsbtVsize: non-signable input witness sizing', () => {

  const p2trScript = btc.p2tr(schnorr.getPublicKey(PRIV), undefined, NETWORK).script;
  const p2wpkhScript = btc.p2wpkh(secp256k1.getPublicKey(PRIV, true), NETWORK).script;

  it('sizes a P2WPKH non-signable input larger than a P2TR one (real witness is ~44 bytes bigger)', () => {
    const trVsize = computePsbtVsize({
      psbt: psbtWithNonSignableInput(p2trScript),
      network: NETWORK,
      nonSignableInputs: [0],
    });
    const wpkhVsize = computePsbtVsize({
      psbt: psbtWithNonSignableInput(p2wpkhScript),
      network: NETWORK,
      nonSignableInputs: [0],
    });

    // A P2WPKH witness (<sig 72><pubkey 33>) weighs ~44 bytes more than a
    // taproot key-path witness (single 64-byte sig) → ~11 vB. If both
    // came back equal, the helper is still faking taproot for every
    // non-signable input (the bug this fix closes).
    expect(wpkhVsize).toBeGreaterThan(trVsize);
    expect(wpkhVsize - trVsize).toBeGreaterThanOrEqual(9);
    expect(wpkhVsize - trVsize).toBeLessThanOrEqual(13);
  });

  it('an unknown/absent scriptPubKey falls back to the larger P2WPKH estimate (conservative)', () => {
    // A bare OP_RETURN-ish script isn't P2TR, so the helper must not
    // under-count with the 64-byte taproot stub.
    const oddScript = new Uint8Array([0x6a, 0x01, 0x00]); // OP_RETURN push
    const oddVsize = computePsbtVsize({
      psbt: psbtWithNonSignableInput(oddScript),
      network: NETWORK,
      nonSignableInputs: [0],
    });
    const trVsize = computePsbtVsize({
      psbt: psbtWithNonSignableInput(p2trScript),
      network: NETWORK,
      nonSignableInputs: [0],
    });
    expect(oddVsize).toBeGreaterThan(trVsize);
  });
});
