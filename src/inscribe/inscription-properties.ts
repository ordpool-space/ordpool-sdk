import { compressBrotliSync } from './brotli-wasm-encoder';
import { CborOrderedMap, encodeCborDeterministic } from './inscription-cbor';
import { encodeInscriptionId } from './inscription-envelope';

/**
 * Typed inputs for ord's `properties` field (envelope tag `0x11`): the
 * gallery an inscription belongs to, its title and its traits.
 *
 * ord takes these as `--gallery <ID> --gallery <ID> --title "..."`, and in a
 * batchfile as `gallery:`, `title:` and `traits:`. Built by hand they are an
 * integer-keyed CBOR map, with a silent failure for a plain object (text
 * keys, which ord drops); these types encode them exactly as ord does.
 *
 * The raw `properties` input on the inscribe helpers stays as the escape
 * hatch for pre-encoded bytes.
 */

/**
 * A trait value, ord's `Trait`: a bool, an integer (i64), null or a string.
 * Integers beyond the safe-integer range go in as `bigint`.
 */
export type TraitValue = boolean | number | bigint | null | string;

/**
 * Traits in their order, ord's `Traits` (properties.rs): a list of
 * name/value pairs written as a CBOR map in exactly that order. Pass a `Map`
 * or an array of pairs; a plain object would reorder integer-like names.
 */
export type TraitsInput = ReadonlyMap<string, TraitValue> | ReadonlyArray<readonly [string, TraitValue]>;

/** One entry in a gallery. A bare string is the common case. */
export interface GalleryItem {
  /** Inscription id, `<txid>i<index>`. */
  id: string;
  /** Per-item title, ord's `Item.attributes.title`. */
  title?: string;
  /** Per-item traits, ord's `Item.attributes.traits`. */
  traits?: TraitsInput;
}

export interface InscriptionPropertiesInput {
  /** Inscriptions this one is a gallery of. Bare ids or items with titles. */
  gallery?: ReadonlyArray<string | GalleryItem>;
  /**
   * The inscription's own title, ord's top-level `Attributes.title`. An
   * empty string is still a title, and ord writes it.
   */
  title?: string;
  /** The inscription's traits, ord's top-level `Attributes.traits` (batchfile `traits:`). */
  traits?: TraitsInput;
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function traitEntries(traits: TraitsInput | undefined): Array<[string, TraitValue]> {
  if (traits === undefined) return [];
  const entries: Array<[string, TraitValue]> = traits instanceof Map
    ? [...traits.entries()]
    : (traits as ReadonlyArray<readonly [string, TraitValue]>).map(([k, v]) => [k, v]);
  const names = new Set<string>();
  for (const [name, value] of entries) {
    if (names.has(name)) throw new Error(`duplicate trait: ${name}`);
    names.add(name);
    const integer = typeof value === 'bigint' ? value : typeof value === 'number' ? value : undefined;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new Error(`trait ${name}: ${value} is not an integer; ord's traits take bools, integers, null and strings`);
    }
    if (integer !== undefined && (BigInt(integer) < I64_MIN || BigInt(integer) > I64_MAX)) {
      throw new Error(`trait ${name}: ${integer} is outside i64`);
    }
  }
  return entries;
}

/**
 * ord's `Attributes`: `{ 0: title, 1: traits }`, each only when present
 * (traits are skipped when empty). `undefined` when there is neither.
 */
function attributes(title: string | undefined, traits: TraitsInput | undefined): Map<number, unknown> | undefined {
  const entries = traitEntries(traits);
  if (title === undefined && entries.length === 0) return undefined;
  const m = new Map<number, unknown>();
  if (title !== undefined) m.set(0, title);
  if (entries.length > 0) m.set(1, new CborOrderedMap(entries));
  return m;
}

function normalise(entry: string | GalleryItem): GalleryItem {
  return typeof entry === 'string' ? { id: entry } : entry;
}

/**
 * ord's INLINE form: each gallery item carries its own id.
 *
 *   { 0: [ { 0: <id bytes>, 1?: attributes } … ], 1?: attributes }
 *
 * where attributes is `{ 0?: title, 1?: traits }`.
 */
function inlineCbor(gallery: GalleryItem[], attrs: InscriptionPropertiesInput): Uint8Array {
  const top = new Map<number, unknown>();
  if (gallery.length > 0) {
    top.set(0, gallery.map(item => {
      const m = new Map<number, unknown>([[0, encodeInscriptionId(item.id)]]);
      const a = attributes(item.title, item.traits);
      if (a) m.set(1, a);
      return m;
    }));
  }
  const a = attributes(attrs.title, attrs.traits);
  if (a) top.set(1, a);
  return encodeCborDeterministic(top);
}

/**
 * ord's PACKED form: ids are stripped from the items and the raw 32-byte
 * txids are concatenated into one byte string under key 2. An item keeps only
 * its title and, when non-zero, its inscription index.
 *
 *   { 0: [ { 1?: attributes, 2?: index } … ], 1?: attributes, 2: <txids> }
 *
 * The txid is the first 32 bytes of the id encoding, already reversed into
 * ord's internal byte order.
 */
