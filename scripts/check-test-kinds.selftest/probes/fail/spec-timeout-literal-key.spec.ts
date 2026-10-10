test('signs', async () => {
  await clickApprovalAndRequireClose(button, popup, { closeTimeoutMs: 2_000 });
  expect(popup.isClosed()).toBe(true);
});
