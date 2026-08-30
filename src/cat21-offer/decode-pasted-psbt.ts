import { base64, hex } from '@scure/base';

/**
 * Decode a base64- or hex-encoded PSBT paste to raw bytes. All standard PSBTs
 * start with the magic bytes `0x70736274ff` ("psbt" + 0xff): base64-encoded
 * that is the prefix `cHNidP`, hex-encoded it is literally `70736274ff`. The
 * accept-offer flow uses this to turn a seller's pasted `?offer=…` artifact
 * into bytes without depending on the watch-only signer module.
 */
export function decodePastedPsbt(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Pasted offer is empty');
  if (trimmed.startsWith('cHNidP')) return base64.decode(trimmed);
  if (/^70736274ff/i.test(trimmed) && trimmed.length % 2 === 0) {
    return hex.decode(trimmed.toLowerCase());
  }
  throw new Error('Offer must be base64 or hex PSBT (start: "cHNidP" or "70736274ff")');
}
