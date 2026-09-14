/**
 * The funding-safety decision, proven against REAL ord on regtest.
 *
 * `classifyUtxoContent` decides whether a coin is safe to spend as funding:
 * clean means no inscription, no rune, no cat, no rare sat. Everything below
 * that decision was unit-proven only, against ord responses the SDK wrote
 * itself. That is the failure shape where a mock becomes the source of truth
 * about a collaborator: the code and the fixture agree with each other and
 * both disagree with the real service, and the suite is green either way.
 *
 * So this spec never hands the classifier a literal. It seeds five coins that
 * really carry the five states on a live chain, reads them back through
 * `classifyOutpoint` (real HTTP to both ord instances: stock ord for
 * inscriptions + runes + sat ranges, cat21-ord for cats) and asserts the
 * verdict AND the field the verdict rests on. If ord changes the wire shape
 * of `/output` (the `cats` element type, a renamed `sat_ranges`, runes moving
 * from object to array) a spec here goes red, instead of a holder's cat going
 * into a miner fee.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../../src/network';
import { classifyOutpoint } from '../../src/wallet/xpub/classify-outpoint';
import {
  ORD_STOCK_URL,
  catInscriptionId,
  mineBlocks,
  postTx,
  rpc,
  seedInscribedCoin,
  seedRareSatCoin,
  seedRuneCoin,
  waitForCatAtAddress,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const ORD_CAT21_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
const FEE_SATS = 1_000;

const regtestNetwork = toScureNetwork(Network.Regtest);

/** Classify one outpoint through the real HTTP path, against both ords. */
function classify(txid: string, vout: number) {
  return classifyOutpoint(`${txid}:${vout}`, {
    ordApiUrl: ORD_STOCK_URL,
    cat21OrdApiUrl: ORD_CAT21_URL,
  });
}

describe('funding-safety classification vs real ord (regtest)', () => {

  let priv: Uint8Array;
  let address: string;
  let script: Uint8Array;

  beforeAll(async () => {
    await waitForOrdReady();
    await waitForOrdStockReady();
    priv = secp256k1.utils.randomPrivateKey();
    const p2wpkh = btc.p2wpkh(secp256k1.getPublicKey(priv, true), regtestNetwork);
    address = p2wpkh.address as string;
    script = p2wpkh.script;
  }, 240_000);

  /** Fund `address` with `btcAmount` and return the confirmed, indexed UTXO. */
  async function fundOwn(btcAmount: string, expectSats: number) {
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', address, btcAmount);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
    await waitForOrdStockSync(tip);
    return waitForUtxoAt(address, expectSats);
  }

  it('a plain coin is clean, and clean means every content field is empty', async () => {
    // Getting a content-free coin on regtest takes deliberate construction.
    // Every coin here descends from a coinbase, and a coinbase output OPENS on
    // its block's first sat, which ordinal theory calls `uncommon`. So funding
    // an address and calling the result plain is wrong: seedRareSatCoin mints
    // its notable coin from exactly that property.
    //
    // Sats travel first-in-first-out, so output 0 of a spend takes the opening
    // sats of the input and output 1 begins after them. Spending a funded coin
    // and testing output 1 therefore yields a coin whose range starts INSIDE a
    // coinbase range rather than at its head: no notable sat, nothing else
    // either.
    const funding = await fundOwn('0.5', 50_000_000);
    const split = new btc.Transaction();
    split.addInput({
      txid: funding.txid,
      index: funding.vout,
      witnessUtxo: { script, amount: BigInt(funding.value) },
    });
    split.addOutputAddress(address, BigInt(10_000), regtestNetwork); // absorbs the head
    split.addOutputAddress(address, BigInt(funding.value - 10_000 - FEE_SATS), regtestNetwork);
    split.signIdx(priv, 0, [btc.SigHash.ALL]);
    split.finalize();

    const txid = await postTx(split.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(txid);
    await waitForOrdSync(tip);
    await waitForOrdStockSync(tip);

    const c = await classify(txid, 1);

    // Report ord's own account of the coin when this disagrees, so a failure
    // says WHICH content was found instead of only "expected true".
    expect({
      clean: c.clean,
      inscriptionIds: c.inscriptionIds,
      runes: c.runes,
      catIds: c.catIds,
      rareSat: c.rareSat,
    }).toEqual({
      clean: true,
      inscriptionIds: [],
      runes: null,
      catIds: [],
      rareSat: null,
    });
  }, 300_000);

  it('a coin really carrying an inscription is refused, by inscription id', async () => {
    const coin = await seedInscribedCoin({ address });
    const c = await classify(coin.txid, coin.vout);

    expect(c.clean).toBe(false);
    expect(c.inscriptionIds).toContain(coin.inscriptionId);
  }, 600_000);

  it('a coin really carrying a rune is refused, keyed by the rune ord spells', async () => {
    const coin = await seedRuneCoin({ address });
    const c = await classify(coin.txid, coin.vout);

    expect(c.clean).toBe(false);
    expect(c.runes).not.toBeNull();
    // Keyed by the SPACED name, exactly as ord emits it: the shape the SDK's
    // rune readout indexes by.
    expect(Object.keys(c.runes as object)).toContain(coin.runeName);
  }, 600_000);

  it('a coin really carrying a notable sat is refused, with the sat ord named', async () => {
    const coin = await seedRareSatCoin({ address });
    const c = await classify(coin.txid, coin.vout);

    expect(c.clean).toBe(false);
    expect(c.rareSat).not.toBeNull();
    expect(c.rareSat?.sat).toBe(String(coin.sat));
    expect(c.rareSat?.rarity).toBe(coin.rarity);
  }, 600_000);

  it('a coin really carrying a cat is refused, and the cat id is a STRING from cat21-ord', async () => {
    // Raw nLockTime=21 mint: cat21-ord indexes any lockTime=21 output as a cat.
    const funding = await fundOwn('0.5', 50_000_000);
    const tx = new btc.Transaction({ lockTime: 21 });
    tx.addInput({
      txid: funding.txid,
      index: funding.vout,
      sequence: 0xfffffffe, // non-RBF, the sequence the SDK mint uses
      witnessUtxo: { script, amount: BigInt(funding.value) },
    });
    tx.addOutputAddress(address, BigInt(546), regtestNetwork); // output 0: the cat
    tx.addOutputAddress(address, BigInt(funding.value - 546 - FEE_SATS), regtestNetwork);
    tx.signIdx(priv, 0, [btc.SigHash.ALL]);
    tx.finalize();

    const txid = await postTx(tx.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(txid);
    await waitForOrdSync(tip);
    await waitForOrdStockSync(tip);

    const inscriptionId = catInscriptionId(txid);
    await waitForCatAtAddress(inscriptionId, address);

    const c = await classify(txid, 0);
    expect(c.clean).toBe(false);
    expect(c.catIds).toContain(inscriptionId);
    // cat21-ord emits `cats` as inscription-id STRINGS. Typing that array as
    // numbers is what shipped broken to production once; pin the element type.
    expect(typeof c.catIds[0]).toBe('string');
    // A cat sits at offset 0, so the classifier can name the sat it rides.
    expect(typeof c.catSat).toBe('number');
  }, 600_000);
});
