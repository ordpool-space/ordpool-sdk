import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  BuildCat21TransferArgs,
  CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS,
  buildCat21TransferPsbt,
} from './cat21-transfer.helper';
import { CAT21_TRANSFER_POSTAGE_SATS } from './cat21-transfer.types';

const publicKey = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const p2wpkhMainnet = btc.p2wpkh(publicKey, btc.NETWORK);
const RECIPIENT_ADDR = p2wpkhMainnet.address!;
const CHANGE_ADDR = p2wpkhMainnet.address!;

function makeBaseArgs(overrides: Partial<BuildCat21TransferArgs> = {}): BuildCat21TransferArgs {
  return {
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Mainnet,
    catUtxo: {
      txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      vout: 0,
      value: 546,
      scriptPubKey: p2wpkhMainnet.script,
    },
    fundingInputs: [
      {
        txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        vout: 1,
        value: 50_000,
        scriptPubKey: p2wpkhMainnet.script,
      },
    ],
    destinations: {
      recipientAddress: RECIPIENT_ADDR,
      senderChangeAddress: CHANGE_ADDR,
    },
    feeSats: 1_100,
    ...overrides,
  };
}

describe('buildCat21TransferPsbt', () => {

  it('produces a parseable PSBT', () => {
    const result = buildCat21TransferPsbt(makeBaseArgs());
    expect(Array.from(result.psbt.slice(0, 5))).toEqual([0x70, 0x73, 0x62, 0x74, 0xff]);
  });

  it('sets lockTime=21 (every cat-touching tx is structurally a CAT-21 mint)', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21TransferPsbt(makeBaseArgs()).psbt);
    expect(tx.lockTime).toBe(21);
  });

  it('puts the cat UTXO at input 0 and funding UTXO(s) at 1..N', () => {
    const args = makeBaseArgs();
    const tx = btc.Transaction.fromPSBT(buildCat21TransferPsbt(args).psbt);
    expect(tx.inputsLength).toBe(2);
    expect(Array.from(tx.getInput(0).txid!)).toEqual(Array.from(hex.decode(args.catUtxo.txid)));
    expect(Array.from(tx.getInput(1).txid!)).toEqual(
      Array.from(hex.decode(args.fundingInputs[0].txid))
    );
  });

  it('places the cat at output 0 with the configured postage', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21TransferPsbt(makeBaseArgs()).psbt);
    expect(tx.getOutput(0).amount).toBe(BigInt(CAT21_TRANSFER_POSTAGE_SATS));
  });

  it('emits change at output 1 when above dust', () => {
    // 546 cat + 50_000 funding - 546 postage - 1_100 fee = 48_900 change
    const result = buildCat21TransferPsbt(makeBaseArgs());
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(1).amount).toBe(BigInt(48_900));
    expect(result.changeSats).toBe(48_900);
  });

  it('absorbs sub-dust change into the miner fee instead of emitting it', () => {
    // Default senderChangeAddress is P2WPKH → dust=294.
    // catUtxo=546 + funding=1_393 = 1_939 totalIn; 1_939 - 546 - 1_100 = 293 change → sub-P2WPKH-dust
    const result = buildCat21TransferPsbt(
      makeBaseArgs({
        fundingInputs: [
          {
            txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            vout: 1,
            value: 1_393,
            scriptPubKey: p2wpkhMainnet.script,
          },
        ],
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(1);
    expect(result.changeSats).toBe(0);
  });

  it('supports zero funding inputs when the caller covers fee with no surplus (fee=0 edge case)', () => {
    // catUtxo always 546 (HARD RULE). Self-funded transfers are only viable
    // when feeSats=0 (which a real broadcast wouldn't accept, but the
    // builder doesn't reject — fee policy is the broadcaster's concern).
    const result = buildCat21TransferPsbt(
      makeBaseArgs({
        fundingInputs: [],
        feeSats: 0,
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.inputsLength).toBe(1);
    expect(result.fundingInputTotalSats).toBe(0);
  });

  it('throws on insufficient funding', () => {
    expect(() =>
      buildCat21TransferPsbt(
        makeBaseArgs({
          fundingInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 100,
              scriptPubKey: p2wpkhMainnet.script,
            },
          ],
        })
      )
    ).toThrow(/Transfer funding insufficient/);
  });

  describe('RBF policy — always on for transfer, regardless of wallet (2026-07-25 fix)', () => {

    // Transfers run against cats already on chain. A third-party
    // wallet's accelerate UI producing an RBF replacement without
    // `lockTime=21` only loses the BONUS mint, not the existing cat.
    // The mint-only RBF-off gate does NOT apply here (per user rule:
    // "I only care that cat21 mints are not destroyed"). Every
    // wallet gets 0xfffffffd so third-party sellers stuck at old
    // fees can bump.

    it.each([
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.xverse,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.leather,
    ])('%s → every input sequence = 0xfffffffd (RBF on)', (walletType) => {
      const tx = btc.Transaction.fromPSBT(
        buildCat21TransferPsbt(makeBaseArgs({ walletType })).psbt
      );
      for (let i = 0; i < tx.inputsLength; i++) {
        expect(tx.getInput(i).sequence).toBe(0xfffffffd);
      }
    });
  });

  it('every input carries SIGHASH_ALL', () => {
    const tx = btc.Transaction.fromPSBT(buildCat21TransferPsbt(makeBaseArgs()).psbt);
    for (let i = 0; i < tx.inputsLength; i++) {
      expect(tx.getInput(i).sighashType).toBe(btc.SigHash.ALL);
    }
  });

  it('supports a P2TR cat UTXO via tapInternalKey', () => {
    const taproot = btc.p2tr(publicKey.slice(1, 33), undefined, btc.NETWORK);
    const result = buildCat21TransferPsbt(
      makeBaseArgs({
        catUtxo: {
          txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          vout: 0,
          value: 546,
          scriptPubKey: taproot.script,
          tapInternalKey: publicKey.slice(1, 33),
        },
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.getInput(0).tapInternalKey).toBeDefined();
  });

  it('accepts a cat UTXO of any size (546 is our OUTPUT convention, not an input constraint)', () => {
    // A cat can be minted on any UTXO size by any transaction, not only ours.
    // The transfer uses the real catUtxo.value; the surplus above the 546
    // output goes to the sender's change. Output 0 stays 546 (our convention).
    // 1_000 cat + 50_000 funding - 546 postage - 1_100 fee = 49_354 change.
    const big = buildCat21TransferPsbt(makeBaseArgs({
      catUtxo: { ...makeBaseArgs().catUtxo, value: 1_000 },
    }));
    expect(btc.Transaction.fromPSBT(big.psbt).getOutput(0).amount).toBe(BigInt(546));
    expect(big.changeSats).toBe(49_354);

    // A sub-546 cat (e.g. a 330-sat taproot mint) is fine too; funding tops
    // up the postage. 330 cat + 50_000 funding - 546 postage - 1_100 fee = 48_684.
    const small = buildCat21TransferPsbt(makeBaseArgs({
      catUtxo: { ...makeBaseArgs().catUtxo, value: 330 },
    }));
    expect(small.changeSats).toBe(48_684);
  });

  it('rejects a negative fee', () => {
    expect(() => buildCat21TransferPsbt(makeBaseArgs({ feeSats: -1 }))).toThrow(/non-negative/);
  });

  it('uses the configured dust limit (546) as the change boundary', () => {
    // Exactly at the dust limit → change is EMITTED (>= boundary).
    // 546 + 1_692 funding - 546 postage - 1_100 fee = 592 change
    // 546 + 1_546 funding - 546 postage - 1_000 fee = 546 change exactly → emitted
    const result = buildCat21TransferPsbt(
      makeBaseArgs({
        catUtxo: {
          txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          vout: 0,
          value: 546,
          scriptPubKey: p2wpkhMainnet.script,
        },
        fundingInputs: [
          {
            txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            vout: 1,
            value: 1_546,
            scriptPubKey: p2wpkhMainnet.script,
          },
        ],
        feeSats: 1_000,
      })
    );
    const tx = btc.Transaction.fromPSBT(result.psbt);
    expect(tx.outputsLength).toBe(2);
    expect(result.changeSats).toBe(CAT21_TRANSFER_CHANGE_DUST_LIMIT_SATS);
  });

  describe('Finding #13 — per-address-type dust floor for senderChangeAddress', () => {

    // Pre-fix the builder hardcoded 546 as the dust threshold, so a
    // P2TR sender with change in [330, 546) lost the whole change to
    // the miner fee silently. Fix derives the floor from
    // senderChangeAddress via getMinimumUtxoSize (P2TR=330, P2WPKH=294,
    // P2SH=546, P2PKH=546).

    const p2trMainnet = btc.p2tr(publicKey.slice(1, 33), undefined, btc.NETWORK);

    it('P2TR senderChangeAddress: emits change at 330 sats (previously absorbed)', () => {
      // 546 cat + 1_430 funding - 546 postage - 1_100 fee = 330 change → emit (P2TR dust = 330).
      const result = buildCat21TransferPsbt(
        makeBaseArgs({
          destinations: {
            recipientAddress: RECIPIENT_ADDR,
            senderChangeAddress: p2trMainnet.address!,
          },
          fundingInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 1_430,
              scriptPubKey: p2wpkhMainnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(330);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(2);
    });

    it('P2TR senderChangeAddress: absorbs 329 sats change into fee (just below P2TR dust)', () => {
      // 546 + 1_429 - 546 - 1_100 = 329 change → sub-P2TR-dust → absorbed.
      const result = buildCat21TransferPsbt(
        makeBaseArgs({
          destinations: {
            recipientAddress: RECIPIENT_ADDR,
            senderChangeAddress: p2trMainnet.address!,
          },
          fundingInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 1_429,
              scriptPubKey: p2wpkhMainnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(0);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(1);
    });

    it('P2WPKH senderChangeAddress: emits change at 294 sats (previously absorbed)', () => {
      // 546 + 1_394 - 546 - 1_100 = 294 change → emit (P2WPKH dust = 294).
      const result = buildCat21TransferPsbt(
        makeBaseArgs({
          fundingInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 1_394,
              scriptPubKey: p2wpkhMainnet.script,
            },
          ],
        })
      );
      expect(result.changeSats).toBe(294);
      expect(btc.Transaction.fromPSBT(result.psbt).outputsLength).toBe(2);
    });
  });
});
