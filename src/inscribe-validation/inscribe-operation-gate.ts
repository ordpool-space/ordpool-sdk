/**
 * Inscribe operation validation gate. Parallel to
 * `validateCat21Operation` from `cat21-validation/`, separate by
 * design (different protocol, different consumer set). See the
 * types file for the full rationale.
 */

import * as btc from '@scure/btc-signer';

import { Network } from '../network';

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
  if (!recipient.ok) return recipient.result;

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
  if (!fee.ok) return fee.result;

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
      const blockedLower = config.blockedContentTypes.map(s => s.toLowerCase().trim());
      if (blockedLower.includes(normalisedContentType)) {
        return reject('content-type-blocked', intent.contentType);
      }
    }
    if (config.allowedContentTypes && config.allowedContentTypes.length > 0) {
      const allowedLower = config.allowedContentTypes.map(s => s.toLowerCase().trim());
      if (!allowedLower.includes(normalisedContentType)) {
        return reject('content-type-not-allowed', intent.contentType);
      }
    }
  }

  return success({
    kind: 'inscribe',
    recipientScript: recipient.script,
    contentBytes: intent.body,
    contentType: normalisedContentType,
  });
}

/**
 * 350 KB default cap on inscription body bytes. Phase-1 hard
 * ceiling — keeps the reveal tx under the ~400 kWU standard relay
 * cap. Override via `config.maxContentBytes`.
 */
const DEFAULT_MAX_CONTENT_BYTES = 350_000;

/* ──────────────────────────  Helpers  ────────────────────────── */

function validateAddress(
  address: unknown,
  config: InscribeOperationGateConfig,
):
  | { ok: true; script: Uint8Array }
  | { ok: false; result: InscribeOperationGateResult } {
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
): { ok: true } | { ok: false; result: InscribeOperationGateResult } {
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

function addressesEquivalent(
  a: string,
  b: string,
  network: typeof btc.NETWORK,
): boolean {
  if (a === b) return true;
  try {
    const da = btc.Address(network).decode(a);
    const db = btc.Address(network).decode(b);
    const sa = btc.OutScript.encode(da);
    const sb = btc.OutScript.encode(db);
    if (sa.length !== sb.length) return false;
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  } catch {
    return false;
  }
}

function allowlistContainsAddress(
  address: string,
  allowlist: ReadonlyArray<string>,
  network: typeof btc.NETWORK,
): boolean {
  for (const entry of allowlist) {
    if (addressesEquivalent(address, entry, network)) return true;
  }
  return false;
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

function toScureNetwork(n: Network): typeof btc.NETWORK {
  return n === Network.Mainnet ? btc.NETWORK : btc.TEST_NETWORK;
}
