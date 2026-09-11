/**
 * checkInscriptionsExist against live stock ord: the same lookup ord's own
 * `wallet inscribe --gallery` / `--delegate` relies on to refuse ids its index
 * does not have.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import { checkInscriptionsExist } from '../../src/inscribe/inscription-existence';
import {
  fundOrdStockWallet,
  mineBlocks,
  ordStockWalletInscribe,
  waitForOrdStockReady,
  waitForOrdStockSync,
  writeOrdStockFile,
} from './regtest-helpers';

const ORD_WALLET = `existence-stock-${Date.now().toString(36)}`;
const ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';

describe('checkInscriptionsExist → live stock ord', () => {
  let existing: string;

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    await fundOrdStockWallet(ORD_WALLET);
    writeOrdStockFile('/tmp/existence.txt', new TextEncoder().encode('I exist'));
    existing = `${ordStockWalletInscribe(ORD_WALLET, '/tmp/existence.txt', 5).reveal}i0`;
    await waitForOrdStockSync(mineBlocks(1));
  }, 240_000);

  it('an inscription ord indexed exists; a well-formed id it never saw is missing; a malformed one is invalid', async () => {
    const neverInscribed = `${'00'.repeat(32)}i0`;
    const r = await checkInscriptionsExist([existing, neverInscribed, 'not-an-id'], { ordBaseUrl: ORD_STOCK_URL });
    expect(r.get(existing)).toBe('exists');
    expect(r.get(neverInscribed)).toBe('missing');
    expect(r.get('not-an-id')).toBe('invalid');
  }, 60_000);

  it('an unreachable ord is unknown, not missing', async () => {
    const r = await checkInscriptionsExist([existing], { ordBaseUrl: 'http://127.0.0.1:9', timeoutMs: 2_000 });
    expect(r.get(existing)).toBe('unknown');
  }, 30_000);
});
