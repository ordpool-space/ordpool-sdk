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

  it('fractional fee rates: reveal fee and commit output match ord, which rounds rather than rounds up', async () => {
    // ord's fee is round(rate x vsize) (FeeRate::fee). At these rates the
    // product lands on both sides of .5, so at least one case below is one
    // where rounding up would give a different fee; the test checks that too.
    const rates = [1.1, 1.3, 2.7, 0.6];
    let discriminating = 0;
    for (const rate of rates) {
      const body = new TextEncoder().encode(`parity: fee rate ${rate}`);
      writeOrdStockFile(`/tmp/parity-rate-${rate}.txt`, body);
      const ord = ordStockWalletInscribe(ORD_WALLET, `/tmp/parity-rate-${rate}.txt`, rate, ['--postage', '546sat']);
      await waitForOrdStockSync(mineBlocks(1));
      const ordReveal = decode(ord.reveal);
      const ordCommit = decode(ord.commit);

      const sdk = createInscribeTransactions({
        paymentOutput: { ...utxo, status: { confirmed: true } },
        paymentPublicKey: fundingPubkey,
        paymentAddress: fundingAddr,
        recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
        body,
        contentType: TXT,
        feeRatePerVbyte: rate,
        network: Network.Regtest,
      });
      expect(sdk.fees.revealVsize).toBe(ordReveal.vsize);
      expect(sdk.fees.commitOutputValueSats).toBe(ordCommit.vout[0]);
      if (Math.ceil(ordReveal.vsize * rate) !== Math.round(ordReveal.vsize * rate)) discriminating++;
    }
    expect(discriminating).toBeGreaterThan(0);
  }, 300_000);

  it('--commit-fee-rate: the commit pays its own rate, the reveal keeps --fee-rate, and the commit output matches ord', async () => {
    const body = new TextEncoder().encode('parity: commit fee rate');
    writeOrdStockFile('/tmp/parity-commit-rate.txt', body);
    const ord = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-commit-rate.txt', 5, [
      '--commit-fee-rate', '2', '--postage', '546sat',
    ]);
    await waitForOrdStockSync(mineBlocks(1));
    const ordCommitTx = JSON.parse(rpc('getrawtransaction', ord.commit, 'true')) as {
      vin: { txid: string; vout: number }[]; vout: { value: number }[]; vsize: number;
    };
    const inputSats = ordCommitTx.vin.reduce((sum, i) => {
      const prev = JSON.parse(rpc('getrawtransaction', i.txid, 'true')) as { vout: { value: number }[] };
      return sum + Math.round(prev.vout[i.vout].value * 1e8);
    }, 0);
    const outputSats = ordCommitTx.vout.reduce((sum, o) => sum + Math.round(o.value * 1e8), 0);
    // ord's commit is at 2 sat/vB: round(2 x vsize), ord's FeeRate::fee.
    expect(inputSats - outputSats).toBe(Math.round(2 * ordCommitTx.vsize));

    const sdk = createInscribeTransactions({
      paymentOutput: { ...utxo, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body,
      contentType: TXT,
      feeRatePerVbyte: 5,
      commitFeeRatePerVbyte: 2,
      network: Network.Regtest,
    });
    // The reveal at 5 sat/vB decides the commit output, same as ord's.
    expect(sdk.fees.commitOutputValueSats).toBe(Math.round(ordCommitTx.vout[0].value * 1e8));
    // The SDK's commit is at 2 sat/vB (its funding input differs from ord's,
    // so the vsize and the fee are its own). Its P2WPKH signature is a DER
    // signature of 71 to 73 bytes, and the fee is settled on one simulated
    // signature while the reported vsize comes from another, so the two can
    // differ by one vbyte: the fee is within 2 sats of 2 x vsize.
    expect(Math.abs(sdk.fees.commitFeeSats - 2 * sdk.fees.commitVsize)).toBeLessThanOrEqual(2);
  }, 180_000);

  it('a reveal over MAX_STANDARD_TX_WEIGHT is refused like ord refuses it, and built with noLimit (--no-limit)', async () => {
    // Roughly one weight unit per witness byte, so 401 000 body bytes put the
    // reveal just over 400 000.
    const body = new Uint8Array(401_000).map((_, i) => (i * 31 + 7) & 0xff);
    writeOrdStockFile('/tmp/parity-heavy.bin', body);
    let ordError = '';
    try {
      ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-heavy.bin', FEE_RATE, ['--postage', '546sat']);
    } catch (err) {
      ordError = String((err as { stderr?: string }).stderr ?? err);
    }
    expect(ordError).toMatch(/reveal transaction weight greater than 400000 \(MAX_STANDARD_TX_WEIGHT\): \d+/);
    const ordWeight = Number(/MAX_STANDARD_TX_WEIGHT\): (\d+)/.exec(ordError)![1]);

    const args = {
      paymentOutput: { ...utxo, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body,
      contentType: 'application/octet-stream',
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    };
    // Same refusal, same message, same weight as ord computed.
    expect(() => createInscribeTransactions(args))
      .toThrow(`reveal transaction weight greater than 400000 (MAX_STANDARD_TX_WEIGHT): ${ordWeight}`);
    const built = createInscribeTransactions({ ...args, noLimit: true });
    expect(btc.Transaction.fromRaw(hex.decode(built.revealHex)).weight).toBe(ordWeight);
  }, 300_000);

  it('--destination to a P2WPKH address: same output script, value, reveal vsize and commit output as ord', async () => {
    // A non-taproot destination changes the reveal's output size, so this
    // also checks the fee accounting beyond the P2TR case.
    const destination = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const body = new TextEncoder().encode('parity: destination p2wpkh');
    writeOrdStockFile('/tmp/parity-destination.txt', body);
    const ord = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-destination.txt', FEE_RATE, [
      '--destination', destination, '--postage', '546sat',
    ]);
    await waitForOrdStockSync(mineBlocks(1));
    const ordRevealTx = JSON.parse(rpc('getrawtransaction', ord.reveal, 'true')) as {
      vout: { value: number; scriptPubKey: { address: string } }[]; vsize: number;
    };

    const sdk = createInscribeTransactions({
      paymentOutput: { ...utxo, status: { confirmed: true } },
      paymentPublicKey: fundingPubkey,
      paymentAddress: fundingAddr,
      recipientAddress: destination,
      body,
      contentType: TXT,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const sdkReveal = btc.Transaction.fromRaw(hex.decode(sdk.revealHex));

    expect(ordRevealTx.vout.map(o => o.scriptPubKey.address)).toEqual([destination]);
    expect(hex.encode(sdkReveal.getOutput(0).script!))
      .toBe(hex.encode(btc.OutScript.encode(btc.Address(scureRegtest).decode(destination))));
    expect(Number(sdkReveal.getOutput(0).amount)).toBe(Math.round(ordRevealTx.vout[0].value * 1e8));
    expect(sdk.fees.revealVsize).toBe(ordRevealTx.vsize);
    expect(sdk.fees.commitOutputValueSats).toBe(decode(ord.commit).vout[0]);
  }, 180_000);
});
