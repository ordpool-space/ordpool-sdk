/**
 * Sourcing the second coin that pads a chosen sat's alignment output: the pure
 * pick, and the orchestrator doing it on the consumer's behalf. The live proof
 * that a padded commit actually confirms is in
 * e2e/regtest/inscribe-padding-source.spec.ts.
 */

import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { selectPaddingUtxo } from './padding-utxo';
import {
  InscribeContent,
  InscribeMintOrchestrator,
  InscribeOrchestratorDeps,
  InscribeSnapshot,
  InscribeWalletContext,
} from './inscribe-mint-orchestrator';


const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;

const satKey = schnorr.utils.randomPrivateKey();
const satXonly = schnorr.getPublicKey(satKey);
const satTr = btc.p2tr(satXonly, undefined, btc.NETWORK, true);
/** Taproot dust floor is 330, so a sat 100 in is 230 short. */
const SAT_OFFSET = 100;
const SHORTFALL = 230;

const wallet: InscribeWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: satTr.address!,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

const coin = (label: string, value: number): TxnOutput => ({
  txid: label.repeat(64).slice(0, 64),
  vout: 0,
  status: { confirmed: true },
  value,
});

const satSource = {
  txid: '5'.repeat(64), vout: 0, value: 9_000,
  scriptPubKey: satTr.script, tapInternalKey: satXonly,
  address: satTr.address!, offset: SAT_OFFSET,
};

const content = (over: Partial<InscribeContent> = {}): InscribeContent => ({
  source: { kind: 'file', body: new TextEncoder().encode('pad me'), contentType: 'text/plain' },
  satTarget: { kind: 'in-utxo', utxo: satSource, offset: SAT_OFFSET },
  ...over,
});

function waitFor(o: InscribeMintOrchestrator, pred: (s: InscribeSnapshot) => boolean): Promise<InscribeSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => { if (pred(s)) { unsub(); resolve(s); } });
  });
}

describe('selectPaddingUtxo', () => {
  const coins = [coin('a', 100_000), coin('b', 400), coin('c', 250), coin('d', 20)];

  it('a sat needing no padding selects nothing', () => {
    expect(selectPaddingUtxo(coins, { satOffset: 0, paddingAddress: satTr.address! }))
      .toEqual({ kind: 'not-needed' });
    expect(selectPaddingUtxo(coins, { satOffset: 330, paddingAddress: satTr.address! }))
      .toEqual({ kind: 'not-needed' });
  });

  it('takes the smallest coin that covers the shortfall, leaving the big ones alone', () => {
    const picked = selectPaddingUtxo(coins, { satOffset: SAT_OFFSET, paddingAddress: satTr.address! });
    expect(picked).toEqual({ kind: 'selected', utxo: coin('c', 250), shortfallSats: SHORTFALL });
  });

  it('a coin worth exactly the shortfall covers it', () => {
    const exact = [coin('e', SHORTFALL)];
    expect(selectPaddingUtxo(exact, { satOffset: SAT_OFFSET, paddingAddress: satTr.address! }))
      .toEqual({ kind: 'selected', utxo: coin('e', SHORTFALL), shortfallSats: SHORTFALL });
  });

  it('never picks a coin the transaction already spends', () => {
    const picked = selectPaddingUtxo(coins, {
      satOffset: SAT_OFFSET,
      paddingAddress: satTr.address!,
      excludeOutpoints: [`${coin('c', 250).txid}:0`],
    });
    expect(picked).toEqual({ kind: 'selected', utxo: coin('b', 400), shortfallSats: SHORTFALL });
  });

  it('says what it is short of when nothing covers it', () => {
    expect(selectPaddingUtxo([coin('d', 20), coin('f', 99)], {
      satOffset: SAT_OFFSET, paddingAddress: satTr.address!,
    })).toEqual({ kind: 'none-covers', shortfallSats: SHORTFALL, largestAvailableSats: 99 });

    expect(selectPaddingUtxo([], { satOffset: SAT_OFFSET, paddingAddress: satTr.address! }))
      .toEqual({ kind: 'none-covers', shortfallSats: SHORTFALL, largestAvailableSats: 0 });
  });

  it('the floor is the padding address\'s own', () => {
    // A P2WPKH padding address has a 294 floor, so the same sat is 194 short.
    const picked = selectPaddingUtxo(coins, { satOffset: SAT_OFFSET, paddingAddress: PAYMENT_ADDR });
    expect(picked).toEqual({ kind: 'selected', utxo: coin('c', 250), shortfallSats: 194 });
  });
});

