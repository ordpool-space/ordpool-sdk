/**
 * `InscribeMintOrchestrator.setBatch` driven end to end on regtest.
 *
 * The batch BUILDER already has byte-parity with `ord wallet batch`. What this
 * proves is the ORCHESTRATOR's wiring around it: that setBatch plans, prices,
 * signs and broadcasts a real commit and reveal, and that stock ord then finds
 * every inscription where the snapshot said it would be. The assertions are
 * ord's own index, not our arithmetic about it.
 *
 * The wallet stand-in is Bitcoin Core's descriptor wallet via
 * `walletprocesspsbt`, reached through the orchestrator's own
 * `mint(promptForSignedPsbt)` bridge, so the production watch-only signer path
 * runs rather than a test-only shortcut.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import {
  InscribeMintOrchestrator,
  type InscribeOrchestratorDeps,
  type InscribeSigningStep,
  type InscribeSnapshot,
} from '../../src/inscribe/inscribe-mint-orchestrator';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  fundUninscribed,
  getStockOrdContent,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  waitForOrdStockInscription,
} from './regtest-helpers';

const FEE_RATE = 5;
const scureRegtest = toScureNetwork(Network.Regtest);
const enc = (s: string) => new TextEncoder().encode(s);

/** A fresh taproot address to receive inscriptions. */
function randomP2tr(): string {
  return btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!;
}

/** Bitcoin Core signs and finalizes, exactly as an external wallet would. */
function walletSign(unsigned: { base64: string; hex: string }): Promise<string> {
  const processed = JSON.parse(rpc(
    '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
    `psbt=${unsigned.base64}`, 'sign=true', 'finalize=true',
  )) as { psbt: string; complete: boolean };
  if (!processed.complete) throw new Error('walletprocesspsbt did not complete');
  return Promise.resolve(processed.psbt);
}

/** Run a batch through the orchestrator and return the snapshots it emitted. */
async function runBatch(batch: Parameters<InscribeMintOrchestrator['setBatch']>[0]) {
  const f = await fundUninscribed();
  const deps: InscribeOrchestratorDeps = {
    getUtxos: async () => [{ ...f.utxo, status: { confirmed: true } }],
    // The funding-safety scan is the consumer's own IO; this spec is about the
    // batch wiring, so the coin is declared clean.
    scan: { classify: async () => 'clean' },
    broadcast: (txHex: string) => postTx(txHex),
    network: Network.Regtest,
  };
  const o = new InscribeMintOrchestrator(deps);
  const signingSteps: Array<InscribeSigningStep | null> = [];
  const states: string[] = [];
  let lastSigning = '\u0000'; // never equal to a real serialisation
  o.subscribe((s: InscribeSnapshot) => {
    const serialised = JSON.stringify(s.signing);
    if (serialised !== lastSigning) {
      lastSigning = serialised;
      signingSteps.push(s.signing);
    }
    if (states.at(-1) !== s.state) states.push(s.state);
  });

  await o.setWallet({
    type: KnownOrdinalWalletType.xpub,
    ordinalsAddress: randomP2tr(),
    paymentAddress: f.fundingAddr,
    paymentPublicKey: hex.encode(f.fundingPubkey),
  });
  o.setFeeRate(FEE_RATE);
  o.setBatch(batch);
  await new Promise<void>((resolve) => {
    const unsub = o.subscribe((s) => {
      if (s.simulations.length > 0 && s.simulations[0].preview !== null) {
        unsub();
        resolve();
      }
    });
  });

  const preview = o.getSnapshot().simulations[0].preview!;
  const result = await o.mint(walletSign);

  const tip = mineBlocks(1);
  await waitForElectrsSync(tip);
  await waitForOrdStockSync(tip);
  return { o, result, preview, signingSteps, states };
}

beforeAll(async () => {
  await waitForOrdStockReady();
}, 120_000);

describe('InscribeMintOrchestrator.setBatch → live commit + reveal', () => {
  it('separate-outputs: every inscription lands on its own output, where the snapshot said', async () => {
    const bodies = ['batch one', 'batch two', 'batch three'].map(enc);
    const recipients = [randomP2tr(), randomP2tr(), randomP2tr()];
    const { o, result, preview, signingSteps, states } = await runBatch({
      mode: 'separate-outputs',
      inscriptions: bodies.map((body, i) => ({
        source: { kind: 'file', body, contentType: 'text/plain;charset=utf-8' },
        destination: recipients[i],
      })),
    });

    expect(o.getSnapshot().state).toBe('success');
    expect(states).toEqual(['idle', 'loading-utxos', 'ready', 'minting', 'success']);
    // No parents and no satpoints, so the wallet is asked once, for the commit.
    expect(preview.walletPrompts).toBe(1);
    expect(signingSteps).toEqual([null, { step: 1, of: 1, what: 'commit' }, null]);

    // ord's index, not ours: three inscriptions, each on its own output's
    // first sat, each carrying the bytes and the content type we set.
    for (let i = 0; i < bodies.length; i++) {
      const id = `${result.revealTxId}i${i}`;
      const insc = await waitForOrdStockInscription(id);
      expect(insc.satpoint).toBe(`${result.revealTxId}:${i}:0`);
      expect(insc.address).toBe(recipients[i]);
      const content = await getStockOrdContent(id);
      expect(Array.from(content.bytes)).toEqual(Array.from(bodies[i]));
      expect(content.contentType).toBe('text/plain;charset=utf-8');
    }
  }, 300_000);

  it('shared-output: all of them ride one output, one postage apart, as ord reads it', async () => {
    const bodies = ['shared a', 'shared b'].map(enc);
    const postageSats = 700;
    const { result } = await runBatch({
      mode: 'shared-output',
      postageSats,
      inscriptions: bodies.map((body) => ({
        source: { kind: 'file', body, contentType: 'text/plain;charset=utf-8' },
      })),
    });

    for (let i = 0; i < bodies.length; i++) {
      const insc = await waitForOrdStockInscription(`${result.revealTxId}i${i}`);
      expect(insc.satpoint).toBe(`${result.revealTxId}:0:${i * postageSats}`);
    }
    // One output holding every postage together.
    const first = await waitForOrdStockInscription(`${result.revealTxId}i0`);
    expect(first.value).toBe(postageSats * bodies.length);
  }, 300_000);

  it('the preview priced what the wallet actually spent', async () => {
    const { result, preview } = await runBatch({
      mode: 'separate-outputs',
      inscriptions: [
        { source: { kind: 'file', body: enc('priced a'), contentType: 'text/plain' } },
        { source: { kind: 'file', body: enc('priced b'), contentType: 'text/plain' } },
      ],
    });

    const commit = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', result.commitTxId)));
    const reveal = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', result.revealTxId)));
    expect(commit.vsize).toBe(preview.commitVsize);
    expect(reveal.vsize).toBe(preview.revealVsize);
    // The commit output funds the reveal: its fee plus every postage.
    expect(Number(commit.getOutput(0).amount)).toBe(preview.revealFeeSats + preview.postageSats);
  }, 300_000);
});
