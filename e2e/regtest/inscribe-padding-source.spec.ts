/**
 * Inscribing onto a sat that sits less than a dust limit into its coin.
 *
 * Such a sat leaves the sats in front of it as an output too small to relay, so
 * ord pulls a further wallet input in to pad it. The orchestrator sources that
 * coin itself: this drives the whole thing on chain and then asks stock ord
 * whether the inscription really landed on the sat we asked for, which is the
 * only thing that proves the padded commit was built right.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import {
  InscribeMintOrchestrator,
  type InscribeOrchestratorDeps,
  type InscribeSnapshot,
} from '../../src/inscribe/inscribe-mint-orchestrator';
import { Network } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  fundUninscribed,
  getStockOrdOutput,
  getStockOrdOutputInscriptions,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdStockInscription,
  waitForUtxoAt,
} from './regtest-helpers';

const FEE_RATE = 5;
/** The sat sits 100 into its coin; a taproot output's floor is 330. */
const SAT_OFFSET = 100;
const SHORTFALL = 230;
const SAT_COIN_SATS = 9_000;
const PADDING_COIN_SATS = 1_000;

function newWalletTaproot(): { address: string; script: Uint8Array; internalKey: Uint8Array } {
  const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32m').trim();
  const info = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'getaddressinfo', address)) as {
    desc: string; scriptPubKey: string;
  };
  const m = /tr\((?:\[[^\]]+\])?([0-9a-f]{64})\)/i.exec(info.desc);
  if (!m) throw new Error(`cannot parse tr() internal key from descriptor: ${info.desc}`);
  return { address, script: hex.decode(info.scriptPubKey), internalKey: hex.decode(m[1]) };
}

/** Core signs and finalizes: every input of this commit is one of its own. */
function walletSign(unsigned: { base64: string; hex: string }): Promise<string> {
  const processed = JSON.parse(rpc(
    '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
    `psbt=${unsigned.base64}`, 'sign=true', 'finalize=true',
  )) as { psbt: string; complete: boolean };
  if (!processed.complete) throw new Error('walletprocesspsbt did not complete the commit');
  return Promise.resolve(processed.psbt);
}

function waitFor(o: InscribeMintOrchestrator, pred: (s: InscribeSnapshot) => boolean): Promise<InscribeSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => { if (pred(s)) { unsub(); resolve(s); } });
  });
}

let home: ReturnType<typeof newWalletTaproot>;
let satCoin: { txid: string; vout: number; value: number };
/** The sat 100 sats into the sat coin, per ord's own ranges. */
let chosenSat: number;
let payment: { fundingAddr: string; fundingPubkey: Uint8Array; utxo: { txid: string; vout: number; value: number } };
let paddingCoin: { txid: string; vout: number; value: number };

beforeAll(async () => {
  await waitForOrdStockReady();

  // The sat's coin: taproot, at an address Core holds the key for. The wallet
  // pool can hand back sats an earlier run already inscribed, which would make
  // this a reinscription, so keep asking until the coin is clean (the same
  // retry `fundUninscribed` uses for the payment side).
  let clean = false;
  for (let attempt = 0; attempt < 8 && !clean; attempt++) {
    home = newWalletTaproot();
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', home.address, (SAT_COIN_SATS / 1e8).toFixed(8));
    const satTip = mineBlocks(1);
    await waitForElectrsSync(satTip);
    await waitForOrdStockSync(satTip);
    const found = await waitForUtxoAt(home.address, SAT_COIN_SATS);
    satCoin = { txid: found.txid, vout: found.vout, value: found.value };
    clean = (await getStockOrdOutputInscriptions(`${satCoin.txid}:${satCoin.vout}`)).length === 0;
  }
  if (!clean) throw new Error('no un-inscribed taproot coin for the sat source after 8 attempts');

  let tip: number;
  const { sat_ranges } = await getStockOrdOutput(`${satCoin.txid}:${satCoin.vout}`);
  expect(sat_ranges[0][1] - sat_ranges[0][0]).toBeGreaterThan(SAT_OFFSET);
  chosenSat = sat_ranges[0][0] + SAT_OFFSET;

  // The payment side: one coin to fund the fee, one small one to pad with.
  payment = await fundUninscribed();
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', payment.fundingAddr, (PADDING_COIN_SATS / 1e8).toFixed(8));
  tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdStockSync(tip);
  const small = await waitForUtxoAt(payment.fundingAddr, PADDING_COIN_SATS);
  paddingCoin = { txid: small.txid, vout: small.vout, value: small.value };
}, 300_000);

describe('a sat below the dust floor of its coin, padded by a coin the SDK sources', () => {
  it('sources the padding coin, builds the padded commit, and ord finds the inscription on that exact sat', async () => {
    const deps: InscribeOrchestratorDeps = {
      getUtxos: async () => [
        { ...payment.utxo, status: { confirmed: true } },
        { ...paddingCoin, status: { confirmed: true } },
      ],
      scan: { classify: async () => 'clean' },
      broadcast: (txHex: string) => postTx(txHex),
      network: Network.Regtest,
    };
    const o = new InscribeMintOrchestrator(deps);
    await o.setWallet({
      type: KnownOrdinalWalletType.xpub,
      ordinalsAddress: home.address,
      paymentAddress: payment.fundingAddr,
      paymentPublicKey: hex.encode(payment.fundingPubkey),
    });
    o.setFeeRate(FEE_RATE);
    o.setContent({
      source: { kind: 'file', body: new TextEncoder().encode('on a padded sat'), contentType: 'text/plain' },
      satTarget: {
        kind: 'in-utxo',
        utxo: {
          txid: satCoin.txid, vout: satCoin.vout, value: satCoin.value,
          scriptPubKey: home.script, tapInternalKey: home.internalKey,
          address: home.address, offset: SAT_OFFSET,
        },
        offset: SAT_OFFSET,
      },
    });

    // The orchestrator picks the small coin, not the 1 BTC one.
    const withPadding = await waitFor(o, (s) => s.padding !== null || s.errorMessage !== null);
    expect(withPadding.errorMessage).toBeNull();
    expect(withPadding.padding).toEqual({
      utxo: { ...paddingCoin, status: { confirmed: true } },
      shortfallSats: SHORTFALL,
      automatic: true,
    });

    await waitFor(o, (s) => s.simulations.length > 0 && s.simulations[0].preview !== null);
    const result = await o.mint(walletSign);
    expect(o.getSnapshot().state).toBe('success');

    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);

    // The padding output: the padding coin's whole value plus the sats in
    // front of the chosen one, returned to the sat coin's own address.
    const commit = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', result.commitTxId)));
    const padded = Array.from({ length: commit.outputsLength }, (_, i) => commit.getOutput(i))
      .find((out) => Number(out.amount) === PADDING_COIN_SATS + SAT_OFFSET);
    expect(padded).toBeDefined();
    expect(hex.encode(padded!.script!)).toBe(hex.encode(home.script));

    // ord's own index: the inscription is on the sat we asked for, not on the
    // coin's first sat, which is what an unpadded or misaligned commit gives.
    const insc = await waitForOrdStockInscription(`${result.revealTxId}i0`);
    expect(insc.sat).toBe(chosenSat);
  }, 420_000);
});
