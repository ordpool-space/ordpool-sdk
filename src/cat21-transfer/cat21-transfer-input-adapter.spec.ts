import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { prepareTransferCatInput, prepareTransferFundingInput } from './cat21-transfer-input-adapter';

const PUBKEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const NETWORK = Network.Mainnet;
const SCURE_NET = toScureNetwork(NETWORK);

const segwitAddr = btc.p2wpkh(PUBKEY, SCURE_NET).address!;
const p2shAddr = btc.p2sh(btc.p2wpkh(PUBKEY, SCURE_NET), SCURE_NET).address!;
const p2trAddr = btc.p2tr(PUBKEY.subarray(1, 33), undefined, SCURE_NET, true).address!;

const baseUtxo = {
  txid: '0123456789abcdef'.repeat(4),
  vout: 0,
  value: 546,
  status: { confirmed: true, block_height: 800_000 },
};

describe('prepareTransferCatInput / prepareTransferFundingInput', () => {

  it('returns a SegWit-shaped input for Leather (P2WPKH script, no redeemScript/nonWitnessUtxo/tapInternalKey)', () => {
    const input = prepareTransferCatInput({
      walletType: KnownOrdinalWalletType.leather,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(22); // P2WPKH = OP_0 + 20-byte hash
    expect(input.redeemScript).toBeUndefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
    expect(input.tapInternalKey).toBeUndefined();
  });

  it('returns a Taproot-shaped input for Unisat-P2TR (with tapInternalKey)', () => {
    const input = prepareTransferFundingInput({
      walletType: KnownOrdinalWalletType.unisat,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2trAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(34); // P2TR = OP_1 + 32-byte x-only pubkey
    expect(input.tapInternalKey).toBeDefined();
    expect(input.tapInternalKey!.length).toBe(32);
    expect(input.redeemScript).toBeUndefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
  });

  it('returns a P2SH-wrapped SegWit shape for Xverse-P2SH (with redeemScript)', () => {
    const input = prepareTransferFundingInput({
      walletType: KnownOrdinalWalletType.xverse,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: p2shAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(23); // P2SH = OP_HASH160 + 20-byte hash + OP_EQUAL
    expect(input.redeemScript).toBeDefined();
    expect(input.nonWitnessUtxo).toBeUndefined();
    expect(input.tapInternalKey).toBeUndefined();
  });

  it('swaps the dummy keypair on isSimulation=true', () => {
    // Real pubkey shouldn't appear in the simulation output. Sanity: simulation
    // and real PSBT input differ in scriptPubKey because the dummy pubkey
    // produces a different script.
    const real = prepareTransferFundingInput({
      walletType: KnownOrdinalWalletType.leather,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: false,
      network: NETWORK,
    });
    const sim = prepareTransferFundingInput({
      walletType: KnownOrdinalWalletType.leather,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: true,
      network: NETWORK,
    });
    expect(hex.encode(real.scriptPubKey)).not.toBe(hex.encode(sim.scriptPubKey));
  });

  it('accepts an unknown walletType and dispatches purely on address format (no wallet-name switch left)', () => {
    // Pre-refactor this threw 'Unknown wallet'. After the address-
    // format-driven migration, walletType is orchestration-only and
    // the adapter ignores it for script construction. ANY string the
    // caller passes produces a valid P2WPKH input here because the
    // payment address is bech32 p2wpkh.
    const input = prepareTransferCatInput({
      walletType: 'NOT-A-REAL-WALLET' as unknown as KnownOrdinalWalletType,
      utxo: baseUtxo,
      paymentPublicKey: PUBKEY,
      paymentAddress: segwitAddr,
      isSimulation: false,
      network: NETWORK,
    });
    expect(input.scriptPubKey.length).toBe(22); // P2WPKH
    expect(input.tapInternalKey).toBeUndefined();
  });
});