describe('InscribeMintOrchestrator: sourcing the padding coin', () => {
  const deps = (over: Partial<InscribeOrchestratorDeps> = {}): InscribeOrchestratorDeps => ({
    getUtxos: async () => [coin('a', 100_000), coin('c', 250)],
    scan: { classify: async () => 'clean' },
    broadcast: async () => 'txid',
    network: Network.Mainnet,
    ...over,
  });

  async function settle(o: InscribeMintOrchestrator, c: InscribeContent) {
    await o.setWallet(wallet);
    o.setContent(c);
    o.setFeeRate(10);
    return waitFor(o, (s) => s.errorMessage !== null || s.padding !== null
      || (s.simulations.length > 0 && s.simulations[0].simulation !== null));
  }

  it('sources a clean coin itself, so a sub-dust sat can be inscribed', async () => {
    const o = new InscribeMintOrchestrator(deps());
    const s = await settle(o, content());
    expect(s.errorMessage).toBeNull();
    expect(s.padding).toEqual({ utxo: coin('c', 250), shortfallSats: SHORTFALL, automatic: true });
  });

  it('never offers the padding coin as funding as well', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await settle(o, content());
    const s = await waitFor(o, (x) => x.simulations.length > 0);
    const offered = s.simulations.map((row) => row.utxo.txid);
    expect(offered).toEqual([coin('a', 100_000).txid]);
    expect(s.fundingRecommendation.candidates.map((c) => c.txid)).not.toContain(coin('c', 250).txid);
  });

  it('will not spend a coin carrying assets as padding, even when it is the closest fit', async () => {
    const assetCoin = coin('c', 250);   // the best fit, but it carries assets
    const cleanSpare = coin('e', 600);  // the next one up, and clean
    const o = new InscribeMintOrchestrator(deps({
      getUtxos: async () => [coin('a', 100_000), assetCoin, cleanSpare],
      scan: { classify: async (outpoint: string) => outpoint.startsWith(assetCoin.txid) ? 'has-assets' : 'clean' },
    }));
    const s = await settle(o, content());
    expect(s.padding).toEqual({ utxo: cleanSpare, shortfallSats: SHORTFALL, automatic: true });
  });

  it('a coin whose scan fails is not spent either', async () => {
    const cleanSpare = coin('e', 600);
    const o = new InscribeMintOrchestrator(deps({
      getUtxos: async () => [coin('a', 100_000), coin('c', 250), cleanSpare],
      scan: {
        classify: async (outpoint: string) => {
          if (outpoint.startsWith(coin('c', 250).txid)) throw new Error('ord unreachable');
          return 'clean';
        },
      },
    }));
    const s = await settle(o, content());
    expect(s.padding).toEqual({ utxo: cleanSpare, shortfallSats: SHORTFALL, automatic: true });
  });

  it('says what is missing when no coin can pad it', async () => {
    // Nothing here reaches the 230 sats the padding output is short.
    const o = new InscribeMintOrchestrator(deps({ getUtxos: async () => [coin('d', 150), coin('e', 20)] }));
    const s = await settle(o, content());
    // `errorMessage` carries the developer wording, as it does for every
    // recompute-time failure; the person-facing text is on the error's
    // `userMessage`, which a consumer reaches via `inscribeUserMessage`.
    expect(s.errorMessage).toContain('padding input of at least 230 sats');
    expect(s.padding).toBeNull();
    expect(s.simulations).toEqual([]);
  });

  it('a sat needing no padding reports none', async () => {
    const o = new InscribeMintOrchestrator(deps());
    const s = await settle(o, content({
      satTarget: { kind: 'in-utxo', utxo: { ...satSource, offset: 0 }, offset: 0 },
    }));
    expect(s.padding).toBeNull();
    expect(s.errorMessage).toBeNull();
  });

  it('a coin the consumer chose is reported as theirs, not sourced', async () => {
    const chosen = coin('c', 250);
    const o = new InscribeMintOrchestrator(deps());
    const s = await settle(o, content({ paddingUtxo: chosen }));
    expect(s.padding).toEqual({ utxo: chosen, shortfallSats: SHORTFALL, automatic: false });
  });

  it('the padded commit is priced, so the grid is not empty', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await settle(o, content());
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].simulation !== null);
    expect(s.simulations[0].preview).not.toBeNull();
    expect(s.simulations[0].simulation!.commitVsize).toBeGreaterThan(0);
  });
});

