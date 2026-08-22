/**
 * Inscribe operation validation gate. Parallel to
 * `validateCat21Operation` from `cat21-validation/`, separate by
 * design (different protocol, different consumer set). See the
 * types file for the full rationale.
 */

import * as btc from '@scure/btc-signer';

import { addressesEquivalent, allowlistContainsAddress } from '../cat21-script/address-format';
import { INSCRIBE_POSTAGE_SATS } from '../inscribe/inscription-commit.helper';
import { encodeParentInscriptionId } from '../inscribe/inscription-envelope';
import { Network, toScureNetwork } from '../network';

import {
  InscribeGateRejectReason,
  InscribeGateResources,
  InscribeIntent,
  InscribeOperation,
  InscribeOperationGateConfig,
  InscribeOperationGateResult,
} from './inscribe-operation-gate.types';

/* ──────────────────────────  Public entry  ────────────────────────── */

export function validateInscribeOperation(args: {
  config: InscribeOperationGateConfig;
  operation: InscribeOperation;
}): InscribeOperationGateResult {
  const { config, operation } = args;

  if (!isObject(operation) || typeof operation.kind !== 'string') {
    return reject('intent-not-an-object');
  }
  if (!isObject(operation.intent)) {
    return reject('intent-not-an-object');
  }

  switch (operation.kind) {
    case 'inscribe':
      return validateInscribe(operation.intent, config);
    default: {
      const _exhaust: never = operation.kind;
      return reject('unsupported-operation-kind', safeStringify(_exhaust));
    }
  }
}

/* ──────────────────────────  Per-operation  ────────────────────────── */

function validateInscribe(
  intent: InscribeIntent,
  config: InscribeOperationGateConfig,
): InscribeOperationGateResult {
  // Recipient.
  const recipient = validateAddress(intent.recipient, config);
  if (recipient.ok === false) return recipient.result;

  const targetNet = toScureNetwork(config.network);
  if (config.allowedRecipients && config.allowedRecipients.length > 0) {
    if (!allowlistContainsAddress(intent.recipient, config.allowedRecipients, targetNet)) {
      return reject('recipient-not-allowed', intent.recipient);
    }
  }
  if (
    config.ownPaymentAddress &&
    addressesEquivalent(intent.recipient, config.ownPaymentAddress, targetNet)
  ) {
    return reject('self-send', intent.recipient);
  }

  // Fee rate.
  const fee = validateFeeRate(intent.feeRate, config);
  if (fee.ok === false) return fee.result;

  // Content body.
  if (!ArrayBuffer.isView(intent.body) || intent.body.constructor.name !== 'Uint8Array') {
    return reject('content-not-bytes', safeStringify(typeof intent.body));
  }
  const cap = config.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  if (intent.body.length > cap) {
    return reject('content-too-large', `body=${intent.body.length} cap=${cap}`);
  }

  // Content type — optional, validated when present.
  let normalisedContentType: string | undefined;
  if (intent.contentType !== undefined) {
    if (typeof intent.contentType !== 'string') {
      return reject('content-type-not-string', safeStringify(typeof intent.contentType));
    }
    normalisedContentType = intent.contentType.toLowerCase().trim();
    // Defensive blocklist runs FIRST. A misconfigured allowlist that
    // accidentally permits `application/javascript` (a JS XSS vector
    // inside inscribed HTML) still loses to the blocklist.
    if (config.blockedContentTypes && config.blockedContentTypes.length > 0) {
      if (config.blockedContentTypes.some(s => s.toLowerCase().trim() === normalisedContentType)) {
        return reject('content-type-blocked', intent.contentType);
      }
    }
    if (config.allowedContentTypes && config.allowedContentTypes.length > 0) {
      if (!config.allowedContentTypes.some(s => s.toLowerCase().trim() === normalisedContentType)) {
        return reject('content-type-not-allowed', intent.contentType);
      }
    }
  }

  // Tip — optional, validated when present.
  let tipResource: { address: string; tipScript: Uint8Array; tipValueSats: number } | undefined;
  if (intent.tip !== undefined) {
    const tipResult = validateTip(intent.tip, config);
    if (tipResult.ok === false) return tipResult.result;
    tipResource = tipResult.resource;
  }

  // Note — optional, validated when present.
  let noteBytes: Uint8Array | undefined;
  if (intent.note !== undefined) {
    if (typeof intent.note !== 'string') {
      return reject('note-not-a-string', safeStringify(typeof intent.note));
    }
    const encoded = new TextEncoder().encode(intent.note);
    const noteCap = config.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES;
    if (encoded.length > noteCap) {
      return reject('note-too-large', `note=${encoded.length} cap=${noteCap}`);
    }
    noteBytes = encoded;
  }

  // Parent inscription id — optional, encoder throws on bad input.
  let parentBytes: Uint8Array | undefined;
  if (intent.parent !== undefined) {
    try {
      parentBytes = encodeParentInscriptionId(intent.parent);
    } catch (e) {
      return reject('parent-malformed', e instanceof Error ? e.message : String(e));
    }
  }

  // Content encoding — only 'br' is supported.
  let contentEncoding: 'br' | undefined;
  if (intent.contentEncoding !== undefined) {
    if (intent.contentEncoding !== 'br') {
      return reject('content-encoding-invalid', safeStringify(intent.contentEncoding));
    }
    contentEncoding = 'br';
  }

  return success({
    kind: 'inscribe',
    recipientScript: recipient.script,
    contentBytes: intent.body,
    contentType: normalisedContentType,
    tip: tipResource,
    noteBytes,
    parentBytes,
    contentEncoding,
  });
}

