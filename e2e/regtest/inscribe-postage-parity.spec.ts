/**
 * Postage parity with `ord wallet inscribe --postage <AMOUNT>`, at several
 * sizes.
 *
 * The whole transaction cannot be byte-identical: the reveal key is random,
 * the funding input and change address are each wallet's own, and our reveal
 * carries `nLockTime=21` plus a non-RBF sequence for the free cats. So the
 * comparison is on the three values postage decides, each of which must match
 * ord EXACTLY:
 *
 *   reveal output 0   = the postage
 *   reveal vsize      = ord's, because the envelope and the 1-in/1-out shape
 *                       are identical
 *   commit output 0   = postage + reveal fee, which therefore also matches
 *
 * The third is the hard one. It only holds if the postage, the envelope AND
 * the reveal's shape all agree with ord, so it cannot pass by accident.
 *
 * Sizes stress more than 546, per the rule that a 546-only size test proves
 * nothing about size handling: 546 is our default, 10000 is ord's.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  mineBlocks,
  fundOrdStockWallet,
  ordStockWalletInscribe,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForUtxoAt,
  writeOrdStockFile,
} from './regtest-helpers';

// A fresh ord wallet per run. Every inscribe deposits into ord's own wallet,
// and reusing a wallet across runs grows a UTXO pool that eventually trips
// ord's coin-selection invariant (transaction_builder.rs, checked_sub on
// Target::Value). CI starts from a fresh stack; a reused local stack does not.
const ORD_WALLET = `parity-postage-stock-${Date.now().toString(36)}`;
const PSBT_WALLET = 'ordpool-e2e';
const TXT = 'text/plain;charset=utf-8';
const FEE_RATE = 5;
const scureRegtest = toScureNetwork(Network.Regtest);

function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

function decode(txid: string): { vout: number[]; vsize: number } {
  const t = JSON.parse(rpc('getrawtransaction', txid, 'true')) as {
    vout: { value: number }[]; vsize: number;
  };
  return { vout: t.vout.map(o => Math.round(o.value * 1e8)), vsize: t.vsize };
}

describe('inscribe postage → parity with `ord wallet inscribe --postage`', () => {
  let fundingAddr: string;
  let fundingPubkey: Uint8Array;
  let utxo: { txid: string; vout: number; value: number };

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(ORD_WALLET);

    // A real funded P2WPKH input for the SDK side. We only BUILD the SDK
    // transactions, so it is never spent here.
    fundingAddr = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    fundingPubkey = hex.decode(JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', fundingAddr)).pubkey);
    bitcoinCliPsbtWallet('sendtoaddress', fundingAddr, '1.0');
    const t2 = mineBlocks(1);
    await waitForElectrsSync(t2);
    const u = await waitForUtxoAt(fundingAddr, 100_000_000);
    utxo = { txid: u.txid, vout: u.vout, value: u.value };
  }, 240_000);

  it.each([546, 3000, 10_000, 30_000])(
    'postage %i sats: reveal output, reveal vsize and commit output all match ord',
    async (postage) => {
      const body = new TextEncoder().encode(`parity: postage ${postage}`);
      const path = `/tmp/parity-postage-${postage}.txt`;
      writeOrdStockFile(path, body);
      const ord = ordStockWalletInscribe(ORD_WALLET, path, FEE_RATE, ['--postage', `${postage}sat`]);
      await waitForOrdStockSync(mineBlocks(1));

      const ordReveal = decode(ord.reveal);
      const ordCommit = decode(ord.commit);

      // P2TR recipient, the same address type ord's own destination uses, so
      // the reveal's output weighs the same and the vsize is comparable.
      const recipient = btc.p2tr(
        schnorr.getPublicKey(schnorr.utils.randomPrivateKey()),
        undefined,
        scureRegtest,
        true,
      ).address!;

      const sdk = createInscribeTransactions({
        paymentOutput: { ...utxo, status: { confirmed: true } },
        paymentPublicKey: fundingPubkey,
        paymentAddress: fundingAddr,
        recipientAddress: recipient,
        body,
        contentType: TXT,
        feeRatePerVbyte: FEE_RATE,
        postageSats: postage,
        network: Network.Regtest,
      });
      const sdkReveal = btc.Transaction.fromRaw(hex.decode(sdk.revealHex));

      expect(ordReveal.vout).toEqual([postage]);
      expect(sdkReveal.outputsLength).toBe(1);
      expect(Number(sdkReveal.getOutput(0).amount)).toBe(postage);

      expect(sdk.fees.revealVsize).toBe(ordReveal.vsize);
      expect(sdk.fees.commitOutputValueSats).toBe(ordCommit.vout[0]);
    },
    180_000,
  );
});
