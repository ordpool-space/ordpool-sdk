test('connects', async () => {
  const popup = await waitForOptionalApprovalPopup({ context, knownPages, isApproval });
  expect(popup).toBeNull();
});
