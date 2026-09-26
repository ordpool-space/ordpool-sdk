import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';
import {
  InscribeContent,
  InscribeMintOrchestrator,
  InscribeOrchestratorDeps,
  InscribeSnapshot,
  InscribeWalletContext,
} from './inscribe-mint-orchestrator.js';

// Node unit test. Real keys/addresses so simulateInscribeFees +
// prepareInscribeFundingInput actually run. Pins the framework-agnostic
// inscribe orchestration: state machine, the per-UTXO fee grid, safe-auto
// funding pick, and mint()'s pre-signing guards. The signer happy-path (commit
// signing) needs a browser wallet provider → covered by the wallet-matrix e2e.

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

const wallet: InscribeWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

const content: InscribeContent = {
  source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' },
};

const coin = (id: string, value: number): TxnOutput => ({
  txid: id.repeat(64).slice(0, 64),
  vout: 0,
  status: { confirmed: true },
  value,
});

const deps = (over: Partial<InscribeOrchestratorDeps> = {}): InscribeOrchestratorDeps => ({
  getUtxos: async () => [coin('c', 100_000)],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  ...over,
});

function waitFor(o: InscribeMintOrchestrator, pred: (s: InscribeSnapshot) => boolean): Promise<InscribeSnapshot> {
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

describe('InscribeMintOrchestrator (framework-agnostic)', () => {
  it('starts idle', () => {
    expect(new InscribeMintOrchestrator(deps()).getSnapshot().state).toBe('idle');
  });

  it('setWallet fetches UTXOs and reaches ready', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('ready');
  });

  it('AUTO: clean coin + content + feeRate => a viable simulation row + auto funding', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    expect(s.simulations).toHaveLength(1);
    expect(s.simulations[0].insufficient).toBe(false);
    expect(s.simulations[0].simulation?.totalFeeSats).toBeGreaterThan(0);
  });

  it('EXPERT-REQUIRED: only an asset coin => expert-required, mint() refuses', async () => {
    const o = new InscribeMintOrchestrator(
      deps({ getUtxos: async () => [coin('d', 100_000)], scan: { classify: async () => 'has-assets' } }),
    );
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status === 'expert-required');
    expect(s.simulations).toHaveLength(1);
    await expect(o.mint()).rejects.toThrow(/Select a funding UTXO/);
  });

  it('an explicit pick RE-DECIDES, so a consumer never overrides the verdict', async () => {
    // fundingRecommendation.recommended answers "what would we choose" and
    // deliberately does not follow an explicit pick. resolvedFundingUtxo and
    // resolvedFundingStatus answer "what happens if you press the button",
    // which is what a CTA is gated on. Without them a consumer short-circuits
    // its own CTA, which is a consumer computing funding policy.
    const dirty = coin('d', 100_000);
    const o = new InscribeMintOrchestrator(
      deps({ getUtxos: async () => [dirty], scan: { classify: async () => 'has-assets' } }),
    );
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    const blocked = await waitFor(o, (s) => s.fundingRecommendation.status === 'expert-required');
    expect(blocked.resolvedFundingUtxo).toBeNull();
    expect(blocked.resolvedFundingStatus).toBe('expert-required');

    o.setSelectedUtxo(dirty);
    const picked = await waitFor(o, (s) => s.resolvedFundingUtxo != null);
    expect(picked.resolvedFundingUtxo?.txid).toBe(dirty.txid);
    // 'asset-notice', not 'ready': the pick is honoured AND the coin still
    // carries an asset. Reporting 'ready' threw the warning away at the moment
    // the user chose the risky coin, which is when it matters most. It is an
    // ENABLED state, so the CTA stays live and executeInscribe proceeds.
    expect(picked.resolvedFundingStatus).toBe('asset-notice');
  });

  it('mint() guards: no wallet / no feeRate / no UTXO / no content', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await expect(o.mint()).rejects.toThrow('No wallet connected');
    await o.setWallet(wallet);
    await expect(o.mint()).rejects.toThrow('No fee rate set');
    o.setFeeRate(10);
    await expect(o.mint()).rejects.toThrow('No UTXO selected');
    o.setSelectedUtxo(coin('c', 100_000));
    await expect(o.mint()).rejects.toThrow('No inscription content set');
  });

  it('subscribe fires immediately then on change; unsubscribe stops it', async () => {
    const o = new InscribeMintOrchestrator(deps());
    const seen: string[] = [];
    const unsub = o.subscribe((s) => seen.push(s.state));
    expect(seen).toEqual(['idle']);
    await o.setWallet(wallet);
    expect(seen).toContain('ready');
    const n = seen.length;
    unsub();
    o.reset();
    expect(seen).toHaveLength(n);
  });

  it('getUtxos rejection => state error + cleared grid', async () => {
    const o = new InscribeMintOrchestrator(
      deps({ getUtxos: async () => { throw new Error('electrs 502'); } }),
    );
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBe('Failed to load UTXOs: electrs 502');
    expect(o.getSnapshot().simulations).toEqual([]);
  });

  it('reset() clears the simulation grid + funding recommendation, not just feeRate', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    o.reset();
    const s = o.getSnapshot();
    expect(s.feeRate).toBeNull();
    expect(s.content).toBeNull();
    expect(s.simulations).toEqual([]);
    expect(s.fundingRecommendation.status).toBe('scanning'); // reset() clears the inputs, so there is no verdict to report
    expect(s.state).toBe('ready');
  });

  it('disconnect (setWallet(null)) returns to idle and clears the grid', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    await o.setWallet(null);
    expect(o.getSnapshot().state).toBe('idle');
    expect(o.getSnapshot().simulations).toEqual([]);
  });

  it('reset() with no wallet connected returns to idle', () => {
    const o = new InscribeMintOrchestrator(deps());
    o.reset();
    expect(o.getSnapshot().state).toBe('idle');
  });

  it('mint() drives state:error when the wallet signer is unavailable', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    await expect(o.mint()).rejects.toThrow();
    expect(o.getSnapshot().state).toBe('error');
  });
});

