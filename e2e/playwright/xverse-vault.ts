/**
 * Two responsibilities here:
 *
 * 1. `buildXverseVault(mnemonic, password)` — generate the four
 *    vault::* chrome.storage.local entries deterministically from a
 *    seed. Reverse-engineered crypto; verified via the roundtrip in
 *    scripts/xverse-vault-roundtrip.mjs. Produces vault::* keys
 *    that Xverse recognizes (Unlock screen renders with the
 *    password) but post-unlock state (account list, redux state,
 *    per-network auth tokens) isn't pre-populated, so the dashboard
 *    hangs on a loading spinner. Snapshot+replay (clone an already-
 *    onboarded chromium user-data-dir) remains the working path.
 *
 * 2. `applyXverseVariant(context, extensionId, variant)` — given a
 *    Playwright BrowserContext launched against an already-onboarded
 *    seed dir, mutate `persistentStore::networks.value.active.bitcoin`
 *    and `persist:walletState.btcPaymentAddressType` to pick a
 *    specific Network × Payment-Address-Type combination. Used by
 *    the matrix specs to exercise every Xverse combo against the
 *    same baseline wallet without re-onboarding.
 *
 * Build a complete chrome.storage.local snapshot for the Xverse
 * extension from just (mnemonic, password). The snapshot can be
 * injected with chrome.storage.local.set(...) in a Playwright spec
 * to skip the entire onboarding click-flow.
 *
 * Reverse-engineered from xverse v2.3.2's background.js. The
 * encryption pipeline (see scripts/xverse-vault-brute4.mjs for the
 * verification trail):
 *
 *   passwordHash = argon2id({
 *     pass: password,                   // utf-8 bytes
 *     salt: utf8(saltHexString),        // utf-8 OF THE HEX STRING, not raw bytes
 *     time: 3, mem: 65536, parallelism: 4,
 *     hashLen: 16, type: Argon2id
 *   }).hashHex                           // → 32-char hex string
 *
 *   aesKey = utf8(passwordHashHex)       // 32-byte AES-256 key from the hex string
 *
 *   blob = AES-256-GCM-encrypt(plaintext, aesKey, iv=random16)
 *   stored = hex(iv || ciphertext || gcmTag)
 *
 * The encryptionVault stores `{seedEncryptionKey, dataEncryptionKey}`
 * (each a 32-char hex string = 16-byte argon2id-derived sub-key) as
 * JSON. Each sub-key encrypts further blobs the same way.
 */

import { argon2id } from '@noble/hashes/argon2';
import * as crypto from 'node:crypto';

const ARGON2_PARAMS = { t: 3, m: 65536, p: 4, dkLen: 16 } as const;

const enc = new TextEncoder();

function randomBytes(n: number): Uint8Array {
  return crypto.randomBytes(n);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Derive the 16-byte argon2id hash, hex-encoded. This is the
 * "passwordHash" shape Xverse uses everywhere a string-keyed AES
 * operation needs a value.
 */
function deriveHashHex(password: string, saltHexString: string): string {
  const out = argon2id(password, enc.encode(saltHexString), ARGON2_PARAMS);
  return toHex(out);
}

/**
 * AES-256-GCM encrypt as Xverse does: utf-8-encode the hex-string
 * key to get the actual 32-byte AES key, prepend a random 16-byte
 * IV, return iv || ciphertext || gcmTag as hex.
 */
function aesGcmEncryptToHex(plaintext: string, keyHexString: string): string {
  const iv = randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', enc.encode(keyHexString), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('hex');
}

export interface XverseVaultBlob {
  /** chrome.storage.local entries that completely define an onboarded wallet. */
  'vault::version': string;
  'vault::passwordSalt': string;
  'vault::encryptionVault': string;
  'vault::seedVault': string;
}

/**
 * Build the four `vault::*` storage entries for a wallet with the
 * given mnemonic and password. The remaining storage keys
 * (`persistentStore::*`, `persist:*`) are derived by Xverse at
 * boot from the unlocked seed; they don't need to be pre-seeded
 * (Xverse rebuilds them on first unlock).
 */
export function buildXverseVault(mnemonic: string, password: string): XverseVaultBlob {
  // 32-byte salt for password derivation
  const passwordSaltBytes = randomBytes(32);
  const passwordSaltHex   = toHex(passwordSaltBytes);

  // Argon2id(password, utf8(saltHex)) → 16-byte hash, used as hex string
  const passwordHashHex   = deriveHashHex(password, passwordSaltHex);

  // The inner vault holds two per-wallet sub-keys (also 16-byte
  // argon2id outputs in hex-string form, derived from random
  // 32-byte inputs and a shared random 32-byte salt).
  const seedSaltBytes     = randomBytes(32);
  const seedSaltHex       = toHex(seedSaltBytes);
  const seedKeySource     = randomBytes(32);
  const dataKeySource     = randomBytes(32);
  const seedEncryptionKey = deriveHashHex(toHex(seedKeySource), seedSaltHex);
  const dataEncryptionKey = deriveHashHex(toHex(dataKeySource), seedSaltHex);

  const innerVaultJson = JSON.stringify({ seedEncryptionKey, dataEncryptionKey });
  const encryptionVault = aesGcmEncryptToHex(innerVaultJson, passwordHashHex);

  // The seed payload mirrors xverse-core's storeWalletByMnemonic:
  // wraps the mnemonic in {keyType, mnemonic, derivationType} JSON
  // and encrypts with seedEncryptionKey.
  const seedPayload = JSON.stringify({
    keyType: 'mnemonic',
    mnemonic,
    derivationType: 'account',
  });
  const seedVault = aesGcmEncryptToHex(seedPayload, seedEncryptionKey);

  return {
    'vault::version': '2',
    'vault::passwordSalt': passwordSaltHex,
    'vault::encryptionVault': encryptionVault,
    'vault::seedVault': seedVault,
  };
}


// ─────────────────────────────────────────────────────────────────
// Variant mutators for the matrix specs
// ─────────────────────────────────────────────────────────────────

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
): Promise<void> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });

  await worker.evaluate(async ({ network, paymentType }) => {
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
  }, variant);
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