/**
 * Validate the optional reveal-tx tip output.
 *
 * A tip is either absent OR fully valid — no partial passes. `value=0`
 * is allowed as a no-op (matches the reveal builder's zero-skip
 * sentinel); the resource is only produced when `value > 0`.
 */
function validateTip(
  tip: unknown,
  config: InscribeOperationGateConfig,
): HelperResult<{ resource: { address: string; tipScript: Uint8Array; tipValueSats: number } | undefined }> {
  if (!isObject(tip)) {
    return { ok: false, result: reject('tip-not-an-object', safeStringify(typeof tip)) };
  }
  const t = tip as { address?: unknown; value?: unknown };

  // Value first — cheaper to reject.
  if (typeof t.value !== 'number' || !Number.isFinite(t.value)) {
    return { ok: false, result: reject('tip-value-not-finite-number', safeStringify(t.value)) };
  }
  if (!Number.isInteger(t.value)) {
    return { ok: false, result: reject('tip-value-not-integer', safeStringify(t.value)) };
  }
  if (t.value < 0) {
    return { ok: false, result: reject('tip-value-negative', String(t.value)) };
  }
  if (t.value === 0) {
    // Documented no-op: the reveal builder skips the output for value=0.
    // We still require the address to be well-formed so a policy allowlist
    // can't be bypassed by "just send 0".
  }
  if (t.value > 0 && t.value < INSCRIBE_POSTAGE_SATS) {
    return { ok: false, result: reject('tip-value-below-dust', `value=${t.value} dust=${INSCRIBE_POSTAGE_SATS}`) };
  }
  if (config.maxTipValueSats != null && t.value > config.maxTipValueSats) {
    return { ok: false, result: reject('tip-value-above-cap', `${t.value} > ${config.maxTipValueSats}`) };
  }

  // Address validation runs even at value=0 so an allowlist bypass isn't possible.
  if (typeof t.address !== 'string' || t.address.length === 0) {
    return { ok: false, result: reject('tip-address-not-a-bitcoin-address', safeStringify(t.address)) };
  }
  const scureTarget = toScureNetwork(config.network);
  let tipScript: Uint8Array;
  try {
    const decoded = btc.Address(scureTarget).decode(t.address);
    tipScript = btc.OutScript.encode(decoded);
  } catch {
    const otherNet = config.network === Network.Mainnet ? btc.TEST_NETWORK : btc.NETWORK;
    try {
      btc.Address(otherNet).decode(t.address);
      return { ok: false, result: reject('tip-address-wrong-network', t.address) };
    } catch {
      return { ok: false, result: reject('tip-address-not-a-bitcoin-address', t.address) };
    }
  }
  if (config.allowedTipAddresses && config.allowedTipAddresses.length > 0) {
    if (!allowlistContainsAddress(t.address, config.allowedTipAddresses, scureTarget)) {
      return { ok: false, result: reject('tip-address-not-allowed', t.address) };
    }
  }

  return {
    ok: true,
    resource: t.value > 0 ? { address: t.address, tipScript, tipValueSats: t.value } : undefined,
  };
}

