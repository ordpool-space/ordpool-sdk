import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import {
  Cat21MintOrchestrator,
  MintOrchestratorDeps,
  MintSnapshot,
  MintWalletContext,
} from './cat21-mint-orchestrator.js';
import { TxnOutput } from './cat21.service.types.js';
import { simulateMintTransaction } from './cat21.service.helper.js';
import { outpointKey } from '../cat21-fee/candidate-fees.js';

// Node unit test — no browser. Real keys so simulateMintTransaction
// actually builds a PSBT. Pins the framework-agnostic orchestration: the state
// machine, the safe-auto funding pick (via selectFunding), and mint()'s
// pre-signing guards. The signer happy-path needs a browser wallet provider,
// so it's covered by the wallet-matrix e2e, not here.

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

const wallet: MintWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

const coin = (id: string, value: number): TxnOutput => ({
  txid: id.repeat(64).slice(0, 64),
  vout: 0,
  status: { confirmed: true },
  value,
});

const deps = (over: Partial<MintOrchestratorDeps> = {}): MintOrchestratorDeps => ({
  getUtxos: async () => [coin('c', 100_000)],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  ...over,
});

/** Resolve once a snapshot satisfying `pred` is emitted (the async recompute). */
function waitFor(o: Cat21MintOrchestrator, pred: (s: MintSnapshot) => boolean): Promise<MintSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => {
      if (pred(s)) {
        unsub();
        resolve(s);
      }
    });
  });
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('Cat21MintOrchestrator (framework-agnostic)', () => {
  it('starts idle with an empty recommendation', () => {
    const o = new Cat21MintOrchestrator(deps());
    expect(o.getSnapshot().state).toBe('idle');
    expect(o.getSnapshot().fundingRecommendation.status).toBe('scanning');
  });

  it('setWallet fetches UTXOs and reaches ready', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('ready');
  });

  it('AUTO: a clean covering coin becomes the safe recommendation', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status !== 'scanning');
    expect(s.fundingRecommendation.status).toBe('auto');
    expect(s.fundingRecommendation.recommended?.txid).toBe(coin('c', 100_000).txid);
    expect(s.simulations).toHaveLength(1);
    expect(s.simulations[0].insufficient).toBe(false);
  });

  it('the snapshot carries a per-coin fee for every candidate, keyed by outpoint', async () => {
    // What a picker binds to. The orchestrator computes this inside its call to
    // the core and used to discard it, so a page could show which coins are
    // safe and not what any of them would cost.
    const big = coin('c', 100_000);
    const small = coin('e', 1_000);
    const o = new Cat21MintOrchestrator(deps({ getUtxos: async () => [big, small] }));
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.candidateFees.length > 0);

    const byOutpoint = new Map(s.candidateFees.map((f) => [outpointKey(f), f]));
    expect([...byOutpoint.keys()].sort()).toEqual([outpointKey(big), outpointKey(small)].sort());

    const rich = byOutpoint.get(outpointKey(big));
    const poor = byOutpoint.get(outpointKey(small));
    // The roomy coin funds the mint and emits change, so nothing is folded into
    // the fee. The 1000-sat coin cannot cover postage + fee at 10 sat/vB at
    // all, so it is unavailable rather than free.
    expect({ richAbsorbed: rich?.absorbedSubDustSats, poorFee: poor?.finalFeeSats, poorAbsorbed: poor?.absorbedSubDustSats })
      .toEqual({ richAbsorbed: 0, poorFee: null, poorAbsorbed: null });

    // The picker grid is DERIVED from these fees rather than priced again, so
    // comparing the two would compare a number with itself. Check it against
    // the BUILDER instead: build the mint at the derived fee and require the
    // row to describe the transaction that actually comes out.
    const gridRow = s.simulations.find((r) => r.utxo.txid === big.txid);
    const view = gridRow?.simulation;
    expect(view).toBeTruthy();
    if (!view) return;

    const built = simulateMintTransaction(
      wallet.type, wallet.ordinalsAddress, big, wallet.paymentAddress,
      hex.decode(wallet.paymentPublicKey), view.finalTransactionFee, Network.Mainnet,
    );
    expect({
      fee: view.finalTransactionFee,
      change: view.changeAmount,
      recipient: view.amountToRecipient,
      vsize: view.vsize,
    }).toEqual({
      fee: built.finalTransactionFee,
      change: built.changeAmount,
      recipient: built.amountToRecipient,
      vsize: built.vsize,
    });

    // Conservation: nothing is invented or lost between the coin and the
    // three places its sats can go.
    expect(view.singleInputAmount).toBe(
      view.amountToRecipient + view.finalTransactionFee + view.changeAmount,
    );
  });

  it('the snapshot carries both funding targets, not only the feasibility floor', async () => {
    // Anyone sizing a coin from the requirement alone is working from half the
    // rule: selection PREFERS a coin clearing the change-headroom target.
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRequirementSats > 0);
    expect(s.fundingPreferredSats).toBeGreaterThan(s.fundingRequirementSats);
  });

  it('EXPERT-REQUIRED: only an asset-bearing covering coin => no auto-pick, mint() refuses', async () => {
    const o = new Cat21MintOrchestrator(
      deps({ getUtxos: async () => [coin('d', 100_000)], scan: { classify: async () => 'has-assets' } }),
    );
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status !== 'scanning');
    expect(s.fundingRecommendation.status).toBe('expert-required');
    await expect(o.mint()).rejects.toThrow(/Select a funding UTXO/);
  });

  it('mint() guards: no feeRate / no wallet throw before touching a signer', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await expect(o.mint()).rejects.toThrow('No wallet connected');
    await o.setWallet(wallet);
    await expect(o.mint()).rejects.toThrow('No fee rate set');
  });

  it('subscribe fires immediately then on every change; unsubscribe stops it', async () => {
    const o = new Cat21MintOrchestrator(deps());
    const seen: string[] = [];
    const unsub = o.subscribe((s) => seen.push(s.state));
    expect(seen).toEqual(['idle']); // immediate
    await o.setWallet(wallet);
    expect(seen).toContain('ready');
    const countAtUnsub = seen.length;
    unsub();
    o.reset();
    expect(seen).toHaveLength(countAtUnsub); // no more after unsubscribe
  });

  it('disconnect (setWallet(null)) returns to idle and clears the grid', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    await o.setWallet(null);
    const s = o.getSnapshot();
    expect(s.state).toBe('idle');
    expect(s.simulations).toEqual([]);
    expect(s.fundingRecommendation.status).toBe('scanning');
  });

  it('reset() with no wallet connected returns to idle', () => {
    const o = new Cat21MintOrchestrator(deps());
    o.reset();
    expect(o.getSnapshot().state).toBe('idle');
  });

  it('mint() drives state:error when the wallet signer is unavailable (no browser provider)', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    // Inputs are valid, so this passes every guard and reaches the signer,
    // which has no browser provider in node -> the catch arm must fire.
    await expect(o.mint()).rejects.toThrow();
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBeTruthy();
  });

  it('a genuine wallet change resets fee + selection', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    o.setSelectedUtxo(coin('c', 100_000));
    await o.setWallet({ ...wallet, ordinalsAddress: btc.p2tr(hex.decode('0'.repeat(63) + '2'), undefined, btc.NETWORK).address! });
    expect(o.getSnapshot().feeRate).toBeNull();
    expect(o.getSnapshot().selectedUtxo).toBeNull();
  });

  it('AUTO-picks a danger-band coin the old fixed-200 ceiling would have rejected', async () => {
    // 2200 < old target (546 + 200*10 = 2546) => used to show insufficient.
    const o = new Cat21MintOrchestrator(deps({ getUtxos: async () => [coin('c', 2200)] }));
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.fundingRecommendation.status === 'auto');
    expect(s.simulations[0].insufficient).toBe(false);
    expect(Number(s.simulations[0].simulation!.finalTransactionFee)).toBeLessThanOrEqual(2200 - 546);
  });

  it('getUtxos rejection => state error + cleared grid', async () => {
    const o = new Cat21MintOrchestrator(
      deps({ getUtxos: async () => { throw new Error('electrs 502'); } }),
    );
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBe('Failed to load UTXOs: electrs 502');
    expect(o.getSnapshot().simulations).toEqual([]);
  });

  it("mint() rejects with 'No UTXO selected' when funding is insufficient (not expert)", async () => {
    const o = new Cat21MintOrchestrator(deps({ getUtxos: async () => [coin('c', 400)] }));
    await o.setWallet(wallet);
    o.setFeeRate(10);
    await flush();
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient'); // MEASURED: a recompute ran and no coin covers
    await expect(o.mint()).rejects.toThrow('No UTXO selected');
  });

  it('reset() clears the simulation grid + funding recommendation, not just feeRate', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    o.reset();
    const s = o.getSnapshot();
    expect(s.feeRate).toBeNull();
    expect(s.simulations).toEqual([]);
    expect(s.fundingRecommendation.status).toBe('scanning');
    expect(s.state).toBe('ready');
  });
});

