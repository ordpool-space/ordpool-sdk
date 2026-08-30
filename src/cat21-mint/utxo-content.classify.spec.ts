import {
  classifyUtxoContent,
  detectRareSat,
  firstSat,
} from './utxo-content.classify';
import {
  Cat21OrdOutputResponse,
  OrdOutputResponse,
  RARE_SAT_MAX_RANGES,
} from './utxo-content.types';

// Pins the content-safety classification the funding force-scan depends on:
// a UTXO is `clean` (auto-spendable as fee funding) ONLY when it carries no
// inscription, no rune, no cat, and no rare sat. If any of these is misread as
// clean, the safe-auto would spend a valuable coin as fee-money. The e2e
// harnesses stub `/output` to a clean body, so this is the only place the real
// classification logic runs against realistic inputs.

// Sat values are DERIVED, not guessed, from the documented epoch-0 subsidy
// (`SUBSIDY_EPOCH_0 = 50 BTC = 5_000_000_000 sat`, sat-rarity.helper.ts):
//   first sat of block N = N * 5_000_000_000 (within epoch 0).
const EPOCH0_SUBSIDY = 5_000_000_000;
const BLOCK1_FIRST_SAT = 1 * EPOCH0_SUBSIDY;        // 5_000_000_000 — uncommon
const BLOCK2016_FIRST_SAT = 2016 * EPOCH0_SUBSIDY;  // 10_080_000_000_000 — rare (difficulty adjustment)
const BLOCK210000_FIRST_SAT = 210_000 * EPOCH0_SUBSIDY; // 1_050_000_000_000_000 — epic (halving)

const ord = (over: Partial<OrdOutputResponse> = {}): OrdOutputResponse => ({
  inscriptions: [],
  runes: null,
  sat_ranges: [[BLOCK1_FIRST_SAT + 1, BLOCK1_FIRST_SAT + 6]], // common (mid-block sats 2..6 of block 1)
  ...over,
});
const cat21 = (over: Partial<Cat21OrdOutputResponse> = {}): Cat21OrdOutputResponse => ({
  cats: [],
  sat_ranges: [[BLOCK1_FIRST_SAT + 1, BLOCK1_FIRST_SAT + 6]],
  ...over,
});

describe('classifyUtxoContent — the content-safety gate', () => {
  it('CLEAN: no inscription, rune, cat, or rare sat → clean, everything empty', () => {
    const r = classifyUtxoContent(ord(), cat21());
    expect(r.clean).toBe(true);
    expect(r.inscriptionIds).toEqual([]);
    expect(r.runes).toBeNull();
    expect(r.catIds).toEqual([]);
    expect(r.catSat).toBeNull();
    expect(r.rareSat).toBeNull();
  });

  it('INSCRIPTION present → NOT clean', () => {
    const id = 'a'.repeat(64) + 'i0';
    const r = classifyUtxoContent(ord({ inscriptions: [id] }), cat21());
    expect(r.clean).toBe(false);
    expect(r.inscriptionIds).toEqual([id]);
  });

  it('RUNE present → NOT clean (empty runes object stays clean)', () => {
    const withRune = classifyUtxoContent(ord({ runes: { 'UNCOMMON•GOODS': { amount: '1' } } }), cat21());
    expect(withRune.clean).toBe(false);
    expect(withRune.runes).toEqual({ 'UNCOMMON•GOODS': { amount: '1' } });

    // `{}` (upstream returned a runes field but no balances) is NOT an asset.
    const emptyRunes = classifyUtxoContent(ord({ runes: {} }), cat21());
    expect(emptyRunes.clean).toBe(true);
    expect(emptyRunes.runes).toBeNull();
  });

  it('CAT present → NOT clean, catSat read from cat21-ord (authoritative)', () => {
    const catId = 'b'.repeat(64) + 'i0';
    const r = classifyUtxoContent(
      ord(),
      cat21({ cats: [catId], sat_ranges: [[BLOCK1_FIRST_SAT + 1, BLOCK1_FIRST_SAT + 2]] }),
    );
    expect(r.clean).toBe(false);
    expect(r.catIds).toEqual([catId]);
    expect(r.catSat).toBe(BLOCK1_FIRST_SAT + 1); // first sat of cat21-ord's first range
  });

  it('RARE SAT (block-first-sat → uncommon) → NOT clean — the regtest-shaped case', () => {
    // A range that OPENS on a block-first-sat carries an uncommon sat.
    const r = classifyUtxoContent(
      ord({ sat_ranges: [[BLOCK1_FIRST_SAT, BLOCK1_FIRST_SAT + 5]] }),
      cat21(),
    );
    expect(r.clean).toBe(false);
    expect(r.rareSat).toEqual({ sat: String(BLOCK1_FIRST_SAT), block: 1, rarity: 'uncommon' });
  });

  it('multiple assets at once: a cat riding a rare sat is still NOT clean, both surfaced', () => {
    const catId = 'c'.repeat(64) + 'i0';
    const r = classifyUtxoContent(
      ord({ sat_ranges: [[BLOCK2016_FIRST_SAT, BLOCK2016_FIRST_SAT + 3]] }),
      cat21({ cats: [catId], sat_ranges: [[BLOCK2016_FIRST_SAT, BLOCK2016_FIRST_SAT + 3]] }),
    );
    expect(r.clean).toBe(false);
    expect(r.catIds).toEqual([catId]);
    expect(r.rareSat).toEqual({ sat: String(BLOCK2016_FIRST_SAT), block: 2016, rarity: 'rare' });
  });
});

