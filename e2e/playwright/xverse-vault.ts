/**
 * Variant mutators for the Xverse matrix specs.
 *
 * `applyXverseVariant(context, variant)` — given a Playwright
 * BrowserContext launched against an already-onboarded seed dir,
 * mutate `persistentStore::networks.value.active.bitcoin` and
 * `persist:walletState.btcPaymentAddressType` to pick a specific
 * Network × Payment-Address-Type combination. Used by the matrix
 * specs to exercise every Xverse combo against the same baseline
 * wallet without re-onboarding.
 *
 * The seeded user-data-dir is produced by `global-setup.ts` (which
 * drives the full Xverse onboarding click-through once per CI run);
 * matrix specs clone it and call `applyXverseVariant` to set up
 * each variant in <1s.
 *
 * Historical note: an earlier attempt synthesized the four
 * `vault::*` chrome.storage.local keys deterministically from the
 * seed + password (encryption was verified end-to-end). It was
 * abandoned because Xverse's runtime state — account list, redux
 * stores, per-network auth tokens — derives from React side
 * effects we'd have to replicate too. The dashboard hangs on a
 * loading spinner without that runtime state. The git log around
 * 2026-05-13 has the full investigation (xverse-vault-brute*.mjs).
 * Snapshot+replay via global-setup remained the working path.
 */

/** Xverse's built-in Bitcoin network IDs (see persistentStore::networks). */
export type XverseBitcoinNetworkId =
  | 'bitcoin-mainnet'
  | 'bitcoin-testnet4'
  | 'bitcoin-signet'
  | 'bitcoin-regtest';

/**
 * Which of the three btcAddresses the wallet exposes as the
 * Payment purpose via sats-connect. Xverse v2 default is `native`;
 * `nested` was v1's default and is selectable in Preferred Address
 * Type. `taproot` exists in the storage but Xverse never exposes
 * it as payment — only ordinals — so we don't expose it as a
 * variant option.
 */
export type XverseBtcPaymentAddressType = 'native' | 'nested';

export interface XverseVariant {
  network: XverseBitcoinNetworkId;
  paymentType: XverseBtcPaymentAddressType;
}

/**
 * Apply a variant to a freshly-launched Xverse BrowserContext via
 * direct chrome.storage writes from the MV3 service worker. No
 * popup, no unlock, no UI click — and crucially no React app boot,
 * so redux-persist doesn't get a chance to rehydrate-then-overwrite
 * our values.
 *
 * Three keys, all read-modify-write:
 *  - `persistentStore::networks.value.active.bitcoin` — active net
 *  - `persistentStore::activeAccount.value.btcPaymentAddressType` —
 *    v2 schema, what `getAddresses` honors
 *  - `persist:walletState.btcPaymentAddressType` — legacy redux store,
 *    JSON-stringified per-key (redux-persist's reducer-level
 *    serialization). Kept in sync so the popup UI shows the right
 *    tile as selected.
 *
 * Caller contract: invoke immediately after `launchPersistentContext`
 * + service-worker readiness. The popup MUST NOT have been opened
 * yet; opening it boots redux-persist which then debounce-saves over
 * any later writes.
 */
interface PlaywrightWorkerLike {
  evaluate: <T, A>(fn: (a: A) => Promise<T> | T, arg: A) => Promise<T>;
  url: () => string;
}
interface PlaywrightContextLike {
  serviceWorkers: () => readonly PlaywrightWorkerLike[];
  waitForEvent: (event: 'serviceworker', opts?: { timeout?: number }) => Promise<PlaywrightWorkerLike>;
}

