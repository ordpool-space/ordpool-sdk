import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { getAddressFormat } from '../cat21-script/address-format';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../network';

import {
  buildInscribeCommitPsbt,
} from './inscription-commit.helper';
import {
  buildInscriptionEnvelope,
  type OrdEnvelopeField,
} from './inscription-envelope';
import {
  prepareInscribeFundingInput,
} from './inscription-input-adapter';
import {
  buildInscribeRevealTx,
  deriveRevealPubkeyXonly,
} from './inscription-reveal.helper';
import {
  simulateInscribeFees,
  type SimulateInscribeFeesResult,
} from './inscription-fee.helper';

/**
 * Layer-4 orchestration entry: ties the envelope encoder + per-
 * wallet input adapter + commit/reveal builders + fee simulator
 * into a single createTransaction-style entry point.
 *
 * Mirrors `createTransaction` from `cat21.service.helper.ts`. The
 * caller hands in the funding UTXO + wallet payment context + the
 * inscription content + feeRate; we hand back an unsigned commit
 * PSBT + a default signed reveal hex + the **ephemeral key material**
 * needed to build any other reveal shape (redirect, RBF, recover-
 * to-self, bundle).
 *
 * # Lifecycle
 *
 *  1. Generate fresh ephemeral keypair (32 random bytes).
 *  2. Derive Schnorr x-only pubkey — this doubles as the envelope's
 *     `<pubkey> CHECKSIG` prefix AND the taproot internal key of the
 *     commit output.
 *  3. Build envelope with that pubkey + caller's content.
 *  4. Simulate fees (Layer 3): commitFee, revealFee,
 *     commitOutputValueSats, fundingRequirementSats.
 *  5. Build the commit PSBT at the resolved commitFee.
 *  6. Build a default reveal tx at the resolved revealFee using the
 *     ephemeral private key (recipient = `args.recipientAddress`).
 *  7. Return the ephemeral key material so the caller can re-build
 *     the reveal under different parameters later if it wants to.
 *
 * # Bearer-key semantic
 *
 * `ephemeral.privKey` is a **bearer instrument**: anyone who holds
 * it can spend the commit output (redirect the inscription, RBF the
 * reveal, recover the postage to themselves, ...) until the commit
 * output is spent on chain. Treat it with the same care as any
 * other money-bearing key:
 *
 *   - Phase 1 storage: `localStorage` keyed by `commitTxid` is fine
 *     for typical low-value inscriptions. The key lives only
 *     between commit broadcast and reveal broadcast (seconds to
 *     hours typically).
 *   - For higher-value flows, encrypt at rest with the wallet
 *     password — same posture as any other hot key.
 *   - Lose the key with no reveal broadcast and the postage is
 *     permanently locked. Save it before discarding the result.
 *
 * This is byte-equivalent to the `ord` reference client's design
 * (`src/wallet/batch/plan.rs` lines 367-382 + 676-709) — ord
 * persists the ephemeral key into Bitcoin Core's wallet under a
 * `commit tx recovery key` label; we hand it to the consumer to
 * persist however it wants.
 */

export interface CreateInscribeTransactionsArgs {
  /** Funding UTXO. */
  paymentOutput: TxnOutput;
  /** Wallet's payment public key (33-byte compressed). */
  paymentPublicKey: Uint8Array;
  /** Wallet's payment address (where change returns). */
  paymentAddress: string;
  /** Where the inscription lands (P2TR recommended for ord theory). */
  recipientAddress: string;
  /** Inscription body bytes. */
  body: Uint8Array;
  /** MIME type. */
  contentType?: string;
  /** Optional extra ord tags (parent, metaprotocol, metadata...). */
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  /** sat/vB target. Applied identically to commit + reveal. */
  feeRatePerVbyte: number;
  /** Network. */
  network: Network;
}

export interface CreateInscribeTransactionsResult {
  /** Unsigned commit PSBT — hand to the user's wallet for signing. */
  commitPsbt: Uint8Array;
  /**
   * Computed txid of the commit. SegWit txids are witness-independent,
   * so this matches what the wallet-signed commit will produce.
   */
  commitTxid: string;
  /** Signed, finalized reveal-tx hex. Self-contained; broadcast as-is. */
  revealHex: string;
  /** Computed txid of the reveal (lets consumers display/track before broadcast). */
  revealTxid: string;
  /** Commit-tx P2TR address (bech32m). */
  commitAddress: string;
  /** Final fees (sats), vsizes, and the funding requirement. */
  fees: SimulateInscribeFeesResult;
  /**
   * Ephemeral bearer key for the commit output. Authorises any
   * reveal-tx shape (default reveal, redirect, RBF, recover-to-
   * self, bundle) until the commit output is spent. SAVE BEFORE
   * DISCARDING THIS RESULT — losing the key with no reveal
   * broadcast locks the postage forever.
   */
  ephemeral: {
    /** 32-byte Schnorr private key. */
    privKey: Uint8Array;
    /** 32-byte x-only public key. Same key embedded in the envelope. */
    pubkeyXonly: Uint8Array;
  };
  /** Material the caller needs to rebuild the reveal tx under different parameters. */
  commit: {
    /** Commit output scriptPubKey. */
    outputScript: Uint8Array;
    /** Postage + revealFeeReserve at the commit output. */
    outputValueSats: number;
    /** Envelope tapscript bytes (the leaf the reveal spends through). */
    envelopeScript: Uint8Array;
  };
}

/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function modulo `randomPrivateKey`.
 *
 * The returned `ephemeral.privKey` is the bearer instrument for
 * the commit output — see the module-level lifecycle note for the
 * storage semantic.
 */
