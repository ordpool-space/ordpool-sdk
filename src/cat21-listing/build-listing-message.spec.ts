import { describe, expect, it } from '@jest/globals';

import { Network } from '../network';
import { toOrdinalsAddress, toPaymentAddress } from '../wallet/address-types';
import {
  CAT21_LISTING_MESSAGE_VERSION,
  buildListingMessage,
  ListingMessageFields,
  parseCatsList,
  serializeCats,
} from './build-listing-message';
import { MAX_ASK_SATS } from './cat21-listing.types';

// Real derived addresses from a known test key so shape checks pass.
const ORD_ADDR = toOrdinalsAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq7pkrz9');
const PAY_ADDR = toPaymentAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx');
const TXID = 'ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df';

const baseFields = (): ListingMessageFields => ({
  catNumber: 42,
  cats: [42],
  network: Network.Mainnet,
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
      expect(CAT21_LISTING_MESSAGE_VERSION).toBe('v3');
    });
  });

  describe('happy path', () => {

    it('produces the exact multi-line byte sequence expected — prefix, field order, separator all locked', () => {
      const msg = buildListingMessage(baseFields());
      const expected = [
        'cat21-ask:v3',
        'network=mainnet',
        'catNumber=42',
        'cats=42',
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
        network: Network.Mainnet,
        catVout: 0,
        ordinalsAddress: ORD_ADDR,
        payTo: PAY_ADDR,
        catTxid: TXID,
        cats: [42],
        askSats: 21_000,
        catNumber: 42,
      };
      expect(buildListingMessage(reordered)).toBe(buildListingMessage(baseFields()));
    });

    it('produces a message where every line except the first is a `key=value` pair', () => {
      const lines = buildListingMessage(baseFields()).split('\n');
      expect(lines[0]).toBe('cat21-ask:v3');
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
      const msg = buildListingMessage({ ...baseFields(), catNumber: 0, cats: [0], askSats: 2_100_000_000 });
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
    it('accepts exactly MAX_ASK_SATS (21 M BTC — total supply ceiling)', () => {
      expect(() => buildListingMessage({ ...baseFields(), askSats: MAX_ASK_SATS })).not.toThrow();
    });
    it('rejects > MAX_ASK_SATS (nonsense — no listing costs more than every bitcoin)', () => {
      expect(() => buildListingMessage({ ...baseFields(), askSats: MAX_ASK_SATS + 1 })).toThrow(/MAX_ASK_SATS/);
    });
  });

  describe('validation — network (anti-replay across mainnet/testnet)', () => {
    it('emits network=mainnet for Network.Mainnet', () => {
      const msg = buildListingMessage({ ...baseFields(), network: Network.Mainnet });
      expect(msg).toContain('network=mainnet');
    });
    it('emits network=testnet3 for Network.Testnet3', () => {
      const msg = buildListingMessage({ ...baseFields(), network: Network.Testnet3 });
      expect(msg).toContain('network=testnet3');
    });
    it('emits network=regtest for Network.Regtest', () => {
      const msg = buildListingMessage({ ...baseFields(), network: Network.Regtest });
      expect(msg).toContain('network=regtest');
    });
    it('rejects an unknown network value', () => {
      expect(() => buildListingMessage({ ...baseFields(), network: 'sombrio' as never })).toThrow(/Unknown network/);
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

  describe('cats bundle (v3 — the load-bearing on-chain identifier)', () => {
    it('emits `cats=42` for a single-cat UTXO', () => {
      const msg = buildListingMessage(baseFields());
      expect(msg).toContain('cats=42');
    });

    it('emits `cats=0,42,100` sorted ascending for a bundle (order-insensitive input)', () => {
      const msg = buildListingMessage({
        ...baseFields(),
        catNumber: 0,
        cats: [100, 0, 42],
        askSats: 2_100_000_000, // genesis-cat lore pin — not asserted here, avoids MAX_ASK check hit
      });
      expect(msg).toContain('cats=0,42,100');
    });

    it('dedupes repeats in the bundle', () => {
      const msg = buildListingMessage({ ...baseFields(), cats: [42, 42, 42] });
      expect(msg).toContain('cats=42');
    });

    it('rejects empty bundle (a listing must sell at least one cat)', () => {
      expect(() => buildListingMessage({ ...baseFields(), cats: [] })).toThrow(/cats/);
    });

    it('rejects bundle containing a negative cat number', () => {
      expect(() => buildListingMessage({ ...baseFields(), cats: [42, -1] })).toThrow(/cats/);
    });

    it('rejects bundle containing a non-integer', () => {
      expect(() => buildListingMessage({ ...baseFields(), cats: [42, 1.5] })).toThrow(/cats/);
    });

    it('rejects when the headline catNumber is not a member of the bundle (would let a seller hide the headline)', () => {
      expect(() =>
        buildListingMessage({ ...baseFields(), catNumber: 42, cats: [100, 200] }),
      ).toThrow(/headline catNumber 42 must be a member/);
    });

    it('accepts headline = min(cats) (the canonical case)', () => {
      const msg = buildListingMessage({ ...baseFields(), catNumber: 0, cats: [0, 42, 100], askSats: 21_000 });
      expect(msg).toContain('catNumber=0');
      expect(msg).toContain('cats=0,42,100');
    });

    it('accepts headline that is a non-minimum member (rare but valid — presentational choice)', () => {
      const msg = buildListingMessage({ ...baseFields(), catNumber: 42, cats: [0, 42, 100], askSats: 21_000 });
      expect(msg).toContain('catNumber=42');
      expect(msg).toContain('cats=0,42,100');
    });
  });

  describe('serializeCats (canonicalizer) + parseCatsList (inverse)', () => {
    it('serializes ascending + deduped', () => {
      expect(serializeCats([100, 0, 42, 42], 0)).toBe('0,42,100');
    });

    it('parses back into the canonical number array', () => {
      expect(parseCatsList('0,42,100')).toEqual([0, 42, 100]);
    });

    it('round-trips: parse(serialize(x)) === canonical(x)', () => {
      const csv = serializeCats([100, 42, 0], 0);
      expect(parseCatsList(csv)).toEqual([0, 42, 100]);
    });

    it('parseCatsList rejects garbage', () => {
      expect(() => parseCatsList('abc,42')).toThrow(/cats line/);
      expect(() => parseCatsList('42,-1')).toThrow(/cats line/);
      expect(() => parseCatsList('')).toThrow(/cats line/);
    });

    it('parseCatsList normalises a non-canonical line to sorted + deduped (the true inverse of serializeCats)', () => {
      // Doc promises a sorted, deduped array; a hand-rolled unsorted /
      // duplicated line must come back as the set it represents.
      expect(parseCatsList('100,42,0,42,100')).toEqual([0, 42, 100]);
    });
  });
});
