import { describe, expect, it, afterEach } from '@jest/globals';

import { createInputScriptForUnisat, createTransaction, getAddressFormat, getDummyKeypair, getMinimumUtxoSize, getDummyLegacyTransaction, toXOnly, isSegWit } from './cat21.service.helper';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { Network, toScureNetwork } from '../network';
import { sha256 } from '@noble/hashes/sha256';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { CreateTransactionResult, TxnOutput } from './cat21.service.types';


describe('getMinimumUtxoSize', () => {

  it('correctly determines the minimum UTXO size for mainnet P2PKH addresses', () => {
    expect(getMinimumUtxoSize('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(546);
  });

  it('correctly determines the minimum UTXO size for testnet P2PKH addresses', () => {
    expect(getMinimumUtxoSize('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(546);
  });

  it('correctly determines the minimum UTXO size for mainnet P2WPKH addresses', () => {
    expect(getMinimumUtxoSize('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(294);
  });

  it('correctly determines the minimum UTXO size for testnet P2WPKH addresses', () => {
    expect(getMinimumUtxoSize('tb1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(294);
  });

  it('throws an error for unsupported address types', () => {
    expect(() => getMinimumUtxoSize('0xInvalidAddress')).toThrow('Unsupported address type');
  });
});

describe('getAddressFormat', () => {
  it('identifies P2WPKH format correctly', () => {
    expect(getAddressFormat('bc1q...')).toEqual('P2WPKH');
    expect(getAddressFormat('tb1q...')).toEqual('P2WPKH');
  });

  it('identifies uncertain P2SH format correctly', () => {
    expect(getAddressFormat('3...')).toEqual('P2SH???');
    expect(getAddressFormat('2...')).toEqual('P2SH???');
  });

  it('identifies P2TR format correctly', () => {
    expect(getAddressFormat('bc1p...')).toEqual('P2TR');
    expect(getAddressFormat('tb1p...')).toEqual('P2TR');
  });

  it('identifies P2PKH format correctly', () => {
    expect(getAddressFormat('1...')).toEqual('P2PKH');
    expect(getAddressFormat('m...')).toEqual('P2PKH');
    expect(getAddressFormat('n...')).toEqual('P2PKH');
  });

  it('throws error for unsupported address formats', () => {
    expect(() => getAddressFormat('x...')).toThrow('Unsupported address format.');
  });
});

describe('toXOnly', () => {
  it('should remove the first byte of the public key', () => {

    const pubkey = new Uint8Array([
      0x02, // First byte indicating the parity
      0x86, 0xdd, 0xd2, 0x1d, 0x86, 0xed, 0x3f, 0x55, 0x1f, 0xbf, 0x47, 0x09, 0x17, 0xaf, 0xbd, 0x17,
      0x27, 0x1e, 0xeb, 0x21, 0x76, 0xf9, 0x0b, 0xfc, 0x0b, 0x48, 0x68, 0x85, 0x51, 0x5f, 0xef, 0x7f,
    ]);

    const result = toXOnly(pubkey);

    const expected = new Uint8Array([
      0x86, 0xdd, 0xd2, 0x1d, 0x86, 0xed, 0x3f, 0x55, 0x1f, 0xbf, 0x47, 0x09, 0x17, 0xaf, 0xbd, 0x17,
      0x27, 0x1e, 0xeb, 0x21, 0x76, 0xf9, 0x0b, 0xfc, 0x0b, 0x48, 0x68, 0x85, 0x51, 0x5f, 0xef, 0x7f,
    ]);

    expect(result).toEqual(expected);
  });
});

describe('getDummyKeypair', () => {

  it('should always return the same private and public key', () => {
    const result = getDummyKeypair(btc.NETWORK);

    const dummyPrivateKeyHex = hex.encode(result.dummyPrivateKey);
    const dummyPublicKeyHex = hex.encode(result.dummyPublicKey);
    const xOnlyDummyPublicKeyHex = hex.encode(result.xOnlyDummyPublicKey);

    expect(dummyPrivateKeyHex).toEqual('0101010101010101010101010101010101010101010101010101010101010101');
    expect(dummyPublicKeyHex).toEqual('031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f');

    const expectedDummyPublicKeyHex = hex.encode(toXOnly(result.dummyPublicKey));
    expect(xOnlyDummyPublicKeyHex).toEqual(expectedDummyPublicKeyHex);
  });

  it('should always return the same addresses for mainnet', () => {
    const result = getDummyKeypair(btc.NETWORK);

    expect(result.addressP2PKH).toEqual('1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD');
    expect(result.addressP2SH_P2WPKH).toEqual('35LM1A29K95ADiQ8rJ9uEfVZCKffZE4D9i');
    expect(result.addressP2WPKH).toEqual('bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvrh6yhyw');
    expect(result.addressP2TR).toEqual('bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t');
  });

  it('should always return the same addresses for testnet', () => {
    const result = getDummyKeypair(btc.TEST_NETWORK);

    expect(result.addressP2PKH).toEqual('mrcNu71ztWjAQA6ww9kHiW3zBWSQidHXTQ');
    expect(result.addressP2SH_P2WPKH).toEqual('2MvtZ4txAvbaWRW2gXRmmrcUpQfsqNgpfUm');
    expect(result.addressP2WPKH).toEqual('tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla');
    expect(result.addressP2TR).toEqual('tb1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8snwrkwy');
  });
});

describe('getDummyLegacyTransaction', () => {
  it('creates a dummy transaction with the specified number of outputs for mainnet', () => {

    const txnOutput: TxnOutput = {
      txid: '', // not used
      vout: 2, // Expecting 3 outputs, including the one specified and two placeholders
      status: {} as any, // not used
      value: 1000
    };

    const transaction = getDummyLegacyTransaction(txnOutput, btc.NETWORK);
    expect(transaction.outputsLength).toBe(3);
    expect(transaction.hex).toBeTruthy();
  });

  it('creates a dummy transaction with the specified number of outputs for testnet', () => {

    const txnOutput: TxnOutput = {
      txid: '', // not used
      vout: 2, // Expecting 3 outputs, including the one specified and two placeholders
      status: {} as any, // not used
      value: 1000
    };

    const transaction = getDummyLegacyTransaction(txnOutput, btc.TEST_NETWORK);
    expect(transaction.outputsLength).toBe(3);
    expect(transaction.hex).toBeTruthy();
  });
});

describe('createInputScriptForUnisat', () => {
  const { dummyPublicKey, xOnlyDummyPublicKey } = getDummyKeypair(btc.NETWORK);

  // "Legacy" Pay-to-Public-Key-Hash
  it('creates script for P2PKH addresses', () => {
    const result = createInputScriptForUnisat('1...', dummyPublicKey, btc.NETWORK);
    expect(result).toHaveProperty('script');
    expect(result.redeemScript).toBeUndefined();
  });

  // Nested Segwit
  it('creates script for P2SH addresses', () => {
    const result = createInputScriptForUnisat('3...', dummyPublicKey, btc.NETWORK);
    expect(result).toHaveProperty('script');
    expect(result).toHaveProperty('redeemScript');
  });

  // Native Seqwit
  it('creates script for P2WPKH addresses', () => {
    const result = createInputScriptForUnisat('bc1q...', dummyPublicKey, btc.NETWORK);
    expect(result).toHaveProperty('script');
    expect(result.redeemScript).toBeUndefined();
  });

  // Taproot
  it('creates script for P2TR addresses', () => {
    const result = createInputScriptForUnisat('bc1p...', xOnlyDummyPublicKey, btc.NETWORK);
    expect(result).toHaveProperty('script');
    expect(result.redeemScript).toBeUndefined();
  });

});

describe('proof that we can create+sign a taproot input + output with dummy data', () => {

  // will first throw an exception (Invalid checksum!), but the second try should pass
  it('should execute flawlessly', () => {

    const { dummyPrivateKey, xOnlyDummyPublicKey } = getDummyKeypair(btc.TEST_NETWORK);
    const tx = new btc.Transaction();
    const scriptP2tr: btc.P2TROut = btc.p2tr(xOnlyDummyPublicKey, undefined, btc.TEST_NETWORK, true);

    // Add the Taproot input
    tx.addInput({
      txid: '0000000000000000000000000000000000000000000000000000000000000000',
      index: 0,
      witnessUtxo: {
        script: scriptP2tr.script,
        amount: BigInt(1000),
      },
      ...scriptP2tr // P2TROut has some extra properties that we all just merge into the intput
    });
    tx.addOutputAddress('tb1pz8ylmfpyl78mmqrvjnlwewec2apmvd3hydtnwxykr497qv89etrqksf3qc', BigInt(1000), btc.TEST_NETWORK);

    // Sign the input with the dummy private key
    tx.signIdx(dummyPrivateKey, 0);
    tx.finalize();
  });
});


const dummyKeypair = getDummyKeypair(btc.NETWORK);

const createTransactionTestCases = [
  {
    info: 'Xverse which always uses Nested SegWit for payments and Taproot for ordinals',
    walletType: KnownOrdinalWalletType.xverse,
    recipientAddress: dummyKeypair.addressP2TR,
    paymentPublicKey: dummyKeypair.dummyPublicKey,
    paymentAddress: dummyKeypair.addressP2SH_P2WPKH,
    feesForSingleOutput: BigInt(9000), // High fee to ensure change of 454 sats ($0.19) is below dust limit of 546 sats ($0.23)
  },
  {
    info: 'Leather which always uses Native SegWit for payments and Taproot for ordinals',
    walletType: KnownOrdinalWalletType.leather,
    recipientAddress: dummyKeypair.addressP2TR,
    paymentPublicKey: dummyKeypair.dummyPublicKey,
    paymentAddress: dummyKeypair.addressP2WPKH,
    feesForSingleOutput: BigInt(9000 + 200) // Higher fees compared to Xverse test, because Native SegWit has a smaller dust limit
  },
  {
    info: 'Unisat with Legacy address for payments and ordinals 🙀',
    walletType: KnownOrdinalWalletType.unisat,
    recipientAddress: dummyKeypair.addressP2PKH,
    paymentPublicKey: dummyKeypair.dummyPublicKey,
    paymentAddress: dummyKeypair.addressP2PKH,
    feesForSingleOutput: BigInt(9000)
  },
  {
    info: 'Unisat with Nested Segwit address for payments and ordinals 🙀',
    walletType: KnownOrdinalWalletType.unisat,
    recipientAddress: dummyKeypair.addressP2SH_P2WPKH,
    paymentPublicKey: dummyKeypair.dummyPublicKey,
    paymentAddress: dummyKeypair.addressP2SH_P2WPKH,
    feesForSingleOutput: BigInt(9000)
  },
  {
    info: 'Unisat with Native Seqwit address for payments and ordinals 🙀',
    walletType: KnownOrdinalWalletType.unisat,
    recipientAddress: dummyKeypair.addressP2WPKH,
    paymentPublicKey: dummyKeypair.dummyPublicKey,
    paymentAddress: dummyKeypair.addressP2WPKH,
    feesForSingleOutput: BigInt(9000 + 200) // Higher fees, because Native SegWit has a smaller dust limit
  },
  {
    info: 'Unisat with Taproot for payments and ordinals 😻',
    walletType: KnownOrdinalWalletType.unisat,
    recipientAddress: dummyKeypair.addressP2TR,
    paymentPublicKey: dummyKeypair.dummyPublicKey,
    paymentAddress: dummyKeypair.addressP2TR,
    feesForSingleOutput: BigInt(9000 + 200) // Higher fees, because Taproot has a smaller dust limit
  }
];

// Byte-snapshot of the finalized mint tx, per wallet / address combo,
// per dust-vs-change branch. Pinned with the SDK on
// @scure/btc-signer 1.2.1. Snapshots are the canary for a scure bump
// — review the diff, re-pin if the new bytes are still valid signed
// transactions. Snapshots don't promise byte equality across versions;
// they pin "what we ship today" so a bump's effect is visible.
describe('createTransaction byte snapshot (pinned for @scure/btc-signer)', () => {

  createTransactionTestCases.forEach(({ info, walletType, recipientAddress, paymentPublicKey, paymentAddress, feesForSingleOutput }) => {

    const paymentUtxo: TxnOutput = {
      txid: hex.encode(sha256('text-txid')),
      vout: 0,
      value: 10000,
      status: {} as any,
      transactionHex: undefined
    };

    if (!isSegWit(paymentAddress)) {
      const dummyTx = getDummyLegacyTransaction(paymentUtxo, btc.NETWORK);
      paymentUtxo.txid = dummyTx.id;
      paymentUtxo.transactionHex = dummyTx.hex;
    }

    // Zero-aux makes Schnorr signing deterministic (BIP-340 §3.3 — aux
    // is optional and zeros are explicitly allowed). Without this, the
    // Taproot cases produce a fresh random signature on every run and
    // the snapshot is useless.
    const zeroAux = new Uint8Array(32);

    const signedHexFor = (fee: bigint): string => {
      const result = createTransaction(
        walletType,
        recipientAddress,
        paymentUtxo,
        paymentPublicKey,
        paymentAddress,
        fee,
        false,
        Network.Mainnet
      );
      result.tx.signIdx(dummyKeypair.dummyPrivateKey, 0, [btc.SigHash.ALL], zeroAux);
      result.tx.finalize();
      return result.tx.hex;
    };

    describe(info, () => {

      it('dust-absorb branch produces the canonical finalized tx hex', () => {
        expect(signedHexFor(feesForSingleOutput)).toMatchSnapshot();
      });

      it('change-output branch produces the canonical finalized tx hex', () => {
        expect(signedHexFor(BigInt(5000))).toMatchSnapshot();
      });
    });
  });
});

// prices: 1BTC == 42855 USD
createTransactionTestCases.forEach(({ info, walletType, recipientAddress, paymentPublicKey, paymentAddress, feesForSingleOutput }) => {

  describe(`createTransaction for ${info}`, () => {

    let result: CreateTransactionResult | undefined;

    const paymentUtxo: TxnOutput = {
      txid: hex.encode(sha256('text-txid')),
      vout: 0,
      value: 10000, // 10000 sats ($4.28)
      status: {} as any,
      transactionHex: undefined
    };

    if (!isSegWit(paymentAddress)) {
      const dummyTx = getDummyLegacyTransaction(paymentUtxo, btc.NETWORK);
      paymentUtxo.txid = dummyTx.id;
      paymentUtxo.transactionHex = dummyTx.hex;
    }

    it('creates only one output if change would be below dust limit, miner gets some more fees', () => {

      result = createTransaction(
        walletType,
        recipientAddress,
        paymentUtxo,
        paymentPublicKey,
        paymentAddress,
        feesForSingleOutput,
        false,
        Network.Mainnet
      );

      if (!result.tx) {
        throw Error('Transaction expected');
      }

      expect(result.tx.outputsLength).toBe(1);
      expect(result.tx.getOutput(0).amount).toBe(BigInt(546));

      expect(result.amountToRecipient).toBe(BigInt(546));
      expect(result.singleInputAmount).toBe(BigInt(10000));
      expect(result.changeAmount).toBe(BigInt(0));
      expect(result.finalTransactionFee).toBe(BigInt(9454));

      expect(result.amountToRecipient + result.changeAmount + result.finalTransactionFee).toBe(result.singleInputAmount);
    });

    it('creates two outputs if change is above dust limit', () => {

      result = createTransaction(
        walletType,
        recipientAddress,
        paymentUtxo,
        paymentPublicKey,
        paymentAddress,
        BigInt(5000), // Lower fee to ensure change of 4.454 sats ($1.91) is above dust limit of 546 sats ($0.23)
        false,
        Network.Mainnet
      );

      if (!result.tx) {
        throw Error('Transaction expected');
      }

      expect(result.tx.outputsLength).toBe(2);
      expect(result.tx.getOutput(0).amount).toBe(BigInt(546));
      expect(result.tx.getOutput(1).amount).toBe(BigInt(4454));

      expect(result.amountToRecipient).toBe(BigInt(546));
      expect(result.singleInputAmount).toBe(BigInt(10000));
      expect(result.changeAmount).toBe(BigInt(4454));
      expect(result.finalTransactionFee).toBe(BigInt(5000));

      expect(result.amountToRecipient + result.changeAmount + result.finalTransactionFee).toBe(result.singleInputAmount);
    });

    it('fails with an exeption if funds are too low', () => {

      result = undefined;
      expect(() => createTransaction(
        walletType,
        recipientAddress,
        paymentUtxo,
        paymentPublicKey,
        paymentAddress,
        BigInt(9000 + 1000), // now we are out of money, change would be negative
        false,
        Network.Mainnet
      )).toThrowError(new Error('Insufficient funds for transaction'));
    });

    // creating broken transactions is easy, but can we also sign and finalize them?
    afterEach(() => {

      if (result?.tx) {
        result.tx.signIdx(dummyKeypair.dummyPrivateKey, 0, [btc.SigHash.ALL]);
        result.tx.finalize();
        expect(result.tx.vsize).toBeGreaterThan(100);
      }
    });
  });
});


// All Network enum variants flow through toScureNetwork. The four
// testnet variants flatten to btc.TEST_NETWORK; mainnet stays apart.
// Pin the flattening end-to-end so a future change that introduces
// signet- or regtest-specific address derivation can't slip past.
describe('createTransaction across all Network variants', () => {

  const allNetworks: Network[] = [
    Network.Mainnet,
    Network.Testnet3,
    Network.Testnet4,
    Network.Signet,
    Network.Regtest,
  ];

  allNetworks.forEach(network => {
    it(`derives a usable dummy keypair for ${network}`, () => {
      const kp = getDummyKeypair(toScureNetwork(network));
      expect(kp.addressP2PKH).toBeTruthy();
      expect(kp.addressP2SH_P2WPKH).toBeTruthy();
      expect(kp.addressP2WPKH).toBeTruthy();
      expect(kp.addressP2TR).toBeTruthy();
    });
  });

  it('produces the canonical mainnet addresses for Network.Mainnet', () => {
    const kp = getDummyKeypair(toScureNetwork(Network.Mainnet));
    expect(kp.addressP2PKH).toBe('1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD');
    expect(kp.addressP2WPKH).toBe('bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvrh6yhyw');
    expect(kp.addressP2TR).toBe('bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t');
  });

  it('produces identical testnet addresses for every testnet variant (scure flattens them)', () => {
    const kpT3 = getDummyKeypair(toScureNetwork(Network.Testnet3));
    const kpT4 = getDummyKeypair(toScureNetwork(Network.Testnet4));
    const kpSignet = getDummyKeypair(toScureNetwork(Network.Signet));
    const kpRegtest = getDummyKeypair(toScureNetwork(Network.Regtest));
    expect(kpT4.addressP2WPKH).toBe(kpT3.addressP2WPKH);
    expect(kpSignet.addressP2WPKH).toBe(kpT3.addressP2WPKH);
    expect(kpRegtest.addressP2WPKH).toBe(kpT3.addressP2WPKH);
    // and confirm they're actually testnet, not mainnet
    expect(kpT3.addressP2WPKH).toBe('tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla');
  });

  // The mint flow itself goes through createTransaction(..., network)
  // for every Network. Smoke-test that each variant produces a tx with
  // the recipient output, no scure throw, regardless of which testnet
  // string was picked.
  allNetworks.forEach(network => {
    it(`createTransaction works end-to-end for ${network}`, () => {
      const kp = getDummyKeypair(toScureNetwork(network));
      const utxo: TxnOutput = {
        txid: hex.encode(sha256(`utxo-${network}`)),
        vout: 0,
        value: 10000,
        status: {} as any,
        transactionHex: undefined,
      };
      const result = createTransaction(
        KnownOrdinalWalletType.leather,
        kp.addressP2TR,
        utxo,
        kp.dummyPublicKey,
        kp.addressP2WPKH,
        BigInt(5000),
        false,
        network,
      );
      expect(result.tx.outputsLength).toBe(2);
      expect(result.amountToRecipient).toBe(BigInt(546));
    });
  });
});


// Dust-limit boundary. The branch at cat21.service.helper.ts:464
// decides: if changeAmount >= dustLimit, add a change output; if
// changeAmount < dustLimit, absorb the change into the miner fee.
//
// Absorb is deliberate, not a bug — sub-dust change pushed into the
// fee makes the cat rarer in color (color is derived from feeRate
// per CAT-21 rarity score) and prioritises the tx. See the
// project-level memory "dust-absorb-into-fee is a CAT-21 feature".
// These tests pin the boundary so a future refactor that shifts the
// threshold by one sat is caught immediately.
//
// changeAmount = singleInputAmount - amountToRecipient - transactionFee
//              = 10000 - 546 - fee
//              = 9454 - fee
// We pick `fee` so that `changeAmount` lands at dustLimit-1, dustLimit,
// or dustLimit+1.
describe('createTransaction dust-limit boundary', () => {

  type BoundaryCase = {
    label: string;
    walletType: KnownOrdinalWalletType;
    paymentAddressType: 'P2PKH' | 'P2SH-P2WPKH' | 'P2WPKH' | 'P2TR';
    dustLimit: number;
  };

  const cases: BoundaryCase[] = [
    { label: 'Xverse (Nested SegWit, dust 546)', walletType: KnownOrdinalWalletType.xverse,  paymentAddressType: 'P2SH-P2WPKH', dustLimit: 546 },
    { label: 'Leather (Native SegWit, dust 294)', walletType: KnownOrdinalWalletType.leather, paymentAddressType: 'P2WPKH',      dustLimit: 294 },
    { label: 'Unisat Legacy (dust 546)',         walletType: KnownOrdinalWalletType.unisat,  paymentAddressType: 'P2PKH',       dustLimit: 546 },
    { label: 'Unisat Taproot (dust 330)',        walletType: KnownOrdinalWalletType.unisat,  paymentAddressType: 'P2TR',        dustLimit: 330 },
  ];

  cases.forEach(({ label, walletType, paymentAddressType, dustLimit }) => {

    const paymentAddress = (() => {
      switch (paymentAddressType) {
        case 'P2PKH':       return dummyKeypair.addressP2PKH;
        case 'P2SH-P2WPKH': return dummyKeypair.addressP2SH_P2WPKH;
        case 'P2WPKH':      return dummyKeypair.addressP2WPKH;
        case 'P2TR':        return dummyKeypair.addressP2TR;
      }
    })();

    const buildUtxo = (): TxnOutput => {
      const utxo: TxnOutput = {
        txid: hex.encode(sha256(`boundary-${label}`)),
        vout: 0,
        value: 10000,
        status: {} as any,
        transactionHex: undefined,
      };
      if (!isSegWit(paymentAddress)) {
        const dummyTx = getDummyLegacyTransaction(utxo, btc.NETWORK);
        utxo.txid = dummyTx.id;
        utxo.transactionHex = dummyTx.hex;
      }
      return utxo;
    };

    const callCreateTransaction = (fee: bigint): CreateTransactionResult => createTransaction(
      walletType,
      dummyKeypair.addressP2TR,
      buildUtxo(),
      dummyKeypair.dummyPublicKey,
      paymentAddress,
      fee,
      false,
      Network.Mainnet,
    );

    describe(label, () => {

      // changeAmount == dustLimit - 1 → absorb branch
      it('absorbs change into the miner fee when changeAmount is one sat below the dust limit', () => {
        const fee = BigInt(9454 - (dustLimit - 1));
        const result = callCreateTransaction(fee);

        expect(result.tx.outputsLength).toBe(1);
        expect(result.changeAmount).toBe(BigInt(0));
        expect(result.finalTransactionFee).toBe(fee + BigInt(dustLimit - 1));
        expect(result.tx.getOutput(0).amount).toBe(BigInt(546));
      });

      // changeAmount == dustLimit → change-output branch (>=, not >)
      it('returns change as a second output when changeAmount equals the dust limit exactly', () => {
        const fee = BigInt(9454 - dustLimit);
        const result = callCreateTransaction(fee);

        expect(result.tx.outputsLength).toBe(2);
        expect(result.changeAmount).toBe(BigInt(dustLimit));
        expect(result.finalTransactionFee).toBe(fee);
        expect(result.tx.getOutput(0).amount).toBe(BigInt(546));
        expect(result.tx.getOutput(1).amount).toBe(BigInt(dustLimit));
      });

      // changeAmount == dustLimit + 1 → change-output branch
      it('returns change as a second output when changeAmount is one sat above the dust limit', () => {
        const fee = BigInt(9454 - (dustLimit + 1));
        const result = callCreateTransaction(fee);

        expect(result.tx.outputsLength).toBe(2);
        expect(result.changeAmount).toBe(BigInt(dustLimit + 1));
        expect(result.finalTransactionFee).toBe(fee);
        expect(result.tx.getOutput(1).amount).toBe(BigInt(dustLimit + 1));
      });
    });
  });
});
