import { BIP341_KEYPATH_SIGHASHES } from '../sighash.js';
import { KnownOrdinalWalletType, WalletSigner } from '../wallet.service.types.js';
import { makeUnisatFamilySigner, UnisatFamilyRpc } from './unisat-family-signer.helper.js';
import { unsupportedSignMessage } from './unsupported-sign-message.js';


/**
 * Binance Web3 Wallet — `window.binancew3w.bitcoin.signPsbt(hex,
 * {autoFinalized: false, toSignInputs: […]})`.
 *
 * Binance proxies `window.unisat` per its own docs, so it rides the shared
 * UniSat-family signer. Shape cross-checked against the LaserEyes
 * `binance.ts` provider (omnisat/lasereyes-mono) and
 * developers.binance.com/docs/binance-w3w/bitcoin-provider. It takes the row
 * address as-is (no regtest shim) and, like OKX, needs the BIP-341 key-path
 * whitelist on the funding input so a SIGHASH_DEFAULT Taproot input passes the
 * policy check.
 *
 * **Runtime status:** the shipped v1.17.2 binary does not inject
 * `window.binancew3w.bitcoin` (only wallet / ethereum / solana / tron / sui /
 * tonconnect), so this signer is unreachable on current installs.
 * Detect-by-signature in `binance.connector.ts` returns false, so the wallet
 * never surfaces in the picker and this code is not called. Ships as
 * potential-support; lights up automatically when Binance enables the
 * documented surface.
 */
export const binanceSigner: WalletSigner = makeUnisatFamilySigner({
  walletType: KnownOrdinalWalletType.binance,
  getProvider: () => (window as unknown as { binancew3w: { bitcoin: UnisatFamilyRpc } }).binancew3w.bitcoin,
  shimWalletAddress: false,
  firstInputSighashTypes: BIP341_KEYPATH_SIGHASHES,
  signMessage: unsupportedSignMessage('Binance'),
});
