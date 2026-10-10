/**
 * @test-kind chain
 * Real:   bitcoind, ordpool-electrs
 * Faked:  nothing
 * Proves: a chain spec outside e2e/chain/ is reported
 */
import { mineBlocks } from 'ordpool-sdk/e2e';

it('mines', async () => {
  expect(await mineBlocks(1)).toHaveLength(1);
});
