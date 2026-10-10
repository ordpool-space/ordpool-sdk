test('connects', async () => {
  const popup = await waitForApprovalPopup({ context, knownPages, isApproval }).catch(() => null);
  expect(popup).toBeNull();
});
