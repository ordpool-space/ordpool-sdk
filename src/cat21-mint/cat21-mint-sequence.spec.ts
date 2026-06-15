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
  resolveCat21InputSequence,
} from './cat21-mint-sequence';
import { buildCat21MintPsbt } from './cat21-mint.helper';
import { createTransaction, getDummyKeypair } from './cat21.service.helper';
import { TxnOutput } from './cat21.service.types';

const publicKey = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const p2wpkhMainnet = btc.p2wpkh(publicKey, btc.NETWORK);
const ADDR = p2wpkhMainnet.address!;

describe('resolveCat21InputSequence (single source of truth)', () => {

  it('exposes the two raw sequence constants', () => {
    expect(CAT21_WALLET_INPUT_SEQUENCE).toBe(0xfffffffd);
    expect(CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE).toBe(0xfffffffe);
  });

  it('cat21wallet → 0xfffffffd', () => {
    expect(resolveCat21InputSequence(KnownOrdinalWalletType.cat21wallet)).toBe(0xfffffffd);
  });

  it.each([
    KnownOrdinalWalletType.xverse,
    KnownOrdinalWalletType.unisat,
    KnownOrdinalWalletType.leather,
  ])('%s → 0xfffffffe', wallet => {
    expect(resolveCat21InputSequence(wallet)).toBe(0xfffffffe);
  });

  describe('every cat-flow builder uses the same resolver — no triplication regression', () => {

    // The regression we are pinning: round-2 audit Finding 1 caught
    // that cat21-mint.helper.ts and cat21-transfer.helper.ts each
    // shipped their own private walletInputSequence() copy of the
    // ternary. If a future contributor copies the branch back into
    // any helper, this spec catches the drift by demanding identical
    // sequence values on output PSBTs.

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

    function offerSellerSequence(): number {
      // buildCat21BuyOfferPsbt doesn't take a walletType — its sequence
      // is fixed at CAT21_OFFER_INPUT_SEQUENCE (0xfffffffd), the RBF-on
      // value the buyer chooses on behalf of all parties. Cross-check
      // here so a future "use resolveCat21InputSequence on the offer
      // too" refactor stays consistent with the per-wallet path.
      const tx = btc.Transaction.fromPSBT(
        buildCat21BuyOfferPsbt({
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
    ])('mint, transfer, AND createTransaction agree on sequence for %s', wallet => {
      const expected = resolveCat21InputSequence(wallet);
      expect(mintSequence(wallet)).toBe(expected);
      expect(transferSequence(wallet)).toBe(expected);
      expect(createTransactionSequence(wallet)).toBe(expected);
    });

    it('buy-offer seller-input sequence is the same 0xfffffffd as cat21wallet mint/transfer', () => {
      expect(offerSellerSequence()).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    });
  });
});
