import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildInputScript } from './build-input-script';
import {
  createInputScriptForLeather,
  createInputScriptForUnisat,
  createInputScriptForXverse,
} from './per-wallet-scripts';

const PUBKEY_33 = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
const PUBKEY_XONLY = PUBKEY_33.subarray(1, 33);
const NETWORK = btc.NETWORK;

const segwitAddr = btc.p2wpkh(PUBKEY_33, NETWORK).address!;
const p2shAddr = btc.p2sh(btc.p2wpkh(PUBKEY_33, NETWORK), NETWORK).address!;
const p2trAddr = btc.p2tr(PUBKEY_XONLY, undefined, NETWORK, true).address!;
const p2pkhAddr = btc.p2pkh(PUBKEY_33, NETWORK).address!;

describe('buildInputScript — universal address-format-driven helper', () => {

  it('P2WPKH → produces the same script as createInputScriptForLeather', () => {
    const universal = buildInputScript({
      paymentAddress: segwitAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: false,
      network: NETWORK,
    });
    const legacyHelper = createInputScriptForLeather(PUBKEY_33, NETWORK);
    expect(hex.encode(universal.scriptData.script)).toBe(hex.encode(legacyHelper.script));
    expect(universal.tapInternalKey).toBeUndefined();
  });

  it('P2WPKH → matches createInputScriptForUnisat (Native SegWit branch)', () => {
    const universal = buildInputScript({
      paymentAddress: segwitAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: false,
      network: NETWORK,
    });
    const legacyHelper = createInputScriptForUnisat(segwitAddr, PUBKEY_33, NETWORK);
    expect(hex.encode(universal.scriptData.script)).toBe(hex.encode(legacyHelper.script));
  });

  it('P2SH-wrapped → matches createInputScriptForXverse (Nested SegWit branch)', () => {
    const universal = buildInputScript({
      paymentAddress: p2shAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: false,
      network: NETWORK,
    });
    const legacyHelper = createInputScriptForXverse(p2shAddr, PUBKEY_33, NETWORK);
    expect(hex.encode(universal.scriptData.script)).toBe(hex.encode(legacyHelper.script));
    expect(hex.encode(universal.scriptData.redeemScript!)).toBe(hex.encode(legacyHelper.redeemScript!));
  });

  it('P2TR (33-byte pubkey input) → matches createInputScriptForUnisat after toXOnly conversion', () => {
    const universal = buildInputScript({
      paymentAddress: p2trAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: false,
      network: NETWORK,
    });
    const legacyHelper = createInputScriptForUnisat(p2trAddr, PUBKEY_XONLY, NETWORK);
    expect(hex.encode(universal.scriptData.script)).toBe(hex.encode(legacyHelper.script));
    expect(universal.tapInternalKey).toBeDefined();
    expect(universal.tapInternalKey!.length).toBe(32);
  });

  it('P2TR (32-byte x-only pubkey input) → no double-stripping', () => {
    const universal = buildInputScript({
      paymentAddress: p2trAddr,
      paymentPublicKey: PUBKEY_XONLY,
      isSimulation: false,
      network: NETWORK,
    });
    expect(universal.tapInternalKey).toEqual(PUBKEY_XONLY);
  });

  it('P2PKH → matches createInputScriptForUnisat (Legacy branch)', () => {
    const universal = buildInputScript({
      paymentAddress: p2pkhAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: false,
      network: NETWORK,
    });
    const legacyHelper = createInputScriptForUnisat(p2pkhAddr, PUBKEY_33, NETWORK);
    expect(hex.encode(universal.scriptData.script)).toBe(hex.encode(legacyHelper.script));
  });

  it('simulation P2TR uses the schnorr-derived xOnly dummy (parity-normalised)', () => {
    const sim = buildInputScript({
      paymentAddress: p2trAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: true,
      network: NETWORK,
    });
    expect(sim.tapInternalKey).toBeDefined();
    expect(sim.tapInternalKey!.length).toBe(32);
    // The simulation script differs from the real-key script because
    // we use the dummy keypair. That's the whole point of simulation
    // mode — vsize-observable without exposing the user's key.
    const real = buildInputScript({
      paymentAddress: p2trAddr,
      paymentPublicKey: PUBKEY_33,
      isSimulation: false,
      network: NETWORK,
    });
    expect(hex.encode(sim.scriptData.script)).not.toBe(hex.encode(real.scriptData.script));
  });
});
