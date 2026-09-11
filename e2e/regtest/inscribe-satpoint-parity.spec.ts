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
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { findSatOffset } from '../../src/inscribe/sat-offset';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import {
  sendFromCleanFunderCoin,
  ordStockWalletReceive,
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

describe('inscribe onto a sat in a separate UTXO (satSource)', () => {
  const ownerKey = schnorr.utils.randomPrivateKey();
  const ownerXonly = schnorr.getPublicKey(ownerKey);
  const owner = btc.p2tr(ownerXonly, undefined, scureRegtest, true);

  /** A UTXO of `sats` at the owner's P2TR address, standing in for a rare-sat UTXO. */
  async function ownerUtxo(sats: number) {
    const txid = await sendFromCleanFunderCoin({ [owner.address!]: (sats / 1e8).toFixed(8) });
    return { txid, vout: 0, value: sats, scriptPubKey: owner.script, tapInternalKey: ownerXonly, address: owner.address! };
  }

  /** The funder wallet signs the funding input (1); the owner key signs the satSource (0). */
  async function signAndBroadcast(built: ReturnType<typeof createInscribeTransactions>): Promise<void> {
    const processed = JSON.parse(rpc(
      '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
      `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=false',
    )) as { psbt: string };
    const commit = btc.Transaction.fromPSBT(base64.decode(processed.psbt));
    commit.signIdx(ownerKey, 0);
    commit.finalize();
    expect(await postTx(commit.hex)).toBe(built.commitTxid);
    expect(await postTx(built.revealHex)).toBe(built.revealTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
  }

  function build(satSource: Parameters<typeof createInscribeTransactions>[0]['satSource'], f: Awaited<ReturnType<typeof fundUninscribed>>, body: Uint8Array) {
    return createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body,
      contentType: TXT,
      satSource,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
  }

  const SOURCE_WALLET = `${ORD_WALLET}-source`;

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(SOURCE_WALLET);
  }, 240_000);

  it('offset 5000 in a 20000-sat UTXO: same commit output as ord, padding and remainder back to the owner, inscription on that sat', async () => {
    // ---- ord: a 20000-sat UTXO in its wallet, inscribed at offset 5000 ----
    const ordAddr = ordStockWalletReceive(SOURCE_WALLET);
    const ordSourceTxid = await sendFromCleanFunderCoin({ [ordAddr]: '0.00020000' });
    const body = enc('onto a sat kept in its own UTXO');
    writeOrdStockFile('/tmp/pst-source.txt', body);
    const ord = ordStockWalletInscribe(SOURCE_WALLET, '/tmp/pst-source.txt', FEE_RATE, [
      '--satpoint', `${ordSourceTxid}:0:5000`, '--postage', '546sat',
    ]);
    await waitForOrdStockSync(mineBlocks(1));
    const ordCommit = sats(ord.commit);
    expect(ordCommit[0]).toBe(5_000);

    // ---- SDK ----
    const source = await ownerUtxo(20_000);
    const wantedSat = await satAt(`${source.txid}:0`, 5_000);
    const f = await fundUninscribed();
    const built = build({ ...source, offset: 5_000 }, f, body);
    const commitTx = btc.Transaction.fromPSBT(built.commitPsbt);
    const outs = Array.from({ length: commitTx.outputsLength }, (_, i) => ({
      value: Number(commitTx.getOutput(i).amount), script: hex.encode(commitTx.getOutput(i).script!),
    }));
    expect(outs[0]).toEqual({ value: 5_000, script: hex.encode(owner.script) });
    expect(outs[1].value).toBe(ordCommit[1]);
    // The rest of the 20000 sats go back to the owner, not to the payment change.
    expect(outs[2]).toEqual({ value: 20_000 - 5_000 - ordCommit[1], script: hex.encode(owner.script) });
    // The funding pays only the fee.
    expect(built.fees.fundingRequirementSats).toBe(built.fees.commitFeeSats);

    await signAndBroadcast(built);
    expect((await waitForOrdStockInscription(`${built.revealTxid}i0`)).sat).toBe(wantedSat);
  }, 300_000);

  it('a remainder below dust goes into the inscription\'s postage instead of the miner', async () => {
    const f = await fundUninscribed();
    const body = enc('remainder folded into postage');
    // Measure the commit output this inscription needs, then make a UTXO
    // that leaves exactly 100 sats (below P2TR's 330) after it.
    const probe = build({ txid: 'a'.repeat(64), vout: 0, value: 1_000_000, scriptPubKey: owner.script, tapInternalKey: ownerXonly, address: owner.address!, offset: 1_000 }, f, body);
    const source = await ownerUtxo(1_000 + probe.fees.commitOutputValueSats + 100);
    const wantedSat = await satAt(`${source.txid}:0`, 1_000);
    const built = build({ ...source, offset: 1_000 }, f, body);

    const commitTx = btc.Transaction.fromPSBT(built.commitPsbt);
    // Padding, commit output, change: no remainder output.
    expect(Number(commitTx.getOutput(0).amount)).toBe(1_000);
    expect(Number(commitTx.getOutput(1).amount)).toBe(source.value - 1_000);
    await signAndBroadcast(built);
    const insc = await waitForOrdStockInscription(`${built.revealTxid}i0`);
    expect(insc.sat).toBe(wantedSat);
    expect(insc.value).toBe(546 + 100);
  }, 300_000);

  it('a satSource smaller than the commit output: the funding tops it up, and the inscription still lands on its first sat', async () => {
    const source = await ownerUtxo(600);
    const wantedSat = await satAt(`${source.txid}:0`, 0);
    const f = await fundUninscribed();
    const built = build({ ...source, offset: 0 }, f, enc('on the first sat of a small UTXO'));
    expect(built.fees.fundingRequirementSats)
      .toBe(built.fees.commitOutputValueSats - 600 + built.fees.commitFeeSats);
    await signAndBroadcast(built);
    expect((await waitForOrdStockInscription(`${built.revealTxid}i0`)).sat).toBe(wantedSat);
  }, 300_000);
});

describe('inscribe onto a sat less than a dust limit into its UTXO (paddingUtxo)', () => {
  const PAD_WALLET = `${ORD_WALLET}-pad`;
  const ownerKey = schnorr.utils.randomPrivateKey();
  const ownerXonly = schnorr.getPublicKey(ownerKey);
  const owner = btc.p2tr(ownerXonly, undefined, scureRegtest, true);

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(PAD_WALLET);
    // A small second cardinal UTXO, which ord pads with.
    await sendFromCleanFunderCoin({ [ordStockWalletReceive(PAD_WALLET)]: '0.00001000' });
  }, 240_000);

  /** A second payment UTXO at the funding address, for the SDK to pad with. */
  async function paddingUtxoAt(address: string, sats: number) {
    const txid = await sendFromCleanFunderCoin({ [address]: (sats / 1e8).toFixed(8) });
    return { txid, vout: 0, value: sats, status: { confirmed: true } };
  }

  it('offset 100 in the funding UTXO: ord and the SDK both pad with a further input; same commit output, inscription on that sat', async () => {
    // ---- ord ----
    const ordSource = ordStockWalletOutputs(PAD_WALLET)
      .filter(o => (o.inscriptions ?? []).length === 0)
      .sort((a, b) => b.amount - a.amount)[0].output;
    const ordSat = await satAt(ordSource, 100);
    const body = enc('a sat 100 into its UTXO');
    writeOrdStockFile('/tmp/pst-pad.txt', body);
    const ord = ordStockWalletInscribe(PAD_WALLET, '/tmp/pst-pad.txt', FEE_RATE, [
      '--satpoint', `${ordSource}:100`, '--postage', '546sat',
    ]);
    await waitForOrdStockSync(mineBlocks(1));
    const ordCommitTx = JSON.parse(rpc('getrawtransaction', ord.commit, 'true')) as {
      vin: { txid: string; vout: number }[]; vout: { value: number }[];
    };
    const ordPadIn = JSON.parse(rpc('getrawtransaction', ordCommitTx.vin[0].txid, 'true')) as { vout: { value: number }[] };
    // ord put a further input in front and made the padding its value + 100.
    expect(`${ordCommitTx.vin[1].txid}:${ordCommitTx.vin[1].vout}`).toBe(ordSource);
    expect(Math.round(ordCommitTx.vout[0].value * 1e8))
      .toBe(Math.round(ordPadIn.vout[ordCommitTx.vin[0].vout].value * 1e8) + 100);
    expect((await waitForOrdStockInscription(`${ord.reveal}i0`)).sat).toBe(ordSat);

    // ---- SDK ----
    const f = await fundUninscribed();
    const wantedSat = await satAt(`${f.utxo.txid}:${f.utxo.vout}`, 100);
    const pad = await paddingUtxoAt(f.fundingAddr, 1_000);
    const built = createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body,
      contentType: TXT,
      satOffset: 100,
      paddingUtxo: pad,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const commit = btc.Transaction.fromPSBT(built.commitPsbt);
    expect(hex.encode(commit.getInput(0).txid!)).toBe(pad.txid);
    expect(Number(commit.getOutput(0).amount)).toBe(1_000 + 100);
    expect(Number(commit.getOutput(1).amount)).toBe(Math.round(ordCommitTx.vout[1].value * 1e8));

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
    expect((await waitForOrdStockInscription(`${built.revealTxid}i0`)).sat).toBe(wantedSat);
  }, 300_000);

  it('offset 100 in a satSource: padding input first, the padding back to the sat\'s owner, inscription on that sat', async () => {
    const sourceTxid = await sendFromCleanFunderCoin({ [owner.address!]: '0.00020000' });
    const wantedSat = await satAt(`${sourceTxid}:0`, 100);
    const f = await fundUninscribed();
    const pad = await paddingUtxoAt(f.fundingAddr, 1_000);
    const built = createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body: enc('a rare sat 100 into its UTXO'),
      contentType: TXT,
      satSource: {
        txid: sourceTxid, vout: 0, value: 20_000, scriptPubKey: owner.script,
        tapInternalKey: ownerXonly, address: owner.address!, offset: 100,
      },
      paddingUtxo: pad,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const commit = btc.Transaction.fromPSBT(built.commitPsbt);
    expect([0, 1, 2].map(i => hex.encode(commit.getInput(i).txid!))).toEqual([pad.txid, sourceTxid, f.utxo.txid]);
    expect(Number(commit.getOutput(0).amount)).toBe(1_000 + 100);
    expect(hex.encode(commit.getOutput(0).script!)).toBe(hex.encode(owner.script));

    // The funder signs the payment inputs (0, 2); the owner key the satSource (1).
    const processed = JSON.parse(rpc(
      '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
      `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=false',
    )) as { psbt: string };
    const signed = btc.Transaction.fromPSBT(base64.decode(processed.psbt));
    signed.signIdx(ownerKey, 1);
    signed.finalize();
    expect(await postTx(signed.hex)).toBe(built.commitTxid);
    expect(await postTx(built.revealHex)).toBe(built.revealTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);
    expect((await waitForOrdStockInscription(`${built.revealTxid}i0`)).sat).toBe(wantedSat);
  }, 300_000);
});
