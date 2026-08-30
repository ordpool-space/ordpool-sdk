import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import {
  Cat21TransferOrchestrator,
  TransferOrchestratorDeps,
  TransferSnapshot,
  TransferWalletContext,
} from './cat21-transfer-orchestrator';
import { Cat21Holding } from './cat21-transfer.types';

// Node unit test — no Angular. Real keys so buildTransfer actually builds a
// PSBT. Pins the framework-agnostic transfer orchestration: state machine,
// safe-auto funding pick (cat preserved, funding covers only the fee), and
// transfer()'s pre-signing guards. Signer happy-path needs a browser wallet
// provider → covered by the wallet-matrix e2e.

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

const wallet: TransferWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  ordinalsPublicKey: ORDINALS_XONLY,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

const cat: Cat21Holding = { catNumber: 42, txid: 'a'.repeat(64), vout: 0, value: 546 };

const coin = (id: string, value: number): TxnOutput => ({
  txid: id.repeat(64).slice(0, 64),
  vout: 0,
  status: { confirmed: true },
  value,
});

const deps = (over: Partial<TransferOrchestratorDeps> = {}): TransferOrchestratorDeps => ({
  getUtxos: async () => [coin('c', 100_000)],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  ...over,
});

function waitFor(o: Cat21TransferOrchestrator, pred: (s: TransferSnapshot) => boolean): Promise<TransferSnapshot> {
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

describe('Cat21TransferOrchestrator (framework-agnostic)', () => {
  it('starts idle', () => {
    expect(new Cat21TransferOrchestrator(deps()).getSnapshot().state).toBe('idle');
  });

  it('setWallet fetches UTXOs and reaches ready', async () => {
    const o = new Cat21TransferOrchestrator(deps());
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('ready');
  });

  it('AUTO: clean coin + cat + recipient => a simulation with a positive fee, cat preserved', async () => {
    const o = new Cat21TransferOrchestrator(deps());
    await o.setWallet(wallet);
    o.setCatUtxo(cat);
    o.setRecipientAddress(ORDINALS_ADDR);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.simulation !== null);
    expect(s.fundingRecommendation.status).toBe('auto');
    expect(s.simulation?.feeSats).toBeGreaterThan(0);
    expect(s.simulation?.fundingUtxo.txid).toBe(coin('c', 100_000).txid);
  });

  it('EXPERT-REQUIRED: only an asset coin => no simulation, transfer() refuses', async () => {
    const o = new Cat21TransferOrchestrator(
      deps({ getUtxos: async () => [coin('d', 100_000)], scan: { classify: async () => 'has-assets' } }),
    );
    await o.setWallet(wallet);
    o.setCatUtxo(cat);
    o.setRecipientAddress(ORDINALS_ADDR);
    o.setFeeRate(10);
    const s = await waitFor(o, (s) => s.fundingRecommendation.status === 'expert-required');
    expect(s.simulation).toBeNull();
    await expect(o.transfer()).rejects.toThrow(/Select a funding UTXO/);
  });

  it('transfer() guards: no wallet / no cat / no recipient / no feeRate', async () => {
    const o = new Cat21TransferOrchestrator(deps());
    await expect(o.transfer()).rejects.toThrow('No wallet connected');
    await o.setWallet(wallet);
    await expect(o.transfer()).rejects.toThrow('No cat selected');
    o.setCatUtxo(cat);
    await expect(o.transfer()).rejects.toThrow('No recipient address');
    o.setRecipientAddress(ORDINALS_ADDR);
    await expect(o.transfer()).rejects.toThrow('No fee rate set');
  });

  it('subscribe fires immediately then on change; unsubscribe stops it', async () => {
    const o = new Cat21TransferOrchestrator(deps());
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

  it('getUtxos rejection => state error with the load message, cleared sim', async () => {
    const o = new Cat21TransferOrchestrator(
      deps({ getUtxos: async () => { throw new Error('electrs 502'); } }),
    );
    await o.setWallet(wallet);
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBe('Failed to load UTXOs: electrs 502');
    expect(o.getSnapshot().simulation).toBeNull();
  });

  it('INSUFFICIENT: coin too small => no sim, transfer() refuses with the fee-rate message', async () => {
    const o = new Cat21TransferOrchestrator(deps({ getUtxos: async () => [coin('c', 300)] }));
    await o.setWallet(wallet);
    o.setCatUtxo(cat);
    o.setRecipientAddress(ORDINALS_ADDR);
    o.setFeeRate(10);
    await flush();
    expect(o.getSnapshot().simulation).toBeNull();
    expect(o.getSnapshot().fundingRecommendation.status).toBe('insufficient');
    await expect(o.transfer()).rejects.toThrow(/Insufficient funds for transfer/);
  });

  it('race: a stale recompute never overwrites a newer snapshot (seq guard)', async () => {
    // Gate scan.classify so recomputes can be resolved out of order.
    const gates: Array<(v: 'clean' | 'has-assets') => void> = [];
    const scan = { classify: () => new Promise<'clean' | 'has-assets'>((res) => { gates.push(res); }) };
    const o = new Cat21TransferOrchestrator(deps({ scan }));
    await o.setWallet(wallet);
    o.setCatUtxo(cat);
    o.setRecipientAddress(ORDINALS_ADDR);
    o.setFeeRate(5);   // recompute A -> gates[0]
    o.setFeeRate(50);  // recompute B (newer) -> gates[1]
    for (let i = 0; i < 50 && gates.length < 2; i++) await flush();
    expect(gates.length).toBe(2);
    gates[1]('has-assets'); // resolve the NEWER run first => expert-required, sim null
    await flush();
    gates[0]('clean');      // resolve the STALE run last => would set auto/non-null if unguarded
    await flush();
    // The newer run (B) must win regardless of resolution order.
    expect(o.getSnapshot().fundingRecommendation.status).toBe('expert-required');
    expect(o.getSnapshot().simulation).toBeNull();
  });
});
