import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

/**
 * RBF-signalling sequence. Used on every input that comes from a
 * `cat21wallet` signer AND on ALL cat inputs for transfer + offer
 * flows regardless of wallet — see the scope note below.
 *
 * Our own accelerate code path is required to preserve `lockTime=21`
 * through any RBF replacement (cat21-wallet HARD RULE #1), so
 * signalling RBF is safe AND useful: users bump a stuck fee without
 * rebuilding the transaction.
 */
export const CAT21_WALLET_INPUT_SEQUENCE = 0xfffffffd;

/**
 * Non-RBF sequence. ONLY used on CAT-21 MINT inputs signed by a
 * third-party wallet (Xverse, Unisat, Leather, OKX, Oyl, Wizz,
 * Phantom, Alby, …). Locks their accelerate UI out of touching a
 * mint tx — the 2024 Xverse incident defence: a third-party wallet's
 * fee-bump flow would build a replacement without `lockTime=21`,
 * burning the not-yet-confirmed mint.
 *
 * Transfers, offers, and any other post-mint cat-flow do NOT use
 * this value — the cat is already on chain, so the worst
 * third-party-RBF outcome is a missed bonus mint, not a cat loss.
 */
export const CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE = 0xfffffffe;

/**
 * MINT-ONLY sequence resolver — do NOT call from transfer / offer /
 * any other cat-flow builder. Every cat-flow builder except mint
 * uses `CAT21_WALLET_INPUT_SEQUENCE` (RBF-on) unconditionally.
 *
 * The mint case is special because the not-yet-confirmed mint tx
 * carries the `lockTime=21` protocol marker — an RBF replacement
 * built by a third-party wallet's accelerate UI would DROP the
 * marker (that wallet doesn't know about cats). Every other
 * cat-touching tx runs against a cat that's already on chain; a
 * marker-less RBF replacement there only loses a bonus mint. That's
 * "user's pity" territory (see workspace CLAUDE.md), NOT a fund
 * loss, so we don't degrade the RBF UX for third-party sellers /
 * transferers to prevent it.
 *
 * The SDK's CAT-21 RBF-policy HARD RULE is enforced at exactly ONE
 * place: this function. Renaming it away from the generic
 * `resolveCat21InputSequence` is deliberate — the old name was a
 * footgun; transfer + offer got wired to it and the RBF-off leak
 * only surfaced in the 2026-07-25 code review (finding #8).
 */
export function resolveCat21MintInputSequence(walletType: KnownOrdinalWalletType): number {
  return walletType === KnownOrdinalWalletType.cat21wallet
    ? CAT21_WALLET_INPUT_SEQUENCE
    : CAT21_OTHER_WALLET_MINT_INPUT_SEQUENCE;
}
