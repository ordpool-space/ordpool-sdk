/**
 * Validation a SERVER can run, with no wallet-connector graph behind it.
 *
 * The `/core` barrel reaches the wallet connectors, so its import graph drags
 * `sats-connect`, which is a PEER dependency and is therefore absent from a
 * service that has no wallet UI. A backend importing `/core` for one validator
 * fails to resolve at require time, and the message names sats-connect rather
 * than the mistake, which is importing the broad entry for a narrow need.
 *
 * Everything re-exported here is reachable without that graph: the checks
 * themselves depend only on `@scure/btc-signer`, `@scure/base` and
 * `@noble/curves`. `verifyBip322Signature` lives under `src/wallet/` for
 * historical reasons and imports nothing from the connectors; the directory is
 * misleading, not the module.
 */
export * from './cat21-operation-gate.js';
export * from './cat21-operation-gate.types.js';

// The buy-offer validator a seller's backend runs before it signs anything.
export {
  validateCat21BuyOfferPsbt,
} from '../cat21-offer/cat21-offer.helper.js';

// Proof that a message came from the address that claims it. Crypto only.
export { verifyBip322Signature } from '../wallet/verify-bip322-signature.js';

// The ask ceiling a listing is checked against.
export { MAX_ASK_SATS } from '../cat21-listing/cat21-listing.types.js';
