import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  Cat21MintOrchestrator,
  MintOrchestratorDeps,
  MintSnapshot,
  MintWalletContext,
} from './cat21-mint-orchestrator';
import { TxnOutput } from './cat21.service.types';

// Node unit test — no Angular, no browser. Real keys so simulateMintTransaction
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
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient');
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
    const s = await waitFor(o, (s) => s.fundingRecommendation.status !== 'insufficient');
    expect(s.fundingRecommendation.status).toBe('auto');
    expect(s.fundingRecommendation.recommended?.txid).toBe(coin('c', 100_000).txid);
    expect(s.simulations).toHaveLength(1);
    expect(s.simulations[0].insufficient).toBe(false);
  });

  it('EXPERT-REQUIRED: only an asset-bearing covering coin => no auto-pick, mint() refuses', async () => {
    const o = new Cat21MintOrchestrator(
      deps({ getUtxos: async () => [coin('d', 100_000)], scan: { classify: async () => 'has-assets' } }),
    );
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status !== 'insufficient');
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

  it('a genuine wallet change resets fee + selection', async () => {
    const o = new Cat21MintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(10);
    o.setSelectedUtxo(coin('c', 100_000));
    await o.setWallet({ ...wallet, ordinalsAddress: btc.p2tr(hex.decode('0'.repeat(63) + '2'), undefined, btc.NETWORK).address! });
    expect(o.getSnapshot().feeRate).toBeNull();
    expect(o.getSnapshot().selectedUtxo).toBeNull();
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
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient');
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
    expect(s.fundingRecommendation.status).toBe('insufficient');
    expect(s.state).toBe('ready');
  });
});
