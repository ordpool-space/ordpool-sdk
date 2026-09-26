import { describe, expect, it } from '@jest/globals';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1';

import { Network, toScureNetwork } from '../network.js';
import { simulateBatchInscribeFees } from '../inscribe/inscription-batch.helper.js';
import { prepareInscribeFundingInput } from '../inscribe/inscription-input-adapter.js';
import { vsizeWithMaxSignatures } from './compute-psbt-vsize.helper.js';

const net = toScureNetwork(Network.Regtest);
const recipient = btc.p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true).slice(1), undefined, net).address!;

/** A commit-shaped tx: one payer input, a P2TR and a change output. */
const signedCommitShape = (seed: number, lowR: boolean, legacy = false) => {
  const priv = new Uint8Array(32).fill(1); priv[30] = seed >> 8; priv[31] = seed & 0xff;
  const pub = secp256k1.getPublicKey(priv, true);
  const p = legacy ? btc.p2pkh(pub, net) : btc.p2wpkh(pub, net);
  const tx = new btc.Transaction({ lowR, allowLegacyWitnessUtxo: true });
  tx.addInput({ txid: hex.decode('11'.repeat(32)), index: 0, witnessUtxo: { script: p.script, amount: 100_000n } });
  tx.addOutputAddress(recipient, 10_000n, net);
  tx.addOutputAddress(p.address!, 80_000n, net);
  tx.sign(priv);
  tx.finalize();
  const input = tx.getInput(0);
  const sig = legacy
    ? (btc.Script.decode(input.finalScriptSig!)[0] as Uint8Array).length
    : input.finalScriptWitness![0].length;
  return { tx, sig };
};

describe('vsizeWithMaxSignatures', () => {
  it('bounds every real signature length on a shape where one byte moves the vsize', () => {
    // Both signers are exercised: scure without low-R, and with it, which is
    // what Bitcoin Core does. The raw vsize must actually differ between
    // lengths, or this case proves nothing.
    const bySig = new Map<number, Set<number>>();
    const bounded = new Set<number>();
    for (const lowR of [false, true]) {
      for (let seed = 1; seed <= 600; seed++) {
        const { tx, sig } = signedCommitShape(seed, lowR);
        (bySig.get(sig) ?? bySig.set(sig, new Set()).get(sig)!).add(tx.vsize);
        bounded.add(vsizeWithMaxSignatures(tx));
        expect(vsizeWithMaxSignatures(tx)).toBeGreaterThanOrEqual(tx.vsize);
      }
    }
    const raw = new Set([...bySig.values()].flatMap((s) => [...s]));
    expect(bySig.has(70)).toBe(true);
    expect(raw.size).toBeGreaterThan(1);
    expect(bounded.size).toBe(1);
  });

  it('bounds a P2PKH payer too, where each signature byte weighs 4', () => {
    const raw = new Set<number>();
    const bounded = new Set<number>();
    for (let seed = 1; seed <= 300; seed++) {
      const { tx } = signedCommitShape(seed, false, true);
      raw.add(tx.vsize);
      bounded.add(vsizeWithMaxSignatures(tx));
      expect(vsizeWithMaxSignatures(tx)).toBeGreaterThanOrEqual(tx.vsize);
    }
    expect(raw.size).toBeGreaterThan(1);
    expect(bounded.size).toBe(1);
  });
});

describe('the batch commit preview does not depend on the dummy signature', () => {
  it('reports one commit vsize across funding txids', () => {
    // The dummy signs over the REAL funding txid, so its DER length varies per
    // coin. This commit's weight is 608 + (sig - 70): a 70-byte dummy used to
    // give 152 where 71 and 72 give 153, and a broadcast signed by bitcoind
    // at 70 bytes gave 152 against a 153 preview.
    const priv = new Uint8Array(32).fill(7);
    const pub = secp256k1.getPublicKey(priv, true);
    const pay = btc.p2wpkh(pub, net).address!;
    const seen = new Set<number>();
    for (let i = 0; i < 1500; i++) {
      const txid = hex.encode(secp256k1.utils.randomPrivateKey());
      const fundingInput = prepareInscribeFundingInput({
        utxo: { txid, vout: 0, value: 100_000_000, status: { confirmed: true } },
        paymentPublicKey: pub, paymentAddress: pay, isSimulation: true, network: Network.Regtest,
      });
      const sim = simulateBatchInscribeFees({
        paymentOutput: { txid, vout: 0, value: 100_000_000, status: { confirmed: true } },
        paymentPublicKey: pub,
        paymentAddress: pay,
        mode: 'separate-outputs',
        inscriptions: [
          { body: new TextEncoder().encode('priced a'), contentType: 'text/plain' },
          { body: new TextEncoder().encode('priced b'), contentType: 'text/plain' },
        ],
        recipientAddress: recipient, feeRatePerVbyte: 5, network: Network.Regtest,
      }, { fundingInput, senderChangeAddress: pay, ephemeralPubkeyXonly: new Uint8Array(32).fill(2) });
      seen.add(sim.commitVsize);
    }
    expect([...seen]).toEqual([153]);
  }, 60_000);
});
