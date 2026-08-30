import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { decodePastedPsbt } from './decode-pasted-psbt';

// Pure-function spec for the shared PSBT paste decoder (accept-offer + the
// watch-only psbt-export signer both route through it). Exercises BOTH the
// base64 and hex branches — the hex branch has no other coverage.

const PSBT_BYTES = new btc.Transaction().toPSBT(0);
const B64 = base64.encode(PSBT_BYTES);
const HEX = hex.encode(PSBT_BYTES);

describe('decodePastedPsbt', () => {
  it('decodes a base64 paste (cHNidP…) back to the exact bytes', () => {
    expect(B64.startsWith('cHNidP')).toBe(true);
    expect(decodePastedPsbt(B64)).toEqual(PSBT_BYTES);
  });

  it('decodes a hex paste (70736274ff…) back to the exact bytes', () => {
    expect(HEX.startsWith('70736274ff')).toBe(true);
    expect(decodePastedPsbt(HEX)).toEqual(PSBT_BYTES);
  });

  it('base64 and hex of the same PSBT decode to identical bytes', () => {
    expect(decodePastedPsbt(B64)).toEqual(decodePastedPsbt(HEX));
  });

  it('accepts upper-case hex (normalises via toLowerCase)', () => {
    expect(decodePastedPsbt(HEX.toUpperCase())).toEqual(PSBT_BYTES);
  });

  it('empty / whitespace input throws "empty"', () => {
    expect(() => decodePastedPsbt('')).toThrow(/empty/i);
    expect(() => decodePastedPsbt('   ')).toThrow(/empty/i);
  });

  it('odd-length hex (right prefix, bad length) throws base64-or-hex', () => {
    expect(() => decodePastedPsbt('70736274ffab0')).toThrow(/base64 or hex/i);
  });

  it('non-PSBT garbage throws base64-or-hex', () => {
    expect(() => decodePastedPsbt('not-a-psbt')).toThrow(/base64 or hex/i);
    expect(() => decodePastedPsbt('deadbeef')).toThrow(/base64 or hex/i);
  });

  it('the subject arg names the input in the error (each caller keeps its wording)', () => {
    expect(() => decodePastedPsbt('', 'Signed PSBT')).toThrow('Signed PSBT is empty');
    expect(() => decodePastedPsbt('nope', 'Signed PSBT')).toThrow(/^Signed PSBT must be base64 or hex/);
    expect(() => decodePastedPsbt('')).toThrow('Pasted offer is empty');
  });
});