describe('detectRareSat — rarity ladder over sat_ranges', () => {
  it('common range (mid-block) → null', () => {
    expect(detectRareSat([[BLOCK1_FIRST_SAT + 1, BLOCK1_FIRST_SAT + 6]])).toBeNull();
  });

  it('uncommon: opens on block 1 first sat', () => {
    expect(detectRareSat([[BLOCK1_FIRST_SAT, BLOCK1_FIRST_SAT + 5]]))
      .toEqual({ sat: String(BLOCK1_FIRST_SAT), block: 1, rarity: 'uncommon' });
  });

  it('rare: block 2016 (difficulty adjustment) first sat', () => {
    expect(detectRareSat([[BLOCK2016_FIRST_SAT, BLOCK2016_FIRST_SAT + 5]]))
      .toEqual({ sat: String(BLOCK2016_FIRST_SAT), block: 2016, rarity: 'rare' });
  });

  it('epic: block 210000 (halving) first sat', () => {
    expect(detectRareSat([[BLOCK210000_FIRST_SAT, BLOCK210000_FIRST_SAT + 5]]))
      .toEqual({ sat: String(BLOCK210000_FIRST_SAT), block: 210_000, rarity: 'epic' });
  });

  it('mythic: the genesis sat (block 0)', () => {
    expect(detectRareSat([[0, 5]])).toEqual({ sat: '0', block: 0, rarity: 'mythic' });
  });

  it('empty / undefined ranges → null', () => {
    expect(detectRareSat([])).toBeNull();
    expect(detectRareSat(undefined)).toBeNull();
  });

  it('cost tradeoff: > RARE_SAT_MAX_RANGES ranges are SKIPPED (returns null even if one is rare)', () => {
    // Documented behaviour: a pathological UTXO with too many ranges skips the
    // scan, so a rare sat there is NOT detected and classifyUtxoContent would
    // call it clean. Pinned so a future change to the cap is deliberate.
    const many: Array<readonly [number, number]> = [
      [BLOCK1_FIRST_SAT, BLOCK1_FIRST_SAT + 1], // a genuinely uncommon range...
    ];
    for (let i = 0; i < RARE_SAT_MAX_RANGES; i++) many.push([i * 2, i * 2 + 1]);
    expect(many.length).toBeGreaterThan(RARE_SAT_MAX_RANGES);
    expect(detectRareSat(many)).toBeNull();
  });
});

describe('firstSat — the cat sat (offset 0 of the first range)', () => {
  it('returns the opening sat of the first range', () => {
    expect(firstSat([[100, 200]])).toBe(100);
    expect(firstSat([[BLOCK1_FIRST_SAT, BLOCK1_FIRST_SAT + 1], [999, 1000]])).toBe(BLOCK1_FIRST_SAT);
  });

  it('null when ord supplied no ranges', () => {
    expect(firstSat(undefined)).toBeNull();
    expect(firstSat([])).toBeNull();
  });
});
