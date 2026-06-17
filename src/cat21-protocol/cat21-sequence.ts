import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

/**
 * RBF-signalling. Used by every CAT-21 tx Cat21 Wallet builds (mint,
 * transfer, and any future cat-flow). Our own accelerate code path is
 * required to preserve `lockTime=21` through any RBF replacement
 * (cat21-wallet HARD RULE #1), so signalling RBF is safe AND useful —
 * users can bump a stuck fee without rebuilding the transaction.
 */
export const CAT21_WALLET_INPUT_SEQUENCE = 0xfffffffd;

/**
 * Non-RBF. Used for every CAT-21 mint signed by a third-party wallet
 * (Xverse, Unisat, Leather, OKX, Oyl, Wizz, Phantom, Alby, …). Locks
 * their accelerate UI out of touching the marker — the 2024 Xverse
 * incident defence. (Note: only the MINT path applies this gate;
 * transfers and offers allow RBF for everyone, since cats are
 * immutable once on chain and the worst third-party-RBF outcome is a
 * missed bonus mint, not a cat loss.)
 */
export const CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE = 0xfffffffe;

/**
 * Single source of truth for the per-wallet input sequence on any
 * cat-touching tx OUR code builds. The mint, transfer, and any future
 * cat-flow builder MUST import this helper, NEVER re-implement the
 * ternary. The SDK CLAUDE.md "CAT-21 mints — RBF policy (per-wallet)"
 * rule is enforced at exactly ONE place: this function.
 *
 * The value `21` (lockTime) has no consensus meaning — block 21 was
 * mined in 2009, so the constraint is trivially satisfied no matter
 * when the tx lands. The field is repurposed as protocol-marker data
 * that cat21-ord reads structurally. The sequence choice gates which
 * wallets' fee-bump UI fires on the broadcast tx; that's the real
 * protection axis.
 */
export function resolveCat21InputSequence(walletType: KnownOrdinalWalletType): number {
  return walletType === KnownOrdinalWalletType.cat21wallet
    ? CAT21_WALLET_INPUT_SEQUENCE
    : CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE;
}
