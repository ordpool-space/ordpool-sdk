import { clickApprovalAndRequireClose } from './approval-popup';

it('returns once the popup closes', async () => {
  await expect(clickApprovalAndRequireClose()).resolves.toBeUndefined();
});
