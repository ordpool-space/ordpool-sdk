/**
 * ord-parity STRESS test: offer PSBTs must match `ord wallet offer create`
 * at cat UTXO sizes OTHER than 546.
 *
 * Why this exists: `cat21-flow-roundtrip.spec.ts` step 3b/3c already
 * byte-compares the SDK's `buildCat21BuyOfferPsbt` against a live
 * `ord wallet offer create` — but ONLY for a cat sitting on a 546-sat
 * UTXO (the SDK mint always emits 546). At V=546, ord's
 * `output[0] = postage = 546` coincidentally equals a builder that
 * hardcodes 546, so the parity assertion is green even if the builder
 * ignores the real UTXO size. That is the happy-path blind spot.
 *
 * ord's real rule (cat21-ord/src/subcommand/wallet/offer/create.rs:34-70):
 *
 *   let postage = inscription.value;              // the cat's REAL UTXO size
 *   output[0] = { value: postage,          .. }   // whole UTXO -> buyer
 *   output[1] = { value: amount + postage, .. }   // amount + postage -> seller
 *
 * So on a 9000-sat cat, ord emits `output[0] = 9000`, NOT 546. A builder
 * that forces 546 would route the seller's sats above offset 546 — and any
 * co-located inscription content there — into output[1] (the payment),
 * merging them. This spec mints cats at several sizes via a raw nLockTime=21
 * tx (cat21-ord indexes any lockTime=21 output as a cat, regardless of size)
 * and asserts the SDK and ord agree on `output[0]` (= V) and `output[1]`
 * (= price + V) at every size. The sole intentional diff stays `lockTime`
 * (ord 0, SDK 21 for the bonus mint).
 *
 * A green run at V != 546 is the proof that `buildCat21BuyOfferPsbt`
 * preserves the seller UTXO size in byte-parity with ord.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildCat21BuyOfferPsbt } from '../../src/cat21-offer/cat21-offer.helper';
import { buildCat21TransferPsbt } from '../../src/cat21-transfer/cat21-transfer.helper';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../../src/cat21-protocol/cat21-sequence';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  ElectrsUtxo,
  catInscriptionId,
  mineBlocks,
  mineBlockWithRawTxs,
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
} from './regtest-helpers';

const FEE_SATS = 1_000;
const PRICE_SATS = 50_000;

// The cat UTXO sizes to prove parity at. 546 is the SDK-mint default (the
// only size the happy-path spec ever exercised); the rest are non-546 sizes
// that a co-located inscription-with-nLockTime=21 (or any external minter)
// can legitimately produce. 9000 mirrors ord's own offer test fixture
// (`inscribe_with_options(&core, &ord, Some(9000), 0)`).
const CAT_SIZES = [546, 3_000, 9_000, 30_000];

describe('cat UTXO size preservation at non-546 sizes (offer ord-parity + transfer golden rule)', () => {
  const regtestNetwork = toScureNetwork(Network.Regtest);

  // Wallet A: the cat owner / seller. Plain P2WPKH (bcrt1q).
  let aPriv: Uint8Array;
  let aAddress: string;
  let aScript: Uint8Array;

  beforeAll(async () => {
    let tip = mineBlocks(3);
    await waitForElectrsSync(tip);
    await waitForOrdReady();
    await waitForOrdSync(tip);

    aPriv = secp256k1.utils.randomPrivateKey();
    const aPub = secp256k1.getPublicKey(aPriv, true);
    const aP2 = btc.p2wpkh(aPub, regtestNetwork);
    aAddress = aP2.address!;
    aScript = aP2.script;

    // The buyer-side ord wallet that produces the reference offers. Funded
    // so `ord wallet offer create` can add buyer inputs. Created in
    // cat-aware mode so its client decats the server JSON before serde.
    const ordWalletAddress = ordCreateWallet('ord');
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', ordWalletAddress, '1.0');

    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
  }, 120_000);

  /**
   * Mint a cat onto a UTXO of exactly `valueSats` via a raw nLockTime=21
   * transaction (input 0 = A's funding, output 0 = the cat at A, output 1 =
   * A's change). cat21-ord indexes output 0 as a cat regardless of size.
   * Returns the cat's outpoint + inscription id.
   */
  async function mintCatOfSize(valueSats: number): Promise<{
    txid: string;
    inscriptionId: string;
    value: number;
  }> {
    // Fresh funding UTXO for A (avoids coin-selection races between sizes).
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', aAddress, '0.5');
    let tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
    const funding = await waitForUtxoAt(aAddress, 50_000_000);

    // Raw mint: lockTime=21 makes it a cat; output 0 carries `valueSats`.
    const tx = new btc.Transaction({ lockTime: 21 });
    tx.addInput({
      txid: funding.txid,
      index: funding.vout,
      // 0xfffffffe: non-RBF, enables the (long-satisfied) lockTime. Same
      // sequence the SDK mint uses for non-cat21wallet wallets.
      sequence: 0xfffffffe,
      witnessUtxo: { script: aScript, amount: BigInt(funding.value) },
    });
    // output 0: the cat, at exactly valueSats, to A.
    tx.addOutputAddress(aAddress, BigInt(valueSats), regtestNetwork);
    // output 1: change back to A.
    const changeSats = funding.value - valueSats - FEE_SATS;
    tx.addOutputAddress(aAddress, BigInt(changeSats), regtestNetwork);
    tx.signIdx(aPriv, 0, [btc.SigHash.ALL]);
    tx.finalize();

    const txid = await postTx(tx.hex);
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(txid);
    await waitForOrdSync(tip);

    const inscriptionId = catInscriptionId(txid);
    const insc = await waitForCatAtAddress(inscriptionId, aAddress);
    // The cat must sit on exactly the UTXO size we minted — this is the
    // whole premise of the parity comparison below.
    expect(insc.value).toBe(valueSats);
    return { txid, inscriptionId, value: insc.value };
  }

  it.each(CAT_SIZES)(
    'cat on a %i-sat UTXO: SDK output[0]=V, output[1]=price+V, byte-parity with ord',
    async (valueSats: number) => {
      const cat = await mintCatOfSize(valueSats);

      // ── ord's reference offer (live `ord wallet offer create`) ──
      const ordOffer = ordCreateOffer(cat.inscriptionId, PRICE_SATS, 1);
      expect(ordOffer.inscription).toBe(cat.inscriptionId);
      const ordTx = btc.Transaction.fromPSBT(base64.decode(ordOffer.psbt));

      // ── the SDK's offer for the SAME cat UTXO ──
      const sellerCatScript = btc.p2wpkh(
        secp256k1.getPublicKey(aPriv, true),
        regtestNetwork,
      ).script;
      const sdk = buildCat21BuyOfferPsbt({
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: Network.Regtest,
        sellerInput: {
          txid: cat.txid,
          vout: 0,
          value: cat.value, // the REAL cat UTXO size, not 546
          scriptPubKey: sellerCatScript,
        },
        buyerInputs: [
          // A synthetic 1-BTC buyer input; only the OUTPUT amounts and the
          // seller input matter for the parity comparison.
          {
            txid: 'ab'.repeat(32),
            vout: 0,
            value: 100_000_000,
            scriptPubKey: btc.p2wpkh(
              secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true),
              regtestNetwork,
            ).script,
          },
        ],
        destinations: {
          buyerReceiveAddress: aAddress,
          sellerPaymentAddress: aAddress,
          buyerChangeAddress: aAddress,
        },
        priceSats: PRICE_SATS,
        feeSats: FEE_SATS,
      });
      const sdkTx = btc.Transaction.fromPSBT(sdk.psbt);

      // ── the load-bearing parity assertions, at V != 546 ──

      // output[0] — the cat/inscription UTXO to the buyer. ord preserves the
      // REAL size; the SDK must too. THIS is the assertion the 546-only
      // happy path could never make: at V != 546, a builder that hardcodes
      // 546 fails here.
      expect(ordTx.getOutput(0).amount).toBe(BigInt(valueSats));
      expect(sdkTx.getOutput(0).amount).toBe(BigInt(valueSats));
      expect(sdkTx.getOutput(0).amount).toBe(ordTx.getOutput(0).amount);

      // output[1] — payment to seller = amount + postage = price + V.
      expect(ordTx.getOutput(1).amount).toBe(BigInt(PRICE_SATS + valueSats));
      expect(sdkTx.getOutput(1).amount).toBe(BigInt(PRICE_SATS + valueSats));
      expect(sdkTx.getOutput(1).amount).toBe(ordTx.getOutput(1).amount);

      // seller input: pre-selected, UNSIGNED, sequence ENABLE_RBF_NO_LOCKTIME.
      // Locate ord's seller input by outpoint (fundrawtransaction appends
      // buyer inputs in undefined order).
      const bytesEqual = (a?: Uint8Array, b?: Uint8Array): boolean =>
        !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
      const sdkSeller = sdkTx.getInput(0);
      let ordSellerIdx = -1;
      for (let i = 0; i < ordTx.inputsLength; i++) {
        const c = ordTx.getInput(i);
        if (c.index === sdkSeller.index && bytesEqual(c.txid, sdkSeller.txid)) {
          ordSellerIdx = i;
          break;
        }
      }
      expect(ordSellerIdx).toBeGreaterThanOrEqual(0);
      const ordSeller = ordTx.getInput(ordSellerIdx);
      expect(ordSeller.sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
      expect(sdkSeller.sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
      expect(ordSeller.partialSig).toBeUndefined();
      expect(ordSeller.tapKeySig).toBeUndefined();
      expect(sdkSeller.partialSig).toBeUndefined();
      expect(sdkSeller.tapKeySig).toBeUndefined();

      // the sole intentional structural diff: lockTime (ord 0, SDK 21).
      expect(ordTx.lockTime).toBe(0);
      expect(sdkTx.lockTime).toBe(21);
    },
    120_000,
  );

  it('TRANSFER golden rule: a 9000-sat cat stays 9000 at the recipient (never resized to 546)', async () => {
    // GOLDEN RULE: transfer preserves the cat UTXO's exact size. Output 0 =
    // catUtxo.value; the fee is paid by a SEPARATE funding input, never by
    // shrinking the cat. Proven end-to-end: cat21-ord reports the moved cat
    // on a 9000-sat UTXO, not a 546 one.
    const cat = await mintCatOfSize(9_000);

    // Separate funding for the fee (the cat is never touched for it).
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', aAddress, '0.01');
    let tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
    const funding = await waitForUtxoAt(aAddress, 1_000_000);

    const recipientPriv = secp256k1.utils.randomPrivateKey();
    const recipientAddr = btc.p2wpkh(
      secp256k1.getPublicKey(recipientPriv, true),
      regtestNetwork,
    ).address!;

    const built = buildCat21TransferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      catUtxo: { txid: cat.txid, vout: 0, value: cat.value, scriptPubKey: aScript },
      fundingInputs: [
        { txid: funding.txid, vout: funding.vout, value: funding.value, scriptPubKey: aScript },
      ],
      destinations: { recipientAddress: recipientAddr, senderChangeAddress: aAddress },
      feeSats: FEE_SATS,
    });

    // Output 0 carries the WHOLE cat UTXO (9000), not 546.
    const tx = btc.Transaction.fromPSBT(built.psbt);
    expect(tx.getOutput(0).amount).toBe(BigInt(9_000));

    tx.signIdx(aPriv, 0, [btc.SigHash.ALL]); // cat
    tx.signIdx(aPriv, 1, [btc.SigHash.ALL]); // funding
    tx.finalize();
    const txid = await postTx(tx.hex);
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(txid);
    await waitForOrdSync(tip);

    // cat21-ord is the authority: the cat moved to the recipient AND kept its
    // 9000-sat UTXO. A 546 here would mean the builder resized the cat.
    const moved = await waitForCatAtAddress(cat.inscriptionId, recipientAddr);
    expect(moved.address).toBe(recipientAddr);
    expect(moved.value).toBe(9_000);
  }, 120_000);

  it('GROW rescues a SUB-DUST cat mined out-of-band (relay-rejected) back to a relay-standard 546', async () => {
    // 1) Build a nLockTime=21 tx whose output 0 is 100 sats — BELOW the dust
    //    limit. A cat can be minted this way by an out-of-band submission
    //    (direct-to-miner / MARA) that bypasses relay's dust rule.
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', aAddress, '0.5');
    let tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
    const funding = await waitForUtxoAt(aAddress, 50_000_000);

    const subDust = new btc.Transaction({ lockTime: 21 });
    subDust.addInput({
      txid: funding.txid,
      index: funding.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: aScript, amount: BigInt(funding.value) },
    });
    subDust.addOutputAddress(aAddress, BigInt(100), regtestNetwork); // 100 sats = SUB-DUST
    subDust.addOutputAddress(aAddress, BigInt(funding.value - 100 - FEE_SATS), regtestNetwork);
    subDust.signIdx(aPriv, 0, [btc.SigHash.ALL]);
    subDust.finalize();
    const subDustHex = subDust.hex;
    const subDustTxid = subDust.id;

    // 2) Normal RELAY rejects the sub-dust output; mine it OUT-OF-BAND.
    const accept = JSON.parse(rpc('testmempoolaccept', JSON.stringify([subDustHex])));
    expect(accept[0].allowed).toBe(false); // relay won't take a sub-dust output
    tip = mineBlockWithRawTxs([subDustHex]);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(subDustTxid);
    await waitForOrdSync(tip);

    // cat21-ord indexes the sub-dust cat on its 100-sat UTXO.
    const inscriptionId = catInscriptionId(subDustTxid);
    const subDustCat = await waitForCatAtAddress(inscriptionId, aAddress);
    expect(subDustCat.value).toBe(100);

    // 3) GROW-rescue via the SDK builder: spend the 100-sat cat + funding, with
    //    targetPostageSats = 546 so output 0 clears the dust floor.
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', aAddress, '0.01');
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);
    const rescueFunding = await waitForUtxoAt(aAddress, 1_000_000);

    const recipientAddr = btc.p2wpkh(
      secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true),
      regtestNetwork,
    ).address!;
    const grown = buildCat21TransferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      catUtxo: { txid: subDustTxid, vout: 0, value: 100, scriptPubKey: aScript },
      fundingInputs: [
        { txid: rescueFunding.txid, vout: rescueFunding.vout, value: rescueFunding.value, scriptPubKey: aScript },
      ],
      destinations: { recipientAddress: recipientAddr, senderChangeAddress: aAddress },
      feeSats: FEE_SATS,
      targetPostageSats: 546, // GROW the sub-dust cat to relay-standard
    });
    expect(grown.catOutputSats).toBe(546);
    const gtx = btc.Transaction.fromPSBT(grown.psbt);
    expect(gtx.getOutput(0).amount).toBe(BigInt(546));
    gtx.signIdx(aPriv, 0, [btc.SigHash.ALL]); // cat
    gtx.signIdx(aPriv, 1, [btc.SigHash.ALL]); // funding
    gtx.finalize();

    // 4) Broadcast via NORMAL relay (no out-of-band) — proves it's now standard.
    const grownTxid = await postTx(gtx.hex);
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(grownTxid);
    await waitForOrdSync(tip);

    // 5) cat21-ord: the same cat rode FIFO to the grown 546-sat UTXO at the
    //    recipient — rescued from sub-dust to relay-standard.
    const rescued = await waitForCatAtAddress(inscriptionId, recipientAddr);
    expect(rescued.address).toBe(recipientAddr);
    expect(rescued.value).toBe(546);
    expect(rescued.number).toBe(subDustCat.number);
  }, 120_000);
});
