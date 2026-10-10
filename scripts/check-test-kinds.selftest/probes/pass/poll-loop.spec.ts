it('polls until done', async () => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (done()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  while (!done()) await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 10 && !done(); i++) {
    await sleep(100);
  }
  do {
    await delay(50);
  } while (!done());
  expect(done()).toBe(true);
});

it('runs a timer that is not a wait', async () => {
  let closed = false;
  setTimeout(() => {
    closed = true;
  }, 20);
  const values = source.pipe(delay(100));
  expect(await closeAndWait(() => closed, values)).toBeUndefined();
});
