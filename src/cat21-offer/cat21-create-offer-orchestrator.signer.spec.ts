import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { of, throwError } from 'rxjs';

// Restores the sign coverage (deleted Angular spec mocked Cat21Service): mock
// the signer so createOffer() reaches a controllable buyer-signer. Pins the
// creating->success/error state machine + that the returned bytes are encoded
// into the shareable base64/hex bid artifact.
const mockSignOfferCreatePsbt = jest.fn();
jest.mock('../wallet/signers', () => ({
  findSignerOrThrow: () => ({ signOfferCreatePsbt: mockSignOfferCreatePsbt }),
}));

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import {
  Cat21CreateOfferOrchestrator,
  CreateOfferOrchestratorDeps,
  CreateOfferSnapshot,
  CreateOfferWalletContext,
} from './cat21-create-offer-orchestrator';
import { BuyOfferTargetCat } from './cat21-offer.types';

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const SELLER_XONLY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;
const SELLER_PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const SELLER_CAT_SCRIPT = btc.p2tr(hex.decode(SELLER_XONLY), undefined, btc.NETWORK).script;

const wallet: CreateOfferWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};
const targetCat: BuyOfferTargetCat = { catNumber: 42, txid: 'a'.repeat(64), vout: 0, value: 546, scriptPubKey: SELLER_CAT_SCRIPT };
const coin = (value: number): TxnOutput => ({ txid: 'c'.repeat(64), vout: 0, status: { confirmed: true }, value });

const deps = (over: Partial<CreateOfferOrchestratorDeps> = {}): CreateOfferOrchestratorDeps => ({
  getUtxos: async () => [coin(100_000)],
  scan: { classify: async () => 'clean' },
  network: Network.Mainnet,
  ...over,
});

function waitFor(o: Cat21CreateOfferOrchestrator, pred: (s: CreateOfferSnapshot) => boolean): Promise<CreateOfferSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => { if (pred(s)) { unsub(); resolve(s); } });
  });
}

async function ready(o: Cat21CreateOfferOrchestrator): Promise<void> {
  await o.setWallet(wallet);
  o.setTargetCat(targetCat);
  o.setSellerPaymentAddress(SELLER_PAYMENT_ADDR);
  o.setPriceSats(21_000);
  o.setFeeRate(10);
  await waitFor(o, (s) => s.simulation !== null);
}

describe('Cat21CreateOfferOrchestrator — buyer sign (signer mocked)', () => {
  beforeEach(() => mockSignOfferCreatePsbt.mockReset());

  it('createOffer() success: encodes the signed bytes into the base64/hex bid', async () => {
    mockSignOfferCreatePsbt.mockReturnValue(of(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01])));
    const o = new Cat21CreateOfferOrchestrator(deps());
    await ready(o);
    const bid = await o.createOffer();
    expect(bid.hex).toBe('70736274ff01');
    expect(bid.base64.length).toBeGreaterThan(0);
    expect(o.getSnapshot().state).toBe('success');
    expect(o.getSnapshot().bid).toEqual(bid);
    // No broadcast on the bid path (the seller accepts + broadcasts later).
    expect(mockSignOfferCreatePsbt.mock.calls[0][0].fundingInputCount).toBe(1);
  });

  it('createOffer() failure: the buyer signer rejects -> state error', async () => {
    mockSignOfferCreatePsbt.mockReturnValue(throwError(() => new Error('buyer rejected')));
    const o = new Cat21CreateOfferOrchestrator(deps());
    await ready(o);
    await expect(o.createOffer()).rejects.toThrow('buyer rejected');
    expect(o.getSnapshot().state).toBe('error');
    expect(o.getSnapshot().bid).toBeNull();
  });
});
