import { defer, from, map, Observable } from 'rxjs';

import { SignMessageResult } from '../wallet.service.types';

/**
 * Wrap a wallet-specific `signMessage`-RPC Promise into the
 * SignMessage Observable contract. All five real signMessage impls
 * (cat21wallet, leather, xverse, unisat, okx) share this exact
 * shape: `defer` for lazy invocation → `from` to lift the Promise →
 * `map` to the `{signature}` envelope. Centralising here means
 * changing the observable strategy is one edit, not five.
 */
export function wrapSignMessage(
  callWallet: () => Promise<string>,
): Observable<SignMessageResult> {
  return defer(() => from(callWallet())).pipe(map((signature) => ({ signature })));
}
