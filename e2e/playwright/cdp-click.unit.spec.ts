/**
 * @test-kind unit
 * Real:   cdpClick
 * Faked:  the page's CDP session and the locator (waitFor/boundingBox, shapes: @playwright/test types)
 * Proves: the click is a real press-release at the element's centre, sent only once the element is visible,
 *         and an element without a layout box fails naming it instead of being skipped
 */
import { cdpClick } from './cdp-click';

function fakes(box: { x: number; y: number; width: number; height: number } | null) {
  const events: string[] = [];
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const locator = {
    waitFor: async ({ state }: { state: string }) => { events.push(`waitFor:${state}`); },
    boundingBox: async () => { events.push('boundingBox'); return box; },
  };
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string, params: Record<string, unknown>) => {
          events.push(`${method}:${String(params.type)}`);
          sent.push({ method, params });
        },
      }),
    }),
  };
  return { events, sent, locator, page };
}

describe('cdpClick', () => {
  it('waits for visibility, then moves, presses and releases the left button at the centre', async () => {
    const { events, sent, locator, page } = fakes({ x: 100, y: 40, width: 60, height: 20 });
    await cdpClick(page as never, locator as never, 'the button');
    expect(events).toEqual([
      'waitFor:visible',
      'boundingBox',
      'Input.dispatchMouseEvent:mouseMoved',
      'Input.dispatchMouseEvent:mousePressed',
      'Input.dispatchMouseEvent:mouseReleased',
    ]);
    for (const { params } of sent) expect([params.x, params.y]).toEqual([130, 50]);
    expect(sent.map((s) => [s.params.button, s.params.buttons, s.params.clickCount])).toEqual([
      ['none', 0, undefined],
      ['left', 1, 1],
      ['left', 0, 1],
    ]);
  });

  it('fails naming the control when it has no layout box, and sends nothing', async () => {
    const { sent, locator, page } = fakes(null);
    await expect(cdpClick(page as never, locator as never, 'the "Wizz Wallet" restore source'))
      .rejects.toThrow('cdpClick: the "Wizz Wallet" restore source is visible but has no layout box');
    expect(sent).toEqual([]);
  });
});