function packedCbor(gallery: GalleryItem[], attrs: InscriptionPropertiesInput): Uint8Array {
  const top = new Map<number, unknown>();
  if (gallery.length > 0) {
    const txids = new Uint8Array(gallery.length * 32);
    top.set(0, gallery.map((item, i) => {
      const idBytes = encodeInscriptionId(item.id);
      txids.set(idBytes.subarray(0, 32), i * 32);
      const m = new Map<number, unknown>();
      const a = attributes(item.title, item.traits);
      if (a) m.set(1, a);
      const index = Number(item.id.slice(item.id.lastIndexOf('i') + 1));
      // Index 0 is the common case and ord omits it, so an ordinary gallery
      // item packs to an empty map.
      if (index !== 0) m.set(2, index);
      return m;
    }));
    top.set(2, txids);
  }
  const a = attributes(attrs.title, attrs.traits);
  if (a) top.set(1, a);
  return encodeCborDeterministic(top);
}

/**
 * ord refuses to compress properties larger than this
 * (cat21-ord src/inscriptions/inscription.rs, MAX_COMPRESSED_PROPERTIES_SIZE).
 */
const MAX_COMPRESSED_PROPERTIES_SIZE = 4_000_000;

/**
 * ord refuses compressed properties that shrink by more than 30:1, checked
 * with integer division (MAX_PROPERTIES_COMPRESSION_RATIO, same file).
 */
const MAX_PROPERTIES_COMPRESSION_RATIO = 30;

/** Properties bytes for tag 0x11, and `'br'` for tag 0x13 when compressed. */
export interface EncodedInscriptionProperties {
  properties: Uint8Array;
  propertyEncoding?: 'br';
}

/**
 * ord's `compress_properties`: brotli (generic mode), used only when strictly
 * smaller, with ord's size and ratio limits. Returns `undefined` when the
 * compressed form is not smaller.
 */
function compressProperties(cbor: Uint8Array): Uint8Array | undefined {
  const len = cbor.length;
  if (len > MAX_COMPRESSED_PROPERTIES_SIZE) {
    throw new Error(`properties size of ${len} bytes exceeds ${MAX_COMPRESSED_PROPERTIES_SIZE} byte limit`);
  }
  const compressed = compressBrotliSync(cbor, 'generic');
  if (compressed.length >= len) return undefined;
  if (Math.floor(len / compressed.length) > MAX_PROPERTIES_COMPRESSION_RATIO) {
    throw new Error(`property compression over ${MAX_PROPERTIES_COMPRESSION_RATIO}:1`);
  }
  return compressed;
}

/**
 * Encode properties exactly as ord writes them on-chain.
 *
 * ord builds BOTH forms and keeps the SMALLER one
 * (`Inscription::encode_properties`, `min_by_key(len)`), and on a tie keeps
 * the EARLIER candidate, because `min_by_key` returns the first minimum. That
 * rule is the whole difficulty: a one-item gallery ties at the same length
 * and ships inline, while a two-item gallery ships packed because the shared
 * txid table beats two per-item ids. Neither form alone matches ord across
 * gallery sizes.
 *
 * With `compress` (ord's `--compress`), the brotli-compressed inline and
 * packed forms join the candidates, in that order, after the two plain ones;
 * a compressed winner also sets tag 0x13 to `br`. Compressing needs the
 * brotli wasm loaded first (`loadBrotliWasm`), because this runs inside the
 * synchronous transaction builder.
 *
 * Returns `undefined` when there is nothing to encode, matching ord, which
 * omits the tag entirely rather than writing an empty map.
 */
export function encodeInscriptionProperties(
  input: InscriptionPropertiesInput,
  options: { compress?: boolean } = {},
): EncodedInscriptionProperties | undefined {
  const gallery = (input.gallery ?? []).map(normalise);
  if (gallery.length === 0 && attributes(input.title, input.traits) === undefined) return undefined;

  const inline = inlineCbor(gallery, input);
  const packed = packedCbor(gallery, input);
  const candidates: EncodedInscriptionProperties[] = [{ properties: inline }, { properties: packed }];
  if (options.compress) {
    for (const cbor of [inline, packed]) {
      const compressed = compressProperties(cbor);
      if (compressed !== undefined) candidates.push({ properties: compressed, propertyEncoding: 'br' });
    }
  }

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.properties.length < best.properties.length) best = candidate;
  }
  return best;
}

/**
 * The uncompressed properties bytes ord writes, or `undefined` when there is
 * nothing to encode. See {@link encodeInscriptionProperties}.
 */
export function packInscriptionProperties(
  input: InscriptionPropertiesInput,
): Uint8Array | undefined {
  return encodeInscriptionProperties(input)?.properties;
}
