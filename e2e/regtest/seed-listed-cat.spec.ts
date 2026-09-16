/**
 * The listed-cat fixture, proven against cat21-ord.
 *
 * It exists so an offer page can be driven end to end with a seller whose
 * ORDINALS address is distinct from the payment address they type. That
 * distinction is the whole point: `make-offer` once took the seller's address
 * from an ord lookup, which returns the ordinals address, and used it as the
 * payment address, so every URL-driven accept broke silently. A fixture where
 * the two coincide cannot catch that, so this one takes the owner as an
 * argument.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';

import {
  waitForCatAtAddress,
  mineBlocks,
  rpc,
  seedListedCat,
  waitForOrdReady,
} from './regtest-helpers';

beforeAll(async () => {
  await waitForOrdReady();
}, 180_000);

/** A fresh address the seller "owns", standing in for their ordinals identity. */
const freshAddress = (type: 'bech32' | 'bech32m' = 'bech32m'): string =>
  rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', type).trim();

describe('seedListedCat', () => {

  it('mints a real cat that cat21-ord reports at the address the caller chose', async () => {
    const owner = freshAddress();
    const cat = await seedListedCat({ ordinalsAddress: owner });

    expect(cat.sellerOrdinalsAddress).toBe(owner);
    expect(cat.vout).toBe(0);
    expect(cat.txid).toMatch(/^[0-9a-f]{64}$/);
    // The cat NUMBER, so a number-lookup page can be driven without reading
    // /cats and assuming an ordering.
    expect(typeof cat.catNumber).toBe('number');
    expect(cat.catNumber).toBeGreaterThanOrEqual(0);

    // cat21-ord is the authority, not our own return value.
    const indexed = await waitForCatAtAddress(cat.inscriptionId, owner);
    expect(indexed.address).toBe(owner);
    expect(indexed.value).toBe(546);
  }, 300_000);

  it('honours a non-546 size, which is what a size-preserving offer must be tested against', async () => {
    // A 546-only fixture is how an offer builder that hardcoded 546 stayed
    // green: at that size a preserved value and a hardcoded one coincide.
    const owner = freshAddress();
    const cat = await seedListedCat({ ordinalsAddress: owner, valueSats: 9_000 });

    expect(cat.value).toBe(9_000);
    expect((await waitForCatAtAddress(cat.inscriptionId, owner)).value).toBe(9_000);
  }, 300_000);

  it('gives each call a distinct cat, so a spec can hold a seller and a decoy', async () => {
    const [a, b] = [freshAddress(), freshAddress()];
    const first = await seedListedCat({ ordinalsAddress: a });
    const second = await seedListedCat({ ordinalsAddress: b });

    expect(first.txid).not.toBe(second.txid);
    expect(first.inscriptionId).not.toBe(second.inscriptionId);
    expect(first.catNumber).not.toBe(second.catNumber);
    expect((await waitForCatAtAddress(first.inscriptionId, a)).address).toBe(a);
    expect((await waitForCatAtAddress(second.inscriptionId, b)).address).toBe(b);
  }, 420_000);

  it('the owner address is genuinely the caller\'s, not one the helper picked', async () => {
    // The load-bearing property for an offer spec: O is chosen by the caller,
    // so it can be made distinct from the payment address P the page is typed
    // with. If the helper ever derived O itself, a page paying O instead of P
    // would look correct.
    const owner = freshAddress();
    const cat = await seedListedCat({ ordinalsAddress: owner });
    const wallet = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'getaddressinfo', owner)) as { ismine: boolean };

    expect(wallet.ismine).toBe(true);
    expect(cat.sellerOrdinalsAddress).toBe(owner);
    mineBlocks(1);
  }, 300_000);
});
