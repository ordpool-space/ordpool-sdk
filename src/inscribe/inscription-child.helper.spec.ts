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
import { InscriptionParserService } from 'ordpool-parser';

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

/**
 * OKX-owned-commit "real-key" child reveal — node correctness proof.
 *
 * OKX's closed signPsbt preview refuses any PSBT with an input it doesn't
 * own, so the child reveal's commit input must be OWNED by OKX: its
 * ordinals key is the envelope leaf key AND the commit's taproot internal
 * key. OKX then signs input 0 (key-path, tweaked) AND input 1 (script-path,
 * raw) in one call. There is no ephemeral bearer key.
 *
 * This proof does NOT mock the wallet: it simulates OKX by signing BOTH
 * inputs with one KNOWN key (KNOWN_PRIV stands in for OKX's single BIP-86
 * ordinals key, payment === ordinals), finalizes, and asserts the reveal is
 * byte-valid and ord-parseable.
 */
describe('createChildInscribeTransactions — OKX-owned-commit mode (real-key)', () => {
  const KNOWN_PRIV = new Uint8Array(32).fill(0x77);
  const OKX_XONLY = schnorr.getPublicKey(KNOWN_PRIV);
  const OKX_ADDRESS = btc.p2tr(OKX_XONLY, undefined, scureNetwork, true).address!;
  const OKX_PAYMENT_PUBKEY = secp256k1.getPublicKey(KNOWN_PRIV, true);
  const CHILD_BODY = '<html><body>okx child</body></html>';
  const CHILD_CONTENT_TYPE = 'text/html';

  function okxParentUtxo(value = 546) {
    const p = btc.p2tr(OKX_XONLY, undefined, scureNetwork, true);
    return {
      utxo: {
        txid: 'a'.repeat(64), vout: 0, value,
        scriptPubKey: p.script,
        tapInternalKey: OKX_XONLY,
      },
      returnAddress: p.address!,
    };
  }

  function buildOkx(overrides: Partial<CreateChildInscribeTransactionsArgs> = {}) {
    return createChildInscribeTransactions({
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey: OKX_PAYMENT_PUBKEY,
      paymentAddress: OKX_ADDRESS,
      recipientAddress: OKX_ADDRESS,
      body: new TextEncoder().encode(CHILD_BODY),
      contentType: CHILD_CONTENT_TYPE,
      feeRatePerVbyte: 8,
      parentInscriptionId: PARENT_INSCRIPTION_ID,
      parentUtxo: okxParentUtxo(),
      revealKeyXOnly: OKX_XONLY,
      network: NETWORK,
      ...overrides,
    });
  }

  it('the wallet-facing reveal has input 1 UNSIGNED with a tapLeafScript + the wallet key (no ephemeral tapScriptSig)', () => {
    const built = buildOkx();
    const ownedPsbt = built.revealPsbtForOwnedCommit;
    if (!ownedPsbt) throw new Error('OKX mode must return revealPsbtForOwnedCommit');

    const psbt = btc.Transaction.fromPSBT(ownedPsbt, { allowUnknownInputs: true });
    expect(psbt.inputsLength).toBe(2);

    // Input 0 (parent) unsigned — the wallet key-path-signs it.
    expect(psbt.getInput(0).finalScriptWitness).toBeUndefined();
    expect(psbt.getInput(0).tapKeySig).toBeUndefined();

    // Input 1 (commit) unsigned but wallet-signable: carries the envelope
    // tapLeafScript + the wallet's ordinals key as tapInternalKey, and NO
    // SDK-produced tapScriptSig (the SDK holds no key for it).
    const commitIn = psbt.getInput(1);
    expect(commitIn.tapScriptSig).toBeUndefined();
    expect(commitIn.tapLeafScript).toBeDefined();
    expect(commitIn.tapInternalKey).toBeDefined();
    expect(hex.encode(commitIn.tapInternalKey!)).toBe(hex.encode(OKX_XONLY));

    // The envelope leaf embeds the wallet's key as `<OKX_XONLY> OP_CHECKSIG`
    // (0x20 = 32-byte push, 0xac = OP_CHECKSIG).
    const leafBytes = commitIn.tapLeafScript![0][1];
    expect(hex.encode(leafBytes).startsWith('20' + hex.encode(OKX_XONLY) + 'ac')).toBe(true);

    // Bonus-cat locktime + FIFO output topology (unchanged HARD RULES).
    expect(psbt.lockTime).toBe(21);
    expect(psbt.getOutput(0).amount).toBe(546n);  // parent return
    expect(psbt.getOutput(1).amount).toBe(546n);  // child recipient
  });

  it('OKX signs BOTH inputs with ONE key → byte-valid, ord-parseable reveal (input 0 key-path tweaked, input 1 script-path raw)', () => {
    const built = buildOkx();
    const ownedPsbt = built.revealPsbtForOwnedCommit;
    if (!ownedPsbt) throw new Error('OKX mode must return revealPsbtForOwnedCommit');

    const tx = btc.Transaction.fromPSBT(ownedPsbt, { allowUnknownInputs: true });

    // Simulate OKX input 0: key-path spend with the TWEAKED known key.
    // scure's signIdx applies the BIP-86 taproot tweak for a key-path P2TR
    // input (tapInternalKey set, no leaf), exactly as OKX's tweaked signer.
    tx.signIdx(KNOWN_PRIV, 0);

    // Simulate OKX input 1: SCRIPT-PATH spend over the envelope leaf with
    // the RAW (untweaked) known key — mirrors the builder's manual
    // preimageWitnessV1 + schnorr.sign, but signed by the wallet's key. The
    // SIGHASH_DEFAULT sighash commits to BOTH prevouts (parent + commit).
    const commitLeaf = tx.getInput(1).tapLeafScript!;
    const leafBytes = commitLeaf[0][1];
    const bareLeafScript = leafBytes.subarray(0, -1);
    const leafVersion = leafBytes[leafBytes.length - 1] ?? 0xc0;

    const in0 = tx.getInput(0);
    const in1 = tx.getInput(1);
    const sighash = tx.preimageWitnessV1(
      1,
      [in0.witnessUtxo!.script, in1.witnessUtxo!.script],
      btc.SignatureHash.DEFAULT,
      [in0.witnessUtxo!.amount, in1.witnessUtxo!.amount],
      undefined,
      bareLeafScript,
      leafVersion,
    );
    const scriptPathSig = schnorr.sign(sighash, KNOWN_PRIV);
    const leafHash = btc.tapLeafHash(bareLeafScript, leafVersion);
    tx.updateInput(1, {
      tapScriptSig: [[{ pubKey: OKX_XONLY, leafHash }, scriptPathSig]],
    }, true);

    // Finalize BOTH inputs and serialise to a wire tx.
    tx.finalize();

    const w0 = tx.getInput(0).finalScriptWitness!;
    const w1 = tx.getInput(1).finalScriptWitness!;
    expect(w0.length).toBe(1);                 // key-path: [schnorr sig]
    expect([64, 65]).toContain(w0[0].length);
    expect(w1.length).toBe(3);                 // script-path: [sig, envelopeScript, controlBlock]
    expect(hex.encode(w1[0])).toBe(hex.encode(scriptPathSig));
    expect(tx.lockTime).toBe(21);
    expect(tx.hex.length).toBeGreaterThan(0);  // serialises to a wire tx
    expect(tx.id).toBe(built.revealTxid);      // witness-independent txid matches the builder

    // ord-parseable: the child inscription decodes from input 1's witness,
    // with the correct contentType, body, and parent tag.
    const witness = w1.map((w) => hex.encode(w));
    const parsed = InscriptionParserService.parse({ txid: tx.id, vin: [{ witness }] });
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe(CHILD_CONTENT_TYPE);
    expect(new TextDecoder().decode(parsed[0].getDataRaw())).toBe(CHILD_BODY);
    expect(parsed[0].getParents()).toContain(PARENT_INSCRIPTION_ID);
  });

  it('rejects a non-32-byte revealKeyXOnly', () => {
    expect(() => buildOkx({ revealKeyXOnly: new Uint8Array(31) }))
      .toThrow(/revealKeyXOnly must be a 32-byte x-only key/);
  });

  it('ephemeral mode is unchanged: no revealPsbtForOwnedCommit, input 1 carries the ephemeral tapScriptSig', () => {
    const built = build(); // top-level ephemeral builder (no revealKeyXOnly)
    expect(built.revealPsbtForOwnedCommit).toBeUndefined();
    const full = btc.Transaction.fromPSBT(built.revealPsbt, { allowUnknownInputs: true });
    expect(full.getInput(1).tapScriptSig).toBeDefined();
    expect(built.ephemeral.privKey.length).toBe(32);
  });
});
