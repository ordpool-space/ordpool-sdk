import { describe, expect, it } from '@jest/globals';

import {
  CONNECT_BUTTON_ACCESSIBLE_NAME,
  CONNECT_BUTTON_LABEL,
  CONNECT_PANEL_HEADING,
} from './connect-ui';

describe('connect UI strings', () => {
  it('is the maintainer wording, exactly', () => {
    expect(CONNECT_BUTTON_LABEL).toBe('Connect');
    expect(CONNECT_PANEL_HEADING).toBe('Connect a wallet');
  });

  it('keeps the button a bare verb, because the icon carries the noun', () => {
    expect(CONNECT_BUTTON_LABEL).not.toMatch(/wallet/i);
    expect(CONNECT_BUTTON_LABEL.split(' ')).toHaveLength(1);
  });

  it('gives the button back its noun for a screen reader, which sees no icon', () => {
    // The icon is what makes the bare verb sufficient visually. A reader
    // meeting only the label needs the noun, so these two deliberately differ.
    expect(CONNECT_BUTTON_ACCESSIBLE_NAME).toBe(CONNECT_PANEL_HEADING);
    expect(CONNECT_BUTTON_ACCESSIBLE_NAME).not.toBe(CONNECT_BUTTON_LABEL);
  });

  it('names no wallet, so it cannot rot when the matrix changes', () => {
    for (const s of [CONNECT_BUTTON_LABEL, CONNECT_PANEL_HEADING]) {
      for (const w of ['Xverse', 'Leather', 'UniSat', 'Unisat', 'OKX', 'Phantom']) {
        expect(s).not.toContain(w);
      }
    }
  });

  it('says "a wallet", not "your wallet", because the panel also offers installing', () => {
    expect(CONNECT_PANEL_HEADING).toContain('a wallet');
    expect(CONNECT_PANEL_HEADING).not.toContain('your wallet');
  });
});
