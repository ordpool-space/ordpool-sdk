/**
 * Bulletproof validation gate for the four cat21 mutating operations.
 *
 * Single entry: `validateCat21Operation({ config, operation })`.
 *
 * Failure mode is a typed discriminated union — no exceptions, no
 * phantom `Validated<I>` brand. The success branch hands back
 * pre-decoded resources (scriptPubKey, parsed catId pieces) so
 * downstream code never re-decodes.
 *
 * Spec coverage is exhaustive: every member of `Cat21GateRejectReason`
 * has a dedicated test in `cat21-operation-gate.spec.ts`.
 */

import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { addressesEquivalent, allowlistContainsAddress } from '../cat21-script/address-format';
import { Network, toScureNetwork } from '../network';

import type {
  Cat21AcceptOfferIntent,
  Cat21BuyIntent,
  Cat21CreateOfferIntent,
  Cat21GateRejectReason,
  Cat21GateResources,
  Cat21MintIntent,
  Cat21Operation,
  Cat21OperationGateConfig,
  Cat21OperationGateResult,
  Cat21TransferIntent,
} from './cat21-operation-gate.types';

/* ──────────────────────────  Public entry  ────────────────────────── */

export function validateCat21Operation(args: {
  config: Cat21OperationGateConfig;
  operation: Cat21Operation;
}): Cat21OperationGateResult {
  const { config, operation } = args;

  if (!isObject(operation) || typeof operation.kind !== 'string') {
    return reject('intent-not-an-object');
  }
  if (!isObject(operation.intent)) {
    return reject('intent-not-an-object');
  }

  // Operation-kind allowlist runs BEFORE per-operation validation so
  // a wallet-configured "mint only" agent's transfer attempt fails
  // closed without exposing per-transfer field-level reasons (which
  // a curious agent could probe for capability-leak info).
  if (
    Array.isArray(config.allowedOperations) &&
    config.allowedOperations.length > 0 &&
    !config.allowedOperations.includes(
      operation.kind as 'mint' | 'transfer' | 'create_offer' | 'accept_offer' | 'buy',
    )
  ) {
    return reject('operation-kind-not-allowed', operation.kind);
  }

  switch (operation.kind) {
    case 'mint':
      return validateMint(operation.intent, config);
    case 'transfer':
      return validateTransfer(operation.intent, config);
    case 'create_offer':
      return validateCreateOffer(operation.intent, config);
    case 'accept_offer':
      return validateAcceptOffer(operation.intent, config);
    case 'buy':
      return validateBuy(operation.intent, config);
    default: {
      // Exhaustiveness: any new `kind` member trips a TS error here
      // BEFORE it reaches the runtime check.
      const _exhaustive: never = operation;
      void _exhaustive;
      return reject('unsupported-operation-kind', safeStringify((operation as { kind: unknown }).kind));
    }
  }
}

/* ──────────────────────────  Per-operation  ────────────────────────── */

function validateMint(
  intent: Cat21MintIntent,
  config: Cat21OperationGateConfig,
): Cat21OperationGateResult {
  const recipient = validateAddress(intent.recipient, config, 'recipient');
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

  const fee = validateFeeRate(intent.feeRate, config);
  if (!fee.ok) return fee.result;

  let tipScript: Uint8Array | undefined;
  if (intent.tip != null) {
    const tipResult = validateTip(intent.tip, config);
    if (!tipResult.ok) return tipResult.result;
    tipScript = tipResult.script;
  }

  return success({ kind: 'mint', recipientScript: recipient.script, tipScript });
}

function validateTransfer(
  intent: Cat21TransferIntent,
  config: Cat21OperationGateConfig,
): Cat21OperationGateResult {
  const cat = parseCatId(intent.catId);
  if (!cat.ok) return reject('cat-id-malformed', intent.catId);

  const recipient = validateAddress(intent.recipient, config, 'recipient');
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

  const fee = validateFeeRate(intent.feeRate, config);
  if (!fee.ok) return fee.result;

  return success({
    kind: 'transfer',
    recipientScript: recipient.script,
    catTxid: cat.txid,
    catIndex: cat.index,
  });
}

