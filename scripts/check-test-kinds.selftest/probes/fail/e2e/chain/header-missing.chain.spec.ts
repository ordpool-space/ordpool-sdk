import { mineBlocks } from 'ordpool-sdk/e2e';

it('mines', async () => {
  expect(await mineBlocks(1)).toHaveLength(1);
});
