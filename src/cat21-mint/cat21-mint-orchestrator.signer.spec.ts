import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { map, of, throwError } from 'rxjs';

// Restores the sign+broadcast coverage the deleted Angular spec had (which
// mocked Cat21Service): here we mock the signer registry so mint() reaches a
// controllable signer. Pins the orchestrator's minting->success/error state
// machine + the broadcast-callback wiring — NOT the real wallet (that's the
// wallet-matrix e2e). See feedback_unit_tests_pin_adapter_not_wallet.
const mockSignSingleFundingInput = jest.fn();
jest.mock('../wallet/signers', () => ({
  findSignerOrThrow: () => ({ signSingleFundingInput: mockSignSingleFundingInput }),
}));

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from './cat21.service.types';
import {
  Cat21MintOrchestrator,
  MintOrchestratorDeps,
  MintSnapshot,
  MintWalletContext,
} from './cat21-mint-orchestrator';

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

const coin = (value: number): TxnOutput => ({ txid: 'c'.repeat(64), vout: 0, status: { confirmed: true }, value });

const deps = (over: Partial<MintOrchestratorDeps> = {}): MintOrchestratorDeps => ({
  getUtxos: async () => [coin(100_000)],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  ...over,
});

function waitFor(o: Cat21MintOrchestrator, pred: (s: MintSnapshot) => boolean): Promise<MintSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => { if (pred(s)) { unsub(); resolve(s); } });
  });
}

async function ready(o: Cat21MintOrchestrator): Promise<void> {
  await o.setWallet(wallet);
  o.setFeeRate(10);
  await waitFor(o, (s) => s.fundingRecommendation.status === 'auto');
}

describe('Cat21MintOrchestrator — sign + broadcast (signer mocked)', () => {
  beforeEach(() => mockSignSingleFundingInput.mockReset());

  it('mint() success: minting -> success, stores txId, wires the broadcast callback', async () => {
    // The mock exercises the broadcast callback the orchestrator injects, so
    // the whole chain (orchestrator -> signer -> deps.broadcast) is covered.
    mockSignSingleFundingInput.mockImplementation((input: { broadcast: (h: string) => any }) =>
      input.broadcast('deadbeef').pipe(map((txid: string) => ({ txId: txid }))),
    );
    const o = new Cat21MintOrchestrator(deps());
    await ready(o);
    const seen: string[] = [];
    o.subscribe((s) => seen.push(s.state));
    const { txId } = await o.mint();
    expect(txId).toBe('broadcast-txid');
    expect(o.getSnapshot().state).toBe('success');
    expect(o.getSnapshot().successTxId).toBe('broadcast-txid');
    expect(seen).toContain('minting');
    expect(mockSignSingleFundingInput).toHaveBeenCalledTimes(1);
  });

  it('mint() failure: the signer/broadcast rejects -> state error with the message', async () => {
    mockSignSingleFundingInput.mockReturnValue(throwError(() => new Error('user rejected')));
    const o = new Cat21MintOrchestrator(deps());
    await ready(o);
    await expect(o.mint()).rejects.toThrow('user rejected');
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBe('user rejected');
  });

  it('mint() auto-picks the clean covering coin when none is explicitly selected', async () => {
    mockSignSingleFundingInput.mockReturnValue(of({ txId: 'ok' }));
    const o = new Cat21MintOrchestrator(deps());
    await ready(o);
    await o.mint();
    expect(mockSignSingleFundingInput).toHaveBeenCalledTimes(1);
    // The PSBT handed to the signer funds from the auto-picked 100k coin.
    const arg = mockSignSingleFundingInput.mock.calls[0][0] as { paymentAddress: string };
    expect(arg.paymentAddress).toBe(PAYMENT_ADDR);
    expect(o.getSnapshot().state).toBe('success');
  });
});
