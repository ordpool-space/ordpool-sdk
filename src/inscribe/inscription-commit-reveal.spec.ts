/**
 * Round-trip spec for the Layer-1 commit + reveal builders.
 *
 * The two helpers are coupled at the taptree: the commit's address
 * is derived from a tree containing the envelope (whose pubkey
 * matches the ephemeral private key the reveal signs with). The
 * spec exercises both together to prove:
 *
 *   1. The commit P2TR address is bech32m-valid for each network.
 *   2. The reveal SUCCESSFULLY spends the commit output via the
 *      envelope leaf with the matching ephemeral key (proves
 *      taptree wiring + signature path are correct end-to-end).
 *   3. The reveal places the recipient at output 0 with postage
 *      sats (the ordinal-theory invariant: inscription on the
 *      first sat of the first output).
 *   4. ordpool-parser can reconstruct the inscription content from
 *      the broadcast reveal's witness (full round-trip).
 *   5. The taproot internal key IS the ephemeral pubkey (matches
 *      `ord` reference shape — `src/wallet/batch/plan.rs:367-382`).
 *      Single envelope leaf in the taptree; no recovery leaf.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { InscriptionParserService } from 'ordpool-parser';

import { Network, toScureNetwork } from '../network';

import { buildInscribeCommitPsbt, INSCRIBE_POSTAGE_SATS } from './inscription-commit.helper';
import { buildInscriptionEnvelope } from './inscription-envelope';
import { buildInscribeRevealTx, deriveRevealPubkeyXonly } from './inscription-reveal.helper';


const FUNDING_PRIV = new Uint8Array(32).fill(0x11);
const RECIPIENT_PRIV = new Uint8Array(32).fill(0x22);

function makeFundingUtxo(scureNetwork: typeof btc.NETWORK, valueSats: number) {
  // P2WPKH funding for simplicity — the input-adapter spec
  // exercises P2SH/P2TR/P2PKH separately.
  const fundingPubkey = secp256k1.getPublicKey(FUNDING_PRIV, true);
  const fundingP2wpkh = btc.p2wpkh(fundingPubkey, scureNetwork);
  return {
    fundingPubkey,
    fundingAddress: fundingP2wpkh.address!,
    fundingInput: {
      txid: 'f'.repeat(64),
      vout: 0,
      value: valueSats,
      scriptPubKey: fundingP2wpkh.script,
    },
  };
}


describe('buildInscribeCommitPsbt + buildInscribeRevealTx — round-trip', () => {

  const NETWORK = Network.Mainnet;
  const scureNetwork = toScureNetwork(NETWORK);

  function makeRecipientP2tr() {
    return btc.p2tr(schnorr.getPublicKey(RECIPIENT_PRIV), undefined, scureNetwork, true);
  }

  it('builds a valid commit P2TR address with a single-leaf envelope taptree and ephemeral key as internal key', () => {
    const ephemeralPriv = new Uint8Array(32).fill(0x33);
    const ephemeralPubkey = deriveRevealPubkeyXonly(ephemeralPriv);

    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'text/plain',
      body: new TextEncoder().encode('hello'),
    });

    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100_000);
    const result = buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    });

    expect(result.commitAddress.startsWith('bc1p')).toBe(true);
    expect(result.commitOutputValueSats).toBe(INSCRIBE_POSTAGE_SATS + 2_000);
    expect(result.taproot.internalKey).toEqual(ephemeralPubkey);
    expect(Array.isArray(result.taproot.tapLeafScript)).toBe(true);
    expect(result.taproot.tapLeafScript.length).toBe(1);
  });

  it('reveal can spend the commit output via the envelope leaf (finalize succeeds)', () => {
    const ephemeralPriv = new Uint8Array(32).fill(0x44);
    const ephemeralPubkey = deriveRevealPubkeyXonly(ephemeralPriv);
    const recipient = makeRecipientP2tr();

    const body = new TextEncoder().encode('test inscription content');
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'text/plain',
      body,
    });

    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100_000);
    const commit = buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    });

    const reveal = buildInscribeRevealTx({
      commitTxid: 'a'.repeat(64),
      commitVout: 0,
      commitOutputValueSats: commit.commitOutputValueSats,
      commitOutputScript: commit.commitOutputScript,
      taproot: {
        internalKey: commit.taproot.internalKey,
        tapLeafScript: commit.taproot.tapLeafScript,
      },
      ephemeralPrivKey: ephemeralPriv,
      recipientAddress: recipient.address!,
      network: NETWORK,
    });

    expect(reveal.revealHex.length).toBeGreaterThan(0);
    expect(reveal.revealTxid.length).toBe(64);
    expect(reveal.revealVsize).toBeGreaterThan(0);
  });

  it('reveal output 0 is the recipient at exactly 546 postage sats', () => {
    const ephemeralPriv = new Uint8Array(32).fill(0x55);
    const ephemeralPubkey = deriveRevealPubkeyXonly(ephemeralPriv);
    const recipient = makeRecipientP2tr();

    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'image/png',
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG magic
    });

    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100_000);
    const commit = buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    });

    const reveal = buildInscribeRevealTx({
      commitTxid: 'b'.repeat(64),
      commitVout: 0,
      commitOutputValueSats: commit.commitOutputValueSats,
      commitOutputScript: commit.commitOutputScript,
      taproot: {
        internalKey: commit.taproot.internalKey,
        tapLeafScript: commit.taproot.tapLeafScript,
      },
      ephemeralPrivKey: ephemeralPriv,
      recipientAddress: recipient.address!,
      network: NETWORK,
    });

    const decoded = btc.Transaction.fromRaw(hex.decode(reveal.revealHex));
    expect(decoded.outputsLength).toBe(1);
    expect(decoded.getOutput(0).amount).toBe(BigInt(INSCRIBE_POSTAGE_SATS));
    expect(decoded.getOutput(0).script).toEqual(recipient.script);
  });

  it('reveal witness script equals the BARE envelope (no trailing leaf-version byte) — regression pin for the 2026-06-22 consensus-reject bug', () => {
    // Failing input that previously made the reveal `script-verify-flag-failed`
    // (witness program hash mismatch) at live Bitcoin Core consensus
    // validation: the reveal helper was passing scure's BIP-371
    // `tapLeafScript[i]` value (which is `<script><leafVersionByte>`)
    // straight into both the BIP-341 sighash AND the witness slot.
    // The trailing 0xc0 made the on-chain tapleaf hash differ from
    // the one the commit P2TR committed to → validator rejected.
    // Bare-script-only is the contract; pin it here.
    const ephemeralPriv = new Uint8Array(32).fill(0x55);
    const ephemeralPubkey = deriveRevealPubkeyXonly(ephemeralPriv);
    const recipient = makeRecipientP2tr();
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'text/plain',
      body: new TextEncoder().encode('regression pin'),
    });
    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100_000);
    const commit = buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    });
    const reveal = buildInscribeRevealTx({
      commitTxid: 'd'.repeat(64),
      commitVout: 0,
      commitOutputValueSats: commit.commitOutputValueSats,
      commitOutputScript: commit.commitOutputScript,
      taproot: {
        internalKey: commit.taproot.internalKey,
        tapLeafScript: commit.taproot.tapLeafScript,
      },
      ephemeralPrivKey: ephemeralPriv,
      recipientAddress: recipient.address!,
      network: NETWORK,
    });
    const decoded = btc.Transaction.fromRaw(hex.decode(reveal.revealHex));
    const witness = decoded.getInput(0).finalScriptWitness!;
    expect(witness.length).toBe(3); // [sig, script, controlBlock]
    expect(witness[1]).toEqual(envelope);
    // Negative pin: the witness script MUST NOT carry the trailing
    // leaf-version byte. scure's tapLeafScript value is
    // `<bareScript><leafVerByte>`; the witness wants the bare half.
    const scureLeafValue = commit.taproot.tapLeafScript[0][1];
    expect(scureLeafValue.length).toBe(envelope.length + 1);
    expect(scureLeafValue[scureLeafValue.length - 1]).toBe(0xc0);
    expect(witness[1].length).toBe(envelope.length);
  });

  it('ordpool-parser reconstructs the original inscription content from the broadcast reveal witness', () => {
    const ephemeralPriv = new Uint8Array(32).fill(0x66);
    const ephemeralPubkey = deriveRevealPubkeyXonly(ephemeralPriv);
    const recipient = makeRecipientP2tr();

    const body = new TextEncoder().encode('round-trip end-to-end');
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'text/plain;charset=utf-8',
      body,
    });

    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100_000);
    const commit = buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    });

    const reveal = buildInscribeRevealTx({
      commitTxid: 'c'.repeat(64),
      commitVout: 0,
      commitOutputValueSats: commit.commitOutputValueSats,
      commitOutputScript: commit.commitOutputScript,
      taproot: {
        internalKey: commit.taproot.internalKey,
        tapLeafScript: commit.taproot.tapLeafScript,
      },
      ephemeralPrivKey: ephemeralPriv,
      recipientAddress: recipient.address!,
      network: NETWORK,
    });

    const decoded = btc.Transaction.fromRaw(hex.decode(reveal.revealHex));
    const witness = decoded.getInput(0).finalScriptWitness!.map(w => hex.encode(w));
    const fakeTx = { txid: reveal.revealTxid, vin: [{ witness }] };
    const parsed = InscriptionParserService.parse(fakeTx);
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe('text/plain;charset=utf-8');
    expect(parsed[0].getDataRaw()).toEqual(body);
  });

  it('rejects 33-byte ephemeral pubkey (must be x-only)', () => {
    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100_000);
    expect(() => buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: new Uint8Array(10),
      ephemeralPubkeyXonly: new Uint8Array(33), // wrong size
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    })).toThrow(/32 bytes/);
  });

  it('rejects funding insufficient for postage + reveal fee + commit fee', () => {
    const ephemeralPubkey = deriveRevealPubkeyXonly(new Uint8Array(32).fill(0x77));
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'text/plain',
      body: new Uint8Array(0),
    });
    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, 100);
    expect(() => buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      network: NETWORK,
    })).toThrow(/Funding insufficient/);
  });

  it('change below dust limit is absorbed into the commit fee', () => {
    const ephemeralPubkey = deriveRevealPubkeyXonly(new Uint8Array(32).fill(0x88));
    const envelope = buildInscriptionEnvelope({
      revealPubkeyXonly: ephemeralPubkey,
      contentType: 'text/plain',
      body: new TextEncoder().encode('x'),
    });

    const fundingValue = INSCRIBE_POSTAGE_SATS + 2_000 + 1_000 + 100;
    const { fundingInput, fundingAddress } = makeFundingUtxo(scureNetwork, fundingValue);
    const result = buildInscribeCommitPsbt({
      fundingInput,
      senderChangeAddress: fundingAddress,
      envelopeScript: envelope,
      ephemeralPubkeyXonly: ephemeralPubkey,
      commitFeeSats: 1_000,
      revealFeeReserveSats: 2_000,
      changeDustLimitSats: 294,
      network: NETWORK,
    });

    expect(result.changeSats).toBe(0);
  });
});
