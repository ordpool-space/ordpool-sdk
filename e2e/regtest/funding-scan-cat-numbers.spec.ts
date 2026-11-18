/**
 * The funding scan names cats by their number, read from the real cat21-ord.
 *
 * Two cats share one output: a mint puts cat A on output 0, and a second
 * nLockTime=21 transaction spends that output into a new output 0, which then
 * holds cat A (carried by FIFO) and the bonus cat B it mints onto the same sat.
 * `UtxoContentScanner.classify` on that output must list both cats in
 * `catIds` order with the numbers cat21-ord gives them, B one above A, and
 * the sat they share as `catSat`.
 *
 * Real: bitcoind, electrs, cat21-ord (`--index-cat21`), stock ord, all regtest.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { UtxoContentScanner } from '../../src/cat21-mint/utxo-content-scanner.service';
import { Network, toScureNetwork } from '../../src/network';
import {
  catInscriptionId,
  ELECTRS_URL,
  getOrdInscription,
  mineBlocks,
  ORD_STOCK_URL,
  ORD_URL,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdStockSync,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FEE_SATS = 1_000;
const CAT_SATS = 546;
/** 0.1 BTC, what each `sendtoaddress` below pays. */
const FUNDING_SATS = 10_000_000;

describe('funding scan: cat numbers from cat21-ord', () => {
  const network = toScureNetwork(Network.Regtest);
  const minterPriv = secp256k1.utils.randomPrivateKey();
  const minter = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), network);
  const holderPriv = secp256k1.utils.randomPrivateKey();
  const holder = btc.p2wpkh(secp256k1.getPublicKey(holderPriv, true), network);

  let catA: string;
  let catB: string;
  let sharedOutpoint: string;

  async function confirm(txHex: string): Promise<string> {
    const txid = await postTx(txHex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(txid);
    await waitForOrdSync(tip);
    await waitForOrdStockSync(tip);
    return txid;
  }

  beforeAll(async () => {
    let tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdReady();
    await waitForOrdSync(tip);

    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', minter.address!, '0.1');
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', minter.address!, '0.1');
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);

    // Mint 1: cat A on output 0 at the holder.
    const fundingA = await waitForUtxoAt(minter.address!, FUNDING_SATS);
    const mintA = new btc.Transaction({ lockTime: 21 });
    mintA.addInput({
      txid: fundingA.txid, index: fundingA.vout, sequence: 0xfffffffe,
      witnessUtxo: { script: minter.script, amount: BigInt(fundingA.value) },
    });
    mintA.addOutputAddress(holder.address!, BigInt(CAT_SATS), network);
    mintA.addOutputAddress(minter.address!, BigInt(fundingA.value - CAT_SATS - FEE_SATS), network);
    mintA.signIdx(minterPriv, 0);
    mintA.finalize();
    const mintATxid = await confirm(mintA.hex);
    catA = catInscriptionId(mintATxid);

    // Mint 2: spends cat A's output into a new output 0 and mints cat B onto the same sat.
    const fundingB = await waitForUtxoAt(minter.address!, FUNDING_SATS);
    const mintB = new btc.Transaction({ lockTime: 21 });
    mintB.addInput({
      txid: mintATxid, index: 0, sequence: 0xfffffffe,
      witnessUtxo: { script: holder.script, amount: BigInt(CAT_SATS) },
    });
    mintB.addInput({
      txid: fundingB.txid, index: fundingB.vout, sequence: 0xfffffffe,
      witnessUtxo: { script: minter.script, amount: BigInt(fundingB.value) },
    });
    mintB.addOutputAddress(holder.address!, BigInt(CAT_SATS), network);
    mintB.addOutputAddress(minter.address!, BigInt(fundingB.value - FEE_SATS), network);
    mintB.signIdx(holderPriv, 0);
    mintB.signIdx(minterPriv, 1);
    mintB.finalize();
    const mintBTxid = await confirm(mintB.hex);
    catB = catInscriptionId(mintBTxid);
    sharedOutpoint = `${mintBTxid}:0`;
  }, 180_000);

  it('lists both cats on the shared output with the numbers cat21-ord gives them', async () => {
    const numberA = (await getOrdInscription(catA)).number;
    const numberB = (await getOrdInscription(catB)).number;
    expect(numberB).toBe(numberA + 1);

    const scanner = new UtxoContentScanner({
      mempoolApiUrl: ELECTRS_URL,
      cat21ApiUrl: '',
      ordApiUrl: ORD_STOCK_URL,
      cat21OrdApiUrl: ORD_URL,
    });
    const classification = await scanner.classify(sharedOutpoint);

    if (typeof classification === 'string' || !classification.assets) throw new Error('expected an asset detail');
    const { catIds, cats } = classification.assets;
    expect({ verdict: classification.verdict, catIds: [...catIds].sort(), cats: [...(cats ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)) })
      .toEqual({
        verdict: 'has-assets',
        catIds: [catA, catB].sort(),
        cats: [{ id: catA, number: numberA }, { id: catB, number: numberB }].sort((a, b) => (a.id < b.id ? -1 : 1)),
      });
    expect(cats?.map((c) => c.id)).toEqual(catIds);
    // The sat both cats sit on, for linking a cat whose number is unknown.
    expect(classification.assets.catSat).toBe((await getOrdInscription(catA)).sat);
  });
});
