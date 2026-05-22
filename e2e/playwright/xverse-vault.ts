/**
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
