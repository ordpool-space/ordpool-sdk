/**
 * Proves: a buy-offer built, buyer-signed and finalised by the SDK is accepted
 *         by ord's own `wallet offer accept` (cat21-ord, which carries upstream
 *         ord #4553: "inputs may not specify any sighash type"), at 546, 3000,
 *         9000 and 30000 sats. The seller is an ord wallet holding the cat. ord
 *         first runs every pre-signing check in --dry-run and answers with the
 *         txid of our transaction; then it signs and broadcasts for real, the
 *         transaction confirms, the cat lands at the buyer on the same sat
 *         offset, the seller is paid price + postage, and cat21-ord answers the
 *         spent cat outpoint with `spent: true`, which `getCatsAtOutput` reads
 *         as `null` (no cat there any more) rather than throwing.
 * Control: the same offer with `sighashType: SIGHASH_ALL` written on the buyer
 *         input, left unfinalised, is refused by ord with its sighash message,
 *         so the green case cannot pass because ord accepts anything.
 * Real:   bitcoind, electrs, cat21-ord and its wallet, all regtest.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildCat21BuyOfferPsbt } from '../../src/cat21-offer/cat21-offer.helper';
import { finalizeOfferBuyerInputs } from '../../src/cat21-offer/finalize-offer-buyer-inputs';
import { cat21OrdFetchReader, getCatsAtOutput } from '../../src/cat21-ord/cats-at-output';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  catInscriptionId,
  getOrdInscription,
  getUtxos,
  mineBlocks,
  ordAcceptOffer,
  ordCliErrorSays,
  ordCreateWallet,
  ORD_URL,
  postTx,
  rpc,
  waitForCatAtAddress,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const SELLER_WALLET = 'offer-accept-seller';
const FEE_SATS = 1_000;
const PRICE_SATS = 50_000;
/** 0.1 BTC, what each `sendtoaddress` below pays. */
const FUNDING_SATS = 10_000_000;
const CAT_SIZES = [546, 3_000, 9_000, 30_000] as const;

interface SizedCat {
  sats: number;
  txid: string;
  inscriptionId: string;
  catNumber: number;
  buyerCoin: { txid: string; vout: number; value: number };
}