describe('Cat21MintOrchestrator.refreshUtxos', () => {
  it('re-reads the funding set, so a page that connected too early recovers', async () => {
    // The real path this exists for: the page connects while the funding tx is
    // still unconfirmed, getUtxos returns nothing, and the CTA sits disabled
    // for the life of the page because the set is read once on connect.
    let call = 0;
    const o = new Cat21MintOrchestrator(deps({
      getUtxos: async () => (call++ === 0 ? [] : [coin('c', 100_000)]),
    }));
    await o.setWallet(wallet);
    o.setFeeRate(10);
    // Nothing to fund with, and no fee rate will change that: this is the
    // stuck-disabled state a user sees after connecting too early.
    await waitFor(o, (s) => s.state === 'ready');
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient'); // MEASURED: the set was read and is empty

    // The coin has since confirmed. Re-reading the set is the only thing that
    // recovers it, and it must keep the fee rate the user already chose.
    await o.refreshUtxos();
    const after = await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    expect(after.fundingRecommendation.status).toBe('auto');
    expect(after.fundingRecommendation.recommended?.txid).toBe(coin('c', 100_000).txid);
    expect(o.getSnapshot().feeRate).toBe(10);
  });

  it('is a no-op with no wallet, rather than throwing', async () => {
    const o = new Cat21MintOrchestrator(deps({
      getUtxos: async () => { throw new Error('must not be called without a wallet'); },
    }));
    await expect(o.refreshUtxos()).resolves.toBeUndefined();
  });
  it('a re-emission of the SAME wallet does not reload, so a gated control is not torn out', async () => {
    // WalletService's subject pushes the same wallet again on every
    // onAccountChange. A consumer binding that straight to setWallet used to
    // re-run the whole load, dropping the orchestrator back through
    // loading-utxos; a control gated on that state leaves the DOM for a frame
    // and a click landing there is lost.
    let fetches = 0;
    const states: string[] = [];
    const o = new Cat21MintOrchestrator(
      deps({ getUtxos: async () => { fetches++; return [coin('c', 100_000)]; } }),
    );
    o.subscribe((s) => states.push(s.state));
    await o.setWallet(wallet);
    const afterFirst = fetches;
    await o.setWallet({ ...wallet });
    await o.setWallet({ ...wallet });

    expect({ afterFirst, total: fetches }).toEqual({ afterFirst: 1, total: 1 });
    // One load-transition only: the re-emissions produced no second one.
    expect(states.filter((s) => s === 'loading-utxos')).toHaveLength(1);
  });

  it('refreshUtxos re-reads for the SAME wallet, which setWallet no longer does', async () => {
    let fetches = 0;
    const o = new Cat21MintOrchestrator(
      deps({ getUtxos: async () => { fetches++; return [coin('c', 100_000)]; } }),
    );
    await o.setWallet(wallet);
    await o.refreshUtxos();
    expect(fetches).toBe(2);
  });

  it('a wallet differing only in paymentAddress IS a different wallet', async () => {
    // The old guard compared ordinalsAddress alone, so this read as a
    // re-emission and the flow kept the previous wallet's coins.
    let fetches = 0;
    const o = new Cat21MintOrchestrator(
      deps({ getUtxos: async () => { fetches++; return [coin('c', 100_000)]; } }),
    );
    await o.setWallet(wallet);
    await o.setWallet({ ...wallet, paymentAddress: PAYMENT_ADDR.replace(/.$/, 'x') });
    expect(fetches).toBe(2);
  });

  it('a failed recompute reports the reason and claims nothing about the coins', async () => {
    // The old swallow produced a disabled control with no explanation. The new
    // failure must not overcorrect into 200 rows each asserting "can't fund at
    // this rate", which is a statement about the fee rate that nobody measured.
    // A scan that throws is NOT this case: selectFunding turns that into a
    // `failed` bucket, which is a coin state rather than a crash. The recompute
    // throws when the BUILDER cannot work from the params at all, which is what
    // a wrong-network address looks like.
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet({ ...wallet, ordinalsAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' });
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.errorMessage !== null);
    expect(s.errorMessage).toMatch(/Could not price the funding coins/);
    expect(s.simulations).toEqual([]);
    expect(s.fundingRecommendation.status).toBe('scanning');
    // Reachability, not just presence: every consumer gates its banner on
    // `state === 'error'`, so a reason written while the state stays `ready`
    // is a message nobody can render and the screen falls through to
    // "not enough Bitcoin, add funds" for a code or network fault.
    expect(s.state).toBe('error');
  });

  it('an explicit pick RE-DECIDES, so the consumer never has to override the verdict', async () => {
    // The pick feeds selectedFundingUtxo in the core, so the recommendation is
    // a different answer once it is set. Without a recompute the status and the
    // recommended coin keep describing the AUTO pick, and a consumer has to
    // short-circuit its own CTA to make an explicit pick usable. That is a
    // consumer computing funding policy, which the asset-safety rule forbids.
    const small = coin('a', 60_000);
    const big = coin('b', 900_000);
    const o = new Cat21MintOrchestrator(deps({ getUtxos: async () => [small, big] }));
    await o.setWallet(wallet);
    o.setFeeRate(10);

    // ord's best-fit picks the SMALLEST covering coin.
    // `recommendation.recommended` stays the AUTO answer by design: it means
    // "what would we choose". The RESOLVED pick is what the button spends.
    const auto = await waitFor(o, (s) => s.resolvedFundingUtxo != null);
    expect(auto.resolvedFundingUtxo?.txid).toBe(small.txid);
    expect(auto.resolvedFundingStatus).toBe('ready');

    o.setSelectedUtxo(big);
    const picked = await waitFor(o, (s) => s.resolvedFundingUtxo?.txid === big.txid);
    expect(picked.resolvedFundingUtxo?.txid).toBe(big.txid);
    expect(picked.resolvedFundingStatus).toBe('ready');
  });

  it('a failed refresh invalidates an in-flight recompute', async () => {
    // ordpool polls refreshUtxos() while the status is insufficient. One poll
    // hits an electrs blip while a recompute from a typed fee rate is still
    // awaiting its content scans. Without an eager seq bump the recompute lands
    // SECOND and patches its rows and recommendation over an emptied utxo set,
    // so the page offers funding options for coins the orchestrator no longer
    // holds.
    //
    // Asserted on the SEQUENCE rather than by racing two promises: the property
    // is an ordering guarantee, and a timing-based version of this test is
    // flaky by construction, which is what our own rules forbid.
    const o = new Cat21MintOrchestrator(deps({
      getUtxos: async () => { throw new Error('electrs blip'); },
    }));
    const seq = () => (o as unknown as { recomputeSeq: number }).recomputeSeq;

    await o.setWallet(wallet);
    const before = seq();
    await o.refreshUtxos();

    expect(seq()).toBeGreaterThan(before);
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toMatch(/Failed to load UTXOs: electrs blip/);
  });

  it('a SUCCESSFUL recompute does not clear an error it did not write', async () => {
    // mint()'s broadcast failure and loadUtxos's failure both write
    // errorMessage. Clobbering one on the next fee-rate nudge leaves
    // `state: 'error'` with nothing to render: no text, no CTA, no way out.
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);

    (o as unknown as { patch(n: Record<string, unknown>): void })
      .patch({ state: 'error', errorMessage: 'user rejected the signature' });

    o.setFeeRate(11);
    // Let the recompute run to completion rather than racing its first
    // emission: the clobber this pins happens in the FINAL patch.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    expect(o.getSnapshot().errorMessage).toBe('user rejected the signature');
  });

});

