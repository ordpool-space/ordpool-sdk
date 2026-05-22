#!/usr/bin/env node
// Same brute as v1 but using argon2-browser (the actual WASM Xverse
// bundles) instead of @noble/hashes, to rule out KDF impl differences.

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import argon2 from 'argon2-browser';

const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const salt = Buffer.from(dump['vault::passwordSalt'], 'hex');
const vault = Buffer.from(dump['vault::encryptionVault'], 'hex');
const iv = vault.subarray(0, 16);
const ct = vault.subarray(16, vault.length - 16);
const tag = vault.subarray(vault.length - 16);

console.log(`salt=${salt.length}B vault=${vault.length}B iv=${iv.length}B ct=${ct.length}B`);

const t0 = Date.now();
const res = await argon2.hash({
  pass: 'TestPassword123!',
  salt,
  time: 3,
  mem: 65536,
  parallelism: 4,
  hashLen: 16,
  type: argon2.ArgonType.Argon2id,
});
console.log(`argon2-browser ${Date.now() - t0}ms`);
console.log(`  hash(hex): ${res.hashHex}`);
console.log(`  hash(raw): ${Buffer.from(res.hash).toString('hex')}`);
console.log(`  encoded:   ${res.encoded}`);

const utf8Key = Buffer.from(new TextEncoder().encode(res.hashHex));
console.log(`\nAES key = utf8(hashHex): ${utf8Key.toString('hex')} (${utf8Key.length}B)`);

try {
  const dec = crypto.createDecipheriv('aes-256-gcm', utf8Key, iv);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(ct), dec.final()]);
  console.log(`\n✓ MATCH plaintext (${plain.length}B):\n${plain.toString('utf8')}`);
  process.exit(0);
} catch (e) {
  console.log(`\n✗ decrypt failed: ${e.message}`);
  process.exit(1);
}
