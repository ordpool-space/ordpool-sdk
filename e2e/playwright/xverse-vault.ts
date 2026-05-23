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
 * Given a Playwright BrowserContext launched against an already-
 * onboarded Xverse seed dir, mutate `persistentStore::networks`
 * and `persist:walletState` to make the wallet boot on a specific
 * (network, paymentType) combination. The context's leveldb gets
 * the change; the caller should close the context and relaunch
 * for the wallet to pick up the new values.
 *
 * Pass a chrome-extension://-origin page so chrome.storage.local
 * is reachable. If `page` is omitted, the caller's responsibility
 * is to make sure the active page is on an extension origin.
 */
export async function applyXverseVariant(
  pageOnExtensionOrigin: {
    evaluate: <T, A>(fn: (a: A) => Promise<T> | T, arg: A) => Promise<T>;
  },
  variant: XverseVariant,
): Promise<void> {
  type ChromeBridge = {
    chrome: {
      storage: {
        local: {
          get: (k: string[] | string, cb: (v: Record<string, string | undefined>) => void) => void;
          set: (d: Record<string, string>, cb: () => void) => void;
        };
      };
      runtime: { lastError?: { message: string } };
    };
  };

  await pageOnExtensionOrigin.evaluate(async (input: XverseVariant) => {
    const c = (window as unknown as ChromeBridge).chrome;

    // ─── 1. persistentStore::networks: switch active Bitcoin network ───
    const cur = await new Promise<Record<string, string | undefined>>((resolve) =>
      c.storage.local.get(['persistentStore::networks', 'persistentStore::activeAccount', 'persist:walletState'], resolve),
    );
    const networksRaw = cur['persistentStore::networks'];
    if (!networksRaw) throw new Error('persistentStore::networks missing from chrome.storage.local');
    const networks = JSON.parse(networksRaw) as {
      value: { active: { bitcoin: string;[k: string]: string } };
      version: number;
    };
    networks.value.active.bitcoin = input.network;

    // ─── 2. persistentStore::activeAccount: the new Zustand-style ───
    //   store Xverse reads `btcPaymentAddressType` from. The legacy
    //   `persist:walletState.btcPaymentAddressType` is no longer the
    //   source of truth — Xverse migrated to this store, default
    //   "native". The key may not exist for our test wallet because
    //   the user never explicitly changed Preferred Address Type;
    //   in that case build a fresh value from the in-code default.
    const activeRaw = cur['persistentStore::activeAccount'];
    let active: { value: { selectedAccountIndex: number; selectedAccountType: string; selectedWalletId?: string; btcPaymentAddressType: string }; version: number };
    if (activeRaw) {
      active = JSON.parse(activeRaw);
    } else {
      // Reuse the selectedWalletId from persist:walletState so the
      // activeAccount record points at the actual onboarded wallet.
      const stateRaw0 = cur['persist:walletState'];
      let selectedWalletId: string | undefined;
      if (stateRaw0) {
        const state0 = JSON.parse(stateRaw0) as Record<string, string>;
        const swRaw = state0.selectedWalletId;
        if (swRaw) selectedWalletId = JSON.parse(swRaw) as string;
      }
      active = {
        value: {
          selectedAccountIndex: 0,
          selectedAccountType: 'software',
          selectedWalletId,
          btcPaymentAddressType: 'native',
        },
        version: 0,
      };
    }
    active.value.btcPaymentAddressType = input.paymentType;

    // ─── 3. legacy persist:walletState.btcPaymentAddressType ───
    //   Set it too — some older code paths still read it. Doesn't
    //   hurt to keep both stores consistent.
    const stateRaw = cur['persist:walletState'];
    const writes: Record<string, string> = {
      'persistentStore::networks': JSON.stringify(networks),
      'persistentStore::activeAccount': JSON.stringify(active),
    };
    if (stateRaw) {
      const state = JSON.parse(stateRaw) as Record<string, string>;
      state.btcPaymentAddressType = JSON.stringify(input.paymentType);
      writes['persist:walletState'] = JSON.stringify(state);
    }

    await new Promise<void>((r, j) =>
      c.storage.local.set(writes, () => {
        if (c.runtime.lastError) j(new Error(c.runtime.lastError.message));
        else r();
      }),
    );
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
