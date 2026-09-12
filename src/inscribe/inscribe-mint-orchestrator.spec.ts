import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import {
  InscribeContent,
  InscribeMintOrchestrator,
  InscribeOrchestratorDeps,
  InscribeSnapshot,
  InscribeWalletContext,
} from './inscribe-mint-orchestrator';

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
    expect(s.fundingRecommendation.status).toBe('insufficient');
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
    const { createInscribeTransactions } = await import('./inscription.service.helper');
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
