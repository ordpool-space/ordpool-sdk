/**
 * cat21-ord answers for one minted cat, verbatim.
 *
 * Source: cat21-ord at 486f5338ae45e2329423523c5396d16542eae09d (CAT21_ORD_SHA in
 * e2e/build-pins.env) running `--regtest --index-cat21 --index-sats
 * --index-addresses` in the SDK's e2e/docker-compose.regtest.yml stack, after
 * `seedListedCat` minted three cats (`/status`: `"cats":3`). Captured
 * 2026-10-11 with `curl -H 'Accept: application/json'`. The cat is the third
 * one minted, so its number is 2, not the index in its id (`i0`).
 */

/** `GET /output/1b93…9d37:0`: the mint's output 0, carrying cat #2. */
export const cat21OrdOutputWithCatFixture = {
  address: 'bcrt1p4sd4g25lc6a5nxf73xuu2dughw5xs79dcfzpqvafg2x2nc9ta5pqq987la',
  confirmations: 1,
  indexed: true,
  cats: ['1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37i0'],
  outpoint: '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37:0',
  runes: null,
  sat_ranges: [[9997991540, 9997992086]],
  script_pubkey: '5120ac1b542a9fc6bb49993e89b9c53788bba86878adc2441033a9428ca9e0abed02',
  spent: false,
  transaction: '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37',
  value: 546,
} as const;

/** `GET /output/1b93…9d37:1`: the same mint's change output, no cat. */
export const cat21OrdOutputWithoutCatsFixture = {
  address: 'bcrt1qgv7w5fjzz0s9wfguuye2xvt94vk27ne4urmzmu',
  confirmations: 1,
  indexed: true,
  cats: [],
  outpoint: '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37:1',
  runes: null,
  sat_ranges: [[9997992086, 9998990540]],
  script_pubkey: '0014433cea264213e057251ce132a33165ab2caf4f35',
  spent: false,
  transaction: '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37',
  value: 998454,
} as const;

/** `GET /inscription/1b93…9d37i0`: cat #2. */
export const cat21OrdCatInscriptionFixture = {
  address: 'bcrt1p4sd4g25lc6a5nxf73xuu2dughw5xs79dcfzpqvafg2x2nc9ta5pqq987la',
  charms: [],
  child_count: 0,
  children: [],
  content_length: null,
  content_type: null,
  effective_content_type: null,
  fee: 1000,
  height: 107,
  id: '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37i0',
  metaprotocol: null,
  next: null,
  number: 2,
  parents: [],
  previous: '641a7befa2f02ff4dfecf38972aee36597b18a24e51724ef9859229855316614i0',
  properties: { gallery: [], attributes: { title: null, traits: {} } },
  rune: null,
  sat: 9997991540,
  satpoint: '1b93c1483cce1bca58d4dee25404865ec54f2a394f63e50f90a6155aac469d37:0:0',
  timestamp: 1791728216,
  value: 546,
  weight: 610,
  size: 235,
  minted_by: 'bcrt1p4sd4g25lc6a5nxf73xuu2dughw5xs79dcfzpqvafg2x2nc9ta5pqq987la',
  block_hash: '1d89b70c3b733978cb2f8fbdfe878d23cfc2ab5481559393aae431de9f9e75a1',
} as const;

/** The plain-text body of cat21-ord's 404 for an output it never saw (`/output/abab…abab:0`). */
export const cat21OrdOutputNotFoundBody = 'output abababababababababababababababababababababababababababababababab:0 not found';
