/**
 * Inscribe gate spec. Each `InscribeGateRejectReason` gets at least
 * one positive-equality test:
 *
 *   content-not-bytes, content-too-large,
 *   content-type-not-string, content-type-not-allowed,
 *   content-type-blocked, plus the shared recipient / fee-rate /
 *   intent-not-an-object cases.
 *
 * Parallel to `cat21-validation/cat21-operation-gate.spec.ts` —
 * separate module by design (different protocol). See the gate's
 * types-file module doc for the rationale.
 */
import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';

import { validateInscribeOperation } from './inscribe-operation-gate';
import type {
  InscribeIntent,
  InscribeOperationGateConfig,
} from './inscribe-operation-gate.types';

const MAINNET_TAPROOT =
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const ANOTHER_MAINNET_TAPROOT =
  'bc1pdkz7m4d57mtprhckl54zsd62cwhcmw6gj8jx32t99cwt3l6yj7msvvfn0w';
const TESTNET_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

const mainnetConfig: InscribeOperationGateConfig = { network: Network.Mainnet };

function inscribeIntent(over: Partial<InscribeIntent> = {}): InscribeIntent {
  return {
    recipient: MAINNET_TAPROOT,
    feeRate: 5,
    body: new TextEncoder().encode('hello inscribe'),
    contentType: 'text/plain',
    ...over,
  };
}

describe('validateInscribeOperation — inscribe happy paths', () => {
  it('accepts a minimal inscribe and returns recipientScript + contentBytes + normalised contentType', () => {
    const body = new TextEncoder().encode('happy');
    const result = validateInscribeOperation({
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
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: undefined }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.contentType).toBeUndefined();
    }
  });

  it('accepts an empty body (zero-byte inscription)', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: new Uint8Array(0) }) },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateInscribeOperation — inscribe recipient + fee-rate rejections (reuses shared helpers)', () => {
  it('rejects a non-address recipient with recipient-not-a-bitcoin-address', () => {
    const result = validateInscribeOperation({
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
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ recipient: TESTNET_ADDR }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipient-wrong-network');
  });

  it('rejects a recipient outside allowedRecipients with recipient-not-allowed', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, allowedRecipients: [ANOTHER_MAINNET_TAPROOT] },
      operation: { kind: 'inscribe', intent: inscribeIntent() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipient-not-allowed');
  });

  it('rejects a self-send (recipient === ownPaymentAddress) with self-send', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, ownPaymentAddress: MAINNET_TAPROOT },
      operation: { kind: 'inscribe', intent: inscribeIntent() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('self-send');
  });

  it('rejects feeRate <= 0 with fee-rate-not-positive', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ feeRate: 0 }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fee-rate-not-positive');
  });

  it('rejects feeRate above maxFeeRatePerVbyte cap', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, maxFeeRatePerVbyte: 100 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ feeRate: 1000 }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fee-rate-above-cap');
  });
});

