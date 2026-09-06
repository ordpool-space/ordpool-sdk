import { describe, it, expect } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { verifyBip322Signature } from './verify-bip322-signature';

/**
 * Real-wallet regression vectors. Before this spec existed the verifier had
 * ZERO coverage against an actual wallet — only self-signed round-trips
 * (`verify-listing-signature.spec` `signBase()`), which reverse the same
 * bytes on sign and verify and so can never catch a byte-order or
 * sighash-construction bug. The cat21wallet sign-message e2e caught exactly
 * such a bug: the to_spend txid was passed to `@scure/btc-signer` in internal
 * byte order, but @scure reverses it when serializing, so the to_sign sighash
 * referenced a byte-reversed prevout and EVERY real taproot BIP-322 signature
 * failed. This vector is a genuine signature produced by the real Cat21 Wallet
 * extension (a Leather fork, signing via bitcoinjs-lib) in CI.
 */
describe('verifyBip322Signature — real cat21wallet (Leather-fork) P2TR vector', () => {
  // Captured from the cat21wallet-sign-message-roundtrip e2e (real extension).
  const ADDRESS = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
  const MESSAGE = 'ordpool sign-message e2e — prove BIP-322 roundtrip';
  const SIGNATURE = 'AUAzQKkIhYTU9toEwG71UwPpYXdd0I6w1NK+VLV/KTZApvxu+c+Cra5fc5rDQ5TSr+tcSxfsYJOblv5yEDNPMCDQ';

  it('verifies the real signature against its address + message', () => {
    expect(verifyBip322Signature({ address: ADDRESS, message: MESSAGE, signatureBase64: SIGNATURE }))
      .toEqual({ ok: true });
  });

  it('rejects the real signature against a tampered message', () => {
    const r = verifyBip322Signature({ address: ADDRESS, message: MESSAGE + '!', signatureBase64: SIGNATURE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature-does-not-verify');
  });

  it('rejects the real signature against a different (valid) P2TR address', () => {
    // A valid but unrelated mainnet P2TR address (BIP-340 test-vector x-only key).
    const other = btc.p2tr(
      hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'),
      undefined,
      btc.NETWORK,
    ).address!;
    const r = verifyBip322Signature({ address: other, message: MESSAGE, signatureBase64: SIGNATURE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature-does-not-verify');
  });
});

describe('verifyBip322Signature — regtest (bcrt) P2TR address decoding', () => {
  // regtest shares mainnet's script encoding; only the bech32 HRP differs.
  const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
  const bcrtAddress = btc.p2tr(
    hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'),
    undefined,
    REGTEST
  ).address!;

  it('decodes a bcrt (regtest) address and reaches signature verification', () => {
    // A bcrt address used to be rejected as `invalid-address` before its
    // signature was ever checked. With regtest support it decodes, so an
    // unrelated signature must fail at VERIFICATION, not at decoding. Real
    // regtest BIP-322 roundtrips are proven end to end by the wallet's cat21
    // create-offer chain-truth e2e against the real Bazaar backend.
    const r = verifyBip322Signature({
      address: bcrtAddress,
      message: 'ordpool regtest bip322 decode probe',
      signatureBase64:
        'AUAzQKkIhYTU9toEwG71UwPpYXdd0I6w1NK+VLV/KTZApvxu+c+Cra5fc5rDQ5TSr+tcSxfsYJOblv5yEDNPMCDQ',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('signature-does-not-verify');
  });
});
