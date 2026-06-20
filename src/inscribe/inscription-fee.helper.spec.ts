import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';

import { INSCRIBE_POSTAGE_SATS } from './inscription-commit.helper';
import { simulateInscribeFees } from './inscription-fee.helper';
import { prepareInscribeFundingInput } from './inscription-input-adapter';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);

const FUNDING_PRIV = new Uint8Array(32).fill(0x77);
const RECIPIENT_PRIV = new Uint8Array(32).fill(0x88);

function makeFundingUtxo(valueSats: number) {
  const fundingPubkey = secp256k1.getPublicKey(FUNDING_PRIV, true);
  const p2wpkh = btc.p2wpkh(fundingPubkey, scureNetwork);
  // Build the funding input via the Layer-2 adapter in simulation
  // mode so the funding signature can be dummy-keyed during the
  // fee simulation passes. The orchestrator (Layer 4) is responsible
  // for this in real flows.
  const fundingInput = prepareInscribeFundingInput({
    utxo: {
      txid: 'f'.repeat(64),
      vout: 0,
      value: valueSats,
      status: { confirmed: true },
    },
    paymentPublicKey: fundingPubkey,
    paymentAddress: p2wpkh.address!,
    isSimulation: true,
    network: NETWORK,
  });
  return {
    fundingAddress: p2wpkh.address!,
    fundingInput,
  };
}

function makeRecipientP2tr() {
  return btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true);
}

describe('simulateInscribeFees', () => {

  it('returns commit_fee + reveal_fee = total at a fixed fee rate', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    const result = simulateInscribeFees({
      feeRatePerVbyte: 5,
      body: new TextEncoder().encode('hello'),
      contentType: 'text/plain',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    expect(result.totalFeeSats).toBe(result.commitFeeSats + result.revealFeeSats);
    expect(result.commitFeeSats).toBeGreaterThan(0);
    expect(result.revealFeeSats).toBeGreaterThan(0);
  });

  it('combinedVsize = commitVsize + revealVsize', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    const r = simulateInscribeFees({
      feeRatePerVbyte: 10,
      body: new TextEncoder().encode('roundtrip'),
      contentType: 'text/plain',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    expect(r.combinedVsize).toBe(r.commitVsize + r.revealVsize);
    expect(r.commitVsize).toBeGreaterThan(0);
    expect(r.revealVsize).toBeGreaterThan(0);
  });

  it('commitOutputValueSats = postage + revealFeeSats', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    const r = simulateInscribeFees({
      feeRatePerVbyte: 8,
      body: new TextEncoder().encode('postage check'),
      contentType: 'text/plain',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    expect(r.commitOutputValueSats).toBe(INSCRIBE_POSTAGE_SATS + r.revealFeeSats);
  });

  it('fundingRequirementSats = commitOutputValueSats + commitFeeSats', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    const r = simulateInscribeFees({
      feeRatePerVbyte: 12,
      body: new TextEncoder().encode('funding req check'),
      contentType: 'text/plain',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    expect(r.fundingRequirementSats).toBe(r.commitOutputValueSats + r.commitFeeSats);
  });

  it('reveal vsize grows with body size (linear in 520-byte chunks)', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(200_000);
    const smallBody = new Uint8Array(100);
    const bigBody = new Uint8Array(2000); // 4 chunks vs 1
    const small = simulateInscribeFees({
      feeRatePerVbyte: 5,
      body: smallBody,
      contentType: 'application/octet-stream',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    const big = simulateInscribeFees({
      feeRatePerVbyte: 5,
      body: bigBody,
      contentType: 'application/octet-stream',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    expect(big.revealVsize).toBeGreaterThan(small.revealVsize);
  });

  it('total fee scales with fee rate (10 sat/vB ~= 2× 5 sat/vB at same content)', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    const at5 = simulateInscribeFees({
      feeRatePerVbyte: 5,
      body: new TextEncoder().encode('scaling'),
      contentType: 'text/plain',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    const at10 = simulateInscribeFees({
      feeRatePerVbyte: 10,
      body: new TextEncoder().encode('scaling'),
      contentType: 'text/plain',
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    // Ratios won't be exactly 2× because of ceil() rounding on
    // separate commit + reveal fees, but should be within ~5%.
    const ratio = at10.totalFeeSats / at5.totalFeeSats;
    expect(ratio).toBeGreaterThan(1.95);
    expect(ratio).toBeLessThan(2.05);
  });

  it('rejects feeRatePerVbyte <= 0', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    expect(() => simulateInscribeFees({
      feeRatePerVbyte: 0,
      body: new Uint8Array(0),
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    })).toThrow(/positive/);
  });

  it('rejects 33-byte ephemeral pubkey', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(100_000);
    expect(() => simulateInscribeFees({
      feeRatePerVbyte: 5,
      body: new Uint8Array(0),
      fundingInput,
      senderChangeAddress: fundingAddress,
      recipientAddress: makeRecipientP2tr().address!,
      ephemeralPubkeyXonly: new Uint8Array(33),
      network: NETWORK,
    })).toThrow(/32 bytes/);
  });
});
