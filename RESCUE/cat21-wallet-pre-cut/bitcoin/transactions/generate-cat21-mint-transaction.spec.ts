import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { describe, expect, it } from 'vitest';

import type { OwnedUtxo } from '@leather.io/models';

import { getBtcSignerLibNetworkConfigByMode } from '../utils/bitcoin.network';
import { createBitcoinAddress } from '../validation/bitcoin-address';
import {
  CAT21_LOCK_TIME,
  CAT21_MINT_INPUT_SEQUENCE,
  CAT21_OUTPUT_VALUE,
  GenerateCat21MintTransactionArgs,
  generateCat21MintUnsignedTransaction,
} from './generate-cat21-mint-transaction';

const publicKey = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const payment = btc.p2wpkh(publicKey, btc.TEST_NETWORK);

const baseArgs: GenerateCat21MintTransactionArgs<OwnedUtxo> = {
  feeRate: 5,
  network: getBtcSignerLibNetworkConfigByMode('testnet'),
  recipient: 'tb1qsqncyhhqdtfn07t3dhupx7smv5gk83ds6k0gfa',
  changeAddress: createBitcoinAddress(payment.address!),
  utxos: [
    {
      address: payment.address!,
      path: "m/84'/1'/0'/0/0",
      keyOrigin: "deadbeef/84'/1'/0'/0/0",
      txid: '8192e8e20088c5f052fc7351b86b8f60a9454937860b281227e53e19f3e9c3f6',
      vout: 0,
      value: 50000,
    },
  ],
  payerLookup(keyOrigin: string) {
    return {
      paymentType: 'p2wpkh',
      address: createBitcoinAddress(payment.address!),
      keyOrigin,
      masterKeyFingerprint: 'deadbeef',
      network: 'testnet',
      payment: { script: payment.script, type: 'p2wpkh' },
      publicKey,
    };
  },
};

describe(generateCat21MintUnsignedTransaction.name, () => {
  it('sets nLockTime to exactly 21', () => {
    const result = generateCat21MintUnsignedTransaction(baseArgs);
    expect(result.tx.lockTime).toBe(CAT21_LOCK_TIME);
    expect(result.tx.lockTime).toBe(21);
  });

  it('sets every input sequence to 0xfffffffd (RBF-signaling, locktime honored)', () => {
    const result = generateCat21MintUnsignedTransaction(baseArgs);
    for (let i = 0; i < result.tx.inputsLength; i++) {
      const input = result.tx.getInput(i);
      expect(input.sequence).toBe(CAT21_MINT_INPUT_SEQUENCE);
      expect(input.sequence).toBe(0xfffffffd);
      // < 0xfffffffe => RBF-signaling
      expect(input.sequence!).toBeLessThan(0xfffffffe);
      // < 0xffffffff => locktime still honored
      expect(input.sequence!).toBeLessThan(0xffffffff);
    }
  });

  it('makes output 0 the recipient with the standard CAT-21 sat value', () => {
    const result = generateCat21MintUnsignedTransaction(baseArgs);
    const output0 = result.tx.getOutput(0);
    expect(output0.amount).toBe(BigInt(CAT21_OUTPUT_VALUE));
  });

  it('emits a tip output when configured with positive value', () => {
    /* `payment.address!` is the wallet's own change address. Using it as the tip
     * destination is fine for the spec — we only assert that a 1000-sat output
     * appears, not who receives it. */
    const result = generateCat21MintUnsignedTransaction({
      ...baseArgs,
      tip: { address: payment.address!, value: 1000 },
    });

    let foundTip = false;
    for (let i = 0; i < result.tx.outputsLength; i++) {
      const out = result.tx.getOutput(i);
      if (out.amount === BigInt(1000)) {
        foundTip = true;
        break;
      }
    }
    expect(foundTip).toBe(true);
  });

  it('does NOT emit a tip output when tip.value is 0', () => {
    const result = generateCat21MintUnsignedTransaction({
      ...baseArgs,
      tip: { address: payment.address!, value: 0 },
    });
    for (let i = 0; i < result.tx.outputsLength; i++) {
      expect(result.tx.getOutput(i).amount).not.toBe(BigInt(0));
    }
  });

  it('produces a parseable PSBT', () => {
    const result = generateCat21MintUnsignedTransaction(baseArgs);
    const psbtMagic = [0x70, 0x73, 0x62, 0x74, 0xff];
    expect(Array.from(result.psbt.slice(0, 5))).toEqual(psbtMagic);
  });
});