describe('setSelectedUtxo is free when the selection does not change', () => {
  it('a consumer re-driving the setter from a snapshot stream does NOT loop', async () => {
    // A consumer tap that reconciles its selection on every emission calls the
    // setter again with the value already in the snapshot. Because the setter
    // recomputes, a patch there would emit, re-enter the tap and never settle:
    // measured at 800+ emissions in one second before the guard existed. This
    // is the shape ordpool's paymentOutputs$ tap has, and its lane failed with
    // the funding picker never rendering.
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    let emissions = 0;
    o.subscribe(() => {
      emissions++;
      if (emissions < 200) o.setSelectedUtxo(o.getSnapshot().selectedUtxo);
    });
    o.setFeeRate(10);
    await new Promise((r) => setTimeout(r, 300));
    expect(emissions).toBeLessThan(50);
  }, 15_000);

  it('a DIFFERENT outpoint still patches and recomputes', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    let emissions = 0;
    o.subscribe(() => { emissions++; });
    const before = emissions;
    o.setSelectedUtxo(coin('c', 100_000));
    expect(emissions).toBeGreaterThan(before);
    expect(o.getSnapshot().selectedUtxo?.value).toBe(100_000);
  }, 15_000);
});

describe('the snapshot says SCANNING rather than claiming a verdict it has not measured', () => {
  it('reports scanning while the content scan is in flight, and never insufficient', async () => {
    // Before this, the window read state 'ready' with the EMPTY placeholder's
    // 'insufficient' showing through, so a consumer gating on the
    // recommendation told the user nothing covers while the scan that would
    // find their coin was still running. `state` is the wrong thing to gate
    // on: loadUtxos patches 'ready' BEFORE awaiting the recompute.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let gated = false;
    const o = new Cat21MintOrchestrator(deps({
      scan: { classify: async () => { if (gated) await gate; return 'clean'; } },
    }));
    await o.setWallet(wallet);

    // Land a FIRST answer, so the in-flight marker has something to overwrite.
    // Asserting it on the first recompute proves nothing: the initial snapshot
    // is already 'scanning', so the window and the initial value coincide and
    // removing the marker leaves the assertion green.
    o.setFeeRate(10);
    const settled = await waitFor(o, (s) => s.resolvedFundingStatus === 'ready');
    expect(settled.fundingRecommendation.status).toBe('auto');

    // Now a SECOND recompute, with the scan held open.
    gated = true;
    o.setFeeRate(25);
    await flush();
    const during = o.getSnapshot();
    expect(during.resolvedFundingStatus).toBe('scanning');
    expect(during.fundingRecommendation.status).not.toBe('insufficient');

    release();
    const after = await waitFor(o, (s) => s.resolvedFundingStatus !== 'scanning');
    expect(after.resolvedFundingStatus).toBe('ready');
    expect(after.fundingRecommendation.status).toBe('auto');
  }, 15_000);

  it('a READ but empty funding set is insufficient, an unread one is scanning', async () => {
    // The distinction the whole change exists for: "nothing covers" is a
    // measured verdict, "no answer yet" is the absence of one.
    const unread = new Cat21MintOrchestrator(deps());
    expect(unread.getSnapshot().fundingRecommendation.status).toBe('scanning');
    expect(unread.getSnapshot().resolvedFundingStatus).toBe('scanning');

    const empty = new Cat21MintOrchestrator(deps({ getUtxos: async () => [] }));
    await empty.setWallet(wallet);
    empty.setFeeRate(10);
    await flush();
    expect(empty.getSnapshot().fundingRecommendation.status).toBe('insufficient');
    expect(empty.getSnapshot().resolvedFundingStatus).toBe('insufficient');
  }, 15_000);
});