describe('InscribeMintOrchestrator: resolving batch parents by id', () => {
  const entry = { source: { kind: 'file' as const, body: new TextEncoder().encode('child'), contentType: 'text/plain' } };
  const parentId = `${'ab'.repeat(32)}i0`;

  const run = async (deps: InscribeOrchestratorDeps, w: InscribeWalletContext) => {
    const o = new InscribeMintOrchestrator(deps);
    await o.setWallet(w);
    o.setFeeRate(10);
    o.setBatch({ mode: 'separate-outputs', inscriptions: [entry], parentIds: [parentId] });
    return waitFor(o, (s) => s.errorMessage !== null || s.parents !== null);
  };

  const baseDeps: InscribeOrchestratorDeps = {
    getUtxos: async () => [coin('a', 100_000)],
    scan: { classify: async () => 'clean' },
    broadcast: async () => 'txid',
    network: Network.Mainnet,
  };

  it('says so when there is no ord to ask', async () => {
    const s = await run(baseDeps, { ...wallet, ordinalsPublicKey: PAYMENT_PUB });
    expect(s.errorMessage).toContain('ordBaseUrl');
    expect(s.parents).toBeNull();
  });

  it('says so when the wallet gave no ordinals key to spend the parent with', async () => {
    const s = await run({ ...baseDeps, ordBaseUrl: 'https://ord.example' }, wallet);
    expect(s.errorMessage).toContain('ordinalsPublicKey');
    expect(s.parents).toBeNull();
  });

  it('an explicit parents list is used as given, without asking ord', async () => {
    const o = new InscribeMintOrchestrator(baseDeps);
    await o.setWallet(wallet);
    o.setFeeRate(10);
    o.setBatch({
      mode: 'separate-outputs',
      inscriptions: [entry],
      parents: [{
        id: parentId,
        utxo: { txid: 'a'.repeat(64), vout: 0, value: 546, scriptPubKey: satTr.script, tapInternalKey: satXonly },
        returnAddress: satTr.address!,
      }],
    });
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].preview !== null);
    expect(s.errorMessage).toBeNull();
    expect(s.parents).toBeNull();            // nothing was resolved; the list was given
    expect(s.simulations[0].preview!.walletPrompts).toBe(2);
  });
});

describe('InscribeMintOrchestrator: the person-facing failure text', () => {
  const deps: InscribeOrchestratorDeps = {
    getUtxos: async () => [coin('d', 150), coin('e', 20)],
    scan: { classify: async () => 'clean' },
    broadcast: async () => 'txid',
    network: Network.Mainnet,
  };

  it('carries the user wording alongside the developer wording', async () => {
    const o = new InscribeMintOrchestrator(deps);
    await o.setWallet(wallet);
    o.setContent(content());
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.errorMessage !== null);

    // The developer string names the internal concept; the user string does not.
    expect(s.errorMessage).toContain('padding input of at least 230 sats');
    expect(s.userMessage).toBe(
      'This sat sits 100 sats into its coin, so it needs a second coin of at least 230 sats to go with it, and none of your coins can be used for that.',
    );
    expect(s.userMessage).not.toContain('padding input');
  });

  it('a failure with no person-facing wording repeats the developer one, so a screen needs no fallback', async () => {
    const o = new InscribeMintOrchestrator({ ...deps, getUtxos: async () => { throw new Error('electrs down'); } });
    await o.setWallet(wallet);
    const s = o.getSnapshot();
    expect(s.errorMessage).toBe('Failed to load UTXOs: electrs down');
    expect(s.userMessage).toBe(s.errorMessage);
  });

  it('clears with the error it belongs to', async () => {
    const o = new InscribeMintOrchestrator({ ...deps, getUtxos: async () => [coin('a', 100_000), coin('c', 250)] });
    await o.setWallet(wallet);
    o.setContent(content());
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.padding !== null);
    expect(s.errorMessage).toBeNull();
    expect(s.userMessage).toBeNull();
  });
});

describe('InscribeMintOrchestrator: a superseded recompute', () => {
  it('does not publish a padding coin for content the user already replaced', async () => {
    const paddingCandidate = coin('c', 250);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const o = new InscribeMintOrchestrator({
      getUtxos: async () => [coin('a', 100_000), paddingCandidate],
      scan: {
        // Only the padding candidate is held up. The funding coin classifies
        // at once, so the newer recompute runs to completion while the older
        // one is still waiting here.
        classify: async (outpoint: string) => {
          if (outpoint.startsWith(paddingCandidate.txid)) await gate;
          return 'clean';
        },
      },
      broadcast: async () => 'txid',
      network: Network.Mainnet,
    });
    await o.setWallet(wallet);
    o.setFeeRate(10);

    o.setContent(content());                                     // needs padding
    // Let that recompute run until it is inside the scan, past the guards that
    // would otherwise stop it early; only then does the newer content arrive.
    await new Promise((r) => setTimeout(r, 0));
    o.setContent(content({                                       // supersedes it, needs none
      satTarget: { kind: 'in-utxo', utxo: { ...satSource, offset: 0 }, offset: 0 },
    }));
    const settled = await waitFor(o, (s) => s.simulations.length > 0 && s.simulations[0].simulation !== null);
    expect(settled.padding).toBeNull();

    // The superseded run finishes now. Its answer is for content that is gone.
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(o.getSnapshot().padding).toBeNull();
  });
});