export async function applyXverseVariant(
  context: PlaywrightContextLike,
  variant: XverseVariant,
): Promise<{ phase1Legacy: string; storageKeys: string[] }> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });

  const diag = await worker.evaluate(async ({ network, paymentType }) => {
    type ChromeBridge = {
      chrome: {
        storage: { local: {
          get: (k: string | string[], cb: (v: Record<string, string | undefined>) => void) => void;
          set: (d: Record<string, string>, cb: () => void) => void;
        }};
        runtime: { lastError?: { message: string } };
      };
    };
    const c = (globalThis as unknown as ChromeBridge).chrome;
    const get = (key: string) => new Promise<string | undefined>((r) =>
      c.storage.local.get(key, (v) => r(v[key])));
    const set = (data: Record<string, string>) => new Promise<void>((r, j) =>
      c.storage.local.set(data, () => {
        if (c.runtime.lastError) j(new Error(c.runtime.lastError.message)); else r();
      }));

    const networksRaw = await get('persistentStore::networks');
    if (!networksRaw) throw new Error('persistentStore::networks missing from chrome.storage.local');
    const networks = JSON.parse(networksRaw) as {
      value: { active: { bitcoin: string; [k: string]: string } };
      version: number;
    };
    networks.value.active.bitcoin = network;
    await set({ 'persistentStore::networks': JSON.stringify(networks) });

    // v2 zustand active-account store. This is the SOT — Xverse's
    // boot init reads it; if missing it falls back to its hard-coded
    // defaultValue (btcPaymentAddressType: 'native') and syncs that
    // into walletState, clobbering anything we write to walletState
    // alone. So we UPSERT — create the key with the bundle's exact
    // default schema (verified by reverse-engineering popup.js v2.3.2:
    // {selectedAccountIndex:0, selectedAccountType:"software",
    // selectedWalletId: undefined, btcPaymentAddressType:"native"})
    // — with our override applied.
    const accRaw = await get('persistentStore::activeAccount');
    const acc = accRaw
      ? JSON.parse(accRaw) as { value: { btcPaymentAddressType: string; [k: string]: unknown }; version?: number }
      : { value: { selectedAccountIndex: 0, selectedAccountType: 'software', btcPaymentAddressType: 'native' as string }, version: 0 };
    acc.value.btcPaymentAddressType = paymentType;
    await set({ 'persistentStore::activeAccount': JSON.stringify(acc) });

    const stateRaw = await get('persist:walletState');
    if (!stateRaw) throw new Error('persist:walletState missing from chrome.storage.local');
    const state = JSON.parse(stateRaw) as Record<string, string>;
    state.btcPaymentAddressType = JSON.stringify(paymentType);
    await set({ 'persist:walletState': JSON.stringify(state) });

    // Read-back diagnostic + key list — must happen before the
    // reload below, otherwise the SW handle goes invalid.
    const allKeys = await new Promise<string[]>((r) =>
      (globalThis as unknown as { chrome: { storage: { local: { get: (k: null, cb: (v: Record<string, unknown>) => void) => void } } } })
        .chrome.storage.local.get(null, (v) => r(Object.keys(v))),
    );
    const verifyRaw = await get('persist:walletState');
    let phase1Legacy = '<no walletState>';
    if (verifyRaw) {
      const s = JSON.parse(verifyRaw) as Record<string, string>;
      phase1Legacy = s.btcPaymentAddressType ? JSON.parse(s.btcPaymentAddressType) : '<no btcPaymentAddressType>';
    }

    // Force the SW to restart so its in-memory redux store can't
    // flush stale defaults over our leveldb writes during shutdown.
    // chrome.runtime.reload() unloads and reloads the extension;
    // on reload, the new SW rehydrates from leveldb (our values)
    // rather than continuing with whatever in-memory state was
    // there at our write time.
    const reloadFn = (globalThis as unknown as { chrome: { runtime: { reload: () => void } } }).chrome.runtime.reload;
    reloadFn();
    return { phase1Legacy, storageKeys: allKeys.filter(k => /account|wallet|address|persist/i.test(k)).sort() };
  }, variant);
  // The worker that ran chrome.runtime.reload() is dead. We don't
  // explicitly wait for the new SW here — the next consumer's
  // operation (e.g. waitForChromeStorageKey) re-fetches the worker
  // each iteration and naturally rides out the restart by retrying
  // its evaluate() on "target closed".
  return diag;
}

/**
 * Convenience: every combination of (4 networks × 2 payment types)
 * the matrix specs exercise. The mainnet+nested combo is exactly
 * the Xverse v1 default that worked before this session's bug
 * fix; including it confirms backward compatibility wasn't broken.
 */
export const XVERSE_MATRIX: ReadonlyArray<XverseVariant> = Object.freeze([
  { network: 'bitcoin-mainnet',  paymentType: 'native' },
  { network: 'bitcoin-mainnet',  paymentType: 'nested' },
  { network: 'bitcoin-testnet4', paymentType: 'native' },
  { network: 'bitcoin-testnet4', paymentType: 'nested' },
  { network: 'bitcoin-signet',   paymentType: 'native' },
  { network: 'bitcoin-signet',   paymentType: 'nested' },
  { network: 'bitcoin-regtest',  paymentType: 'native' },
  { network: 'bitcoin-regtest',  paymentType: 'nested' },
]);
