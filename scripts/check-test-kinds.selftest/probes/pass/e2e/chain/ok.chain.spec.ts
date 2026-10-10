/**
 * @test-kind chain
 * Real:   bitcoind 30, ordpool-electrs
 * Faked:  nothing
 * Proves: a mined block reaches electrs
 */
import { mineBlocks, waitForElectrsSync } from 'ordpool-sdk/e2e';

it('mines', async () => {
  await mineBlocks(1);
  expect(await waitForElectrsSync()).toBe(true);
});