describe('InscribeMintOrchestrator: the preview prices what the build signs', () => {
  const previewFee = async (c: InscribeContent): Promise<number> => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent(c);
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].simulation !== null);
    return s.simulations[0].simulation!.revealFeeSats;
  };

  it('counts metadata, title and gallery in the reveal fee (the envelope fields the build writes)', async () => {
    const plain = await previewFee(content);
    const withMetadata = await previewFee({ ...content, metadata: new Uint8Array(200).fill(0xa0) });
    const withTitle = await previewFee({ ...content, title: 'a long enough title to cost a few vbytes' });
    const withGallery = await previewFee({ ...content, gallery: [`${'ab'.repeat(32)}i0`] });
    expect(withMetadata).toBeGreaterThan(plain);
    expect(withTitle).toBeGreaterThan(plain);
    expect(withGallery).toBeGreaterThan(plain);
  });

  it('postage raises the funding requirement by exactly the extra postage', async () => {
    const at = async (postageSats: number) => {
      const o = new InscribeMintOrchestrator(deps());
      await o.setWallet(wallet);
      o.setContent({ ...content, postageSats });
      o.setFeeRate(10);
      const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].simulation !== null);
      return s.simulations[0].simulation!;
    };
    const a = await at(546);
    const b = await at(10_000);
    expect(b.commitOutputValueSats - a.commitOutputValueSats).toBe(10_000 - 546);
  });

  it('reports content that cannot be inscribed once, instead of empty funding rows', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    o.setContent({ ...content, gallery: ['not-an-id'] });
    const s = await waitFor(o, (x) => x.errorMessage !== null);
    expect(s.errorMessage).toMatch(/Invalid inscription id "not-an-id"/);
    expect(s.simulations).toEqual([]);
  });

  it('compressProperties without the brotli wasm says what is missing', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    o.setContent({ ...content, title: 't', compressProperties: true });
    const s = await waitFor(o, (x) => x.errorMessage !== null);
    expect(s.errorMessage).toBe('compressProperties needs the brotli wasm: pass brotliWasm in the orchestrator deps');
  });

  it('satOffset needs the UTXO holding the sat to be chosen explicitly', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent({ ...content, satTarget: { kind: 'in-funding', offset: 1_000 } });
    o.setFeeRate(10);
    await expect(o.mint()).rejects.toThrow('Select the UTXO that holds the sat to inscribe onto');
  });
});

