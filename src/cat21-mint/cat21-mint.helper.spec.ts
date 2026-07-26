import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  BuildCat21MintArgs,
  CAT21_MINT_CHANGE_DUST_LIMIT_SATS,
  CAT21_MINT_POSTAGE_SATS,
  buildCat21MintPsbt,
} from './cat21-mint.helper';

const publicKey = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const p2wpkhMainnet = btc.p2wpkh(publicKey, btc.NETWORK);
const RECIPIENT_ADDR = p2wpkhMainnet.address!;
const CHANGE_ADDR = p2wpkhMainnet.address!;

function makeBaseArgs(overrides: Partial<BuildCat21MintArgs> = {}): BuildCat21MintArgs {
  return {
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Mainnet,
    fundingInput: {
      txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      vout: 0,
      value: 50_000,
      scriptPubKey: p2wpkhMainnet.script,
    },
    destinations: {
      recipientAddress: RECIPIENT_ADDR,
      senderChangeAddress: CHANGE_ADDR,
    },
    feeSats: 750,
    ...overrides,
  };
}

describe('buildCat21MintPsbt', () => {

  it('produces a parseable PSBT', () => {
    const result = buildCat21MintPsbt(makeBaseArgs());
    expect(Array.from(result.psbt.slice(0, 5))).toEqual([0x70, 0x73, 0x62, 0x74, 0xff]);
  });

  it('sets lockTime=21 (the protocol marker)', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21MintPsbt(makeBaseArgs()).psbt);
    expect(tx.lockTime).toBe(21);
  });

  it('places the cat at output 0 with the configured postage', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21MintPsbt(makeBaseArgs()).psbt);
    expect(tx.getOutput(0).amount).toBe(BigInt(CAT21_MINT_POSTAGE_SATS));
  });

  it('emits change at output 1 when above dust (no tip)', () => {
    // 50_000 - 546 postage - 750 fee = 48_704 change
    const result = buildCat21MintPsbt(makeBaseArgs());
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(1).amount).toBe(BigInt(48_704));
    expect(result.changeSats).toBe(48_704);
  });

  it('includes a developer-tip output between recipient and change when supplied', () => {
    // 50_000 - 546 postage - 1_000 tip - 750 fee = 47_704 change
    const result = buildCat21MintPsbt(
      makeBaseArgs({
        destinations: {
          recipientAddress: RECIPIENT_ADDR,
          senderChangeAddress: CHANGE_ADDR,
          tip: { address: RECIPIENT_ADDR, valueSats: 1_000 },
        },
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(3);
    expect(tx.getOutput(1).amount).toBe(BigInt(1_000));
    expect(tx.getOutput(2).amount).toBe(BigInt(47_704));
  });

  it('skips the tip output when value is 0', () => {
    const result = buildCat21MintPsbt(
      makeBaseArgs({
        destinations: {
          recipientAddress: RECIPIENT_ADDR,
          senderChangeAddress: CHANGE_ADDR,
          tip: { address: RECIPIENT_ADDR, valueSats: 0 },
        },
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
  });

  it('absorbs sub-dust change into the miner fee', () => {
    // 50_000 - 546 postage - 49_000 fee = 454 change → sub-dust → absorbed
    const result = buildCat21MintPsbt(makeBaseArgs({ feeSats: 49_000 }));
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(1);
    expect(result.changeSats).toBe(0);
  });

  it('throws on insufficient funding', () => {
    expect(() =>
      buildCat21MintPsbt(
        makeBaseArgs({
          fundingInput: {
            txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            vout: 0,
            value: 100,
            scriptPubKey: p2wpkhMainnet.script,
          },
        })
      )
    ).toThrow(/Mint funding insufficient/);
  });

  describe('per-wallet sequence (RBF policy)', () => {

    it('cat21wallet → sequence = 0xfffffffd (RBF on)', () => {
      const tx = btc.Transaction.fromPSBT(
        buildCat21MintPsbt(makeBaseArgs({ walletType: KnownOrdinalWalletType.cat21wallet })).psbt
      );
      expect(tx.getInput(0).sequence).toBe(0xfffffffd);
    });

    it('Xverse → sequence = 0xfffffffe (RBF off, third-party defence)', () => {
      const tx = btc.Transaction.fromPSBT(
        buildCat21MintPsbt(makeBaseArgs({ walletType: KnownOrdinalWalletType.xverse })).psbt
      );
      expect(tx.getInput(0).sequence).toBe(0xfffffffe);
    });

    it('Unisat → sequence = 0xfffffffe', () => {
      const tx = btc.Transaction.fromPSBT(
        buildCat21MintPsbt(makeBaseArgs({ walletType: KnownOrdinalWalletType.unisat })).psbt
      );
      expect(tx.getInput(0).sequence).toBe(0xfffffffe);
    });

    it('Leather → sequence = 0xfffffffe', () => {
      const tx = btc.Transaction.fromPSBT(
        buildCat21MintPsbt(makeBaseArgs({ walletType: KnownOrdinalWalletType.leather })).psbt
      );
      expect(tx.getInput(0).sequence).toBe(0xfffffffe);
    });
  });

  it('input carries SIGHASH_ALL', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21MintPsbt(makeBaseArgs()).psbt);
    expect(tx.getInput(0).sighashType).toBe(btc.SigHash.ALL);
  });

  it('supports a P2TR funding UTXO via tapInternalKey', () => {
    const taproot = btc.p2tr(publicKey.slice(1, 33), undefined, btc.NETWORK);
    const result = buildCat21MintPsbt(
      makeBaseArgs({
        fundingInput: {
          txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          vout: 0,
          value: 50_000,
          scriptPubKey: taproot.script,
          tapInternalKey: publicKey.slice(1, 33),
        },
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.getInput(0).tapInternalKey).toBeDefined();
  });

  // Finding #12 — the post-build sequence check used to `continue`
  // for Taproot inputs (the continue was scoped to the sighash
  // concern but accidentally swept the sequence check under). Pin
  // that Taproot inputs' sequence is asserted against the resolved
  // per-wallet value.
  it('asserts sequence on Taproot inputs too (no continue-past-the-check)', () => {
    const taproot = btc.p2tr(publicKey.slice(1, 33), undefined, btc.NETWORK);
    // cat21wallet → 0xfffffffd
    const cat21walletTx = btc.Transaction.fromPSBT(
      buildCat21MintPsbt(
        makeBaseArgs({
          walletType: KnownOrdinalWalletType.cat21wallet,
          fundingInput: {
            txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            vout: 0,
            value: 50_000,
            scriptPubKey: taproot.script,
            tapInternalKey: publicKey.slice(1, 33),
          },
        }),
      ).psbt,
    );
    expect(cat21walletTx.getInput(0).sequence).toBe(0xfffffffd);

    // Xverse (third-party) → 0xfffffffe
    const xverseTx = btc.Transaction.fromPSBT(
      buildCat21MintPsbt(
        makeBaseArgs({
          walletType: KnownOrdinalWalletType.xverse,
          fundingInput: {
            txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            vout: 0,
            value: 50_000,
            scriptPubKey: taproot.script,
            tapInternalKey: publicKey.slice(1, 33),
          },
        }),
      ).psbt,
    );
    expect(xverseTx.getInput(0).sequence).toBe(0xfffffffe);
  });

  it('rejects a negative fee', () => {
    expect(() => buildCat21MintPsbt(makeBaseArgs({ feeSats: -1 }))).toThrow(/non-negative/);
  });

  it('uses the configured dust limit (546) as the change boundary', () => {
    // 50_000 funding - 546 postage - 48_908 fee = 546 change → exactly at boundary → emitted
    const result = buildCat21MintPsbt(makeBaseArgs({ feeSats: 48_908 }));
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
    expect(result.changeSats).toBe(CAT21_MINT_CHANGE_DUST_LIMIT_SATS);
  });
});
