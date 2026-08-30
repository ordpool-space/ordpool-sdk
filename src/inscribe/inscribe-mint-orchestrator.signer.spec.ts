import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { of, throwError } from 'rxjs';

// Restores the inscribe success/error coverage. The inscribe happy path runs
// through inscribeAndBroadcast (build commit+reveal, wallet-sign commit, sign
// reveal, broadcast both) — mock that so the orchestrator's minting->success/
// error state machine is unit-covered; the real signing chain is the
// inscribe-ord-parity + wallet-matrix e2e.
const mockInscribeAndBroadcast = jest.fn();
jest.mock('./inscribe-orchestrator', () => ({ inscribeAndBroadcast: mockInscribeAndBroadcast }));

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
const content: InscribeContent = { body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' };
const coin = (value: number): TxnOutput => ({ txid: 'c'.repeat(64), vout: 0, status: { confirmed: true }, value });

const deps = (over: Partial<InscribeOrchestratorDeps> = {}): InscribeOrchestratorDeps => ({
  getUtxos: async () => [coin(100_000)],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  ...over,
});

// Opaque to the orchestrator (it just stores it on success); shape-plausible.
const result = {
  commitTxId: 'commit-tx',
  revealTxId: 'reveal-tx',
  commitAddress: 'bc1pexamplecommitaddress',
  ephemeral: { privKey: new Uint8Array(32), pubKeyXonly: new Uint8Array(32) },
  fees: { commitFeeSats: 300, revealFeeSats: 200, totalFeeSats: 500 },
} as any;

function waitFor(o: InscribeMintOrchestrator, pred: (s: InscribeSnapshot) => boolean): Promise<InscribeSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => { if (pred(s)) { unsub(); resolve(s); } });
  });
}

async function ready(o: InscribeMintOrchestrator): Promise<void> {
  await o.setWallet(wallet);
  o.setContent(content);
  o.setFeeRate(10);
  await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
}

describe('InscribeMintOrchestrator — sign + broadcast (inscribeAndBroadcast mocked)', () => {
  beforeEach(() => mockInscribeAndBroadcast.mockReset());

  it('mint() success: minting -> success, stores the result', async () => {
    mockInscribeAndBroadcast.mockReturnValue(of(result));
    const o = new InscribeMintOrchestrator(deps());
    await ready(o);
    const seen: string[] = [];
    o.subscribe((s) => seen.push(s.state));
    const out = await o.mint();
    expect(out).toBe(result);
    expect(o.getSnapshot().state).toBe('success');
    expect(o.getSnapshot().successResult).toBe(result);
    expect(seen).toContain('minting');
    // The orchestrator fed inscribeAndBroadcast the auto-picked coin + content.
    const arg = mockInscribeAndBroadcast.mock.calls[0][0] as { recipientAddress: string; body: Uint8Array };
    expect(arg.recipientAddress).toBe(ORDINALS_ADDR);
    expect(arg.body).toEqual(content.body);
  });

  it('mint() failure: inscribeAndBroadcast rejects -> state error', async () => {
    mockInscribeAndBroadcast.mockReturnValue(throwError(() => new Error('reveal broadcast failed')));
    const o = new InscribeMintOrchestrator(deps());
    await ready(o);
    await expect(o.mint()).rejects.toThrow('reveal broadcast failed');
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBe('reveal broadcast failed');
  });
});