function validateCreateOffer(
  intent: Cat21CreateOfferIntent,
  config: Cat21OperationGateConfig,
): Cat21OperationGateResult {
  const cat = parseCatId(intent.catId);
  if (!cat.ok) return reject('cat-id-malformed', intent.catId);

  const price = validatePrice(intent.priceSats, config);
  if (!price.ok) return price.result;

  const payment = validateAddress(intent.paymentAddress, config, 'payment-address');
  if (!payment.ok) return payment.result;

  if (config.allowedCounterparties && config.allowedCounterparties.length > 0) {
    const targetNet = toScureNetwork(config.network);
    if (!allowlistContainsAddress(intent.paymentAddress, config.allowedCounterparties, targetNet)) {
      return reject('payment-address-not-allowed', intent.paymentAddress);
    }
  }

  return success({
    kind: 'create_offer',
    paymentScript: payment.script,
    catTxid: cat.txid,
    catIndex: cat.index,
  });
}

function validateBuy(
  intent: Cat21BuyIntent,
  config: Cat21OperationGateConfig,
): Cat21OperationGateResult {
  const cat = parseCatId(intent.catId);
  if (!cat.ok) return reject('cat-id-malformed', intent.catId);

  // bidSats is the buyer's outflow to the seller; reuse the same
  // price validation (positive, under maxPriceSats) as create-offer.
  const price = validatePrice(intent.bidSats, config);
  if (!price.ok) return price.result;

  const fee = validateFeeRate(intent.feeRate, config);
  if (!fee.ok) return fee.result;

  // sellerPaymentAddress comes from the listing (never an on-chain
  // lookup). Decode it against the active network; on an allowlisted
  // agent, it's the counterparty we'd pay.
  const payment = validateAddress(intent.sellerPaymentAddress, config, 'payment-address');
  if (!payment.ok) return payment.result;

  if (config.allowedCounterparties && config.allowedCounterparties.length > 0) {
    const targetNet = toScureNetwork(config.network);
    if (
      !allowlistContainsAddress(intent.sellerPaymentAddress, config.allowedCounterparties, targetNet)
    ) {
      return reject('payment-address-not-allowed', intent.sellerPaymentAddress);
    }
  }

  return success({
    kind: 'buy',
    sellerPaymentScript: payment.script,
    catTxid: cat.txid,
    catIndex: cat.index,
  });
}

function validateAcceptOffer(
  intent: Cat21AcceptOfferIntent,
  config: Cat21OperationGateConfig,
): Cat21OperationGateResult {
  const cat = parseCatId(intent.expectedCatId);
  if (!cat.ok) return reject('expected-cat-id-malformed', intent.expectedCatId);

  const priceCheck = validateExpectedPrice(intent.expectedPriceSats);
  if (!priceCheck.ok) return priceCheck.result;

  const utxoOk = isWellFormedUtxoRef(intent.expectedSellerUtxo);
  if (!utxoOk) {
    return reject(
      'expected-seller-utxo-malformed',
      JSON.stringify(intent.expectedSellerUtxo),
    );
  }

  if (
    typeof intent.offerPsbt === 'string' &&
    intent.offerPsbt.length > (config.maxOfferPsbtBytes ?? DEFAULT_MAX_OFFER_PSBT_BYTES) * 2
  ) {
    // Reject before base64-decoding when the raw string is already
    // larger than the cap × 2 (base64 expansion factor is ~4/3, but
    // hex is 2x; ×2 covers the worst case). DoS guard against an
    // agent flooding the wallet with a huge PSBT.
    return reject(
      'offer-psbt-too-large',
      `${intent.offerPsbt.length} chars > ${(config.maxOfferPsbtBytes ?? DEFAULT_MAX_OFFER_PSBT_BYTES) * 2}`,
    );
  }
  const psbtBytes = tryDecodePsbt(intent.offerPsbt);
  if (!psbtBytes) return reject('offer-psbt-malformed');
  if (!startsWithPsbtMagic(psbtBytes)) {
    return reject('offer-psbt-missing-magic-bytes');
  }
  const cap = config.maxOfferPsbtBytes ?? DEFAULT_MAX_OFFER_PSBT_BYTES;
  if (psbtBytes.length > cap) {
    return reject('offer-psbt-too-large', `${psbtBytes.length} > ${cap}`);
  }

  return success({
    kind: 'accept_offer',
    offerPsbtBytes: psbtBytes,
    catTxid: cat.txid,
    catIndex: cat.index,
  });
}

