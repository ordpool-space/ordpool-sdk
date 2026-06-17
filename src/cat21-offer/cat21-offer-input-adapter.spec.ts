import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { prepareBuyOfferBuyerInput } from './cat21-offer-input-adapter';

const PUBKEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const NETWORK = Network.Mainnet;
const SCURE_NET = toScureNetwork(NETWORK);

const segwitAddr = btc.p2wpkh(PUBKEY, SCURE_NET).address!;
const p2shAddr = btc.p2sh(btc.p2wpkh(PUBKEY, SCURE_NET), SCURE_NET).address!;
const p2trAddr = btc.p2tr(PUBKEY.subarray(1, 33), undefined, SCURE_NET, true).address!;

const baseUtxo = {
  txid: '0123456789abcdef'.repeat(4),
  vout: 1,
  value: 50_000,
  status: { confirmed: true, block_height: 800_000 },
};

describe('prepareBuyOfferBuyerInput', () => {

  it('returns a SegWit-shaped input for Leather (P2WPKH script, no redeemScript/nonWitnessUtxo)', () => {
    const input = prepareBuyOfferBuyerInput({
      walletType: KnownOrdinalWalletType.leather,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(22);
    expect(input.redeemScript).toBeUndefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
    expect(input.tapInternalKey).toBeUndefined();
    expect(input.value).toBe(50_000);
  });

  it('returns Taproot-shape for Unisat-P2TR', () => {
    const input = prepareBuyOfferBuyerInput({
      walletType: KnownOrdinalWalletType.unisat,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2trAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.tapInternalKey).toBeDefined();
    expect(input.tapInternalKey!.length).toBe(32);
  });

  it('returns P2SH-wrapped shape for Xverse (with redeemScript)', () => {
    const input = prepareBuyOfferBuyerInput({
      walletType: KnownOrdinalWalletType.xverse,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2shAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.redeemScript).toBeDefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
  });

  it('rejects unknown wallet type', () => {
    expect(() => prepareBuyOfferBuyerInput({
      walletType: 'NOPE' as unknown as KnownOrdinalWalletType,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: false,
      network: NETWORK,
    })).toThrow(/Unknown wallet/);
  });
});
