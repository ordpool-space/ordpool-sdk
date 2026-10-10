it('funds', async () => {
  const utxo = await waitForUtxoAt(address, 546, FUNDING_TIMEOUT);
  expect(utxo.value).toBe(546);
});
