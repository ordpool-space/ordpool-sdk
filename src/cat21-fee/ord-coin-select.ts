/**
 * ord-parity coin selection + fee model.
 *
 * A byte-faithful TypeScript port of stock ord's cardinal-UTXO selection and
 * fee estimation from `ord/src/wallet/transaction_builder.rs`. We adopt ord's
 * algorithm verbatim (rather than our own largest-covering pick) so that,
 * given the same available UTXOs, an SDK-built cat-touching transaction is
 * byte-identical to what `ord wallet send` / `wallet offer` / `wallet inscribe`
 * would build — modulo the two things that MUST differ: `nLockTime=21` (our
 * bonus-cat marker) and the change output's address (the sender's own change,
 * which ord derives internally). Matching ord's selection removes the only
 * remaining source of divergence — the "no bullshit" guarantee.
 *
 * Ported constructs:
 *   - `selectCardinalUtxo` ← `TransactionBuilder::select_cardinal_utxo`
 *   - `estimateTaprootVbytes` ← `TransactionBuilder::estimate_vbytes_with`
 *   - `estimateFeeSats` ← `TransactionBuilder::estimate_fee`
 *
 * ord assumes every input is a taproot key-path spend (single 64-byte Schnorr
 * signature) because its wallets are taproot-descriptor only; the fee model
 * mirrors that assumption exactly.
 */

/** A spendable non-inscription ("cardinal") UTXO candidate. */
export interface CardinalUtxoCandidate {
  txid: string;
  vout: number;
  /** Value in sats. */
  value: number;
}

/**
 * ord's best-fit cardinal-UTXO selection
 * (`transaction_builder.rs::select_cardinal_utxo`).
 *
 * Returns the candidate whose value best matches `targetValueSats`:
 *   - `preferUnder = false` (what ord's `add_value` uses): prefer the SMALLEST
 *     candidate that is `>= target` (covers the need in a single input); if
 *     none covers, the LARGEST one under (closest), and the caller loops.
 *   - `preferUnder = true`: prefer the LARGEST candidate `<= target`; if none,
 *     the smallest over.
 *
 * Candidates are scanned in ascending outpoint order (ord iterates a
 * `BTreeSet<OutPoint>`), so ties resolve deterministically. The caller must
 * pre-exclude inscription / rune / locked UTXOs — ord skips those inline; here
 * that filtering is the caller's job (the SDK already classifies outpoints).
 *
 * Verified against ord's own `select_cardinal_utxo_prefer_under` test vectors.
 * Returns `null` when `candidates` is empty (ord's `NotEnoughCardinalUtxos`).
 */
export function selectCardinalUtxo(
  candidates: ReadonlyArray<CardinalUtxoCandidate>,
  targetValueSats: number,
  preferUnder: boolean,
): CardinalUtxoCandidate | null {
  // ord iterates a BTreeSet<OutPoint>, i.e. ascending (txid, vout). We sort a
  // copy the same way so tie-breaks match ord byte-for-byte.
  const ordered = [...candidates].sort((a, b) =>
    a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1,
  );

  const absDiff = (x: number, y: number): number => Math.abs(x - y);

  let best: CardinalUtxoCandidate | null = null;
  for (const utxo of ordered) {
    if (best === null) {
      // ord seeds best_match with the first candidate unconditionally.
      best = utxo;
      continue;
    }

    const bestValue = best.value;
    const current = utxo.value;
    const isCloser = absDiff(current, targetValueSats) < absDiff(bestValue, targetValueSats);

    const notPreferenceButCloser = preferUnder
      ? bestValue > targetValueSats && isCloser
      : bestValue < targetValueSats && isCloser;

    const isPreferenceAndCloser = preferUnder
      ? current <= targetValueSats && isCloser
      : current >= targetValueSats && isCloser;

    const newlyMeetsPreference = preferUnder
      ? bestValue > targetValueSats && current <= targetValueSats
      : bestValue < targetValueSats && current >= targetValueSats;

    if (isPreferenceAndCloser || notPreferenceButCloser || newlyMeetsPreference) {
      best = utxo;
    }
  }

  return best;
}

/** vbytes added per taproot key-path input (ord: `ADDITIONAL_INPUT_VBYTES`). */
export const ORD_ADDITIONAL_INPUT_VBYTES = 57;
/** vbytes added per output (ord: `ADDITIONAL_OUTPUT_VBYTES`). */
export const ORD_ADDITIONAL_OUTPUT_VBYTES = 43;
/** Schnorr signature size in bytes (ord: `SCHNORR_SIGNATURE_SIZE`). */
export const ORD_SCHNORR_SIGNATURE_SIZE = 64;

/**
 * Virtual size (vbytes) of a transaction with `numInputs` taproot key-path
 * inputs and the given output scriptPubKey lengths, matching ord's
 * `estimate_vbytes_with` (which builds a dummy tx: version 2, locktime 0, each
 * input carrying a single 64-byte Schnorr witness, then calls `.vsize()`).
 *
 * `outputScriptLengths` is the byte length of each output's scriptPubKey
 * (P2TR 34, P2WPKH 22, P2PKH 25, P2SH 23). We compute the BIP-141 weight and
 * round up, exactly as rust-bitcoin's `Transaction::vsize` does.
 */
export function estimateTaprootVbytes(
  numInputs: number,
  outputScriptLengths: ReadonlyArray<number>,
): number {
  const varInt = (n: number): number =>
    n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;

  // Non-witness (base) bytes.
  let base = 4; // version
  base += varInt(numInputs);
  base += numInputs * (32 + 4 + 1 + 4); // outpoint(36) + scriptSig len(0 -> 1) + sequence(4)
  base += varInt(outputScriptLengths.length);
  for (const len of outputScriptLengths) {
    base += 8 + varInt(len) + len; // value(8) + scriptPubKey len + scriptPubKey
  }
  base += 4; // locktime

  // Witness bytes: segwit marker+flag (2) + per-input taproot key-path witness
  // (stack items count 1, element length 1, 64-byte Schnorr sig).
  const witness = numInputs === 0 ? 0 : 2 + numInputs * (1 + 1 + ORD_SCHNORR_SIGNATURE_SIZE);

  const weight = base * 4 + witness;
  return Math.ceil(weight / 4);
}

/**
 * ord's fee for a taproot-input transaction: `feeRatePerVb × vsize`, rounded
 * up to the next sat (`estimate_fee` → `FeeRate::fee`, which is
 * ceil(vsize × fee_rate)).
 */
export function estimateFeeSats(
  numInputs: number,
  outputScriptLengths: ReadonlyArray<number>,
  feeRatePerVb: number,
): number {
  return Math.ceil(estimateTaprootVbytes(numInputs, outputScriptLengths) * feeRatePerVb);
}
