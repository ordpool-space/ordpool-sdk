/**
 * @test-kind e2e
 * Real:   bitcoind, ordpool-electrs
 * Faked:  nothing
 * Proves: the header kind must agree with the file name
 */
import { mineBlocks } from 'ordpool-sdk/e2e';

it('mines', async () => {
  expect(await mineBlocks(1)).toHaveLength(1);
});
