/**
 * Inscribe-specific gate spec. Mirrors the per-operation block style
 * used by the other operations in `cat21-operation-gate.spec.ts` but
 * splits to its own file so the inscribe specs stay easy to find.
 *
 * Every named `Cat21GateRejectReason` introduced by inscribe gets at
 * least one positive-equality test:
 *
 *   content-not-bytes, content-too-large,
 *   content-type-not-string, content-type-not-allowed,
 *   content-type-blocked.
 *
 * Plus happy-path checks for the success resources (recipientScript,
 * contentBytes, normalised contentType) and the standard recipient /
 * fee-rate / kind-allowlist reuse paths.
 */
import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';

import { validateCat21Operation } from './cat21-operation-gate';
import type {
  Cat21InscribeIntent,
  Cat21OperationGateConfig,
} from './cat21-operation-gate.types';

const MAINNET_TAPROOT =
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const ANOTHER_MAINNET_TAPROOT =
  'bc1pdkz7m4d57mtprhckl54zsd62cwhcmw6gj8jx32t99cwt3l6yj7msvvfn0w';
const TESTNET_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

const mainnetConfig: Cat21OperationGateConfig = { network: Network.Mainnet };

function inscribeIntent(over: Partial<Cat21InscribeIntent> = {}): Cat21InscribeIntent {
  return {
    recipient: MAINNET_TAPROOT,
    feeRate: 5,
    body: new TextEncoder().encode('hello inscribe'),
    contentType: 'text/plain',
    ...over,
  };
}

describe('validateCat21Operation — inscribe happy paths', () => {
  it('accepts a minimal inscribe and returns recipientScript + contentBytes + normalised contentType', () => {
    const body = new TextEncoder().encode('happy');
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ body, contentType: 'TEXT/PLAIN' }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.resources.kind).toBe('inscribe');
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.recipientScript.length).toBeGreaterThan(0);
      expect(result.resources.contentBytes).toBe(body);
      expect(result.resources.contentType).toBe('text/plain');
    }
  });

  it('accepts an inscribe without contentType (omitted in the envelope)', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: undefined }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.contentType).toBeUndefined();
    }
  });

  it('accepts an empty body (zero-byte inscription)', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: new Uint8Array(0) }) },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateCat21Operation — inscribe recipient + fee-rate rejections (reuses shared helpers)', () => {
  it('rejects a non-address recipient with recipient-not-a-bitcoin-address', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ recipient: 'not-an-address' }) },
    });
    expect(result).toEqual({
      ok: false,
      reason: 'recipient-not-a-bitcoin-address',
      detail: 'not-an-address',
    });
  });

  it('rejects a recipient on the wrong network with recipient-wrong-network', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ recipient: TESTNET_ADDR }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipient-wrong-network');
  });

  it('rejects a recipient outside allowedRecipients with recipient-not-allowed', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedRecipients: [ANOTHER_MAINNET_TAPROOT] },
      operation: { kind: 'inscribe', intent: inscribeIntent() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipient-not-allowed');
  });

  it('rejects a self-send (recipient === ownPaymentAddress) with self-send', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, ownPaymentAddress: MAINNET_TAPROOT },
      operation: { kind: 'inscribe', intent: inscribeIntent() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('self-send');
  });

  it('rejects feeRate <= 0 with fee-rate-not-positive', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ feeRate: 0 }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fee-rate-not-positive');
  });

  it('rejects feeRate above maxFeeRatePerVbyte cap', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxFeeRatePerVbyte: 100 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ feeRate: 1000 }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fee-rate-above-cap');
  });
});

describe('validateCat21Operation — inscribe body rejections', () => {
  it('rejects a non-Uint8Array body with content-not-bytes', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'inscribe',
        intent: inscribeIntent({ body: 'a string' as unknown as Uint8Array }),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-not-bytes');
  });

  it('rejects a body that exceeds the default 350KB cap with content-too-large', () => {
    const big = new Uint8Array(350_001);
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: big }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-too-large');
  });

  it('rejects a body that exceeds a custom maxInscribeContentBytes', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxInscribeContentBytes: 100 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: new Uint8Array(101) }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-too-large');
  });

  it('accepts a body exactly at the cap (boundary)', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, maxInscribeContentBytes: 100 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: new Uint8Array(100) }) },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateCat21Operation — inscribe contentType rejections', () => {
  it('rejects a non-string contentType with content-type-not-string', () => {
    const result = validateCat21Operation({
      config: mainnetConfig,
      operation: {
        kind: 'inscribe',
        intent: inscribeIntent({ contentType: 42 as unknown as string }),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-type-not-string');
  });

  it('rejects a contentType outside allowedContentTypes with content-type-not-allowed', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedContentTypes: ['image/png', 'text/plain'] },
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: 'image/jpeg' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-type-not-allowed');
  });

  it('matches allowedContentTypes case-insensitively', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedContentTypes: ['image/png'] },
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: 'Image/PNG' }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.contentType).toBe('image/png');
    }
  });

  it('rejects a blocked contentType with content-type-blocked', () => {
    const result = validateCat21Operation({
      config: {
        ...mainnetConfig,
        blockedContentTypes: ['application/javascript', 'text/javascript'],
      },
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: 'application/javascript' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-type-blocked');
  });

  it('blocklist wins over allowlist (defence-in-depth)', () => {
    const result = validateCat21Operation({
      config: {
        ...mainnetConfig,
        allowedContentTypes: ['application/javascript'], // mistakenly permits
        blockedContentTypes: ['application/javascript'], // but defensive block fires
      },
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: 'application/javascript' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-type-blocked');
  });
});

describe('validateCat21Operation — inscribe kind-allowlist', () => {
  it('rejects inscribe when allowedOperations does not include it', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: ['mint'] },
      operation: { kind: 'inscribe', intent: inscribeIntent() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('operation-kind-not-allowed');
  });

  it('accepts inscribe when allowedOperations includes it', () => {
    const result = validateCat21Operation({
      config: { ...mainnetConfig, allowedOperations: ['inscribe'] },
      operation: { kind: 'inscribe', intent: inscribeIntent() },
    });
    expect(result.ok).toBe(true);
  });
});
