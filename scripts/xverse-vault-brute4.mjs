#!/usr/bin/env node
// Try variants on salt encoding. The xverse code calls
// `hash(password, passwordSalt)` — but does it pass salt as raw
// 32 bytes or as the hex string utf-8-encoded (= 64 bytes)?

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';

const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const saltHex = dump['vault::passwordSalt'];
const vault = Buffer.from(dump['vault::encryptionVault'], 'hex');
const iv = vault.subarray(0, 16);
const ct = vault.subarray(16, vault.length - 16);
const tag = vault.subarray(vault.length - 16);

const password = 'TestPassword123!';

function tryWithSalt(saltLabel, salt) {
  try {
    const hash = argon2id(password, salt, { t: 3, m: 65536, p: 4, dkLen: 16 });
    const hashHex = Buffer.from(hash).toString('hex');
    const key = Buffer.from(new TextEncoder().encode(hashHex)); // utf8(hex) → 32B
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    const plain = Buffer.concat([dec.update(ct), dec.final()]);
    console.log(`\n✓ MATCH with salt-variant "${saltLabel}":`);
    console.log(`  hash16:    ${hashHex}`);
    console.log(`  plaintext: ${plain.toString('utf8')}`);
    return true;
  } catch (e) {
    console.log(`✗ ${saltLabel}: ${e.message}`);
    return false;
  }
}

// Variant 1: salt as raw 32 bytes (hex-decoded)
tryWithSalt('raw-32B', Buffer.from(saltHex, 'hex')) ||
// Variant 2: salt as utf-8 of the hex string (64 bytes)
tryWithSalt('utf8(hexString)', Buffer.from(new TextEncoder().encode(saltHex))) ||
// Variant 3: salt as utf-8 of the hex string with prefix
tryWithSalt('utf8(0x+hex)', Buffer.from(new TextEncoder().encode('0x' + saltHex))) ||
// Variant 4: maybe password is also processed differently
(() => {
  console.log('\n--- trying password variants too ---');
  for (const pw of [password, password.normalize('NFKC'), password.trim()]) {
    for (const [saltLabel, salt] of [
      ['raw-32B', Buffer.from(saltHex, 'hex')],
      ['utf8(hexString)', Buffer.from(new TextEncoder().encode(saltHex))],
    ]) {
      try {
        const hash = argon2id(pw, salt, { t: 3, m: 65536, p: 4, dkLen: 16 });
        const hashHex = Buffer.from(hash).toString('hex');
        const key = Buffer.from(new TextEncoder().encode(hashHex));
        const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        const plain = Buffer.concat([dec.update(ct), dec.final()]);
        console.log(`\n✓ MATCH pw=${JSON.stringify(pw)} salt=${saltLabel}:`);
        console.log(`  plaintext: ${plain.toString('utf8')}`);
        return true;
      } catch {}
    }
  }
  return false;
})() ||
process.exit(1);
