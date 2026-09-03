import { secp256k1 } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { map, throwError } from 'rxjs';

// Restores the sign+broadcast coverage (deleted spec mocked
// Cat21Service): mock the signer so acceptOffer() reaches a controllable
// seller-signer (via accept-offer.core). Pins accepting->success/error + the
// broadcast wiring on a validated offer.
const mockSignOfferAccept = jest.fn();
jest.mock('../wallet/signers', () => ({
  findSignerOrThrow: () => ({ signOfferAccept: mockSignOfferAccept }),
}));

import { Network } from '../network';
import { toPaymentAddress } from '../wallet/address-types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { buildCat21BuyOfferPsbt } from './cat21-offer.helper';
import { prepareBuyOfferBuyerInput } from './cat21-offer-input-adapter';
import {
  AcceptOfferOrchestratorDeps,
  AcceptOfferWalletContext,
  Cat21AcceptOfferOrchestrator,
} from './cat21-accept-offer-orchestrator';

const SELLER_KEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000002');
const SELLER_P2TR = btc.p2tr(SELLER_KEY.slice(1, 33), undefined, btc.NETWORK);
const SELLER_PAYMENT = btc.p2wpkh(SELLER_KEY, btc.NETWORK).address!;
const BUYER_PRIV = hex.decode('0101010101010101010101010101010101010101010101010101010101010101');
const BUYER_PUB = secp256k1.getPublicKey(BUYER_PRIV, true);
const BUYER_PAYMENT = btc.p2wpkh(BUYER_PUB, btc.NETWORK).address!;
const BUYER_RECEIVE = btc.p2tr(BUYER_PUB.slice(1, 33), undefined, btc.NETWORK).address!;
const CAT = { txid: 'a'.repeat(64), vout: 0, value: 546 };
const PRICE = 21_000;

function buildOfferBase64(): string {
  const buyerInput = prepareBuyOfferBuyerInput({
    utxo: { txid: 'b'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey: BUYER_PUB,
    paymentAddress: BUYER_PAYMENT,
    isSimulation: false,
    network: Network.Mainnet,
  });
  const built = buildCat21BuyOfferPsbt({
    walletType: KnownOrdinalWalletType.cat21wallet,
    network: Network.Mainnet,
    sellerInput: { txid: CAT.txid, vout: CAT.vout, value: CAT.value, scriptPubKey: SELLER_P2TR.script },
    buyerInputs: [buyerInput],
    destinations: { buyerReceiveAddress: BUYER_RECEIVE, sellerPaymentAddress: SELLER_PAYMENT, buyerChangeAddress: BUYER_PAYMENT },
    priceSats: PRICE,
    feeSats: 1_000,
  });
  const tx = btc.Transaction.fromPSBT(built.psbt);
  tx.signIdx(BUYER_PRIV, 1);
  return base64.encode(tx.toPSBT());
}

const wallet: AcceptOfferWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: SELLER_P2TR.address!,
  ordinalsPublicKey: hex.encode(SELLER_KEY.slice(1, 33)),
};

const deps = (over: Partial<AcceptOfferOrchestratorDeps> = {}): AcceptOfferOrchestratorDeps => ({
  broadcast: async () => ({ txid: 'settle-txid', channel: 'mempool' }),
  network: Network.Mainnet,
  ...over,
});

function parsed(o: Cat21AcceptOfferOrchestrator): void {
  o.setWallet(wallet);
  o.setExpectedCatUtxo({ txid: CAT.txid, vout: CAT.vout });
  o.setExpectedSellerPaymentAddress(toPaymentAddress(SELLER_PAYMENT));
  o.setFloorPriceSats(PRICE);
  o.setPastedOffer(buildOfferBase64());
}

describe('Cat21AcceptOfferOrchestrator — seller sign + broadcast (signer mocked)', () => {
  beforeEach(() => mockSignOfferAccept.mockReset());

  it('acceptOffer() success: accepting -> success, stores txid + channel, wires broadcast', async () => {
    mockSignOfferAccept.mockImplementation((input: { broadcast: (h: string) => any }) =>
      input.broadcast('deadbeef').pipe(map((txid: string) => ({ txId: txid }))),
    );
    const o = new Cat21AcceptOfferOrchestrator(deps());
    parsed(o);
    expect(o.getSnapshot().state).toBe('parsed');
    const outcome = await o.acceptOffer();
    expect(outcome).toEqual({ txid: 'settle-txid', channel: 'mempool' });
    expect(o.getSnapshot().state).toBe('success');
    expect(o.getSnapshot().successTxId).toBe('settle-txid');
    expect(o.getSnapshot().channel).toBe('mempool');
  });

  it('acceptOffer() failure: the seller signer rejects -> state error', async () => {
    mockSignOfferAccept.mockReturnValue(throwError(() => new Error('seller rejected')));
    const o = new Cat21AcceptOfferOrchestrator(deps());
    parsed(o);
    await expect(o.acceptOffer()).rejects.toThrow('seller rejected');
    expect(o.getSnapshot().state).toBe('error');
  });
});
