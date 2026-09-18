import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network.js';

import { simulateInscribeFees } from './inscription-fee.helper.js';
import { prepareInscribeFundingInput } from './inscription-input-adapter.js';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const FUNDING_PRIV = new Uint8Array(32).fill(0x77);
const RECIPIENT_PRIV = new Uint8Array(32).fill(0x88);

function requirementForFundingValue(valueSats: number): number {
  const fundingPubkey = secp256k1.getPublicKey(FUNDING_PRIV, true);
  const p2wpkh = btc.p2wpkh(fundingPubkey, scureNetwork);
  const fundingInput = prepareInscribeFundingInput({
    utxo: { txid: 'f'.repeat(64), vout: 0, value: valueSats, status: { confirmed: true } },
    paymentPublicKey: fundingPubkey,
    paymentAddress: p2wpkh.address!,
    isSimulation: true,
    network: NETWORK,
  });
  return simulateInscribeFees({
    feeRatePerVbyte: 5,
    body: new TextEncoder().encode('x'.repeat(400)),
    contentType: 'text/plain',
    fundingInput,
    senderChangeAddress: p2wpkh.address!,
    recipientAddress: btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true).address!,
    ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
    network: NETWORK,
  }).fundingRequirementSats;
}

describe('fundingRequirementSats is knowable before a funding coin is chosen', () => {
  /**
   * A guard spec has to seed its dirty coin just above what the flow needs,
   * which is only possible if the requirement can be computed BEFORE picking a
   * coin. It can: the requirement is postage + reveal fee + commit fee, and the
   * commit's vsize turns on the funding input's SCRIPT TYPE, not on how many
   * sats sit behind it. Were that to stop holding, every consumer measuring the
   * requirement up front would silently start seeding into the wrong trap.
   */
  it('is identical across funding values spanning two orders of magnitude', () => {
    const at20k = requirementForFundingValue(20_000);
    expect(requirementForFundingValue(100_000)).toBe(at20k);
    expect(requirementForFundingValue(1_000_000)).toBe(at20k);
    expect(requirementForFundingValue(5_000_000)).toBe(at20k);
  });

  it('is the sum the funding coin actually has to cover', () => {
    const fundingPubkey = secp256k1.getPublicKey(FUNDING_PRIV, true);
    const p2wpkh = btc.p2wpkh(fundingPubkey, scureNetwork);
    const result = simulateInscribeFees({
      feeRatePerVbyte: 5,
      body: new TextEncoder().encode('x'.repeat(400)),
      contentType: 'text/plain',
      fundingInput: prepareInscribeFundingInput({
        utxo: { txid: 'f'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
        paymentPublicKey: fundingPubkey,
        paymentAddress: p2wpkh.address!,
        isSimulation: true,
        network: NETWORK,
      }),
      senderChangeAddress: p2wpkh.address!,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true).address!,
      ephemeralPubkeyXonly: schnorr.getPublicKey(RECIPIENT_PRIV),
      network: NETWORK,
    });
    expect(result.fundingRequirementSats).toBe(result.commitOutputValueSats + result.commitFeeSats);
  });
});
