/**
 * @test-kind unit
 * Real:   the sat picker
 * Faked:  fetch -> a 200 with an empty body, delayed to overlap requests
 * Proves: the picker keeps at most `concurrency` requests in flight
 */
it('keeps at most `concurrency` requests in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchFn = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await pick({ fetchFn, concurrency: 2 });
  expect(peak).toBe(2);
});
