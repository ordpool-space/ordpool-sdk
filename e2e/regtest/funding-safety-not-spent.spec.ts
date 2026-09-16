/**
 * The funding guard, end to end, for every asset class a user can destroy.
 *
 * `funding-safety-classify.spec.ts` proves the CLASSIFIER reads real ord
 * correctly for all four classes. That is not the same claim as this one, and
 * the difference is what makes the gap easy to miss: classification is not
 * refusal. A reader seeing four green classify cases concludes four classes are
 * protected, when what is proven is that ord's JSON was parsed.
 *
 * This spec proves the SELECTION refuses them: the mint runs for real, and the
 * coin carrying the asset is still unspent afterwards.
 *
 * ## Why the sizes are what they are
 *
 * Selection takes the SMALLEST covering candidate. So the dirty coin sits just
 * above the funding requirement and the clean coin well above it, which makes
 * the dirty coin the one an UNGUARDED selection would take. Get this wrong in
 * any of three ways and the spec passes while proving nothing:
 *
 *   1. every coin clean, so the guard never engages;
 *   2. the dirty coin too large to be a candidate;
 *   3. the dirty coin the ONLY coin, so there is no alternative to steer to,
 *      which proves the guard FLAGS rather than that selection AVOIDS.
 *
 * Each case therefore asserts the dirty coin was actually SCANNED. Without
 * that, a dirty coin that was never a candidate is indistinguishable from one
 * the guard rejected, and both look like a pass.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';

import { executeMint } from '../../src/cat21-core/mint.core';
import { BroadcastPort, ContentScanPort, SignPort, UtxosPort } from '../../src/cat21-core/ports';
import { UtxoContentScanner } from '../../src/cat21-mint/utxo-content-scanner.service';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  DirtyCoinAsset,
  fundCommonSats,
  getTx,
  getUtxos,
  mineBlocks,
  postTx,
  seedDirtyCoin,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdStockReady,
  waitForOrdSync,
} from './regtest-helpers';

const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
const ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';
const ELECTRS_URL =
  process.env.REGTEST_ELECTRS_URL ?? `http://localhost:${process.env.E2E_ELECTRS_HOST_PORT ?? 3010}`;

/** Just above a mint's requirement, so best-fit would take it. */
const DIRTY_SATS = 3_000;
/** Well above, so the guard has somewhere to steer to. */
const CLEAN_BTC = 0.0005; // 50 000 sats

const net = Network.Regtest;
const scure = toScureNetwork(net);

describe('funding safety end to end: an asset-bearing coin is never auto-spent', () => {

  beforeAll(async () => {
    await waitForOrdReady(60_000);
    await waitForOrdStockReady(60_000);
  }, 180_000);

  it.each<DirtyCoinAsset>(['inscription', 'cat', 'rune', 'rareSat'])(
    'a coin carrying a %s is scanned, refused, and still unspent after a real mint',
    async (asset) => {
      // A fresh identity per class AND per run. Deriving it from the class name
      // alone is deterministic, which sounds like a virtue and is not: a second
      // run against the same chain reuses the address, finds the previous run's
      // coins still sitting there, and the dirty coin is no longer the smallest.
      // CI never sees it because every run gets a fresh chain; anyone iterating
      // against a long-lived regtest stack sees it on the second run, and the
      // failure lands on the premise rather than on the assertion under test.
      const priv = sha256(randomBytes(32));
      const pub = secp256k1.getPublicKey(priv, true);
      const paymentAddress = btc.p2wpkh(pub, scure).address;
      const ordinalsAddress = btc.p2tr(pub.subarray(1, 33), undefined, scure, true).address;
      if (paymentAddress === undefined || ordinalsAddress === undefined) {
        throw new Error('no address for the generated key');
      }

      // The clean coin first: the guard needs an alternative, or this proves
      // only that the guard flags.
      await fundCommonSats(paymentAddress, CLEAN_BTC);

      const dirty = await seedDirtyCoin({ asset, address: paymentAddress, valueSats: DIRTY_SATS });
      const tip = mineBlocks(1);
      await waitForElectrsSync(tip);
      await waitForOrdSync(tip);

      // The premise the whole case rests on: the dirty coin really is the
      // smallest covering candidate, so an unguarded selection takes it.
      const pool = await getUtxos(paymentAddress);
      const dirtyEntry = pool.find(u => `${u.txid}:${u.vout}` === dirty.outpoint);
      expect(dirtyEntry?.value).toBe(DIRTY_SATS);
      const smallest = [...pool].sort((a, b) => a.value - b.value)[0];
      expect(`${smallest.txid}:${smallest.vout}`).toBe(dirty.outpoint);

      const scanned: string[] = [];
      const scanner = new UtxoContentScanner({
        mempoolApiUrl: ELECTRS_URL,
        cat21ApiUrl: '',
        ordApiUrl: ORD_STOCK_URL,
        cat21OrdApiUrl: ORD_URL,
      });
      const utxos: UtxosPort = {
        spendableUtxos: async (addr) =>
          (await getUtxos(addr)).map(u => ({ txid: u.txid, vout: u.vout, value: u.value })),
      };
      const scan: ContentScanPort = {
        classify: async (outpoint) => { scanned.push(outpoint); return scanner.classify(outpoint); },
      };
      const sign: SignPort = {
        sign: async (psbt, indexes) => {
          const tx = btc.Transaction.fromPSBT(psbt);
          const idxs = indexes === 'all' ? Array.from({ length: tx.inputsLength }, (_, i) => i) : indexes;
          for (const i of idxs) tx.signIdx(priv, i, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
          tx.finalize();
          return { hex: tx.hex, weight: tx.weight };
        },
      };
      const broadcast: BroadcastPort = {
        broadcast: async (hex) => ({ txid: await postTx(hex), channel: 'mempool' }),
      };

      const out = await executeMint(
        {
          walletType: KnownOrdinalWalletType.cat21wallet,
          network: net,
          paymentPublicKey: pub,
          paymentAddress,
          recipientAddress: ordinalsAddress,
          feeRatePerVbyte: 2,
        },
        { utxos, scan, sign, broadcast },
      );
      expect(out.txid).toMatch(/^[0-9a-f]{64}$/);

      // The selection CONSIDERED it. Without this a coin that was never a
      // candidate reads exactly like one the guard rejected.
      expect(scanned).toContain(dirty.outpoint);

      // And refused it. `assetId` is in the message so a failure names the
      // thing that would have been destroyed.
      const vin = (await getTx(out.txid)).vin as Array<{ txid: string; vout: number }>;
      const spent = vin.map(v => `${v.txid}:${v.vout}`);
      expect({ asset, assetId: dirty.assetId, spent })
        .toEqual({ asset, assetId: dirty.assetId, spent: expect.not.arrayContaining([dirty.outpoint]) });

      // Still there on chain, which is the claim a holder cares about.
      const after = await getUtxos(paymentAddress);
      expect(after.map(u => `${u.txid}:${u.vout}`)).toContain(dirty.outpoint);
    },
    600_000,
  );
});
