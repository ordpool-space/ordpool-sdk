import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

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

// Node unit test — no Angular. Real keys/addresses so simulateInscribeFees +
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
  body: new TextEncoder().encode('hello cat'),
  contentType: 'text/plain',
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