describe('ord wallet offer accept takes an SDK-built offer', () => {
  const network = toScureNetwork(Network.Regtest);
  const minterPriv = secp256k1.utils.randomPrivateKey();
  const minter = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), network);
  const buyerPriv = secp256k1.utils.randomPrivateKey();
  const buyer = btc.p2wpkh(secp256k1.getPublicKey(buyerPriv, true), network);
  const cat21Ord = cat21OrdFetchReader(ORD_URL);

  let sellerCatAddress: string;
  let sellerPaymentAddress: string;
  const cats = new Map<number, SizedCat>();

  /** Mint a cat on a `sats`-sized output at the ord wallet: lockTime 21 makes output 0 a cat. */
  async function mintCatAtSeller(sats: number): Promise<{ txid: string; inscriptionId: string }> {
    const funding = await waitForUtxoAt(minter.address!, FUNDING_SATS);
    const mint = new btc.Transaction({ lockTime: 21 });
    mint.addInput({
      txid: funding.txid,
      index: funding.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: minter.script, amount: BigInt(funding.value) },
    });
    mint.addOutputAddress(sellerCatAddress, BigInt(sats), network);
    mint.addOutputAddress(minter.address!, BigInt(funding.value - sats - FEE_SATS), network);
    mint.signIdx(minterPriv, 0);
    mint.finalize();
    const txid = await postTx(mint.hex);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(txid);
    await waitForOrdSync(tip);
    return { txid, inscriptionId: catInscriptionId(txid) };
  }

  beforeAll(async () => {
    let tip = mineBlocks(3);
    await waitForElectrsSync(tip);
    await waitForOrdReady();
    await waitForOrdSync(tip);

    sellerCatAddress = ordCreateWallet(SELLER_WALLET);
    sellerPaymentAddress = ordCreateWallet(SELLER_WALLET);

    // One funding coin per mint and one buyer coin per size, each its own output.
    for (let i = 0; i < CAT_SIZES.length; i++) {
      rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', minter.address!, '0.1');
      rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', buyer.address!, '0.1');
    }
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);

    await waitForUtxoAt(buyer.address!, FUNDING_SATS);
    const buyerUtxos = (await getUtxos(buyer.address!)).filter((u) => u.value === FUNDING_SATS);
    expect(buyerUtxos).toHaveLength(CAT_SIZES.length);

    for (const [i, sats] of CAT_SIZES.entries()) {
      const minted = await mintCatAtSeller(sats);
      const indexed = await waitForCatAtAddress(minted.inscriptionId, sellerCatAddress);
      expect(indexed.value).toBe(sats);
      const coin = buyerUtxos[i];
      cats.set(sats, {
        sats,
        ...minted,
        catNumber: indexed.number,
        buyerCoin: { txid: coin.txid, vout: coin.vout, value: coin.value },
      });
    }
  }, 300_000);

  function buildOffer(c: SizedCat): btc.Transaction {
    const built = buildCat21BuyOfferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      sellerInput: {
        txid: c.txid,
        vout: 0,
        value: c.sats,
        scriptPubKey: btc.OutScript.encode(btc.Address(network).decode(sellerCatAddress)),
      },
      buyerInputs: [{ ...c.buyerCoin, scriptPubKey: buyer.script }],
      destinations: {
        buyerReceiveAddress: buyer.address!,
        sellerPaymentAddress,
        buyerChangeAddress: buyer.address!,
      },
      priceSats: PRICE_SATS,
      feeSats: FEE_SATS,
    });
    return btc.Transaction.fromPSBT(built.psbt, { allowUnknownInputs: true });
  }

  /** The offer as the SDK hands it out: buyer input signed and finalised, no sighash type anywhere. */
  function handedOutOffer(c: SizedCat): btc.Transaction {
    const offer = buildOffer(c);
    offer.signIdx(buyerPriv, 1);
    return btc.Transaction.fromPSBT(finalizeOfferBuyerInputs(offer.toPSBT()));
  }

  it('refuses an offer whose buyer input specifies SIGHASH_ALL and is left unfinalised', () => {
    const c = cats.get(9_000)!;
    const offer = buildOffer(c);
    offer.updateInput(1, { sighashType: btc.SigHash.ALL });
    offer.signIdx(buyerPriv, 1, [btc.SigHash.ALL]);
    const outpoint = `${c.buyerCoin.txid}:${c.buyerCoin.vout}`;

    let refusal: unknown = null;
    try {
      ordAcceptOffer(c.inscriptionId, PRICE_SATS, base64.encode(offer.toPSBT()), SELLER_WALLET, 'dry-run');
    } catch (e) {
      refusal = e;
    }
    expect(ordCliErrorSays(refusal, `input \`${outpoint}\` specifies sighash type`)).toBe(true);
  });

  it.each(CAT_SIZES)('a %i-sat cat: ord accepts in dry-run, then signs, broadcasts and the cat lands at the buyer', async (sats) => {
    const c = cats.get(sats)!;
    const handedOut = handedOutOffer(c);
    for (let i = 0; i < handedOut.inputsLength; i++) {
      expect(handedOut.getInput(i).sighashType).toBeUndefined();
    }
    expect(handedOut.getInput(1).finalScriptWitness).toHaveLength(2);
    expect(handedOut.getInput(0).finalScriptWitness).toBeUndefined();
    const ourTxid = hex.encode(sha256(sha256(handedOut.toBytes(false, false))).reverse());
    const psbt = base64.encode(handedOut.toPSBT());

    expect(ordAcceptOffer(c.inscriptionId, PRICE_SATS, psbt, SELLER_WALLET, 'dry-run').txid).toBe(ourTxid);
    expect(await getCatsAtOutput(cat21Ord, c.txid, 0)).toEqual([c.catNumber]);

    const accepted = ordAcceptOffer(c.inscriptionId, PRICE_SATS, psbt, SELLER_WALLET, 'broadcast');
    expect(accepted.txid).toBe(ourTxid);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(ourTxid);
    await waitForOrdSync(tip);

    const landed = await waitForCatAtAddress(c.inscriptionId, buyer.address!);
    const onChain = JSON.parse(rpc('getrawtransaction', ourTxid, 'true')) as {
      locktime: number;
      vout: Array<{ value: number; scriptPubKey: { address?: string } }>;
    };
    expect({
      satpoint: landed.satpoint,
      postage: landed.value,
      sellerPaid: { address: onChain.vout[1].scriptPubKey.address, sats: Math.round(onChain.vout[1].value * 1e8) },
      locktime: onChain.locktime,
    }).toEqual({
      satpoint: `${ourTxid}:0:0`,
      postage: sats,
      sellerPaid: { address: sellerPaymentAddress, sats: PRICE_SATS + sats },
      locktime: 21,
    });

    // The settle carries lockTime 21, so its output 0 also holds the bonus cat it mints.
    const bonus = await getOrdInscription(catInscriptionId(ourTxid));
    expect({
      spentCatOutput: await getCatsAtOutput(cat21Ord, c.txid, 0),
      landedCatOutput: await getCatsAtOutput(cat21Ord, ourTxid, 0),
    }).toEqual({
      spentCatOutput: null,
      landedCatOutput: [c.catNumber, bonus.number].sort((a, b) => a - b),
    });
  });
});
