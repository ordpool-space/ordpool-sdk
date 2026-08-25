/**
 * Parent/child (ord provenance) builder tests.
 *
 * These pin the reveal TOPOLOGY that makes ord recognise the parent AND
 * return the parent to its owner (nothing lost):
 *   Inputs  = [ parent (0, unsigned — wallet signs), commit (1, ephemeral-finalized) ]
 *   Outputs = [ parent RETURN (0, = parent value), child (1, 546), tip? ]
 * The on-chain proof (ord actually indexes the link, parent back in the
 * wallet) lives in `e2e/regtest/inscribe-child-roundtrip.spec.ts`.
 */
import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';
import { encodeInscriptionId } from './inscription-envelope';
import {
  createChildInscribeTransactions,
  type CreateChildInscribeTransactionsArgs,
} from './inscription.service.helper';
import { buildChildInscribeRevealTx } from './inscription-child-reveal.helper';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);

const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const RECIPIENT_PRIV = new Uint8Array(32).fill(0xcd);
const PARENT_PRIV = new Uint8Array(32).fill(0xef);
const PARENT_INSCRIPTION_ID = 'b'.repeat(64) + 'i0';

function paymentContext() {
  return {
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress: btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!,
  };
}
function recipientAddress() {
  return btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true).address!;
}
function parentP2tr() {
  return btc.p2tr(schnorr.getPublicKey(PARENT_PRIV), undefined, scureNetwork, true);
}
function parentUtxo(value = 546) {
  const p = parentP2tr();
  return {
    utxo: {
      txid: 'a'.repeat(64),
      vout: 0,
      value,
      scriptPubKey: p.script,
      tapInternalKey: schnorr.getPublicKey(PARENT_PRIV),
    },
    returnAddress: p.address!,
  };
}

function build(overrides: Partial<CreateChildInscribeTransactionsArgs> = {}) {
  const { paymentPublicKey, paymentAddress } = paymentContext();
  return createChildInscribeTransactions({
    paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey,
    paymentAddress,
    recipientAddress: recipientAddress(),
    body: new TextEncoder().encode('<html><body>child</body></html>'),
    contentType: 'text/html',
    feeRatePerVbyte: 8,
    parentInscriptionId: PARENT_INSCRIPTION_ID,
    parentUtxo: parentUtxo(),
    network: NETWORK,
    ...overrides,
  });
}

