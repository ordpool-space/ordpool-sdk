import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

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
 * The reveal's vsize is **deterministic given the envelope and
 * the tip presence** (input = commit output; outputs = recipient
 * at postage + optional tip at `tip.value`; witness = envelope
 * script + Schnorr sig + control block) so we compute it once via
 * a one-shot simulation. The commit's vsize depends on
 * whether the change output crosses the dust limit at the
 * resolved fee, so we run the cat21-style two-pass loop on the
 * commit alone, passing `revealFeeReserveSats = reveal_fee`.
 *
 * Net cost: 1 reveal simulation + 2 commit simulations = 3 builds.
 *
 * Universal fee strategy that matches every inscriber in the
 * verified OSS catalog (ord client, micro-ordinals examples,
 * ordit-sdk, 0xFlicker, LaserEyes — see
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
   * Tag push-encoding choice. Threads to `buildInscriptionEnvelope`
   * so the simulated reveal vsize matches the encoding the real
   * commit will use (pushnum saves 1 byte per tag). Default false.
   */
  minimalTagPush?: boolean;
  /**
   * Funding-input shape — the same `InscribeFundingInput` the commit
   * helper consumes. The Layer-2 adapter produces this.
   */
  fundingInput: InscribeCommitArgs['fundingInput'];
  /** Where the user's change returns to. */
  senderChangeAddress: string;
  /** Where the inscription lands. */
  recipientAddress: string;
  /**
   * 32-byte x-only ephemeral pubkey used as the taproot internal key
   * AND embedded in the envelope's `<pubkey> CHECKSIG` prefix. Real
   * orchestrator passes the freshly-generated key; specs may pass a
   * deterministic dummy because vsizes don't depend on key bytes.
   */
  ephemeralPubkeyXonly: Uint8Array;
  /**
   * Optional reveal-tx tip output. Threads through to the reveal
   * vsize estimate (extra output bytes) AND the commit's
   * `tipValueSats` so the commit funds postage + revealFee + tip.
   */
  tip?: { address: string; value: number };
  /**
   * Wallet whose signature topology drives the commit's funding-
   * input sequence. Threaded through to `buildInscribeCommitPsbt`.
   * Optional; defaults to the safer non-RBF sequence when omitted.
   */
  walletType?: KnownOrdinalWalletType;
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
  /**
   * Amount the commit output 0 holds = postage + revealFeeSats +
   * (tip.value ?? 0) — sized to fund the reveal's recipient
   * + optional tip + miner fee in one P2TR output.
   */
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
  if (args.ephemeralPubkeyXonly.length !== 32) {
    throw new Error(`ephemeralPubkeyXonly must be 32 bytes; got ${args.ephemeralPubkeyXonly.length}`);
  }

  // The simulator uses a deterministic dummy ephemeral private key
  // for the reveal-signing step (the resulting Schnorr signature is
  // always 64 bytes regardless of the key bytes, so vsize doesn't
  // care). The pubkey embedded in the envelope + used as taproot
  // internal key is whatever the caller passed (real orchestrator
  // passes the freshly-generated ephemeral key; specs may pass a
  // fixed dummy).
  const dummyEphemeralPriv = new Uint8Array(32).fill(0x42);

  const envelope = buildInscriptionEnvelope({
    revealPubkeyXonly: args.ephemeralPubkeyXonly,
    contentType: args.contentType,
    body: args.body,
    fields: args.envelopeFields,
    minimalTagPush: args.minimalTagPush,
  });

  // ---- Step 1: reveal vsize is deterministic; compute once. ----
  // We need the commit output's script/address first to construct
  // a reveal that points at it. Build a placeholder commit with
  // zero fees just to get the taptree metadata.
  const placeholderCommit = buildInscribeCommitPsbt({
    fundingInput: args.fundingInput,
    senderChangeAddress: args.senderChangeAddress,
    envelopeScript: envelope,
    ephemeralPubkeyXonly: args.ephemeralPubkeyXonly,
    commitFeeSats: 0,
    revealFeeReserveSats: 0,
    tipValueSats: args.tip?.value,
    walletType: args.walletType,
    changeDustLimitSats: args.changeDustLimitSats,
    network: args.network,
  });
  const tipValueSats = args.tip?.value ?? 0;
  const reveal = buildInscribeRevealTx({
    commitTxid: '0'.repeat(64),
    commitVout: 0,
    // postage + tip; the placeholder commit has revealFeeReserveSats=0
    // so the commit output is sized exactly to cover the reveal's two
    // outputs (recipient at postage, tip at tip.value). Setting it
    // higher would leave change inside the reveal which the helper
    // doesn't model — instead we measure vsize at zero reveal fee and
    // compute the fee separately.
    commitOutputValueSats: INSCRIBE_POSTAGE_SATS + tipValueSats,
    commitOutputScript: placeholderCommit.commitOutputScript,
    taproot: {
      internalKey: placeholderCommit.taproot.internalKey,
      tapLeafScript: placeholderCommit.taproot.tapLeafScript,
    },
    ephemeralPrivKey: dummyEphemeralPriv,
    recipientAddress: args.recipientAddress,
    tip: args.tip,
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
        ephemeralPubkeyXonly: args.ephemeralPubkeyXonly,
        commitFeeSats: feeSats,
        revealFeeReserveSats: revealFeeSats,
        tipValueSats: args.tip?.value,
        walletType: args.walletType,
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
 * Local alias for the Layer-1 funding-input shape referenced in
 * `SimulateInscribeFeesArgs.fundingInput`. The canonical export
 * lives on `./inscription-input-adapter` (`InscribeFundingInput`)
 * so consumers import it from one place; this alias keeps the
 * fee helper's signature self-describing without re-exporting
 * the same name twice through the public barrel.
 */
type InscribeFundingInput = InscribeCommitArgs['fundingInput'];
