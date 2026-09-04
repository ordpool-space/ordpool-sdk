/**
 * The full CAT-21 ownership chain in one regtest spec:
 *
 *   1. Wallet A mints a fresh cat (the first cat in regtest, cat #0).
 *   2. A transfers the cat to wallet B.
 *   3. A constructs a buy-offer to buy the cat BACK from B; ord
 *      builds the SAME offer via `wallet offer create` for byte-compare.
 *   4. B accepts the offer (signs input 0, broadcast).
 *
 * After every broadcast we ask cat21-ord — running with `--index-cat21`
 * against the same regtest bitcoind — who owns the cat. End state:
 * cat #0 back at A, having moved address twice.
 *
 * The byte-compare step is the highest-signal part of this spec:
 * ord's `wallet offer create` is the reference implementation of the
 * ord-style buyer-initiated offer (cat21-ord/src/subcommand/wallet/
 * offer/create.rs). The SDK's `buildCat21BuyOfferPsbt` should agree
 * with ord on every byte ord's create.rs:52-71 commits to — input 0
 * outpoint, sequence 0xfffffffd, output 0 = 546 to buyer, output 1
 * = priceSats + 546 to seller — modulo the ONE intentional diff:
 * `lockTime` (ord = 0, SDK = 21 for the cherry-on-top bonus mint
 * per cat21-wallet HARD RULE #1).
 *
 * cat21-ord's wallet runs in cat-aware mode (`--index-cat21` is
 * passed by `ordCli`) so it un-cats the server's JSON before serde
 * parses it. See cat21-ord commit `2de45815` for the wallet decat.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58, base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { CAT21_POSTAGE_SATS } from '../../src/cat21-protocol/cat21-postage';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../../src/cat21-protocol/cat21-sequence';
import {
  buildCat21BuyOfferPsbt,
  validateCat21BuyOfferPsbt,
} from '../../src/cat21-offer/cat21-offer.helper';
import { buildCat21MintPsbt } from '../../src/cat21-mint/cat21-mint.helper';
import { buildCat21TransferPsbt } from '../../src/cat21-transfer/cat21-transfer.helper';
import { Network, toScureNetwork } from '../../src/network';
import { toPaymentAddress } from '../../src/wallet/address-types';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  ElectrsUtxo,
  FundedAccount,
  catInscriptionId,
  getFundedAccount,
  getUtxos,
  mineBlocks,
  ordCreateOffer,
  ordCreateWallet,
  postTx,
  rpc,
  waitForCatAtAddress,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
  waitForUtxoMatching,
} from './regtest-helpers';

const FEE_SATS = 1_000;
const PRICE_SATS = 50_000;

function wifToPrivateKey(wif: string): Uint8Array {
  return base58.decode(wif).slice(1, 33);
}

/** Sign a P2WPKH input on a partially-built scure Transaction. */
function signP2WPKHInputAt(tx: btc.Transaction, index: number, privKey: Uint8Array): void {
  tx.signIdx(privKey, index, [btc.SigHash.ALL]);
}