describe('InscribeMintOrchestrator: preview equals the build', () => {
  it('for rich content, the preview row\'s fees and commit output equal createInscribeTransactions for the same coin', async () => {
    const { createInscribeTransactions } = await import('./inscription.service.helper.js');
    const rich: InscribeContent = {
      ...content,
      title: 'My Piece',
      traits: [['rank', 3], ['alpha', true]],
      gallery: [`${'ab'.repeat(32)}i0`],
      metadata: new Uint8Array(40).fill(0xa0),
      metaprotocol: 'parity',
      postageSats: 3_000,
      commitFeeRatePerVbyte: 2,
    };
    const utxo = coin('c', 100_000);
    const o = new InscribeMintOrchestrator(deps({ getUtxos: async () => [utxo] }));
    await o.setWallet(wallet);
    o.setContent(rich);
    o.setFeeRate(7);
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].simulation !== null);
    const preview = s.simulations[0].simulation!;

    const built = createInscribeTransactions({
      ...rich,
      body: (rich.source as { body: Uint8Array }).body,
      contentType: (rich.source as { contentType?: string }).contentType,
      paymentOutput: utxo,
      paymentPublicKey: hex.decode(PAYMENT_PUB),
      paymentAddress: PAYMENT_ADDR,
      recipientAddress: ORDINALS_ADDR,
      feeRatePerVbyte: 7,
      walletType: wallet.type,
      network: Network.Mainnet,
    });
    expect(preview.revealVsize).toBe(built.fees.revealVsize);
    expect(preview.revealFeeSats).toBe(built.fees.revealFeeSats);
    expect(preview.commitOutputValueSats).toBe(built.fees.commitOutputValueSats);
  });
});

describe('InscribeMintOrchestrator: the reshaped inputs and what a screen renders', () => {
  const delegateId = `${'ab'.repeat(32)}i0`;

  it('a delegate source inscribes without a file', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent({ source: { kind: 'delegate', delegate: delegateId } });
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].preview !== null);
    // A delegate carries no body, so it stays small next to a real file
    // (the 36-byte delegate id is all it costs).
    const withFile = await (async () => {
      const p = new InscribeMintOrchestrator(deps());
      await p.setWallet(wallet);
      p.setContent({ source: { kind: 'file', body: new Uint8Array(1_000).fill(7), contentType: 'image/png' } });
      p.setFeeRate(10);
      const t = await waitFor(p, (x) => x.simulations.length > 0 && x.simulations[0].preview !== null);
      return t.simulations[0].preview!.revealVsize;
    })();
    expect(s.simulations[0].preview!.revealVsize).toBeLessThan(withFile);
    expect(s.errorMessage).toBeNull();
  });

  it('the preview carries what the screen shows, and postage follows the chosen postage', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent({ ...content, postageSats: 3_000, tip: { address: PAYMENT_ADDR, value: 1_000 } });
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].preview !== null);
    const p = s.simulations[0].preview!;
    const sim = s.simulations[0].simulation!;
    expect(p.postageSats).toBe(3_000);
    expect(p.totalFeeSats).toBe(sim.commitFeeSats + sim.revealFeeSats);
    expect(p.totalSpentSats).toBe(p.totalFeeSats + 3_000 + 1_000);
    expect(p.fundingRequirementSats).toBe(sim.fundingRequirementSats);
    expect(p.walletPrompts).toBe(1);
  });

  it('a coin that cannot fund the inscription has no preview', async () => {
    const o = new InscribeMintOrchestrator(deps({ getUtxos: async () => [coin('c', 700)] }));
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.simulations.length > 0);
    expect(s.simulations[0].insufficient).toBe(true);
    expect(s.simulations[0].preview).toBeNull();
  });

  it('the sat target union: in-utxo needs no explicit coin choice, in-funding does', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent({ ...content, satTarget: { kind: 'in-funding', offset: 1_000 } });
    o.setFeeRate(10);
    await expect(o.mint()).rejects.toThrow('Select the UTXO that holds the sat');
  });
});