describe('createChildInscribeTransactions — reveal topology', () => {
  it('reveal has parent input 0 (UNSIGNED, wallet signs) + commit input 1 (ephemeral partial sig, not finalized)', () => {
    const reveal = btc.Transaction.fromPSBT(build().revealPsbt);
    expect(reveal.inputsLength).toBe(2);

    const parentIn = reveal.getInput(0);
    // 'a'*64 is byte-symmetric, so scure's internal-LE storage still hexes to 'a'*64.
    expect(hex.encode(parentIn.txid!)).toBe('a'.repeat(64));
    expect(parentIn.index).toBe(0);
    expect(parentIn.finalScriptWitness).toBeUndefined(); // wallet must sign it
    expect(parentIn.tapInternalKey).toBeDefined();        // P2TR key-path signable

    // Commit input is signed by the ephemeral key but left PARTIAL
    // (tapScriptSig + tapLeafScript), NOT finalized — so a PSBT handed to
    // a wallet contains no already-finalized input (address-filter signers
    // reject those). Both inputs finalize at the extract step.
    const commitIn = reveal.getInput(1);
    expect(commitIn.finalScriptWitness).toBeUndefined();
    expect(commitIn.tapScriptSig).toBeDefined();
    expect(commitIn.tapScriptSig!.length).toBe(1);
    expect(commitIn.tapLeafScript).toBeDefined();          // envelope leaf, used to finalize
  });

  it('finalizes to valid witnesses on BOTH inputs — the partial tapScriptSig round-trips through finalize()', () => {
    // The core of the fix: sign the parent input 0 (key-path), then run
    // scure finalize() over the whole tx (exactly what the production
    // extract path does). Input 1's partial tapScriptSig + tapLeafScript
    // must build a valid [sig, envelopeScript, controlBlock] script-path
    // witness — if scure couldn't, every wallet would regress here.
    const tx = btc.Transaction.fromPSBT(build().revealPsbt, { allowUnknownInputs: true });
    tx.signIdx(PARENT_PRIV, 0);
    tx.finalize();
    const parentWitness = tx.getInput(0).finalScriptWitness!;
    const commitWitness = tx.getInput(1).finalScriptWitness!;
    expect(parentWitness.length).toBe(1);   // key-path: [schnorr sig]
    expect(commitWitness.length).toBe(3);   // script-path: [sig, envelopeScript, controlBlock]
    const idHex = hex.encode(encodeInscriptionId(PARENT_INSCRIPTION_ID));
    expect(hex.encode(commitWitness[1])).toContain('0103' + '20' + idHex);
    expect(tx.hex.length).toBeGreaterThan(0); // serialises to a wire tx
  });

  it('wallet-facing reveal has a BARE input 1; its input-0 sig merges into the full PSBT', () => {
    // The production flow: the wallet signs input 0 on the BARE PSBT (no
    // envelope tap-leaf — so address-filter wallets do not choke), then
    // that signature is merged into the full PSBT and BOTH inputs finalize.
    const { revealPsbt, revealPsbtForWallet } = build();

    const wf = btc.Transaction.fromPSBT(revealPsbtForWallet);
    expect(wf.inputsLength).toBe(2);
    expect(wf.getInput(1).tapScriptSig).toBeUndefined();   // stripped
    expect(wf.getInput(1).tapLeafScript).toBeUndefined();  // stripped

    // Wallet signs input 0 (key-path) on the bare PSBT.
    wf.signIdx(PARENT_PRIV, 0);
    const in0 = wf.getInput(0);
    const keySig = in0.tapKeySig ?? in0.finalScriptWitness![0];

    // Merge the key-path sig onto the FULL PSBT (input 1 has the ephemeral
    // tapScriptSig), then finalize both — the input-0 sig is valid here
    // because the sighash commits to input 1's prevout, not PSBT metadata.
    const full = btc.Transaction.fromPSBT(revealPsbt, { allowUnknownInputs: true });
    full.updateInput(0, { tapKeySig: keySig }, true);
    full.finalize();
    expect(full.getInput(0).finalScriptWitness!.length).toBe(1); // key-path [sig]
    expect(full.getInput(1).finalScriptWitness!.length).toBe(3); // script-path [sig, script, cb]
    expect(full.hex.length).toBeGreaterThan(0);
  });

  it('reveal outputs: parent RETURN (0) preserves the parent value, child (1) = 546', () => {
    const reveal = btc.Transaction.fromPSBT(build().revealPsbt);
    expect(reveal.outputsLength).toBe(2);

    // Output 0: parent back to its own address, exactly its incoming value.
    expect(reveal.getOutput(0).amount).toBe(546n);
    expect(hex.encode(reveal.getOutput(0).script!)).toBe(hex.encode(parentP2tr().script));

    // Output 1: child at the recipient, 546 postage.
    expect(reveal.getOutput(1).amount).toBe(546n);
    const recipientScript = btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true).script;
    expect(hex.encode(reveal.getOutput(1).script!)).toBe(hex.encode(recipientScript));
  });

  it('preserves a non-dust parent value (10000-sat postage) exactly on return', () => {
    const reveal = btc.Transaction.fromPSBT(build({ parentUtxo: parentUtxo(10_000) }).revealPsbt);
    expect(reveal.getOutput(0).amount).toBe(10_000n); // in == out for the parent
  });

  it('reveal carries nLockTime = 21 (bonus cat, same as any ordpool inscribe)', () => {
    expect(btc.Transaction.fromPSBT(build().revealPsbt).lockTime).toBe(21);
  });

  it('envelope carries the parent tag (0x03, data-pushed) with the encoded parent id', () => {
    const reveal = btc.Transaction.fromPSBT(build().revealPsbt);
    // The commit input's tapLeafScript carries the envelope script (with a
    // trailing leaf-version byte; the parent tag sits mid-script so a
    // substring check is unaffected).
    const envelopeScript = reveal.getInput(1).tapLeafScript![0][1];
    const envelopeHex = hex.encode(envelopeScript);
    const idHex = hex.encode(encodeInscriptionId(PARENT_INSCRIPTION_ID));
    // Tag 0x03 data-pushed as `01 03` (ord-identical) + a 32-byte push (0x20)
    // of the encoded parent id.
    expect(envelopeHex).toContain('0103' + '20' + idHex);
  });
});

