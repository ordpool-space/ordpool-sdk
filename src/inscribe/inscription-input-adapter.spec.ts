import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';
import { prepareInscribeFundingInput } from './inscription-input-adapter';

const PUBKEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const NETWORK = Network.Mainnet;
const SCURE_NET = toScureNetwork(NETWORK);

const segwitAddr = btc.p2wpkh(PUBKEY, SCURE_NET).address!;
const p2shAddr = btc.p2sh(btc.p2wpkh(PUBKEY, SCURE_NET), SCURE_NET).address!;
const p2trAddr = btc.p2tr(PUBKEY.subarray(1, 33), undefined, SCURE_NET, true).address!;
const p2pkhAddr = btc.p2pkh(PUBKEY, SCURE_NET).address!;

const baseUtxo = {
  txid: '0123456789abcdef'.repeat(4),
  vout: 0,
  value: 100_000,
  status: { confirmed: true, block_height: 800_000 },
};

describe('prepareInscribeFundingInput', () => {

  it('returns a SegWit shape for a P2WPKH payment address (no redeemScript/nonWitnessUtxo/tapInternalKey)', () => {
    const input = prepareInscribeFundingInput({
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(22); // P2WPKH = OP_0 + 20-byte hash
    expect(input.redeemScript).toBeUndefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
    expect(input.tapInternalKey).toBeUndefined();
    expect(input.value).toBe(100_000);
  });

  it('returns a Taproot shape for a P2TR payment address (with tapInternalKey)', () => {
    const input = prepareInscribeFundingInput({
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2trAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(34); // P2TR = OP_1 + 32-byte x-only pubkey
    expect(input.tapInternalKey).toBeDefined();
    expect(input.tapInternalKey!.length).toBe(32);
    expect(input.redeemScript).toBeUndefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
  });

  it('returns a P2SH-wrapped SegWit shape for a P2SH-P2WPKH payment address (with redeemScript)', () => {
    const input = prepareInscribeFundingInput({
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2shAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(23); // P2SH = OP_HASH160 + 20-byte hash + OP_EQUAL
    expect(input.redeemScript).toBeDefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
    expect(input.tapInternalKey).toBeUndefined();
  });

  it('returns a Legacy shape with nonWitnessUtxo for a P2PKH payment address when transactionHex is supplied', () => {
    const utxoWithHex = {
      ...baseUtxo,
      transactionHex: '02000000000101' + '00'.repeat(60), // shape-valid placeholder
    };
    const input = prepareInscribeFundingInput({
      utxo: utxoWithHex,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2pkhAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(25); // P2PKH = OP_DUP OP_HASH160 push20 OP_EQUALVERIFY OP_CHECKSIG
    expect(input.nonWitnessUtxo).toBeDefined();
    expect(input.tapInternalKey).toBeUndefined();
    expect(input.redeemScript).toBeUndefined();
  });

  it('throws when P2PKH is real (not simulation) but transactionHex is missing', () => {
    expect(() => prepareInscribeFundingInput({
      utxo: baseUtxo, // no transactionHex
      paymentPublicKey: PUBKEY,
      paymentAddress: p2pkhAddr,
      isSimulation: false,
      network: NETWORK,
    })).toThrow(/Missing transaction hex/);
  });

  it('simulation: P2PKH gets a dummy non-witness UTXO without the caller supplying transactionHex', () => {
    const input = prepareInscribeFundingInput({
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2pkhAddr,
      isSimulation: true,
      network: NETWORK,
    });
    expect(input.nonWitnessUtxo).toBeDefined();
    // Simulation swaps txid for the dummy tx's id.
    expect(input.txid).not.toBe(baseUtxo.txid);
  });

  it('simulation: P2TR script differs from real-key P2TR (dummy keypair under the hood)', () => {
    const real = prepareInscribeFundingInput({
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2trAddr,
      isSimulation: false,
      network: NETWORK,
    });
    const sim = prepareInscribeFundingInput({
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2trAddr,
      isSimulation: true,
      network: NETWORK,
    });
    expect(hex.encode(real.scriptPubKey)).not.toBe(hex.encode(sim.scriptPubKey));
  });
});
