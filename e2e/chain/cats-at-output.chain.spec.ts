/**
 * @test-kind chain
 * Real:   bitcoind 30, ordpool-electrs, cat21-ord (--index-cat21 --index-addresses), a cat minted on regtest
 * Faked:  nothing
 * Proves: getCatsAtOutput reads a seeded cat's output as that cat's number, the number cat21-ord's own
 *         address index gives it; the mint's change output as no cats; an output cat21-ord never saw as null
 */
import { beforeAll, describe, expect, it } from '@jest/globals';

import { cat21OrdFetchReader, getCatsAtOutput } from '../../src/cat21-validation';
import { catsAtAddress } from '../../src/wallet/xpub/cats-at-address';
import { regtestServiceUrls, rpc, seedListedCat, waitForOrdReady } from '../regtest/regtest-helpers';

const CAT21_ORD_URL = regtestServiceUrls().ord;

beforeAll(async () => {
  await waitForOrdReady();
});

describe('getCatsAtOutput against cat21-ord', () => {
  it('reads each seeded cat on its output, numbered as cat21-ord numbers it at the owner address', async () => {
    const reader = cat21OrdFetchReader(CAT21_ORD_URL);
    // Two cats, so at least one number is not 0 and the two differ: a reading
    // that returned the inscription index (`i0`) or a constant fails here.
    const seeded: { atOutput: number[] | null; atAddress: number[] }[] = [];
    for (const valueSats of [9_000, 546]) {
      const owner = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32m');
      const cat = await seedListedCat({ ordinalsAddress: owner, valueSats });
      // The address index's `cat_numbers` is cat21-ord's cat numbering, read
      // without any inscription lookup: the independent side of the comparison.
      seeded.push({
        atOutput: await getCatsAtOutput(reader, cat.txid, cat.vout),
        atAddress: await catsAtAddress(owner, { cat21OrdApiUrl: CAT21_ORD_URL }),
      });
      // The mint's change output carries no cat.
      expect(await getCatsAtOutput(reader, cat.txid, 1)).toEqual([]);
    }

    for (const { atOutput, atAddress } of seeded) {
      expect(atAddress).toHaveLength(1);
      expect(atOutput).toEqual(atAddress);
    }
    expect(seeded[0].atAddress[0]).not.toBe(seeded[1].atAddress[0]);
  });

  it('answers null for an output cat21-ord has never seen', async () => {
    const reader = cat21OrdFetchReader(CAT21_ORD_URL);
    expect(await getCatsAtOutput(reader, 'ab'.repeat(32), 0)).toBeNull();
  });
});
