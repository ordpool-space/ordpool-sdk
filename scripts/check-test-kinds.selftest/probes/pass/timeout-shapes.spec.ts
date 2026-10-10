interface Opts { timeout: number; timeoutMs?: number }

it('waits on states with the config bound', async () => {
  const popup = await waitForApprovalPopup({ context, knownPages, isApproval });
  await waitForUtxoAt(address, 546);
  await waitForElectrsSync(height);
  const opts: Opts = fast ? defaults : defaults;
  const label = slow ? 'timeout' : 'ok';
  expect([popup, opts, label]).toHaveLength(3);
});
