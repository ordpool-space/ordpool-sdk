/**
 * Inscribing onto a chosen sat: parity with `ord wallet inscribe --satpoint`
 * and `--sat`.
 *
 * ord spends the UTXO holding the sat and, when the sat is not its first,
 * puts a padding output of exactly the offset in front, so the chosen sat is
 * the first sat of the commit output (transaction_builder.rs,
 * `align_outgoing`). The SDK does the same with `satOffset`.
 *
 * Compared against ord: the padding output and the commit output. The proof
 * that matters is ord's own index: stock ord (with `--index-sats`) must
 * report the SDK's inscription on exactly the sat we asked for, not a sat
 * our own arithmetic says it should be.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { findSatOffset } from '../../src/inscribe/sat-offset';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  fundOrdStockWallet,
  fundUninscribed,
  getStockOrdOutput,
  mineBlocks,
  ordStockWalletInscribe,
  ordStockWalletOutputs,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdStockInscription,
  waitForOrdStockReady,
  waitForOrdStockSync,
  writeOrdStockFile,
} from './regtest-helpers';

// A fresh ord wallet per run. Every inscribe deposits into ord's own wallet,
// and reusing a wallet across runs grows a UTXO pool that eventually trips
// ord's coin-selection invariant (transaction_builder.rs, checked_sub on
// Target::Value). CI starts from a fresh stack; a reused local stack does not.
const ORD_WALLET = `parity-satpoint-stock-${Date.now().toString(36)}`;
const FEE_RATE = 5;
const TXT = 'text/plain;charset=utf-8';
const scureRegtest = toScureNetwork(Network.Regtest);
const enc = (s: string) => new TextEncoder().encode(s);

function sats(txid: string): number[] {
  return (JSON.parse(rpc('getrawtransaction', txid, 'true')) as { vout: { value: number }[] })
    .vout.map(o => Math.round(o.value * 1e8));
}

/** The sat at `offset` within `outpoint`, as stock ord's sat index has it. */
async function satAt(outpoint: string, offset: number): Promise<number> {
  const { sat_ranges } = await getStockOrdOutput(outpoint);
  let remaining = offset;
  for (const [start, end] of sat_ranges) {
    if (remaining < end - start) return start + remaining;
    remaining -= end - start;
  }
  throw new Error(`offset ${offset} is outside ${outpoint}`);
}

/** ord's one cardinal UTXO (the funding), which it inscribes from. */
function ordCardinal(): string {
  const cardinal = ordStockWalletOutputs(ORD_WALLET)
    .filter(o => (o.inscriptions ?? []).length === 0)
    .sort((a, b) => b.amount - a.amount)[0];
  return cardinal.output;
}

describe('inscribe onto a chosen sat → parity with `ord wallet inscribe --satpoint` / `--sat`', () => {
  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(ORD_WALLET);
  }, 240_000);

  it.each([1_000, 50_000])('offset %i: padding and commit outputs match ord, and ord indexes the SDK inscription on that sat', async (offset) => {
    // ---- ord ----
    const ordSource = ordCardinal();
    const ordSat = await satAt(ordSource, offset);
    const body = enc(`inscribed onto the sat at offset ${offset}`);
    writeOrdStockFile(`/tmp/pst-${offset}.txt`, body);
    const ord = ordStockWalletInscribe(ORD_WALLET, `/tmp/pst-${offset}.txt`, FEE_RATE, [
      '--satpoint', `${ordSource}:${offset}`, '--postage', '546sat',
    ]);
    await waitForOrdStockSync(mineBlocks(1));
    const ordCommit = sats(ord.commit);
    expect(ordCommit[0]).toBe(offset);
    expect((await waitForOrdStockInscription(`${ord.reveal}i0`)).sat).toBe(ordSat);

    // ---- SDK ----
    const f = await fundUninscribed();
    const sdkSource = `${f.utxo.txid}:${f.utxo.vout}`;
    const sdkSat = await satAt(sdkSource, offset);
    const built = createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body,
      contentType: TXT,
      satOffset: offset,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const commit = btc.Transaction.fromPSBT(built.commitPsbt);
    expect(Number(commit.getOutput(0).amount)).toBe(offset);
    // Same body, postage and reveal shape, so the same commit output as ord's.
    expect(Number(commit.getOutput(1).amount)).toBe(ordCommit[1]);

    const processed = JSON.parse(rpc(
      '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
      `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=true',
    )) as { complete: boolean; hex: string };
    expect(processed.complete).toBe(true);
    expect(await postTx(processed.hex)).toBe(built.commitTxid);
    expect(await postTx(built.revealHex)).toBe(built.revealTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);

    const insc = await waitForOrdStockInscription(`${built.revealTxid}i0`);
    expect(insc.sat).toBe(sdkSat);
  }, 240_000);

  it('--sat <n>: findSatOffset turns the sat into the offset ord uses, and both land on it', async () => {
    const ordSource = ordCardinal();
    const { sat_ranges } = await getStockOrdOutput(ordSource);
    const sat = sat_ranges[0][0] + 7_777;
    expect(findSatOffset(sat_ranges, sat)).toBe(7_777);

    writeOrdStockFile('/tmp/pst-sat.txt', enc('inscribed onto a sat by number'));
    const ord = ordStockWalletInscribe(ORD_WALLET, '/tmp/pst-sat.txt', FEE_RATE, ['--sat', String(sat)]);
    await waitForOrdStockSync(mineBlocks(1));
    expect(sats(ord.commit)[0]).toBe(7_777);
    expect((await waitForOrdStockInscription(`${ord.reveal}i0`)).sat).toBe(sat);

    // The SDK, given only a sat number in its own funding UTXO.
    const f = await fundUninscribed();
    const ranges = (await getStockOrdOutput(`${f.utxo.txid}:${f.utxo.vout}`)).sat_ranges;
    const wanted = ranges[0][0] + 7_777;
    const satOffset = findSatOffset(ranges, wanted);
    expect(satOffset).toBe(7_777);
    const built = createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body: enc('the SDK, onto a sat by number'),
      contentType: TXT,
      satOffset,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const processed = JSON.parse(rpc(
      '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
      `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=true',
    )) as { complete: boolean; hex: string };
    expect(await postTx(processed.hex)).toBe(built.commitTxid);
    expect(await postTx(built.revealHex)).toBe(built.revealTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
    expect((await waitForOrdStockInscription(`${built.revealTxid}i0`)).sat).toBe(wanted);
  }, 240_000);
});
