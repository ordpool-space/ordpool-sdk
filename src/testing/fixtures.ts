import * as btc from '@scure/btc-signer';

import { KnownOrdinalWalletType, WalletInfo } from '../wallet/wallet.service.types';

/**
 * Shared wallet fixture builder for SDK Jest specs. Default is a
 * cat21wallet with a well-known taproot ordinals address, matching
 * pubkeys, and a placeholder P2WPKH payment address. Callers pass
 * `over` to specialise (wallet type, real derived addresses, etc.).
 *
 * The default `paymentAddress` (`bc1qexample`) is deliberately
 * placeholder — specs that build real PSBTs must supply a derived
 * address from a real pubkey. Specs that only test state machine
 * transitions can use the default as-is.
 */
export function makeWallet(over: Partial<WalletInfo> = {}): WalletInfo {
  return {
    type: KnownOrdinalWalletType.cat21wallet,
    ordinalsAddress: 'bc1ptrrx4duc8afs4ye63xgcyf6d7kg29a4myay4nqxmd04zx8j9jers899d0x',
    ordinalsPublicKey: '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37',
    paymentAddress: 'bc1qexample',
    paymentPublicKey: '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b',
    signingSupported: true,
    ...over,
  };
}

/**
 * Convenience wrapper: same shape as `makeWallet` but flips the default
 * `type` to `xverse`. Mint / inscribe specs use this because their
 * signer path is the xverse adapter, not cat21wallet's.
 */
export function makeXverseWallet(over: Partial<WalletInfo> = {}): WalletInfo {
  return makeWallet({ type: KnownOrdinalWalletType.xverse, ...over });
}

/**
 * Attach a dummy buyer signature to a PSBT so the buy-offer validator's
 * "buyer-input-unsigned" gate doesn't fire on a synthetic test PSBT.
 * The 71-byte fill is a stand-in for a real ECDSA signature; the
 * validator only checks presence, not verifiability.
 *
 * `inputIndex` defaults to 1 (the buyer's first funding input in
 * the standard offer shape). Pass a different index if the fixture
 * uses a non-standard input layout.
 */
export function attachDummyBuyerSig(
  psbtBytes: Uint8Array,
  buyerPublicKey: Uint8Array,
  inputIndex = 1,
): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbtBytes);
  tx.updateInput(inputIndex, { partialSig: [[buyerPublicKey, new Uint8Array(71).fill(1)]] });
  return tx.toPSBT();
}