/**
 * 128 KiB default cap. Real CAT-21 buy offers are ~600 bytes; this
 * leaves comfortable headroom while still rejecting a 1 MB DoS blob.
 * Override via `config.maxOfferPsbtBytes`.
 */
const DEFAULT_MAX_OFFER_PSBT_BYTES = 128 * 1024;

const PSBT_MAGIC_BYTES = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]);
function startsWithPsbtMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PSBT_MAGIC_BYTES.length) return false;
  for (let i = 0; i < PSBT_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== PSBT_MAGIC_BYTES[i]) return false;
  }
  return true;
}

/* ──────────────────────────  Field validators  ────────────────────────── */

type AddressField = 'recipient' | 'tip-address' | 'payment-address';

function malformedReason(field: AddressField): Cat21GateRejectReason {
  return `${field}-not-a-bitcoin-address` as Cat21GateRejectReason;
}
function wrongNetworkReason(field: AddressField): Cat21GateRejectReason {
  return `${field}-wrong-network` as Cat21GateRejectReason;
}

function validateAddress(
  address: unknown,
  config: Cat21OperationGateConfig,
  field: AddressField,
):
  | { ok: true; script: Uint8Array }
  | { ok: false; result: Cat21OperationGateResult } {
  if (typeof address !== 'string' || address.length === 0) {
    return { ok: false, result: reject(malformedReason(field), safeStringify(address)) };
  }
  const targetNet = toScureNetwork(config.network);
  // Try the target network first; record whether the address parsed on
  // the OTHER network so the failure can be 'wrong-network' instead of
  // 'malformed' for an otherwise valid string.
  try {
    const decoded = btc.Address(targetNet).decode(address);
    const script = btc.OutScript.encode(decoded);
    return { ok: true, script };
  } catch {
    const otherNet = config.network === Network.Mainnet ? btc.TEST_NETWORK : btc.NETWORK;
    try {
      btc.Address(otherNet).decode(address);
      return { ok: false, result: reject(wrongNetworkReason(field), address) };
    } catch {
      return { ok: false, result: reject(malformedReason(field), address) };
    }
  }
}

function validateFeeRate(
  feeRate: unknown,
  config: Cat21OperationGateConfig,
): { ok: true } | { ok: false; result: Cat21OperationGateResult } {
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

function validateTip(
  tip: { address: unknown; value: unknown },
  config: Cat21OperationGateConfig,
):
  | { ok: true; script: Uint8Array | undefined }
  | { ok: false; result: Cat21OperationGateResult } {
  if (typeof tip.value !== 'number' || !Number.isFinite(tip.value)) {
    return { ok: false, result: reject('tip-value-not-finite-number', safeStringify(tip.value)) };
  }
  if (!Number.isInteger(tip.value)) {
    return { ok: false, result: reject('tip-value-not-integer', safeStringify(tip.value)) };
  }
  if (tip.value < 0) {
    return { ok: false, result: reject('tip-value-negative', safeStringify(tip.value)) };
  }
  const tipCap = config.maxTipValueSats ?? config.maxPriceSats;
  if (tipCap != null && tip.value > tipCap) {
    return { ok: false, result: reject('tip-value-above-cap', `${tip.value} > ${tipCap}`) };
  }
  if (tip.value === 0) {
    // Builder skips the output entirely. Address irrelevant.
    return { ok: true, script: undefined };
  }
  const tipAddr = validateAddress(tip.address, config, 'tip-address');
  if (!tipAddr.ok) return tipAddr;
  return { ok: true, script: tipAddr.script };
}

function validatePrice(
  priceSats: unknown,
  config: Cat21OperationGateConfig,
): { ok: true } | { ok: false; result: Cat21OperationGateResult } {
  if (typeof priceSats !== 'number' || !Number.isFinite(priceSats)) {
    return { ok: false, result: reject('price-not-finite-number', safeStringify(priceSats)) };
  }
  if (!Number.isInteger(priceSats)) {
    return { ok: false, result: reject('price-not-integer', safeStringify(priceSats)) };
  }
  if (priceSats <= 0) {
    return { ok: false, result: reject('price-not-positive', safeStringify(priceSats)) };
  }
  // No minimum-price floor. A cat sells for any positive price: the
  // seller's payout is `priceSats + sellerInputValue`, and the cat's own
  // UTXO value is already >= dust, so the payout clears dust for any
  // price >= 1. Stock ord imposes no amount floor either. The gate can't
  // see sellerInputValue anyway (the intent carries only the price), so a
  // price-only floor would be a blind, arbitrary proxy — do not re-add.
  if (config.maxPriceSats != null && priceSats > config.maxPriceSats) {
    return {
      ok: false,
      result: reject('price-above-cap', `${priceSats} > ${config.maxPriceSats}`),
    };
  }
  return { ok: true };
}

function validateExpectedPrice(
  expectedPriceSats: unknown,
): { ok: true } | { ok: false; result: Cat21OperationGateResult } {
  if (typeof expectedPriceSats !== 'number' || !Number.isFinite(expectedPriceSats)) {
    return {
      ok: false,
      result: reject('expected-price-not-finite-number', safeStringify(expectedPriceSats)),
    };
  }
  if (!Number.isInteger(expectedPriceSats)) {
    return { ok: false, result: reject('expected-price-not-integer', safeStringify(expectedPriceSats)) };
  }
  if (expectedPriceSats <= 0) {
    return { ok: false, result: reject('expected-price-not-positive', safeStringify(expectedPriceSats)) };
  }
  return { ok: true };
}

/* ──────────────────────────  Pure shape helpers  ────────────────────── */

const CAT_ID_RE = /^([0-9a-f]{64})i(\d+)$/;

function parseCatId(value: unknown):
  | { ok: true; txid: string; index: number }
  | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  const m = CAT_ID_RE.exec(value);
  if (!m) return { ok: false };
  const index = Number.parseInt(m[2], 10);
  // Reject an index that doesn't survive a parse→string round-trip:
  // beyond 2^53 `parseInt` rounds, so `catIndex` would silently differ
  // from the on-wire index. `String(index) === m[2]` also rejects the
  // (regex-excluded, but defensive) leading-zero form.
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== m[2]) {
    return { ok: false };
  }
  return { ok: true, txid: m[1], index };
}

