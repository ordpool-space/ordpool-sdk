import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { map, of, throwError } from 'rxjs';

// Restores the sign+broadcast coverage (deleted spec mocked
// Cat21Service): mock the signer registry so transfer() reaches a controllable
// signer. Pins the transferring->success/error state machine + broadcast wiring.
const mockSignTransfer = jest.fn();
jest.mock('../wallet/signers', () => ({
  findSignerOrThrow: () => ({ signTransfer: mockSignTransfer }),
}));

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
const coin = (value: number): TxnOutput => ({ txid: 'c'.repeat(64), vout: 0, status: { confirmed: true }, value });

const deps = (over: Partial<TransferOrchestratorDeps> = {}): TransferOrchestratorDeps => ({
  getUtxos: async () => [coin(100_000)],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  ...over,
});

function waitFor(o: Cat21TransferOrchestrator, pred: (s: TransferSnapshot) => boolean): Promise<TransferSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => { if (pred(s)) { unsub(); resolve(s); } });
  });
}

async function ready(o: Cat21TransferOrchestrator): Promise<void> {
  await o.setWallet(wallet);
  o.setCatUtxo(cat);
  o.setRecipientAddress(ORDINALS_ADDR);
  o.setFeeRate(10);
  await waitFor(o, (s) => s.simulation !== null);
}

describe('Cat21TransferOrchestrator — sign + broadcast (signer mocked)', () => {
  beforeEach(() => mockSignTransfer.mockReset());

  it('transfer() success: transferring -> success, stores txId, wires broadcast', async () => {
    mockSignTransfer.mockImplementation((input: { broadcast: (h: string) => any }) =>
      input.broadcast('deadbeef').pipe(map((txid: string) => ({ txId: txid }))),
    );
    const o = new Cat21TransferOrchestrator(deps());
    await ready(o);
    const seen: string[] = [];
    o.subscribe((s) => seen.push(s.state));
    const { txId } = await o.transfer();
    expect(txId).toBe('broadcast-txid');
    expect(o.getSnapshot().state).toBe('success');
    expect(o.getSnapshot().successTxId).toBe('broadcast-txid');
    expect(seen).toContain('transferring');
    // fundingInputCount is derived (single funding input after the cat).
    expect(mockSignTransfer.mock.calls[0][0].fundingInputCount).toBe(1);
  });

  it('transfer() failure: the signer/broadcast rejects -> state error', async () => {
    mockSignTransfer.mockReturnValue(throwError(() => new Error('user rejected')));
    const o = new Cat21TransferOrchestrator(deps());
    await ready(o);
    await expect(o.transfer()).rejects.toThrow('user rejected');
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().errorMessage).toBe('user rejected');
  });
});
