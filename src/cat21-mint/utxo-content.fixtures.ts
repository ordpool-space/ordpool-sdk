import {
  Cat21OrdOutputResponse,
  OrdOutputResponse,
} from './utxo-content.types.js';

/**
 * Canonical `/output` responses for tests, shaped by the same types
 * `classifyUtxoContent` consumes.
 *
 * These exist because a consumer's hand-written mock cannot follow the
 * classifier when the classifier changes. It happened: the classifier began
 * requiring non-empty `sat_ranges` as proof that ord had INDEXED an output
 * (absence of data is not absence of assets), and every mock that omitted the
 * field started classifying its funding coin as unknown. Two of ordpool's mint
 * lanes went red on a mock, not on a defect.
 *
 * Build fixtures from here and that cannot recur: the builders live beside the
 * classifier, and a spec in this package asserts each one still classifies the
 * way its name claims. If the contract moves again, that spec fails here
 * instead of in three consumers' suites.
 *
 * Sat numbers are deliberately mid-range and common. A rare sat is a
 * BOUNDARY sat (the first of a block), so an arbitrary-looking number is not
 * accidentally notable.
 */

/** A mid-block sat range: real-looking, and definitively common. */
const COMMON_RANGE: ReadonlyArray<readonly [number, number]> = [[1_002_000_000_001, 1_002_000_000_101]];

/** Every fixture carries ranges, because an output with none reads as NOT INDEXED. */
function base(over: Partial<OrdOutputResponse> = {}): OrdOutputResponse {
  return { inscriptions: [], runes: null, sat_ranges: COMMON_RANGE, ...over };
}
function cat21Base(over: Partial<Cat21OrdOutputResponse> = {}): Cat21OrdOutputResponse {
  return { cats: [], sat_ranges: COMMON_RANGE, ...over };
}

/** The pair of responses the scanner fetches for one outpoint. */
export interface OutputFixture {
  /** From the FULL ord: inscriptions, runes, sat ranges. */
  ord: OrdOutputResponse;
  /** From cat21-ord: cats. */
  cat21Ord: Cat21OrdOutputResponse;
}

/** A coin safe to spend as funding: indexed, and carrying nothing. */
export function cleanOutputFixture(): OutputFixture {
  return { ord: base(), cat21Ord: cat21Base() };
}

/** A coin carrying a real inscription. */
export function inscribedOutputFixture(
  inscriptionId = 'a'.repeat(64) + 'i0',
): OutputFixture {
  return { ord: base({ inscriptions: [inscriptionId] }), cat21Ord: cat21Base() };
}

/** A coin carrying a CAT-21 cat. Cats come from cat21-ord, not the full ord. */
export function catOutputFixture(catId = 'b'.repeat(64) + 'i0'): OutputFixture {
  return { ord: base(), cat21Ord: cat21Base({ cats: [catId] }) };
}

/** A coin carrying a rune balance. */
export function runeOutputFixture(runeName = 'ORDPOOL•TEST•RUNE'): OutputFixture {
  return {
    ord: base({ runes: { [runeName]: { amount: 1000, divisibility: 2, symbol: '@' } } }),
    cat21Ord: cat21Base(),
  };
}

/**
 * A coin whose first sat is notable.
 *
 * The sat is the FIRST of a block, which is what ord's rarity model reads as
 * uncommon or better. Both instances carry the range, because the classifier
 * reads the cat's sat from cat21-ord first.
 */
export function rareSatOutputFixture(): OutputFixture {
  const BLOCK_FIRST_SAT = 2016 * 5_000_000_000; // difficulty-adjustment boundary
  const ranges: ReadonlyArray<readonly [number, number]> = [[BLOCK_FIRST_SAT, BLOCK_FIRST_SAT + 100]];
  return { ord: base({ sat_ranges: ranges }), cat21Ord: cat21Base({ sat_ranges: ranges }) };
}

/**
 * An output ord has NOT indexed: 200 with empty fields.
 *
 * Byte-identical to a genuinely empty output, which is exactly why the
 * classifier cannot read it as clean. Use it to prove a consumer fails CLOSED.
 */
export function notIndexedOutputFixture(): OutputFixture {
  return {
    ord: { inscriptions: [], runes: null, sat_ranges: [] },
    cat21Ord: { cats: [], sat_ranges: [] },
  };
}
