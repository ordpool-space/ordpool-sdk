import {
  eitherAsString,
  OrdinalsAddress,
  PaymentAddress,
  toOrdinalsAddress,
  toPaymentAddress,
} from './address-types';

const P2WPKH_MAINNET = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx';
const P2TR_MAINNET = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9';
const P2WPKH_REGTEST = 'bcrt1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx';
const LEGACY_P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const LEGACY_P2SH = '3P14159f73E4gFr7JterCCQh9QjiTjiZrG';

describe('address-types (branded PaymentAddress / OrdinalsAddress)', () => {
  describe('constructors accept every real address shape we support', () => {
    it('bech32 P2WPKH (mainnet + regtest)', () => {
      expect(toPaymentAddress(P2WPKH_MAINNET)).toBe(P2WPKH_MAINNET);
      expect(toPaymentAddress(P2WPKH_REGTEST)).toBe(P2WPKH_REGTEST);
    });

    it('bech32m P2TR', () => {
      expect(toOrdinalsAddress(P2TR_MAINNET)).toBe(P2TR_MAINNET);
    });

    it('legacy P2PKH and P2SH', () => {
      expect(toPaymentAddress(LEGACY_P2PKH)).toBe(LEGACY_P2PKH);
      expect(toPaymentAddress(LEGACY_P2SH)).toBe(LEGACY_P2SH);
    });
  });

  describe('constructors reject garbage at the boundary', () => {
    it('rejects empty string', () => {
      expect(() => toPaymentAddress('')).toThrow(/valid Bitcoin address/);
      expect(() => toOrdinalsAddress('')).toThrow(/valid Bitcoin address/);
    });

    it('rejects obviously non-address strings', () => {
      for (const bad of ['nope', 'https://example.com', ' bc1q…', '0x1234', 'null']) {
        expect(() => toPaymentAddress(bad)).toThrow(/valid Bitcoin address/);
      }
    });

    it('does not swallow non-string inputs', () => {
      // Runtime callers can pass `undefined` via a `??`-chain — surface
      // it loudly rather than percent-encode the word "undefined".
      expect(() => toPaymentAddress(undefined as unknown as string)).toThrow();
      expect(() => toPaymentAddress(null as unknown as string)).toThrow();
    });
  });

  describe('branded types are distinct at compile time', () => {
    it('a function typed as PaymentAddress refuses an OrdinalsAddress at compile time', () => {
      // This test is intentionally a compile-time contract check. The
      // three commented-out lines below must not compile — uncomment
      // any of them and `npm run build` fails. They live here as
      // executable documentation for the friction that stopped the
      // 2026-07-18 auto-fill bug from re-shipping.

      const ord: OrdinalsAddress = toOrdinalsAddress(P2TR_MAINNET);
      const pay: PaymentAddress = toPaymentAddress(P2WPKH_MAINNET);

      function takesPayment(_addr: PaymentAddress): void {}
      function takesOrdinals(_addr: OrdinalsAddress): void {}

      // takesPayment(ord);  // ❌ Argument of type 'OrdinalsAddress' is not assignable to parameter of type 'PaymentAddress'.
      // takesOrdinals(pay); // ❌ symmetric.
      // takesPayment(P2WPKH_MAINNET); // ❌ raw string missing the brand.

      // Both branded values ARE assignable to bare `string` (unchanged
      // structural behaviour) — nothing existing breaks.
      function takesString(_s: string): void {}
      takesString(ord);
      takesString(pay);
      takesString(eitherAsString(ord));
      takesString(eitherAsString(pay));

      // Compile-check assertions consume the vars so the compiler
      // doesn't flag them unused.
      expect(ord).toBeDefined();
      expect(pay).toBeDefined();
      expect(takesPayment).toBeDefined();
      expect(takesOrdinals).toBeDefined();
      expect(takesString).toBeDefined();
    });
  });
});
