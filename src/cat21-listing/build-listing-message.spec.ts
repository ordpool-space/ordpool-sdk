import { describe, expect, it } from '@jest/globals';

import { toOrdinalsAddress, toPaymentAddress } from '../wallet/address-types';
import {
  CAT21_LISTING_MESSAGE_VERSION,
  buildListingMessage,
  ListingMessageFields,
} from './build-listing-message';

// Real derived addresses from a known test key so shape checks pass.
const ORD_ADDR = toOrdinalsAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9');
const PAY_ADDR = toPaymentAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx');
const TXID = 'ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df';

const baseFields = (): ListingMessageFields => ({
  catNumber: 42,
  askSats: 21_000,
  payTo: PAY_ADDR,
  catTxid: TXID,
  catVout: 0,
  ordinalsAddress: ORD_ADDR,
  signedAt: 1_700_000_000,
});

describe('buildListingMessage — canonical human-readable listing message for BIP-322 signing', () => {

  describe('version', () => {
    it('exposes the current message version constant (bump when format changes)', () => {
      expect(CAT21_LISTING_MESSAGE_VERSION).toBe('v1');
    });
  });

  describe('happy path', () => {

    it('produces the exact multi-line byte sequence expected — prefix, field order, separator all locked', () => {
      const msg = buildListingMessage(baseFields());
      const expected = [
        'cat21-ask:v1',
        'catNumber=42',
        'askSats=21000',
        'payTo=bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx',
        'catTxid=ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df',
        'catVout=0',
        'ordinalsAddress=bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9',
        'signedAt=1700000000',
      ].join('\n');
      expect(msg).toBe(expected);
    });

    it('is deterministic — same input, same output, every call', () => {
      const a = buildListingMessage(baseFields());
      const b = buildListingMessage(baseFields());
      expect(a).toBe(b);
    });

    it('is insensitive to JS object property-insertion order (fixed canonical field order)', () => {
      const reordered: ListingMessageFields = {
        signedAt: 1_700_000_000,
        catVout: 0,
        ordinalsAddress: ORD_ADDR,
        payTo: PAY_ADDR,
        catTxid: TXID,
        askSats: 21_000,
        catNumber: 42,
      };
      expect(buildListingMessage(reordered)).toBe(buildListingMessage(baseFields()));
    });

    it('produces a message where every line except the first is a `key=value` pair', () => {
      const lines = buildListingMessage(baseFields()).split('\n');
      expect(lines[0]).toBe('cat21-ask:v1');
      for (const line of lines.slice(1)) {
        expect(line).toMatch(/^[a-zA-Z]+=/);
      }
    });

    it('accepts catVout = 0 (the canonical position for a cat UTXO)', () => {
      expect(() => buildListingMessage({ ...baseFields(), catVout: 0 })).not.toThrow();
    });

    it('accepts catVout > 0 (rare but structurally valid)', () => {
      const msg = buildListingMessage({ ...baseFields(), catVout: 3 });
      expect(msg).toContain('catVout=3');
    });
  });

  describe('validation — catNumber', () => {
    it('accepts 0 (Genesis Cat — a real listable UTXO with lore-fixed 21 BTC price)', () => {
      const msg = buildListingMessage({ ...baseFields(), catNumber: 0, askSats: 2_100_000_000 });
      expect(msg).toContain('catNumber=0');
      expect(msg).toContain('askSats=2100000000');
    });
    it('rejects negative', () => {
      expect(() => buildListingMessage({ ...baseFields(), catNumber: -1 })).toThrow(/catNumber/);
    });
    it('rejects non-integer', () => {
      expect(() => buildListingMessage({ ...baseFields(), catNumber: 1.5 })).toThrow(/catNumber/);
    });
    it('rejects NaN', () => {
      expect(() => buildListingMessage({ ...baseFields(), catNumber: Number.NaN })).toThrow(/catNumber/);
    });
    it('rejects Infinity', () => {
      expect(() => buildListingMessage({ ...baseFields(), catNumber: Number.POSITIVE_INFINITY })).toThrow(/catNumber/);
    });
  });

  describe('validation — askSats', () => {
    it('rejects 0 (a listing at zero price is malformed intent)', () => {
      expect(() => buildListingMessage({ ...baseFields(), askSats: 0 })).toThrow(/askSats/);
    });
    it('rejects negative', () => {
      expect(() => buildListingMessage({ ...baseFields(), askSats: -1 })).toThrow(/askSats/);
    });
    it('rejects non-integer', () => {
      expect(() => buildListingMessage({ ...baseFields(), askSats: 100.5 })).toThrow(/askSats/);
    });
  });

  describe('validation — catVout', () => {
    it('rejects negative', () => {
      expect(() => buildListingMessage({ ...baseFields(), catVout: -1 })).toThrow(/catVout/);
    });
    it('rejects non-integer', () => {
      expect(() => buildListingMessage({ ...baseFields(), catVout: 0.5 })).toThrow(/catVout/);
    });
  });

  describe('validation — catTxid', () => {
    it('rejects wrong length (too short)', () => {
      expect(() => buildListingMessage({ ...baseFields(), catTxid: 'ab' })).toThrow(/catTxid/);
    });
    it('rejects wrong length (too long)', () => {
      expect(() => buildListingMessage({ ...baseFields(), catTxid: TXID + 'ab' })).toThrow(/catTxid/);
    });
    it('rejects UPPERCASE hex (must be canonical lowercase to survive round-trip)', () => {
      expect(() => buildListingMessage({ ...baseFields(), catTxid: TXID.toUpperCase() })).toThrow(/catTxid/);
    });
    it('rejects non-hex characters', () => {
      const bad = 'z' + TXID.slice(1);
      expect(() => buildListingMessage({ ...baseFields(), catTxid: bad })).toThrow(/catTxid/);
    });
    it('rejects empty string', () => {
      expect(() => buildListingMessage({ ...baseFields(), catTxid: '' })).toThrow(/catTxid/);
    });
  });

  describe('validation — payTo + ordinalsAddress', () => {
    it('rejects empty payTo', () => {
      expect(() => buildListingMessage({ ...baseFields(), payTo: '' as never })).toThrow(/payTo/);
    });
    it('rejects empty ordinalsAddress', () => {
      expect(() => buildListingMessage({ ...baseFields(), ordinalsAddress: '' as never })).toThrow(/ordinalsAddress/);
    });
  });

  describe('validation — signedAt', () => {
    it('rejects 0 (epoch-zero is never a real seller timestamp)', () => {
      expect(() => buildListingMessage({ ...baseFields(), signedAt: 0 })).toThrow(/signedAt/);
    });
    it('rejects negative', () => {
      expect(() => buildListingMessage({ ...baseFields(), signedAt: -1 })).toThrow(/signedAt/);
    });
    it('rejects non-integer', () => {
      expect(() => buildListingMessage({ ...baseFields(), signedAt: 1.5 })).toThrow(/signedAt/);
    });
  });
});
