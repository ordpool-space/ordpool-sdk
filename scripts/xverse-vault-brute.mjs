#!/usr/bin/env node
// Brute-verify Xverse's seed-encryption format against a known-good
// chrome.storage.local dump (BIP-39 test seed + TestPassword123!).
//
// From the bundle:
//   DR = async (password, salt, iterations, mode, bits) => {
//     PBKDF2-SHA-256(password, salt, iterations) → bits-many bits
//     return importKey(slice(0,32) as AES-256-GCM)
//   }
//
// Tries two structural variants of the encryptionVault blob:
//   A) iv(16) + ciphertext+tag(rest)     — random-IV encrypt path
//   B) iv(12) + ciphertext+tag(middle) + blobSalt(8)  — per-blob salt path
//
// Across a range of PBKDF2 iteration counts.
//
// Usage: node scripts/xverse-vault-brute.mjs <path-to-dump.json>

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';

const dumpPath = process.argv[2];
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

const saltHex   = String(dump['vault::passwordSalt']);
const vaultHex  = String(dump['vault::encryptionVault']);
const salt      = Buffer.from(saltHex, 'hex');
const vault     = Buffer.from(vaultHex, 'hex');

console.log(`global salt: ${salt.length}B  vault: ${vault.length}B`);

const password = Buffer.from('TestPassword123!', 'utf8');

function tryDecrypt(cipher, key, iv, ct, tag) {
  try {
    const dec = crypto.createDecipheriv(cipher, key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]);
  } catch {
    return null;
  }
}

// From the bundle (background.js):
//   hash: async (pass, salt) => argon2.hash({
//     pass, salt, time: 3, mem: 65536, parallelism: 4,
//     hashLen: 16, type: Argon2id
//   })
//   passwordHash = hash(password, passwordSalt)  → 16 bytes (AES-128 key)
const argonParams = { t: 3, m: 65536, p: 4 };

console.log(`\nargon2id(password, passwordSalt, ${JSON.stringify(argonParams)}, dkLen=16)…`);
const t0 = Date.now();
const argonHash = argon2id(password, salt, { ...argonParams, dkLen: 16 });
const argonHex = Buffer.from(argonHash).toString('hex');
console.log(`  ${Date.now() - t0}ms argonHash16=${argonHex}`);

// Xverse encrypt path: `Qx = A => new TextEncoder().encode(A)`
// so the AES key is utf-8-encoded hex string of the argon2 hash.
const aesKey = Buffer.from(new TextEncoder().encode(argonHex)); // 32 bytes
console.log(`  utf-8(hexString) AES key: ${aesKey.toString('hex')} (${aesKey.length}B)`);

const iv = vault.subarray(0, 16);
const ct = vault.subarray(16, vault.length - 16);
const tag = vault.subarray(vault.length - 16);

console.log(`\n--- AES-256-GCM with utf-8(argon2-hex) key ---`);
console.log(`  iv=${iv.length}B  ct=${ct.length}B  tag=${tag.length}B`);

let plain = tryDecrypt('aes-256-gcm', aesKey, iv, ct, tag);
if (plain) {
  console.log(`\n✓ MATCH plaintext (${plain.length} bytes):`);
  console.log(plain.toString('utf8'));
  console.log(`\nHex: ${plain.toString('hex')}`);
  process.exit(0);
}

console.log('  AES-256-GCM no match');
process.exit(1);