/** Default note cap (bytes). 128 is enough for "inscribed via ordpool.space" + a URL. */
const DEFAULT_MAX_NOTE_BYTES = 128;

/**
 * 350 KB default cap on inscription body bytes. Phase-1 hard
 * ceiling — keeps the reveal tx under the ~400 kWU standard relay
 * cap. Override via `config.maxContentBytes`.
 */
const DEFAULT_MAX_CONTENT_BYTES = 350_000;

/* ──────────────────────────  Helpers  ────────────────────────── */

/**
 * Internal helper return shape. Success carries the pre-decoded
 * value; failure carries the public gate result. Callers narrow via
 * `if (x.ok === false) return x.result;` — explicit `=== false` is
 * used because the caller's outer `InscribeOperationGateResult`
 * union also has an `ok: true` variant, and truthy-narrowing on
 * plain `!x.ok` fails to discriminate under Angular's strict
 * tsconfig.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type HelperResult<S = {}> = ({ ok: true } & S) | { ok: false; result: InscribeOperationGateResult };

function validateAddress(
  address: unknown,
  config: InscribeOperationGateConfig,
): HelperResult<{ script: Uint8Array }> {
  if (typeof address !== 'string' || address.length === 0) {
    return { ok: false, result: reject('recipient-not-a-bitcoin-address', safeStringify(address)) };
  }
  const targetNet = toScureNetwork(config.network);
  try {
    const decoded = btc.Address(targetNet).decode(address);
    const script = btc.OutScript.encode(decoded);
    return { ok: true, script };
  } catch {
    const otherNet = config.network === Network.Mainnet ? btc.TEST_NETWORK : btc.NETWORK;
    try {
      btc.Address(otherNet).decode(address);
      return { ok: false, result: reject('recipient-wrong-network', address) };
    } catch {
      return { ok: false, result: reject('recipient-not-a-bitcoin-address', address) };
    }
  }
}

function validateFeeRate(
  feeRate: unknown,
  config: InscribeOperationGateConfig,
): HelperResult {
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate)) {
    return { ok: false, result: reject('fee-rate-not-finite-number', safeStringify(feeRate)) };
  }
  if (!Number.isInteger(feeRate)) {
    return { ok: false, result: reject('fee-rate-not-integer', safeStringify(feeRate)) };
  }
  if (feeRate <= 0) {
    return { ok: false, result: reject('fee-rate-not-positive', safeStringify(feeRate)) };
  }
  if (config.maxFeeRatePerVbyte != null && feeRate > config.maxFeeRatePerVbyte) {
    return {
      ok: false,
      result: reject('fee-rate-above-cap', `${feeRate} > ${config.maxFeeRatePerVbyte}`),
    };
  }
  return { ok: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function reject(
  reason: InscribeGateRejectReason,
  detail?: string,
): InscribeOperationGateResult {
  return { ok: false, reason, detail };
}

function success(resources: InscribeGateResources): InscribeOperationGateResult {
  return { ok: true, resources };
}