const TXID_RE = /^[0-9a-f]{64}$/;

function isWellFormedUtxoRef(value: unknown): boolean {
  if (!isObject(value)) return false;
  const v = value as { txid?: unknown; vout?: unknown };
  if (typeof v.txid !== 'string' || !TXID_RE.test(v.txid)) return false;
  if (typeof v.vout !== 'number') return false;
  if (!Number.isInteger(v.vout) || v.vout < 0) return false;
  return true;
}

/**
 * Try both hex and base64 decoders; prefer the one whose bytes start
 * with the PSBT magic (`0x70 0x73 0x62 0x74 0xff`). Falls back to
 * the first successful decode when neither has the magic, so the
 * caller's magic check fires with the right reason.
 *
 * The two encodings share the lowercase a–f alphabet (base64
 * includes them, hex uses them), so a string like `70736274ff…`
 * is valid BOTH ways but only the hex result carries the PSBT
 * magic. Pick the one that does.
 */
function tryDecodePsbt(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const hexBytes = tryHex(value);
  if (hexBytes && startsWithPsbtMagic(hexBytes)) return hexBytes;
  const b64Bytes = tryBase64(value);
  if (b64Bytes && startsWithPsbtMagic(b64Bytes)) return b64Bytes;
  // Neither decoded result has the magic; return whichever decoded
  // at all so the caller's missing-magic check can fire instead of
  // a generic 'malformed'.
  return hexBytes ?? b64Bytes ?? undefined;
}

function tryHex(value: string): Uint8Array | undefined {
  try {
    const decoded = hex.decode(value);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryBase64(value: string): Uint8Array | undefined {
  try {
    const decoded = base64.decode(value);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stringify any input — including Symbol, BigInt, prototype-less
 * objects — without throwing. `String(Symbol())` throws TypeError;
 * `String.prototype.toString` on Object.create(null) throws too.
 * The detail field is debug telemetry only, so a "[Symbol]"
 * placeholder is more useful than a runtime crash.
 */
function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'bigint') return `${value}n`;
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function reject(
  reason: Cat21GateRejectReason,
  detail?: string,
): { ok: false; reason: Cat21GateRejectReason; detail?: string } {
  return detail != null ? { ok: false, reason, detail } : { ok: false, reason };
}

function success(resources: Cat21GateResources): Cat21OperationGateResult {
  return { ok: true, resources };
}