describe('createChildInscribeTransactions — fee + funding', () => {
  it('commit funds child postage + reveal fee; the parent value passes through (net zero)', () => {
    const r = build();
    expect(r.fees.revealFeeSats).toBeGreaterThan(0);
    // No tip → commit output = child postage + reveal fee. The parent's
    // sats are NOT in here — they enter and leave via the parent in/out.
    expect(r.fees.commitOutputValueSats).toBe(546 + r.fees.revealFeeSats);
    expect(r.fees.fundingRequirementSats).toBe(r.fees.commitOutputValueSats + r.fees.commitFeeSats);
  });

  it('the child reveal is heavier than a single-input reveal (extra input + output)', () => {
    // Sanity: a 2-in/2-out reveal is materially bigger than 1-in/1-out.
    expect(build().fees.revealVsize).toBeGreaterThan(150);
  });

  it('throws on insufficient funding', () => {
    expect(() => build({
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 500, status: { confirmed: true } },
    })).toThrow(/Insufficient funds for child inscribe/);
  });

  it('rejects an empty parentInscriptionId', () => {
    expect(() => build({ parentInscriptionId: '' })).toThrow(/parentInscriptionId/);
  });

  it('rejects a pointer: the child lands on vout[1] via FIFO, and a pointer validated against the plain single-output topology would relocate it onto the parent-return UTXO', () => {
    expect(() => build({ pointer: 0 })).toThrow(/pointer is not supported for child inscriptions/);
    expect(() => build({ pointer: 546 })).toThrow(/pointer is not supported for child inscriptions/);
  });
});

describe('buildChildInscribeRevealTx — guards', () => {
  const commitStub = () => {
    // A throwaway commit P2TR just to give the builder a well-formed taproot.
    const eph = schnorr.getPublicKey(new Uint8Array(32).fill(0x11));
    const env = new Uint8Array([0x20, ...eph, 0xac, 0x00, 0x63, 0x03, 0x6f, 0x72, 0x64, 0x68]); // <pk> CHECKSIG OP_FALSE OP_IF "ord" OP_ENDIF-ish
    const p = btc.p2tr(eph, [{ script: env }], scureNetwork, true);
    return {
      commitOutputScript: p.script,
      taproot: { internalKey: eph, tapLeafScript: p.tapLeafScript! },
    };
  };

  it('rejects a parent value below the 546 postage floor (would shrink the parent)', () => {
    const c = commitStub();
    expect(() => buildChildInscribeRevealTx({
      commitTxid: '0'.repeat(64), commitVout: 0,
      commitOutputValueSats: 5000,
      commitOutputScript: c.commitOutputScript,
      taproot: c.taproot,
      ephemeralPrivKey: new Uint8Array(32).fill(0x11),
      parent: parentUtxo(300),
      recipientAddress: recipientAddress(),
      network: NETWORK,
    })).toThrow(/parent\.utxo\.value/);
  });

  it('rejects a bad ephemeral key length', () => {
    const c = commitStub();
    expect(() => buildChildInscribeRevealTx({
      commitTxid: '0'.repeat(64), commitVout: 0,
      commitOutputValueSats: 5000,
      commitOutputScript: c.commitOutputScript,
      taproot: c.taproot,
      ephemeralPrivKey: new Uint8Array(16),
      parent: parentUtxo(),
      recipientAddress: recipientAddress(),
      network: NETWORK,
    })).toThrow(/ephemeralPrivKey must be 32 bytes/);
  });
});
