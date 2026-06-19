import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { Network, toScureNetwork } from '../network';

import { INSCRIBE_POSTAGE_SATS, buildInscribeCommitPsbt, type InscribeCommitArgs } from './inscription-commit.helper';
import { buildInscriptionEnvelope, type OrdEnvelopeField } from './inscription-envelope';
import { buildInscribeRevealTx, deriveRevealPubkeyXonly } from './inscription-reveal.helper';

/**
 * Layer-3 fee simulation for the inscribe commit + reveal pair.
 *
 * The two transactions pay independent fees at the same `feeRate`:
 *
 *   commit_fee = ceil(commitVsize × feeRate)
 *   reveal_fee = ceil(revealVsize × feeRate)
 *
 * The reveal's vsize is **deterministic given the envelope** (input
 * = commit output, output = recipient at postage, witness =
 * envelope script + Schnorr sig + control block) so we compute it
 * once via a one-shot simulation. The commit's vsize depends on
 * whether the change output crosses the dust limit at the
 * resolved fee, so we run the cat21-style two-pass loop on the
 * commit alone, passing `revealFeeReserveSats = reveal_fee`.
 *
 * Net cost: 1 reveal simulation + 2 commit simulations = 3 builds.
 *
 * Universal fee strategy that matches every inscriber in the
 * verified OSS catalog (ord client, micro-ordinals examples,
 * oyl-sdk, ordit-sdk, 0xFlicker, LaserEyes — see
 * OSS-INSCRIBERS.md). No zero-fee tricks, no CPFP magic; the
 * atomicity story is `submitpackage` at broadcast time, which
 * handles its own package-feerate math.
 */

export interface SimulateInscribeFeesArgs {
  /** sat/vB target fee rate. Same rate applies to both commit + reveal. */
  feeRatePerVbyte: number;
  /** Inscription body bytes. Shape-determines reveal vsize. */
  body: Uint8Array;
  /** MIME type encoded into the envelope. */
  contentType?: string;
  /** Optional extra envelope fields (parent, metaprotocol, metadata...). */
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  /**
   * Funding-input shape — the same `InscribeFundingInput` the commit
   * helper consumes. The Layer-2 adapter produces this.
   */
  fundingInput: InscribeCommitArgs['fundingInput'];
  /** Where the user's change returns to. */
  senderChangeAddress: string;
  /** Where the inscription lands. */
  recipientAddress: string;
  /** User wallet's x-only payment pubkey for the recovery tapscript leaf. */
  userRecoveryPubkeyXonly: Uint8Array;
  /** Per-address-type dust limit for the commit change. */
  changeDustLimitSats?: number;
  network: Network;
}

export interface SimulateInscribeFeesResult {
  /** Final commit-tx fee in sats. */
  commitFeeSats: number;
  /** Final reveal-tx fee in sats. */
  revealFeeSats: number;
  /** commitFeeSats + revealFeeSats. The "total fee burden" for UI display. */
  totalFeeSats: number;
  /** Commit vsize at final fee. */
  commitVsize: number;
  /** Reveal vsize (deterministic given the envelope). */
  revealVsize: number;
  /** commitVsize + revealVsize. Useful for package-feerate math. */
  combinedVsize: number;
  /** Amount the commit output 0 holds = postage + revealFeeSats. */
  commitOutputValueSats: number;
  /** Total sats the funding UTXO must cover: commitOutputValueSats + commitFeeSats. */
  fundingRequirementSats: number;
}

/**
 * Returns the commit + reveal fee math at the given fee rate.
 * Pure function — does not broadcast, does not retain any key
 * material between calls.
 */
