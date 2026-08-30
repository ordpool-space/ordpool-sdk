import { base64, hex } from '@scure/base';

/**
 * Decode a base64- or hex-encoded PSBT paste to raw bytes. All standard PSBTs
 * start with the magic bytes `0x70736274ff` ("psbt" + 0xff): base64-encoded
 * that is the prefix `cHNidP`, hex-encoded it is literally `70736274ff`. The
 * accept-offer flow uses this to turn a seller's pasted `?offer=…` artifact
 * into bytes; also shared by the watch-only psbt-export signer (via `subject`).
 */
export function decodePastedPsbt(input: string, subject = 'Pasted offer'): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(`${subject} is empty`);
  if (trimmed.startsWith('cHNidP')) return base64.decode(trimmed);
  if (/^70736274ff/i.test(trimmed) && trimmed.length % 2 === 0) {
    return hex.decode(trimmed.toLowerCase());
  }
  throw new Error(`${subject} must be base64 or hex PSBT (start: "cHNidP" or "70736274ff")`);
}