export function createInscribeTransactions(
  args: CreateInscribeTransactionsArgs,
): CreateInscribeTransactionsResult {
  if (args.feeRatePerVbyte <= 0) {
    throw new Error('feeRatePerVbyte must be positive');
  }

  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPubkeyXonly = deriveRevealPubkeyXonly(ephemeralPrivKey);

  const envelope = buildInscriptionEnvelope({
    revealPubkeyXonly: ephemeralPubkeyXonly,
    contentType: args.contentType,
    body: args.body,
    fields: args.envelopeFields,
  });

  // Layer-2: convert raw UTXO into the funding-input shape the
  // commit helper expects. Real-mode (not simulation) so the
  // funding gets signed by the real wallet later.
  const realFundingInput = prepareInscribeFundingInput({
    utxo: args.paymentOutput,
    paymentPublicKey: args.paymentPublicKey,
    paymentAddress: args.paymentAddress,
    isSimulation: false,
    network: args.network,
  });

  // Layer-3: simulate fees. Layer 3 uses its own simulation-mode
  // funding input via the dummy keypair pattern.
  const simulationFundingInput = prepareInscribeFundingInput({
    utxo: args.paymentOutput,
    paymentPublicKey: args.paymentPublicKey,
    paymentAddress: args.paymentAddress,
    isSimulation: true,
    network: args.network,
  });
  let fees: SimulateInscribeFeesResult;
  try {
    fees = simulateInscribeFees({
      feeRatePerVbyte: args.feeRatePerVbyte,
      body: args.body,
      contentType: args.contentType,
      envelopeFields: args.envelopeFields,
      fundingInput: simulationFundingInput,
      senderChangeAddress: args.paymentAddress,
      recipientAddress: args.recipientAddress,
      ephemeralPubkeyXonly,
      network: args.network,
    });
  } catch (err) {
    // The commit helper throws `Funding insufficient: ...` when the
    // funding UTXO is below the postage + fees floor. Re-cast to
    // the orchestrator's typed message so consumers can branch on it
    // (same translation pattern cat21's createTransaction uses).
    if (err instanceof Error && /Funding insufficient/.test(err.message)) {
      throw new Error('Insufficient funds for inscribe');
    }
    throw err;
  }

  if (args.paymentOutput.value < fees.fundingRequirementSats) {
    throw new Error(
      `Insufficient funds for inscribe: funding UTXO has ${args.paymentOutput.value} ` +
      `sats, need ${fees.fundingRequirementSats} ` +
      `(commit fee ${fees.commitFeeSats} + commit output value ` +
      `${fees.commitOutputValueSats})`
    );
  }

  // Layer-1 build at resolved fees.
  const changeDustLimitSats = changeDustLimitFor(args.paymentAddress);
  const commit = buildInscribeCommitPsbt({
    fundingInput: realFundingInput,
    senderChangeAddress: args.paymentAddress,
    envelopeScript: envelope,
    ephemeralPubkeyXonly,
    commitFeeSats: fees.commitFeeSats,
    revealFeeReserveSats: fees.revealFeeSats,
    changeDustLimitSats,
    network: args.network,
  });

  // The reveal's input outpoint references the commit's txid.
  // scure 1.2.x's `.id` requires a finalized tx; the real commit
  // is unsigned because the user's wallet hasn't signed yet. We
  // build a SIMULATION-mode commit at the same fees against the
  // dummy-keyed funding input, dummy-sign it, finalize, read its
  // txid. SegWit txid is witness-independent, so the sim txid
  // equals what the wallet-signed real commit will produce
  // byte-for-byte at the same inputs/outputs.
  const simCommit = buildInscribeCommitPsbt({
    fundingInput: simulationFundingInput,
    senderChangeAddress: args.paymentAddress,
    envelopeScript: envelope,
    ephemeralPubkeyXonly,
    commitFeeSats: fees.commitFeeSats,
    revealFeeReserveSats: fees.revealFeeSats,
    changeDustLimitSats,
    network: args.network,
  });
  const simTx = btc.Transaction.fromPSBT(simCommit.commitPsbt);
  const { dummyPrivateKey } = getDummyKeypair(toScureNetwork(args.network));
  simTx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
  simTx.finalize();
  const commitTxidUnsigned = simTx.id;

  const reveal = buildInscribeRevealTx({
    commitTxid: commitTxidUnsigned,
    commitVout: 0,
    commitOutputValueSats: commit.commitOutputValueSats,
    commitOutputScript: commit.commitOutputScript,
    taproot: {
      internalKey: commit.taproot.internalKey,
      tapLeafScript: commit.taproot.tapLeafScript,
    },
    ephemeralPrivKey,
    recipientAddress: args.recipientAddress,
    network: args.network,
  });

  return {
    commitPsbt: commit.commitPsbt,
    commitTxid: commitTxidUnsigned,
    revealHex: reveal.revealHex,
    revealTxid: reveal.revealTxid,
    commitAddress: commit.commitAddress,
    fees,
    ephemeral: {
      privKey: ephemeralPrivKey,
      pubkeyXonly: ephemeralPubkeyXonly,
    },
    commit: {
      outputScript: commit.commitOutputScript,
      outputValueSats: commit.commitOutputValueSats,
      envelopeScript: envelope,
    },
  };
}

/** Per-address-type dust limit, mirroring `getMinimumUtxoSize`. */
function changeDustLimitFor(address: string): number {
  const fmt = getAddressFormat(address);
  switch (fmt) {
    case 'P2TR': return 330;
    case 'P2WPKH': return 294;
    case 'P2SH???':
    case 'P2PKH': return 546;
  }
}
