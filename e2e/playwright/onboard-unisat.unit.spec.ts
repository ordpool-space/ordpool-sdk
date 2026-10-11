/**
 * @test-kind unit
 * Real:   dismissUnisatNoticeControls, dismissUnisatUpdateNagControls
 * Faked:  the UniSat controls (click/waitFor, shapes: @playwright/test Locator)
 * Proves: OK is clicked only once its countdown ended, and each dismissal fails unless its modal went away
 */
import { dismissUnisatNoticeControls, dismissUnisatUpdateNagControls } from './onboard-unisat';

type Control = { click: () => Promise<void>; waitFor: (o: { state: string }) => Promise<void> };

function recorder() {
  const calls: string[] = [];
  const control = (name: string, waits: Record<string, () => Promise<void>> = {}): Control => ({
    click: async () => { calls.push(`${name}.click`); },
    waitFor: async ({ state }) => {
      calls.push(`${name}.${state}`);
      await waits[state]?.();
    },
  });
  return { calls, control };
}

describe('dismissUnisatNoticeControls', () => {
  it('ticks the box, waits for the plain "OK", clicks it, and waits for the notice to go', async () => {
    const { calls, control } = recorder();
    await dismissUnisatNoticeControls({
      checkbox: control('checkbox'),
      okReady: control('okReady'),
      ok: control('ok'),
    } as never);
    expect(calls).toEqual(['checkbox.click', 'okReady.visible', 'okReady.click', 'ok.hidden']);
  });

  it('does not click OK while the countdown is still running', async () => {
    const { calls, control } = recorder();
    const run = dismissUnisatNoticeControls({
      checkbox: control('checkbox'),
      okReady: control('okReady', { visible: () => Promise.reject(new Error('OK still counting down')) }),
      ok: control('ok'),
    } as never);
    await expect(run).rejects.toThrow('OK still counting down');
    expect(calls).toEqual(['checkbox.click', 'okReady.visible']);
  });

  it('fails when the notice stays after OK', async () => {
    const { control } = recorder();
    await expect(dismissUnisatNoticeControls({
      checkbox: control('checkbox'),
      okReady: control('okReady'),
      ok: control('ok', { hidden: () => Promise.reject(new Error('notice-ok-button still visible')) }),
    } as never)).rejects.toThrow('notice-ok-button still visible');
  });
});

describe('dismissUnisatUpdateNagControls', () => {
  it('clicks Skip and waits for the modal to go', async () => {
    const { calls, control } = recorder();
    await dismissUnisatUpdateNagControls({ skip: control('skip'), modal: control('modal') } as never);
    expect(calls).toEqual(['skip.click', 'modal.hidden']);
  });

  it('fails when the modal stays after Skip', async () => {
    const { control } = recorder();
    await expect(dismissUnisatUpdateNagControls({
      skip: control('skip'),
      modal: control('modal', { hidden: () => Promise.reject(new Error('modal still visible')) }),
    } as never)).rejects.toThrow('modal still visible');
  });
});
