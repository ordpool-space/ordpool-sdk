/**
 * Is this the SAME connected wallet, for the purposes of reloading state?
 *
 * A wallet stream re-emits. `WalletService`'s subject pushes the same wallet
 * again on every `onAccountChange`, and Xverse and cat21-wallet fire that
 * repeatedly on regtest. A consumer binding that stream straight to an
 * orchestrator's `setWallet` therefore re-runs the whole load for a wallet that
 * did not change, which drops the orchestrator back through `loading-utxos`
 * and tears any control gated on that state out of the DOM for a frame. A click
 * landing in that frame is lost, and the symptom is an approval popup that
 * never appears.
 *
 * Compares the FULL identity rather than one address: a wallet can change the
 * address a flow does not key on while changing the one it does, and comparing
 * a single field silently treats that as the same wallet.
 */
export interface WalletIdentityFields {
  type?: unknown;
  ordinalsAddress?: string;
  paymentAddress?: string;
  paymentPublicKey?: string;
}

export function walletIdentity(w: WalletIdentityFields | null | undefined): string {
  if (!w) return '';
  // JSON rather than a joined string: a separator that can occur inside a field
  // makes two different tuples collide, and while no bech32 or base58 address
  // contains one, an identity comparison should not rest on the charset of its
  // inputs.
  return JSON.stringify([w.type ?? '', w.ordinalsAddress ?? '', w.paymentAddress ?? '', w.paymentPublicKey ?? '']);
}

/** True when the two describe the same connected wallet. */
export function sameWallet(
  a: WalletIdentityFields | null | undefined,
  b: WalletIdentityFields | null | undefined,
): boolean {
  return walletIdentity(a) === walletIdentity(b);
}