describe('InscribeMintOrchestrator: batches', () => {
  const entry = (text: string) => ({ source: { kind: 'file' as const, body: new TextEncoder().encode(text), contentType: 'text/plain' } });

  it('previews a batch per funding coin, with the batch\'s postage and one prompt', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setBatch({ mode: 'separate-outputs', inscriptions: [entry('a'), entry('b')], postageSats: 700 });
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.simulations.length > 0 && x.simulations[0].preview !== null);
    const p = s.simulations[0].preview!;
    expect(p.postageSats).toBe(1_400); // two inscriptions at 700
    expect(p.walletPrompts).toBe(1);
    expect(s.content).toBeNull();
  });

  it('a batch costs more reveal than a single inscription of the same content', async () => {
    const single = new InscribeMintOrchestrator(deps());
    await single.setWallet(wallet);
    single.setContent(content);
    single.setFeeRate(10);
    const one = await waitFor(single, (x) => x.simulations[0]?.preview != null);

    const many = new InscribeMintOrchestrator(deps());
    await many.setWallet(wallet);
    many.setBatch({ mode: 'separate-outputs', inscriptions: [entry('hello cat'), entry('hello cat')] });
    many.setFeeRate(10);
    const two = await waitFor(many, (x) => x.simulations[0]?.preview != null);
    expect(two.simulations[0].preview!.revealVsize).toBeGreaterThan(one.simulations[0].preview!.revealVsize);
  });

  it('a batch with parents needs two wallet prompts', async () => {
    const parentKey = new Uint8Array(32).fill(0xef);
    const p2tr = btc.p2tr(schnorr.getPublicKey(parentKey), undefined, btc.NETWORK, true);
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setBatch({
      mode: 'separate-outputs',
      inscriptions: [entry('child')],
      parents: [{
        id: `${'ab'.repeat(32)}i0`,
        utxo: { txid: 'ab'.repeat(32), vout: 0, value: 10_000, scriptPubKey: p2tr.script, tapInternalKey: schnorr.getPublicKey(parentKey) },
        returnAddress: p2tr.address!,
      }],
    });
    o.setFeeRate(10);
    const s = await waitFor(o, (x) => x.simulations[0]?.preview != null);
    expect(s.simulations[0].preview!.walletPrompts).toBe(2);
  });

  it('setBatch and setContent replace each other', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setBatch({ mode: 'separate-outputs', inscriptions: [entry('a')] });
    expect(o.getSnapshot().content).toBeNull();
    o.setContent(content);
    expect(o.getSnapshot().batch).toBeNull();
  });

  it('reports a batch ord would refuse, naming the rule', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    o.setBatch({ mode: 'shared-output', inscriptions: [{ ...entry('a'), destination: ORDINALS_ADDR }] });
    const s = await waitFor(o, (x) => x.errorMessage !== null);
    expect(s.errorMessage).toContain('destinations cannot be set');
  });
});

describe('InscribeMintOrchestrator.refreshUtxos', () => {
  it('re-reads the funding set, so a page that connected too early recovers', async () => {
    // Same real path as the mint page: connect while the funding tx is still
    // unconfirmed, getUtxos returns nothing, and the CTA stays disabled for the
    // life of the page because the set is read once on connect. No fee-rate
    // change fixes it, because the fee rate is not what is missing.
    let call = 0;
    const o = new InscribeMintOrchestrator(deps({
      getUtxos: async () => (call++ === 0 ? [] : [coin('c', 100_000)]),
    }));
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'insufficient');

    await o.refreshUtxos();
    const after = await waitFor(o, (s) => s.fundingRecommendation.status !== 'insufficient');
    expect(after.fundingRecommendation.status).toBe('auto');
    // The fee rate the user already chose must survive a refresh.
    expect(o.getSnapshot().feeRate).toBe(10);
  });

  it('is a no-op with no wallet, rather than throwing', async () => {
    const o = new InscribeMintOrchestrator(deps({
      getUtxos: async () => { throw new Error('must not be called without a wallet'); },
    }));
    await expect(o.refreshUtxos()).resolves.toBeUndefined();
  });
});

describe('InscribeMintOrchestrator wallet re-emission', () => {
  it('a re-emission of the SAME wallet does not reload, so a gated control is not torn out', async () => {
    // WalletService's subject pushes the same wallet again on every
    // onAccountChange. Re-running the load drops the orchestrator back through
    // loading-utxos, a control gated on that state leaves the DOM for a frame,
    // and a click landing there is lost.
    let fetches = 0;
    const states: string[] = [];
    const o = new InscribeMintOrchestrator(
      deps({ getUtxos: async () => { fetches++; return [coin('c', 100_000)]; } }),
    );
    o.subscribe((s) => states.push(s.state));
    await o.setWallet(wallet);
    await o.setWallet({ ...wallet });
    await o.setWallet({ ...wallet });

    expect(fetches).toBe(1);
    expect(states.filter((s) => s === 'loading-utxos')).toHaveLength(1);
  });

  it('refreshUtxos re-reads for the SAME wallet, which setWallet no longer does', async () => {
    let fetches = 0;
    const o = new InscribeMintOrchestrator(
      deps({ getUtxos: async () => { fetches++; return [coin('c', 100_000)]; } }),
    );
    await o.setWallet(wallet);
    await o.refreshUtxos();
    expect(fetches).toBe(2);
  });

  it('a wallet differing in ONE field is a different wallet', async () => {
    // The old guard compared a single address, so a change in any other field
    // read as a re-emission and the flow kept the previous wallet's coins.
    let fetches = 0;
    const o = new InscribeMintOrchestrator(
      deps({ getUtxos: async () => { fetches++; return [coin('c', 100_000)]; } }),
    );
    await o.setWallet(wallet);
    await o.setWallet({ ...wallet, paymentPublicKey: wallet.paymentPublicKey.replace(/.$/, '0') });
    expect(fetches).toBe(2);
  });
});

