/**
 * The postage we use for an output we CREATE from scratch: 546 sats.
 *
 * **This is a default, not an invariant.** A cat can live on a UTXO of any
 * size: anyone can mint one by putting `nLockTime=21` on an output of any
 * value, and our own transfer and offer builders PRESERVE whatever size the
 * cat already sits on rather than normalising it. Never assume a cat is 546,
 * never assert it, and never detect a cat by its size. Cat membership comes
 * from the cat index; see the HQ rule "a cat UTXO's size is set ONCE at mint
 * and PRESERVED by every later operation".
 *
 * Why 546 when we do choose: it is the cheapest value that relays everywhere.
 * It is the conservative cross-address-type dust floor (P2TR 330, P2WPKH 294,
 * P2SH 540, so 546 clears them all), which makes a freshly created output
 * spendable into any address type without re-checking dust, and it is the
 * common denominator most tools in this ecosystem already use. Cheaper
 * postage is the point: the sats go to the holder rather than into padding.
 *
 * Where it applies: the mint's fresh cat output, and the inscribe flow's
 * fresh inscription output. Both are outputs nothing existed on before.
 *
 * Where it does NOT apply: anything that moves an existing cat or
 * inscription. Those preserve. `buildCat21TransferPsbt` takes an optional
 * `targetPostageSats` for the deliberate grow and shrink cases.
 */
export const CAT21_POSTAGE_SATS = 546;