describe('validateInscribeOperation — inscribe body rejections', () => {
  it('rejects a non-Uint8Array body with content-not-bytes', () => {
    const result = validateInscribeOperation({
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
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: big }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-too-large');
  });

  it('rejects a body that exceeds a custom maxContentBytes', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, maxContentBytes: 100 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: new Uint8Array(101) }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-too-large');
  });

  it('accepts a body exactly at the cap (boundary)', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, maxContentBytes: 100 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ body: new Uint8Array(100) }) },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateInscribeOperation — inscribe contentType rejections', () => {
  it('rejects a non-string contentType with content-type-not-string', () => {
    const result = validateInscribeOperation({
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
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, allowedContentTypes: ['image/png', 'text/plain'] },
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: 'image/jpeg' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-type-not-allowed');
  });

  it('matches allowedContentTypes case-insensitively', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, allowedContentTypes: ['image/png'] },
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentType: 'Image/PNG' }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.contentType).toBe('image/png');
    }
  });

  it('rejects a blocked contentType with content-type-blocked', () => {
    const result = validateInscribeOperation({
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
    const result = validateInscribeOperation({
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

describe('validateInscribeOperation — entry-level guards', () => {
  it('rejects a non-object intent', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: 'oops' as unknown as InscribeIntent },
    });
    expect(result).toEqual({ ok: false, reason: 'intent-not-an-object', detail: undefined });
  });
});

describe('validateInscribeOperation — tip', () => {
  // Derived from `schnorr.getPublicKey(new Uint8Array(32).fill(7))` at
  // spec-write time. Just needs to be a valid mainnet taproot address
  // distinct from MAINNET_TAPROOT for the allowlist-rejects test.
  const OTHER_VALID_TAPROOT = 'bc1pw53jtgez0wf69n06fchp0ctk48620zdscnrj8heh86wykp9mv20qya3c8w';
  const validTip = { address: MAINNET_TAPROOT, value: 5_000 };

  it('accepts a well-formed tip and pre-decodes the tipScript', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: validTip }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.tip?.address).toBe(MAINNET_TAPROOT);
      expect(result.resources.tip?.tipValueSats).toBe(5_000);
      expect(result.resources.tip?.tipScript.length).toBeGreaterThan(0);
    }
  });

  it('accepts value=0 as a no-op and does not emit a tip resource', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: 0 } }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.tip).toBeUndefined();
    }
  });

  it('still validates the tip address at value=0 (allowlist bypass guard)', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, allowedTipAddresses: [OTHER_VALID_TAPROOT] },
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: 0 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-address-not-allowed');
  });

  it('rejects a non-object tip', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: 42 as unknown as typeof validTip }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-not-an-object');
  });

  it('rejects a non-integer tip.value', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: 1.5 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-value-not-integer');
  });

  it('rejects a negative tip.value', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: -1 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-value-negative');
  });

  it('rejects a below-dust tip.value', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: 100 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-value-below-dust');
  });

  it('rejects a tip.value above maxTipValueSats (drain protection)', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, maxTipValueSats: 10_000 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: 21_000 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-value-above-cap');
  });

  it('rejects a tip address on the wrong network', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: TESTNET_ADDR, value: 5_000 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-address-wrong-network');
  });

  it('rejects a tip address outside allowedTipAddresses', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, allowedTipAddresses: [OTHER_VALID_TAPROOT] },
      operation: { kind: 'inscribe', intent: inscribeIntent({ tip: { address: MAINNET_TAPROOT, value: 5_000 } }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('tip-address-not-allowed');
  });
});

describe('validateInscribeOperation — note', () => {
  it('accepts a short note and emits noteBytes', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ note: 'inscribed via ordpool.space' }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.noteBytes).toBeDefined();
      expect(new TextDecoder().decode(result.resources.noteBytes!)).toBe('inscribed via ordpool.space');
    }
  });

  it('rejects a non-string note', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ note: 42 as unknown as string }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('note-not-a-string');
  });

  it('rejects a note above maxNoteBytes', () => {
    const result = validateInscribeOperation({
      config: { ...mainnetConfig, maxNoteBytes: 8 },
      operation: { kind: 'inscribe', intent: inscribeIntent({ note: 'this is longer than eight bytes' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('note-too-large');
  });
});

describe('validateInscribeOperation — parent', () => {
  it('accepts a well-formed parent inscription id and pre-encodes parentBytes', () => {
    const parentId = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ parent: parentId }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.parentBytes?.length).toBe(32);
    }
  });

  it('rejects a malformed parent inscription id', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ parent: 'not-an-id' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parent-malformed');
  });
});

describe('validateInscribeOperation — contentEncoding', () => {
  it('accepts contentEncoding=br', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentEncoding: 'br' }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.contentEncoding).toBe('br');
    }
  });

  it('accepts contentEncoding=gzip', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentEncoding: 'gzip' }) },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.resources.kind === 'inscribe') {
      expect(result.resources.contentEncoding).toBe('gzip');
    }
  });

  it('rejects an unsupported contentEncoding string', () => {
    const result = validateInscribeOperation({
      config: mainnetConfig,
      operation: { kind: 'inscribe', intent: inscribeIntent({ contentEncoding: 'deflate' as unknown as 'gzip' }) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('content-encoding-invalid');
  });
});
