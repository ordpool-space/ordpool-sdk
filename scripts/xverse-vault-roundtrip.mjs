#!/usr/bin/env node
// Round-trip verification: encrypt with our buildXverseVault,
// decrypt with the same recipe Xverse uses, recover the inputs.

import * as crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';
import { buildXverseVault } from '/tmp/xv-vault.mjs';

const password = 'TestPassword123!';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const blob = buildXverseVault(mnemonic, password);
console.log('produced:');
for (const [k, v] of Object.entries(blob)) console.log(`  ${k}: ${v.length} chars`);

// Decrypt path (mirror of QL):
const enc = new TextEncoder();
const passwordHashHex = Buffer.from(
  argon2id(password, enc.encode(blob['vault::passwordSalt']), { t: 3, m: 65536, p: 4, dkLen: 16 })
).toString('hex');
console.log(`\npasswordHashHex: ${passwordHashHex}`);

function aesGcmDecryptHex(hex, keyHexString) {
  const buf = Buffer.from(hex, 'hex');
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(16, buf.length - 16);
  const dec = crypto.createDecipheriv('aes-256-gcm', enc.encode(keyHexString), iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

const innerVault = JSON.parse(aesGcmDecryptHex(blob['vault::encryptionVault'], passwordHashHex));
console.log(`\nInner vault: ${JSON.stringify(innerVault)}`);

const seedPayload = JSON.parse(aesGcmDecryptHex(blob['vault::seedVault'], innerVault.seedEncryptionKey));
console.log(`\nSeed payload: ${JSON.stringify(seedPayload)}`);

if (seedPayload.mnemonic === mnemonic) {
  console.log('\n✓ ROUNDTRIP OK — mnemonic recovered correctly');
} else {
  console.log('\n✗ MISMATCH');
  process.exit(1);
}