describe('setSelectedUtxo is free when the selection does not change', () => {
  it('a consumer re-driving it from a snapshot stream does NOT loop', async () => {
    // The setter recomputes, so a consumer tap that reconciles its selection on
    // every emission would patch, emit, re-enter and never settle. Measured on
    // the mint orchestrator at 800+ emissions per second, with the symptom a
    // funding picker that never rendered because the page never stopped
    // changing. ordpool has this tap on its inscribe surface too, at
    // inscribe-mint.component.ts:311.
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setContent(content);
    let emissions = 0;
    o.subscribe(() => {
      emissions++;
      if (emissions < 200) o.setSelectedUtxo(o.getSnapshot().selectedUtxo);
    });
    o.setFeeRate(10);
    await new Promise((r) => setTimeout(r, 300));
    expect(emissions).toBeLessThan(50);
  }, 15_000);

  it('the SAME outpoint keeps the first object, a DIFFERENT one replaces it', async () => {
    // The guard compares outpoints, never object identity, and that is the
    // half a consumer feels: re-applying a refreshed row for the same coin is
    // a no-op, so `selectedUtxo` keeps what it had and the LIVE annotated coin
    // is `resolvedFundingUtxo`. Nothing asserted this before; the three
    // sibling specs all set distinct coins, which is exactly the fixture that
    // never enters the branch.
    const first = coin('c', 100_000);
    const refreshed = { ...first, status: { confirmed: true } };
    const other = coin('d', 90_000);
    const o = new InscribeMintOrchestrator(deps({ getUtxos: async () => [first, other] }));
    await o.setWallet(wallet);
    o.setContent(content);
    o.setFeeRate(10);

    o.setSelectedUtxo(first);
    expect(o.getSnapshot().selectedUtxo).toBe(first);

    o.setSelectedUtxo(refreshed);
    expect(o.getSnapshot().selectedUtxo).toBe(first); // same outpoint, not replaced

    o.setSelectedUtxo(other);
    expect(o.getSnapshot().selectedUtxo).toBe(other); // different outpoint, replaced
  }, 15_000);
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('InscribeMintOrchestrator: an empty wallet reads insufficient without a fee rate', () => {
  it('connect an empty wallet and set nothing else: insufficient, not scanning', async () => {
    // No fee rate has been set. An empty set covers nothing at any rate, so
    // the verdict must not wait for one: ordpool renders its
    // fund-this-address panel on 'insufficient'.
    const o = new InscribeMintOrchestrator(deps({ getUtxos: async () => [] }));
    await o.setWallet(wallet);
    await flush();
    expect(o.getSnapshot().feeRate).toBeNull();
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient');
  });

  it('an unread set is not empty: scanning until the read completes', async () => {
    let release: (u: never[]) => void = () => undefined;
    const o = new InscribeMintOrchestrator(deps({ getUtxos: () => new Promise((r) => { release = r; }) }));
    const connecting = o.setWallet(wallet);
    await flush();
    // A fee-rate change while the read is pending recomputes against a set
    // that is still `[]` only because nothing has been read into it yet.
    o.setFeeRate(10);
    await flush();
    expect(o.getSnapshot().fundingRecommendation.status).toBe('scanning');
    release([]);
    await connecting;
    await flush();
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient');
  });
});

describe('InscribeMintOrchestrator: the fee rate survives a wallet connect', () => {
  it('fee rate set before connect, funded wallet: auto once content is set', async () => {
    // ordpool sets the fee rate once, from the fee estimate at page load, and
    // the user connects afterwards. The rate is a network property, so a
    // connect must not drop it and leave a funded wallet without a verdict.
    const o = new InscribeMintOrchestrator(deps());
    o.setFeeRate(10);
    await o.setWallet(wallet);
    o.setContent(content);
    await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
    expect(o.getSnapshot().feeRate).toBe(10);
  });
});