export function simulateInscribeFees(args: SimulateInscribeFeesArgs): SimulateInscribeFeesResult {
  if (args.feeRatePerVbyte <= 0) {
    throw new Error('feeRatePerVbyte must be positive');
  }
  if (args.userRecoveryPubkeyXonly.length !== 32) {
    throw new Error(`userRecoveryPubkeyXonly must be 32 bytes; got ${args.userRecoveryPubkeyXonly.length}`);
  }

  // Deterministic dummy ephemeral key for the simulation. The key
  // affects byte values (signature, pubkey embedded in envelope)
  // but not vsizes — the Schnorr sig is always 64 bytes, the
  // pubkey is always 32 bytes. Using a fixed dummy lets the
  // simulator avoid touching the OS RNG.
  const dummyEphemeralPriv = new Uint8Array(32).fill(0x42);
  const dummyEphemeralPubkey = deriveRevealPubkeyXonly(dummyEphemeralPriv);

  const envelope = buildInscriptionEnvelope({
    revealPubkeyXonly: dummyEphemeralPubkey,
    contentType: args.contentType,
    body: args.body,
    fields: args.envelopeFields,
  });

  // ---- Step 1: reveal vsize is deterministic; compute once. ----
  // We need the commit output's script/address first to construct
  // a reveal that points at it. Build a placeholder commit with
  // zero fees just to get the taptree metadata.
  const placeholderCommit = buildInscribeCommitPsbt({
    fundingInput: args.fundingInput,
    senderChangeAddress: args.senderChangeAddress,
    envelopeScript: envelope,
    userRecoveryPubkeyXonly: args.userRecoveryPubkeyXonly,
    commitFeeSats: 0,
    revealFeeReserveSats: 0,
    changeDustLimitSats: args.changeDustLimitSats,
    network: args.network,
  });
  const envelopeLeafOnly = [placeholderCommit.taproot.tapLeafScript[0]] as typeof placeholderCommit.taproot.tapLeafScript;
  const reveal = buildInscribeRevealTx({
    commitTxid: '0'.repeat(64),
    commitVout: 0,
    commitOutputValueSats: INSCRIBE_POSTAGE_SATS,
    commitOutputScript: placeholderCommit.commitOutputScript,
    taproot: {
      internalKey: placeholderCommit.taproot.internalKey,
      tapLeafScript: envelopeLeafOnly,
    },
    ephemeralPrivKey: dummyEphemeralPriv,
    recipientAddress: args.recipientAddress,
    network: args.network,
  });
  const revealVsize = reveal.revealVsize;
  const revealFeeSats = Math.ceil(revealVsize * args.feeRatePerVbyte);

  // ---- Step 2: commit two-pass with revealFeeReserve = revealFeeSats. ----
  // Reuse the existing twoPassFeeSimulation pattern.
  const { finalFeeSats: commitFeeSats, vsize: commitVsize, finalSimulation } = twoPassFeeSimulation({
    feeRatePerVbyte: args.feeRatePerVbyte,
    simulate: (feeSats: number) => {
      const commit = buildInscribeCommitPsbt({
        fundingInput: args.fundingInput,
        senderChangeAddress: args.senderChangeAddress,
        envelopeScript: envelope,
        userRecoveryPubkeyXonly: args.userRecoveryPubkeyXonly,
        commitFeeSats: feeSats,
        revealFeeReserveSats: revealFeeSats,
        changeDustLimitSats: args.changeDustLimitSats,
        network: args.network,
      });
      // Decode the PSBT, dummy-sign the funding input, finalize,
      // read vsize. Same pattern cat21's simulateTransaction uses
      // (cat21.service.ts:176). Allows both DEFAULT and ALL
      // sighash because the funding input is taproot when the
      // caller passes a Taproot wallet via the Layer-2 adapter's
      // simulation mode.
      const tx = btc.Transaction.fromPSBT(commit.commitPsbt);
      const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(args.network));
      tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      tx.finalize();
      return { vsize: tx.vsize, commit };
    },
  });

  const commitOutputValueSats = finalSimulation.commit.commitOutputValueSats;
  return {
    commitFeeSats,
    revealFeeSats,
    totalFeeSats: commitFeeSats + revealFeeSats,
    commitVsize,
    revealVsize,
    combinedVsize: commitVsize + revealVsize,
    commitOutputValueSats,
    fundingRequirementSats: commitOutputValueSats + commitFeeSats,
  };
}

/**
 * Re-exports for consumers that want the underlying primitive.
 */
export { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';

/**
 * Re-export for consumers that need to forward the field-array.
 */
export type { OrdEnvelopeField } from './inscription-envelope';

/**
 * Re-import for the Layer-1 arg type referenced above.
 */
type InscribeFundingInput = InscribeCommitArgs['fundingInput'];
export type { InscribeFundingInput };
