import {
  buildAcceptOfferQueryParams,
  buildAskQueryParams,
  buildBuyOfferQueryParams,
  buildTransferQueryParams,
  parseAcceptOfferQueryParams,
  parseAskQueryParams,
  parseBuyOfferQueryParams,
  parseTransferQueryParams,
} from './permalink.helper';

const REAL_TXID = 'ab49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df';

describe('permalink helpers', () => {
  describe('ask permalink', () => {
    it('builds and parses a valid ask query', () => {
      const params = buildAskQueryParams({ askSats: 21000 });
      expect(params).toEqual({ ask: '21000' });
      expect(parseAskQueryParams(new URLSearchParams(params))).toEqual({ askSats: 21000 });
    });

    it('rejects non-positive askSats at build time', () => {
      expect(() => buildAskQueryParams({ askSats: 0 })).toThrow(/positive integer/);
      expect(() => buildAskQueryParams({ askSats: -1 })).toThrow(/positive integer/);
      expect(() => buildAskQueryParams({ askSats: 1.5 })).toThrow(/positive integer/);
    });

    it('parse returns askSats=null when the param is missing', () => {
      expect(parseAskQueryParams(new URLSearchParams())).toEqual({ askSats: null });
    });

    it('parse rejects tampered ask values', () => {
      for (const bad of ['abc', '-100', '0', '1.5', '1000 ', ' 1000', '1e5']) {
        expect(parseAskQueryParams({ ask: bad })).toEqual({ askSats: null });
      }
    });

    it('parses ask values that survive a round-trip through URLSearchParams', () => {
      const url = new URL('https://cat21.space/cat/42?ask=99999');
      expect(parseAskQueryParams(url.searchParams)).toEqual({ askSats: 99999 });
    });
  });

  describe('buy-offer permalink', () => {
    it('builds bare "make me an offer" params when no askSats is given', () => {
      const params = buildBuyOfferQueryParams({ catNumber: 42 });
      expect(params).toEqual({ catNumber: '42' });
    });

    it('builds full "responding to ask" params when askSats is given', () => {
      const params = buildBuyOfferQueryParams({ catNumber: 42, askSats: 21000 });
      expect(params).toEqual({ catNumber: '42', askPrice: '21000', fromAsk: '1' });
    });

    it('parses fully-populated params', () => {
      const parsed = parseBuyOfferQueryParams(
        new URLSearchParams({ catNumber: '42', askPrice: '21000', fromAsk: '1' }),
      );
      expect(parsed).toEqual({ catNumber: 42, askSats: 21000, fromAsk: true });
    });

    it('parses without askSats — buyer landed on a bare make-offer link', () => {
      const parsed = parseBuyOfferQueryParams(new URLSearchParams({ catNumber: '42' }));
      expect(parsed).toEqual({ catNumber: 42, askSats: null, fromAsk: false });
    });

    it('rejects tampered catNumber at parse time', () => {
      expect(parseBuyOfferQueryParams({ catNumber: 'abc' })).toEqual({
        catNumber: null,
        askSats: null,
        fromAsk: false,
      });
      expect(parseBuyOfferQueryParams({ catNumber: '-1' })).toEqual({
        catNumber: null,
        askSats: null,
        fromAsk: false,
      });
    });

    it('rejects negative catNumber at build time', () => {
      expect(() => buildBuyOfferQueryParams({ catNumber: -1 })).toThrow(/non-negative integer/);
      expect(() => buildBuyOfferQueryParams({ catNumber: 1.5 })).toThrow(/non-negative integer/);
    });

    it('fromAsk only fires on exact string "1" — no truthy-coercion for future-proofing', () => {
      expect(parseBuyOfferQueryParams({ fromAsk: 'true' }).fromAsk).toBe(false);
      expect(parseBuyOfferQueryParams({ fromAsk: 'yes' }).fromAsk).toBe(false);
      expect(parseBuyOfferQueryParams({ fromAsk: '1' }).fromAsk).toBe(true);
    });
  });

  describe('accept-offer permalink', () => {
    it('builds and parses a valid one-click bundle', () => {
      const params = buildAcceptOfferQueryParams({
        offerBase64: 'cHNidP8B==',
        catOutpoint: { txid: REAL_TXID, vout: 0 },
      });
      expect(params).toEqual({
        offer: 'cHNidP8B==',
        catTxid: REAL_TXID,
        catVout: '0',
      });
      const parsed = parseAcceptOfferQueryParams(new URLSearchParams(params));
      expect(parsed.offerBase64).toBe('cHNidP8B==');
      expect(parsed.catOutpoint).toEqual({ txid: REAL_TXID, vout: 0 });
      expect(parsed.bundleComplete).toBe(true);
    });

    it('rejects uppercase-hex txid by lowercasing on build (invariant: URL is canonical lowercase)', () => {
      const params = buildAcceptOfferQueryParams({
        offerBase64: 'x',
        catOutpoint: { txid: REAL_TXID.toUpperCase(), vout: 0 },
      });
      expect(params['catTxid']).toBe(REAL_TXID);
    });

    it('parse reports bundleComplete=false when offer is missing', () => {
      const parsed = parseAcceptOfferQueryParams({ catTxid: REAL_TXID, catVout: '0' });
      expect(parsed.offerBase64).toBeNull();
      expect(parsed.catOutpoint).toEqual({ txid: REAL_TXID, vout: 0 });
      expect(parsed.bundleComplete).toBe(false);
    });

    it('parse reports bundleComplete=false when catOutpoint is missing', () => {
      const parsed = parseAcceptOfferQueryParams({ offer: 'cHNidP8B==' });
      expect(parsed.offerBase64).toBe('cHNidP8B==');
      expect(parsed.catOutpoint).toBeNull();
      expect(parsed.bundleComplete).toBe(false);
    });

    it('rejects a short txid at build time', () => {
      expect(() =>
        buildAcceptOfferQueryParams({
          offerBase64: 'x',
          catOutpoint: { txid: 'ab', vout: 0 },
        }),
      ).toThrow(/64-hex/);
    });

    it('rejects a non-integer vout at build time', () => {
      expect(() =>
        buildAcceptOfferQueryParams({
          offerBase64: 'x',
          catOutpoint: { txid: REAL_TXID, vout: -1 },
        }),
      ).toThrow(/non-negative integer/);
      expect(() =>
        buildAcceptOfferQueryParams({
          offerBase64: 'x',
          catOutpoint: { txid: REAL_TXID, vout: 1.5 },
        }),
      ).toThrow(/non-negative integer/);
    });

    it('parse defends against tampered non-hex txid', () => {
      const parsed = parseAcceptOfferQueryParams({
        offer: 'x',
        catTxid: 'zz49227cce490e2137872f7d08924187ee4f4bc7e8b3bda7ac63d7bba1d897df',
        catVout: '0',
      });
      expect(parsed.catOutpoint).toBeNull();
    });
  });

  describe('transfer permalink', () => {
    it('builds with catNumber only — page falls back to picker for the outpoint', () => {
      expect(buildTransferQueryParams({ catNumber: 42 })).toEqual({ catNumber: '42' });
    });

    it('builds with catNumber + outpoint for deep-link', () => {
      expect(
        buildTransferQueryParams({
          catNumber: 42,
          catOutpoint: { txid: REAL_TXID, vout: 0 },
        }),
      ).toEqual({ catNumber: '42', catTxid: REAL_TXID, catVout: '0' });
    });

    it('parses both flavours', () => {
      expect(parseTransferQueryParams(new URLSearchParams({ catNumber: '42' }))).toEqual({
        catNumber: 42,
        catOutpoint: null,
      });
      expect(
        parseTransferQueryParams(
          new URLSearchParams({ catNumber: '42', catTxid: REAL_TXID, catVout: '3' }),
        ),
      ).toEqual({ catNumber: 42, catOutpoint: { txid: REAL_TXID, vout: 3 } });
    });
  });
});