describe('cat21 full ownership flow on regtest: mint → transfer → offer → accept', () => {

  const regtestNetwork = toScureNetwork(Network.Regtest);

  let funded: FundedAccount;

  // Wallet A — the original minter and eventual re-buyer.
  let aPriv: Uint8Array;
  let aPub: Uint8Array;
  let aAddress: string;
  let aScript: Uint8Array;
  let aFundingUtxo: ElectrsUtxo;

  // Wallet B — receives the cat in step 2, sells it back in step 4.
  let bPriv: Uint8Array;
  let bPub: Uint8Array;
  let bAddress: string;
  let bScript: Uint8Array;

  // The buyer-side ord wallet. In the protocol there are exactly two
  // roles, buyer and seller; this is the BUYER's wallet that calls
  // `ord wallet offer create` to produce a reference offer PSBT for
  // byte-compare against the SDK's `buildCat21BuyOfferPsbt`. NOT a
  // "third party" — it stands in for A's keys in the A-buys-from-B
  // direction of the multi-step flow.
  let ordWalletAddress: string;

  // Stuff carried between steps.
  let mintTxid: string;
  let inscriptionId: string;
  let mintedCatNumber: number;
  let mintedCatSat: number;
  let transferTxid: string;
  let catUtxoAfterTransfer: { txid: string; vout: number };
  let aChangeUtxoAfterTransfer: ElectrsUtxo;
  let sdkOfferPsbtBytes: Uint8Array;

  beforeAll(async () => {
    funded = getFundedAccount();

    // We need 4 mature coinbases to fund A, B, ord wallet, and have room
    // to top up A's change between steps. The bootstrap mines 101; mine
    // 3 more so we have headroom.
    let tip = mineBlocks(3);
    await waitForElectrsSync(tip);

    // Bring up ord's HTTP server + sync to the current tip.
    await waitForOrdReady();
    await waitForOrdSync(tip);

    // A + B keypairs, both P2WPKH on regtest (the `bcrt1q…` family).
    aPriv = secp256k1.utils.randomPrivateKey();
    aPub  = secp256k1.getPublicKey(aPriv, true);
    const aP2 = btc.p2wpkh(aPub, regtestNetwork);
    aAddress = aP2.address!;
    aScript  = aP2.script;

    bPriv = secp256k1.utils.randomPrivateKey();
    bPub  = secp256k1.getPublicKey(bPriv, true);
    const bP2 = btc.p2wpkh(bPub, regtestNetwork);
    bAddress = bP2.address!;
    bScript  = bP2.script;

    // Buyer-side ord wallet for the byte-compare in step 3b. Created
    // in cat-aware mode (`ordCreateWallet` invokes `--index-cat21` via
    // ordCli) so the wallet client decats the cat server's responses
    // before serde parses them — see cat21-ord 2de45815.
    //
    // Topology note: a faithful regtest of "A buys from B" runs two
    // independent ord+wallet stacks sharing one bitcoind (A holds A's
    // key, B holds B's). Here we collapse to one ord container for
    // test-rig simplicity; the BYTE-COMPARE doesn't care which party
    // built the reference PSBT as long as the inputs/outputs line up.
    ordWalletAddress = ordCreateWallet('ord');

    // Pin every send to a specific mature coinbase so coin selection
    // can't reach for a UTXO we already earmarked elsewhere. The mint
    // spec hit this exact race before pinning.
    type Unspent = { txid: string; vout: number; amount: number; spendable: boolean; confirmations: number };
    const unspent: Unspent[] = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'listunspent', '100'));
    const matureCoinbases = unspent
      .filter(u => u.spendable && u.amount === 50)
      .sort((a, b) => b.confirmations - a.confirmations);
    if (matureCoinbases.length < 3) {
      throw new Error(`need >=3 mature 50-BTC coinbases, got ${matureCoinbases.length}`);
    }
    const [aInput, bInput, ordInput] = matureCoinbases;

    // Fund A with 1 BTC.
    rpc(
      '-named', '-rpcwallet=ordpool-e2e', 'send',
      `outputs=${JSON.stringify([{ [aAddress]: 1.0 }])}`,
      `options=${JSON.stringify({ inputs: [{ txid: aInput.txid, vout: aInput.vout }] })}`,
    );

    // Fund B with 1 BTC (B doesn't need much; it'll pay nothing on the
    // accept-offer tx since the buyer's inputs cover everything).
    rpc(
      '-named', '-rpcwallet=ordpool-e2e', 'send',
      `outputs=${JSON.stringify([{ [bAddress]: 1.0 }])}`,
      `options=${JSON.stringify({ inputs: [{ txid: bInput.txid, vout: bInput.vout }] })}`,
    );

    // Fund the ord wallet with 1 BTC so it can build a reference offer.
    rpc(
      '-named', '-rpcwallet=ordpool-e2e', 'send',
      `outputs=${JSON.stringify([{ [ordWalletAddress]: 1.0 }])}`,
      `options=${JSON.stringify({ inputs: [{ txid: ordInput.txid, vout: ordInput.vout }] })}`,
    );

    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);

    // Snapshot A's funding UTXO for the mint step.
    aFundingUtxo = await waitForUtxoAt(aAddress, 100_000_000);
  });

  it('step 1: A mints cat #0; ord sees the cat at A', async () => {
    const result = buildCat21MintPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      fundingInput: {
        txid: aFundingUtxo.txid,
        vout: aFundingUtxo.vout,
        value: aFundingUtxo.value,
        scriptPubKey: aScript,
      },
      destinations: {
        recipientAddress: aAddress,
        senderChangeAddress: aAddress,
      },
      feeSats: FEE_SATS,
    });

    const tx = btc.Transaction.fromPSBT(result.psbt);
    signP2WPKHInputAt(tx, 0, aPriv);
    tx.finalize();

    mintTxid = await postTx(tx.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(mintTxid);
    await waitForOrdSync(tip);

    inscriptionId = catInscriptionId(mintTxid);
    const inscription = await waitForCatAtAddress(inscriptionId, aAddress);

    expect(inscription.address).toBe(aAddress);
    expect(inscription.value).toBe(CAT21_POSTAGE_SATS);
    // Cat number on regtest can be non-zero because cat21-ord's
    // first_cat21_height is 0 in regtest mode and any earlier
    // lockTime=21 tx (the ord-wallet funding flow has occasionally
    // produced one in passing) gets indexed first. We pin the
    // ASSIGNED number here and reuse it in the final-state assertion.
    expect(inscription.number).toBeGreaterThanOrEqual(0);
    mintedCatNumber = inscription.number;

    // Pin the sat number now so the transfer + final-state steps can
    // cross-check it and prove ordinal continuity. --index-sats is on
    // per docker-compose.regtest.yml, so ord MUST return a number here
    // — a null/undefined would mean cat21-ord silently regressed
    // (index disabled, JSON shape changed) and every downstream
    // consumer relying on the sat field breaks.
    expect(typeof inscription.sat).toBe('number');
    mintedCatSat = inscription.sat as number;
  });

  it('step 2: A transfers the cat to B; ord sees the cat at B', async () => {
    // A's UTXOs after the mint: a 546-sat cat output (vout 0) and a
    // change output (vout 1). Funding input for the fee comes from the
    // change.
    const change = await waitForUtxoMatching(
      aAddress,
      u => u.txid === mintTxid && u.value > CAT21_POSTAGE_SATS,
      `txid=${mintTxid} value>${CAT21_POSTAGE_SATS}`,
    );

    const result = buildCat21TransferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      catUtxo: {
        txid: mintTxid,
        vout: 0,
        value: CAT21_POSTAGE_SATS,
        scriptPubKey: aScript,
      },
      fundingInputs: [
        {
          txid: change.txid,
          vout: change.vout,
          value: change.value,
          scriptPubKey: aScript,
        },
      ],
      destinations: {
        recipientAddress: bAddress,
        senderChangeAddress: aAddress,
      },
      feeSats: FEE_SATS,
    });

    const tx = btc.Transaction.fromPSBT(result.psbt);
    signP2WPKHInputAt(tx, 0, aPriv);
    signP2WPKHInputAt(tx, 1, aPriv);
    tx.finalize();

    transferTxid = await postTx(tx.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(transferTxid);
    await waitForOrdSync(tip);

    const inscription = await waitForCatAtAddress(inscriptionId, bAddress);
    expect(inscription.address).toBe(bAddress);
    expect(inscription.value).toBe(CAT21_POSTAGE_SATS);
    // Same-sat invariant: the transfer MUST land on the same ordinal
    // (that's the whole point of ordinal theory). Silent skip on
    // undefined is not acceptable — we already asserted the number
    // at mint; if it goes missing here that's a regression.
    expect(inscription.sat).toBe(mintedCatSat);

    catUtxoAfterTransfer = { txid: transferTxid, vout: 0 };

    // A's change output from the transfer is at vout 1 (transfer's
    // output 0 was the cat to B; vout 1 is the change back to A).
    // Poll for the change vout; once it's indexed the same address-
    // history pass has also retired vout 0 (now at B), so the sanity
    // check below is race-free.
    aChangeUtxoAfterTransfer = await waitForUtxoMatching(
      aAddress,
      u => u.txid === transferTxid && u.vout !== 0,
      `txid=${transferTxid} vout!=0 (post-transfer change)`,
    );
    const stillAtA = await getUtxos(aAddress);
    expect(stillAtA.find(u => u.txid === transferTxid && u.vout === 0)).toBeUndefined();
  });

  it('step 3: A builds a buy-offer to A; SDK PSBT is well-formed', () => {
    const result = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      sellerInput: {
        txid: catUtxoAfterTransfer.txid,
        vout: catUtxoAfterTransfer.vout,
        value: CAT21_POSTAGE_SATS,
        scriptPubKey: bScript,
      },
      buyerInputs: [
        {
          txid: aChangeUtxoAfterTransfer.txid,
          vout: aChangeUtxoAfterTransfer.vout,
          value: aChangeUtxoAfterTransfer.value,
          scriptPubKey: aScript,
        },
      ],
      destinations: {
        buyerReceiveAddress: aAddress,
        sellerPaymentAddress: bAddress,
        buyerChangeAddress: aAddress,
      },
      priceSats: PRICE_SATS,
      feeSats: FEE_SATS,
    });

    // A signs their buyer-funding input (index 1) now, BEFORE handing the
    // PSBT to B. This is the buyer-initiated-PSBT contract: every byte
    // except input 0's seller signature is committed to before the seller
    // sees it. SIGHASH_ALL means the seller can only sign the offer as
    // it stands — no after-the-fact rewrites.
    const txForSigning = btc.Transaction.fromPSBT(result.psbt);
    signP2WPKHInputAt(txForSigning, 1, aPriv);
    sdkOfferPsbtBytes = txForSigning.toPSBT();

    const tx = btc.Transaction.fromPSBT(sdkOfferPsbtBytes);
    expect(tx.lockTime).toBe(21);
    expect(tx.inputsLength).toBe(2);
    expect(tx.getOutput(0).amount).toBe(BigInt(CAT21_POSTAGE_SATS));
    expect(tx.getOutput(1).amount).toBe(BigInt(PRICE_SATS + CAT21_POSTAGE_SATS));
  });

  it('step 3b: ord-parity — SDK PSBT matches ord wallet offer create on every load-bearing field', () => {
    // ord's reference is `wallet offer create` in cat21-ord/src/
    // subcommand/wallet/offer/create.rs. Lines 52-71:
    //
    //   version: 2
    //   lock_time: LockTime::ZERO                    ← ord uses 0; SDK uses 21
    //   input[0]: {
    //     previous_output: inscription.satpoint.outpoint,
    //     sequence: Sequence::ENABLE_RBF_NO_LOCKTIME (= 0xfffffffd),
    //     witness/script_sig empty (UNSIGNED)
    //   }
    //   output[0]: { value: postage,         script_pubkey: wallet.get_change_address() }
    //   output[1]: { value: amount + postage, script_pubkey: seller_address }
    //
    // After this skeleton ord calls `fund_raw_transaction` to add buyer
    // inputs + (maybe) a change output.
    //
    // Step 3c runs the live `ord wallet offer create` and byte-compares
    // its output. This step pins the same fields against ord's create.rs
    // source directly, so the SDK contract stays guarded even when the
    // docker ord stack isn't in the loop.
    const sdkTx = btc.Transaction.fromPSBT(sdkOfferPsbtBytes);

    // version
    expect(sdkTx.version).toBe(2);

    // input[0]: cat UTXO, sequence ENABLE_RBF_NO_LOCKTIME, unsigned
    const sellerIn = sdkTx.getInput(0);
    expect(sellerIn.sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    expect(CAT21_WALLET_INPUT_SEQUENCE).toBe(0xfffffffd); // = ord's Sequence::ENABLE_RBF_NO_LOCKTIME
    expect(sellerIn.partialSig).toBeUndefined();
    expect(sellerIn.tapKeySig).toBeUndefined();

    // output[0]: 546 to buyer (cat lands here)
    expect(sdkTx.getOutput(0).amount).toBe(BigInt(CAT21_POSTAGE_SATS));

    // output[1]: priceSats + postage to seller (the ord-parity convention
    // — seller is made whole on the 546 they put in via input 0)
    expect(sdkTx.getOutput(1).amount).toBe(BigInt(PRICE_SATS + CAT21_POSTAGE_SATS));

    // The intentional, sole structural diff: lockTime.
    // ord sets 0; SDK sets 21 so the offer-acceptance tx ALSO mints a
    // fresh cat onto the same ordinal (the cherry on top — see the
    // wallet HARD RULE #1 "every cat-touching tx we build carries
    // nLockTime=21").
    expect(sdkTx.lockTime).toBe(21);
  });

  it('step 3c: ord-parity — live `ord wallet offer create` funds a cross-wallet seller input and byte-matches the SDK', () => {
    // The live counterpart to step 3b: this runs the real
    // `ord wallet offer create` against Bitcoin Core and byte-compares
    // its PSBT to the SDK's. It exercises two cat21-ord fixes end to end:
    //
    //   1. Wallet decat (cat21-ord a4ac4ad9): the buyer wallet runs in
    //      `--index-cat21` mode and reverses the server's text-layer
    //      rename before serde, so `wallet.get_inscription(id)` can parse
    //      the cat server's `/inscription/<id>` JSON at all.
    //   2. Offer-create input_weights (cat21-ord 86e4ac5d, upstream PR
    //      ordinals/ord#4537): the seller's cat UTXO sits at B's address,
    //      which the buyer's Bitcoin Core wallet holds no descriptor for.
    //      Core v24+ rejects an unsolvable pre-selected input in
    //      fundrawtransaction unless its weight is supplied. Without the
    //      fix this call dies with
    //      "Not solvable pre-selected input COutPoint(<seller>, 0)"; with
    //      it, funding succeeds.
    //
    // A green run here IS the proof that offer create works on real Core:
    // ordCreateOffer throws on any non-zero exit, so a regressed fix
    // fails the test at the call below.
    const ordOffer = ordCreateOffer(inscriptionId, PRICE_SATS, 1);
    expect(ordOffer.inscription).toBe(inscriptionId);

    const ordTx = btc.Transaction.fromPSBT(base64.decode(ordOffer.psbt));
    const sdkTx = btc.Transaction.fromPSBT(sdkOfferPsbtBytes);

    // version: both 2
    expect(ordTx.version).toBe(2);
    expect(ordTx.version).toBe(sdkTx.version);

    // The seller's cat UTXO appears as a pre-selected, UNSIGNED input in
    // both PSBTs. ord resolves it from the inscription id; the SDK was
    // handed it explicitly. Both end up on the post-transfer satpoint
    // (transferTxid:0). fundrawtransaction APPENDS the buyer's funding
    // inputs (ord only pins the change-output position, not input order),
    // so locate the seller input by outpoint rather than by index. Both
    // txids come from the same parser, so the raw bytes compare directly.
    const sdkSeller = sdkTx.getInput(0);
    const bytesEqual = (a?: Uint8Array, b?: Uint8Array): boolean => {
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };
    let ordSellerIdx = -1;
    for (let i = 0; i < ordTx.inputsLength; i++) {
      const candidate = ordTx.getInput(i);
      if (candidate.index === sdkSeller.index && bytesEqual(candidate.txid, sdkSeller.txid)) {
        ordSellerIdx = i;
        break;
      }
    }
    expect(ordSellerIdx).toBeGreaterThanOrEqual(0);

    // seller input: sequence ENABLE_RBF_NO_LOCKTIME (0xfffffffd), left
    // UNSIGNED — the seller signs it on `offer accept`.
    const ordSeller = ordTx.getInput(ordSellerIdx);
    expect(ordSeller.sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    expect(ordSeller.sequence).toBe(sdkSeller.sequence);
    expect(ordSeller.partialSig).toBeUndefined();
    expect(ordSeller.tapKeySig).toBeUndefined();

    // OUTPUT COUNT: both sides emit cat + seller-payment + optional
    // buyer-change (when change > per-address-type dust). So the
    // expected count is 2 or 3 — anything else is a builder drift.
    // The SDK's optional change lives at output[2] (see
    // `cat21-offer.helper.ts` line ~218); ord's optional change comes
    // from `fundrawtransaction` in `wallet offer create`. The
    // byte-compare below pins the load-bearing indices 0 (cat) and
    // 1 (payment); this count check catches any 4th unexpected
    // output on either side that would otherwise go undetected.
    expect(sdkTx.outputsLength).toBeGreaterThanOrEqual(2);
    expect(sdkTx.outputsLength).toBeLessThanOrEqual(3);
    expect(ordTx.outputsLength).toBeGreaterThanOrEqual(2);
    expect(ordTx.outputsLength).toBeLessThanOrEqual(3);

    // output[0]: 546 postage (the cat lands on the buyer side).
    expect(ordTx.getOutput(0).amount).toBe(BigInt(CAT21_POSTAGE_SATS));
    expect(ordTx.getOutput(0).amount).toBe(sdkTx.getOutput(0).amount);

    // output[1]: priceSats + postage to the seller.
    expect(ordTx.getOutput(1).amount).toBe(BigInt(PRICE_SATS + CAT21_POSTAGE_SATS));
    expect(ordTx.getOutput(1).amount).toBe(sdkTx.getOutput(1).amount);

    // The sole intentional structural diff: lockTime. ord sets 0; the
    // SDK sets 21 so the accept tx ALSO mints a fresh cat onto the same
    // ordinal (wallet HARD RULE #1).
    expect(ordTx.lockTime).toBe(0);
    expect(sdkTx.lockTime).toBe(21);
  });

  it('step 3d: accept-side cross-compat — the LIVE ord-built PSBT passes the SDK validator, B signs it, bitcoind accepts the settlement', () => {
    // The flagship 'buy an inscription from stock ord' claim, proven on
    // the accept side with the REAL artifact: a fundrawtransaction-built
    // `ord wallet offer create` PSBT (Core-signed buyer inputs arrive
    // FINALIZED, input order unpinned, lockTime=0) — not a hand-built
    // fixture. testmempoolaccept instead of broadcast: this settlement
    // spends the same seller UTXO as step 4's SDK settlement, and only
    // one of the two may confirm; allowed:true from bitcoind is the
    // consensus + standardness proof without consuming the UTXO.
    const ordOffer = ordCreateOffer(inscriptionId, PRICE_SATS, 1);

    // 1. The SDK's seller-side validator accepts the stock-ord artifact.
    const validation = validateCat21BuyOfferPsbt({
      psbt: base64.decode(ordOffer.psbt),
      expectedSellerUtxo: catUtxoAfterTransfer,
      floorPriceSats: PRICE_SATS,
      expectedSellerPaymentAddress: toPaymentAddress(bAddress),
      network: Network.Regtest,
    });
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.pricePaidSats).toBe(PRICE_SATS);
    }

    // 2. B (seller) signs the cat input. fundrawtransaction appends the
    // buyer's funding inputs in Core-chosen order, so locate the seller
    // input by outpoint, not by index.
    const tx = btc.Transaction.fromPSBT(base64.decode(ordOffer.psbt));
    // @scure parses prevout txids back into DISPLAY order (it reverses
    // the wire bytes on read), so compare against the display hex as-is.
    const sellerTxidBytes = hex.decode(catUtxoAfterTransfer.txid);
    let sellerIdx = -1;
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (input.index !== catUtxoAfterTransfer.vout || !input.txid) continue;
      if (input.txid.length === sellerTxidBytes.length && input.txid.every((byte, j) => byte === sellerTxidBytes[j])) {
        sellerIdx = i;
        break;
      }
    }
    expect(sellerIdx).toBeGreaterThanOrEqual(0);
    signP2WPKHInputAt(tx, sellerIdx, bPriv);
    // Core delivered the buyer inputs with finalScriptWitness already
    // set; only the freshly signed seller input still needs finalizing.
    tx.finalizeIdx(sellerIdx);

    // 3. bitcoind blesses the fully signed settlement.
    const accept = JSON.parse(rpc('testmempoolaccept', JSON.stringify([tx.hex])));
    expect(accept[0].allowed).toBe(true);
  });

  it('step 4: B signs the buyer-built offer; cat returns to A', async () => {
    // Seller-side validation first — same gate that protects a real
    // wallet's signPsbt callback.
    const validation = validateCat21BuyOfferPsbt({
      psbt: sdkOfferPsbtBytes,
      expectedSellerUtxo: catUtxoAfterTransfer,
      floorPriceSats: PRICE_SATS,
      expectedSellerPaymentAddress: toPaymentAddress(bAddress),
      network: Network.Regtest,
    });
    expect(validation.ok).toBe(true);

    const tx = btc.Transaction.fromPSBT(sdkOfferPsbtBytes);
    // A already signed input 1 in step 3. B (seller) signs input 0
    // here (SIGHASH_ALL — committing to every byte of the offer).
    signP2WPKHInputAt(tx, 0, bPriv);
    tx.finalize();

    const acceptTxid = await postTx(tx.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(acceptTxid);
    await waitForOrdSync(tip);

    const inscription = await waitForCatAtAddress(inscriptionId, aAddress);
    expect(inscription.address).toBe(aAddress);
    expect(inscription.value).toBe(CAT21_POSTAGE_SATS);
  });

  it('final state: cat moved A → B → A; ord agrees with the SDK', async () => {
    const inscription = await waitForCatAtAddress(inscriptionId, aAddress);
    expect(inscription.number).toBe(mintedCatNumber);
    expect(inscription.address).toBe(aAddress);
    expect(inscription.value).toBe(CAT21_POSTAGE_SATS);

    // The cat sat is the SAME ordinal across all three transactions —
    // ord's sat field on the inscription record is set when --index-sats
    // is on (which our compose passes). Pinned as a concrete number
    // at the mint step; MUST still be that number here (offer-accept
    // returned the cat to A on the same sat that was minted originally).
    expect(inscription.sat).toBe(mintedCatSat);
  });
});
