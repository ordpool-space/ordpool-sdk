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
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import {
  fundUninscribed,
  getStockOrdInscription,
  waitForTxConfirmed,
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

/**
 * Bitcoin Core signs, exactly as an external wallet would. `finalize=false`
 * because a batch reveal's wallet-facing PSBT also carries the foreign
 * ephemeral commit input, which Core cannot complete; the SDK's signer
 * finalizes. The commit's PSBT completes either way.
 */
function walletSign(unsigned: { base64: string; hex: string }): Promise<string> {
  const processed = JSON.parse(rpc(
    '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
    `psbt=${unsigned.base64}`, 'sign=true', 'sighashtype=ALL', 'finalize=false',
  )) as { psbt: string };
  return Promise.resolve(processed.psbt);
}

/** The Core wallet's own taproot address plus the internal key from its descriptor. */
function newWalletTaproot(): { address: string; script: Uint8Array; internalKey: Uint8Array } {
  const address = rpc('-rpcwallet=ordpool-e2e', 'getnewaddress', '', 'bech32m').trim();
  const info = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'getaddressinfo', address)) as {
    desc: string; scriptPubKey: string;
  };
  const m = /tr\((?:\[[^\]]+\])?([0-9a-f]{64})\)/i.exec(info.desc);
  if (!m) throw new Error(`cannot parse tr() internal key from descriptor: ${info.desc}`);
  return { address, script: hex.decode(info.scriptPubKey), internalKey: hex.decode(m[1]) };
}

/** Run a batch through the orchestrator and return the snapshots it emitted. */
async function runBatch(batch: Parameters<InscribeMintOrchestrator['setBatch']>[0]) {
  const f = await fundUninscribed();
  return runBatchWith(batch, f);
}

async function runBatchWith(
  batch: Parameters<InscribeMintOrchestrator['setBatch']>[0],
  f: { fundingAddr: string; fundingPubkey: Uint8Array; utxo: { txid: string; vout: number; value: number } },
) {
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

  it('with a parent, the wallet signs twice and ord links every child to it', async () => {
    // The parent's home is the Core wallet's own taproot address, so the same
    // wallet that signs the commit can sign the reveal's parent input.
    const home = newWalletTaproot();
    const pf = await fundUninscribed();
    const parent = createInscribeTransactions({
      paymentOutput: { ...pf.utxo, status: { confirmed: true } },
      paymentPublicKey: pf.fundingPubkey,
      paymentAddress: pf.fundingAddr,
      recipientAddress: home.address,
      body: enc('batch parent'),
      contentType: 'text/plain',
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    const signedCommit = JSON.parse(rpc(
      '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
      `psbt=${Buffer.from(parent.commitPsbt).toString('base64')}`, 'sign=true', 'finalize=true',
    )) as { hex: string; complete: boolean };
    expect(signedCommit.complete).toBe(true);
    expect(await postTx(signedCommit.hex)).toBe(parent.commitTxid);
    mineBlocks(1);
    await waitForTxConfirmed(parent.commitTxid);
    const parentRevealTxid = await postTx(parent.revealHex);
    const parentTip = mineBlocks(1);
    await waitForElectrsSync(parentTip);
    await waitForOrdStockSync(parentTip);
    const parentId = `${parentRevealTxid}i0`;
    const parentBefore = await waitForOrdStockInscription(parentId);
    expect(parentBefore.address).toBe(home.address);

    const bodies = ['child one', 'child two'].map(enc);
    const f = await fundUninscribed();
    const { o, result, preview, signingSteps } = await runBatchWith({
      mode: 'separate-outputs',
      parents: [{
        id: parentId,
        utxo: {
          txid: parentRevealTxid, vout: 0, value: parentBefore.value,
          scriptPubKey: home.script, tapInternalKey: home.internalKey,
        },
        returnAddress: home.address,
      }],
      inscriptions: bodies.map((body) => ({
        source: { kind: 'file', body, contentType: 'text/plain' },
      })),
    }, f);

    expect(o.getSnapshot().state).toBe('success');
    // A parent makes the reveal spend a wallet UTXO, so a second signature.
    expect(preview.walletPrompts).toBe(2);
    expect(signingSteps).toEqual([
      null,
      { step: 1, of: 2, what: 'commit' },
      { step: 2, of: 2, what: 'parent-inputs' },
      null,
    ]);

    // ord's provenance, and the parent back home with its own sats intact.
    for (let i = 0; i < bodies.length; i++) {
      const child = await waitForOrdStockInscription(`${result.revealTxId}i${i}`);
      expect(child.parents).toEqual([parentId]);
    }
    const parentAfter = await getStockOrdInscription(parentId);
    expect(parentAfter.address).toBe(home.address);
    expect(parentAfter.value).toBe(parentBefore.value);
    // The reveal returns each parent at the same index it was spent from.
    expect(parentAfter.satpoint).toBe(`${result.revealTxId}:0:0`);
  }, 420_000);

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
