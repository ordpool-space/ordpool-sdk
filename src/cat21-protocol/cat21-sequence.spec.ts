import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';
import { buildCat21BuyOfferPsbt } from '../cat21-offer/cat21-offer.helper';
import { buildCat21TransferPsbt } from '../cat21-transfer/cat21-transfer.helper';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE,
  CAT21_WALLET_INPUT_SEQUENCE,
  resolveCat21MintInputSequence,
} from './cat21-sequence';
import { buildCat21MintPsbt } from '../cat21-mint/cat21-mint.helper';
import { createTransaction, getDummyKeypair } from '../cat21-mint/cat21.service.helper';
import { TxnOutput } from '../cat21-mint/cat21.service.types';

const publicKey = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const p2wpkhMainnet = btc.p2wpkh(publicKey, btc.NETWORK);
const ADDR = p2wpkhMainnet.address!;

describe('resolveCat21MintInputSequence (single source of truth)', () => {

  it('exposes the two raw sequence constants', () => {
    expect(CAT21_WALLET_INPUT_SEQUENCE).toBe(0xfffffffd);
    expect(CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE).toBe(0xfffffffe);
  });

  it('cat21wallet → 0xfffffffd', () => {
    expect(resolveCat21MintInputSequence(KnownOrdinalWalletType.cat21wallet)).toBe(0xfffffffd);
  });

  it.each([
    KnownOrdinalWalletType.xverse,
    KnownOrdinalWalletType.unisat,
    KnownOrdinalWalletType.leather,
  ])('%s → 0xfffffffe', wallet => {
    expect(resolveCat21MintInputSequence(wallet)).toBe(0xfffffffe);
  });

  describe('cat-flow builders — mint-only RBF-off, everything else RBF-on', () => {

    // The 2026-07-25 code review (finding #8) caught that transfer +
    // offer were incorrectly applying the mint-only per-wallet RBF
    // gate — third-party sellers ended up with 0xfffffffe on the cat
    // input and couldn't bump a stuck fee via their wallet's
    // accelerate UI. The correct rule: mint (and createTransaction
    // which builds mints) is the ONLY flow that needs RBF-off for
    // third-party wallets, because the not-yet-confirmed mint carries
    // the `lockTime=21` marker that would be dropped on a marker-
    // ignorant RBF replacement. Post-mint flows (transfer, offer)
    // run against cats already on chain; the worst RBF outcome is a
    // missed bonus mint. Third-party sellers CAN bump.
    //
    // What this spec pins:
    //   - mint + createTransaction: sequence == resolveCat21MintInputSequence(wallet)
    //     (per-wallet: cat21wallet=RBF-on, others=RBF-off)
    //   - transfer + offer: sequence == CAT21_WALLET_INPUT_SEQUENCE
    //     (RBF-on for EVERY wallet — no more mint-only gate)

    function mintSequence(walletType: KnownOrdinalWalletType): number {
      const tx = btc.Transaction.fromPSBT(
        buildCat21MintPsbt({
          walletType,
          network: Network.Mainnet,
          fundingInput: {
            txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            vout: 0,
            value: 50_000,
            scriptPubKey: p2wpkhMainnet.script,
          },
          destinations: { recipientAddress: ADDR, senderChangeAddress: ADDR },
          feeSats: 750,
        }).psbt
      );
      return tx.getInput(0).sequence!;
    }

    function transferSequence(walletType: KnownOrdinalWalletType): number {
      const tx = btc.Transaction.fromPSBT(
        buildCat21TransferPsbt({
          walletType,
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
          destinations: { recipientAddress: ADDR, senderChangeAddress: ADDR },
          feeSats: 1_100,
        }).psbt
      );
      return tx.getInput(0).sequence!;
    }

    function offerSellerSequence(walletType: KnownOrdinalWalletType): number {
      // Offers ship RBF-on for every wallet (2026-07-25). The
      // walletType arg is still on the type for future use; the
      // sequence-picking no longer branches on it.
      const tx = btc.Transaction.fromPSBT(
        buildCat21BuyOfferPsbt({
          walletType,
          network: Network.Mainnet,
          sellerInput: {
            txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            vout: 0,
            value: 546,
            scriptPubKey: p2wpkhMainnet.script,
          },
          buyerInputs: [
            {
              txid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
              vout: 1,
              value: 50_000,
              scriptPubKey: p2wpkhMainnet.script,
            },
          ],
          destinations: {
            buyerReceiveAddress: ADDR,
            sellerPaymentAddress: ADDR,
            buyerChangeAddress: ADDR,
          },
          priceSats: 21_000,
          feeSats: 1_000,
        }).psbt
      );
      return tx.getInput(0).sequence!;
    }

    // Multi-wallet createTransaction path — the third call site the
    // audit named. Builds via createTransaction(walletType, …) so any
    // future drift in cat21.service.helper.ts:createInput() is caught
    // alongside the other two helpers, completing "all three helpers
    // return the same per-wallet sequence."
    function createTransactionSequence(walletType: KnownOrdinalWalletType): number {
      const dummy = getDummyKeypair(btc.NETWORK);
      const paymentUtxo: TxnOutput = {
        txid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        vout: 0,
        value: 50_000,
        status: { confirmed: true, block_height: 800_000 } as TxnOutput['status'],
        transactionHex: undefined,
      };
      const result = createTransaction(
        walletType,
        dummy.addressP2WPKH,
        paymentUtxo,
        dummy.dummyPublicKey,
        dummy.addressP2WPKH,
        BigInt(750),
        false,
        Network.Mainnet
      );
      return result.tx.getInput(0).sequence!;
    }

    it.each([
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.xverse,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.leather,
    ])('mint + createTransaction use the per-wallet mint gate for %s', wallet => {
      const expected = resolveCat21MintInputSequence(wallet);
      expect(mintSequence(wallet)).toBe(expected);
      expect(createTransactionSequence(wallet)).toBe(expected);
    });

    it.each([
      KnownOrdinalWalletType.cat21wallet,
      KnownOrdinalWalletType.xverse,
      KnownOrdinalWalletType.unisat,
      KnownOrdinalWalletType.leather,
    ])('transfer + offer use RBF-on unconditionally for %s (no mint-only gate)', wallet => {
      expect(transferSequence(wallet)).toBe(CAT21_WALLET_INPUT_SEQUENCE);
      expect(offerSellerSequence(wallet)).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    });
  });
});
