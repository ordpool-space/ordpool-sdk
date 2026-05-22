#!/usr/bin/env node
// Compare @noble/hashes argon2id vs node-argon2 native to rule out
// pure-JS KDF impl differences.

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2';
import argon2 from 'argon2';

const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const salt = Buffer.from(dump['vault::passwordSalt'], 'hex');
const vault = Buffer.from(dump['vault::encryptionVault'], 'hex');
const iv = vault.subarray(0, 16);
const ct = vault.subarray(16, vault.length - 16);
const tag = vault.subarray(vault.length - 16);

console.log(`salt=${salt.toString('hex').slice(0,16)}…  vault=${vault.length}B  iv=${iv.length}B  ct=${ct.length}B`);

const password = 'TestPassword123!';

// @noble
const t1 = Date.now();
const noble = nobleArgon2id(password, salt, { t: 3, m: 65536, p: 4, dkLen: 16 });
console.log(`\n[@noble/hashes argon2id] ${Date.now() - t1}ms`);
console.log(`  hex: ${Buffer.from(noble).toString('hex')}`);

// node-argon2 native (raw mode)
const t2 = Date.now();
const native = await argon2.hash(password, {
  type: argon2.argon2id,
  salt,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
  hashLength: 16,
  raw: true,
  version: 0x13,
});
console.log(`\n[node-argon2 native] ${Date.now() - t2}ms`);
console.log(`  hex: ${native.toString('hex')}`);

if (Buffer.from(noble).equals(native)) {
  console.log(`\n✓ both libraries produce identical hash — KDF is not the cause`);
} else {
  console.log(`\n✗ libraries disagree — one of them has a different impl`);
}

for (const [label, hashBytes] of [['noble', Buffer.from(noble)], ['native', native]]) {
  const hashHex = hashBytes.toString('hex');
  const aesKey = Buffer.from(new TextEncoder().encode(hashHex));
  try {
    const dec = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    dec.setAuthTag(tag);
    const plain = Buffer.concat([dec.update(ct), dec.final()]);
    console.log(`\n✓ MATCH with ${label} key, plaintext (${plain.length}B):`);
    console.log(plain.toString('utf8'));
    process.exit(0);
  } catch (e) {
    console.log(`✗ ${label} decrypt fail: ${e.message}`);
  }
}
process.exit(1);
