import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { getAddressFormat } from '../cat21-script/address-format';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../network';

import {
  buildInscribeCommitPsbt,
  type InscribeCommitArgs,
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
 * inscription content + feeRate; we hand back a signed reveal hex
 * + an unsigned commit PSBT for the user's wallet to sign.
 *
 * Lifecycle:
 *
 *  1. Generate fresh ephemeral keypair (32 random bytes).
 *  2. Derive Schnorr x-only pubkey.
 *  3. Build envelope with that pubkey + caller's content.
 *  4. Simulate fees (Layer 3): returns commitFee, revealFee,
 *     commitOutputValueSats, fundingRequirementSats.
 *  5. Build the commit PSBT at the resolved commitFee.
 *  6. Build the reveal tx at the resolved revealFee using the
 *     ephemeral private key.
 *  7. **Zero the ephemeral key in memory** before returning.
 *
 * The returned `revealHex` is self-contained, broadcastable,
 * replay-able. No key reference survives the function call.
 */

export interface CreateInscribeTransactionsArgs {
  /** Funding UTXO. */
  paymentOutput: TxnOutput;
  /** Wallet's payment public key (33-byte compressed). */
  paymentPublicKey: Uint8Array;
  /** Wallet's payment address (where change returns). */
  paymentAddress: string;
  /** Wallet's payment x-only pubkey for the recovery tapscript leaf. */
  paymentPubkeyXonly: Uint8Array;
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
   * Material for the recovery path — leaf-1 of the commit's
   * taptree. Lets the consumer build + broadcast a tx that spends
   * the commit output back to the user when the reveal never lands.
   *
   * The user signs `recovery.leafScript` with their `userPubkey
   * Xonly` private key (Schnorr); the witness for the recovery tx
   * is `[signature, leafScript, controlBlock]`. See
   * `buildInscribeRecoveryTx` for the canonical builder.
   */
  recovery: {
    /** Commit output script (P2TR). */
    commitOutputScript: Uint8Array;
    /** Postage + revealFeeReserve, in sats. */
    commitOutputValueSats: number;
    /** Recovery tapscript leaf: `<userPubkeyXonly> CHECKSIG`. */
    leafScript: Uint8Array;
    /** scure-encoded control block for the recovery leaf. */
    controlBlock: Uint8Array;
  };
}

export interface BuildInscribeRecoveryTxArgs {
  /** From `result.commitTxid`. */
  commitTxid: string;
  /** Always 0 — the commit output is at vout 0. */
  commitVout?: number;
  /** From `result.recovery`. */
  recovery: CreateInscribeTransactionsResult['recovery'];
  /** Where the recovered postage lands. */
  recoveryAddress: string;
  /** sat/vB target for the recovery tx itself. */
  feeRatePerVbyte: number;
  /** User's recovery private key (32 bytes). The Schnorr signer for leaf-1. */
  userRecoveryPrivKey: Uint8Array;
  /** Network. */
  network: Network;
}

export interface BuildInscribeRecoveryTxResult {
  /** Finalized recovery tx hex (broadcastable). */
  recoveryHex: string;
  recoveryTxid: string;
  /** Sats actually delivered to `recoveryAddress`. */
  recoveryAmountSats: number;
  /** Fee paid by the recovery tx. */
  recoveryFeeSats: number;
}

/**
 * Build the inscribe commit + reveal pair for the given content.
 * Pure function (modulo `randomPrivateKey`). The ephemeral key is
 * zeroed inside this call; nothing in `Result` references it.
 */
export function createInscribeTransactions(
  args: CreateInscribeTransactionsArgs,
): CreateInscribeTransactionsResult {
  if (args.feeRatePerVbyte <= 0) {
    throw new Error('feeRatePerVbyte must be positive');
  }
  if (args.paymentPubkeyXonly.length !== 32) {
    throw new Error(
      `paymentPubkeyXonly must be 32 bytes; got ${args.paymentPubkeyXonly.length}`
    );
  }

  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();

  try {
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
        userRecoveryPubkeyXonly: args.paymentPubkeyXonly,
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
      userRecoveryPubkeyXonly: args.paymentPubkeyXonly,
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
      userRecoveryPubkeyXonly: args.paymentPubkeyXonly,
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

    const envelopeLeafOnly = [commit.taproot.tapLeafScript[0]] as typeof commit.taproot.tapLeafScript;
    const reveal = buildInscribeRevealTx({
      commitTxid: commitTxidUnsigned,
      commitVout: 0,
      commitOutputValueSats: commit.commitOutputValueSats,
      commitOutputScript: commit.commitOutputScript,
      taproot: {
        internalKey: commit.taproot.internalKey,
        tapLeafScript: envelopeLeafOnly,
      },
      ephemeralPrivKey,
      recipientAddress: args.recipientAddress,
      network: args.network,
    });

    // Recovery material: leaf-1 of the commit's 2-leaf taptree.
    // scure's `commitP2tr.tapLeafScript` returns ALL leaves in the
    // order we built them ([envelope, recovery]); the orchestrator
    // exposes [0] to the reveal helper above and [1] here for the
    // user-facing recovery path.
    const recoveryEntry = commit.taproot.tapLeafScript[1];
    if (!recoveryEntry) {
      throw new Error('Internal error: commit taptree missing recovery leaf');
    }
    const [recoveryCb, recoveryLeafScript] = recoveryEntry;
    const recoveryControlBlock = btc.TaprootControlBlock.encode(recoveryCb);

    return {
      commitPsbt: commit.commitPsbt,
      commitTxid: commitTxidUnsigned,
      revealHex: reveal.revealHex,
      revealTxid: reveal.revealTxid,
      commitAddress: commit.commitAddress,
      fees,
      recovery: {
        commitOutputScript: commit.commitOutputScript,
        commitOutputValueSats: commit.commitOutputValueSats,
        leafScript: recoveryLeafScript,
        controlBlock: recoveryControlBlock,
      },
    };
  } finally {
    // Zero the ephemeral key. After this, the only way to spend
    // the commit output is via leaf 1 (the user's recovery key).
    ephemeralPrivKey.fill(0);
  }
}

/**
 * Builds + signs the recovery tx that spends the commit output via
 * leaf 1 (`<userPubkeyXonly> CHECKSIG`). Use when the reveal can't
 * or won't broadcast and the user wants the postage back. Self-
 * contained — output is broadcastable wire-tx hex.
 *
 * The recovery tx is a 1-input, 1-output P2TR-script-path spend.
 * Estimated vsize is ~110 vB at the conservative end (32-byte sig +
 * 34-byte leaf + 33-byte control block = ~110 vB after segwit
 * discount). Fee is derived as `feeRate * 110` to give the recovery
 * room without overpaying.
 */
export function buildInscribeRecoveryTx(
  args: BuildInscribeRecoveryTxArgs,
): BuildInscribeRecoveryTxResult {
  if (args.feeRatePerVbyte <= 0) {
    throw new Error('feeRatePerVbyte must be positive');
  }
  if (args.userRecoveryPrivKey.length !== 32) {
    throw new Error('userRecoveryPrivKey must be 32 bytes');
  }

  const scureNetwork = toScureNetwork(args.network);
  const commitVout = args.commitVout ?? 0;
  // Conservative recovery-tx vsize for fee derivation. 1 P2TR input
  // (script-path with leaf=34B + control=33B + sig=64B), 1 P2TR
  // output (~43B). After segwit discount ≈ 110 vB.
  const recoveryVsizeEstimate = 110;
  const recoveryFee = BigInt(args.feeRatePerVbyte * recoveryVsizeEstimate);
  const commitValue = BigInt(args.recovery.commitOutputValueSats);
  if (commitValue <= recoveryFee) {
    throw new Error(
      `Recovery infeasible: commit output ${commitValue} <= estimated fee ${recoveryFee}`,
    );
  }
  const recoveredAmount = commitValue - recoveryFee;

  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  tx.addInput({
    txid: args.commitTxid,
    index: commitVout,
    witnessUtxo: {
      script: args.recovery.commitOutputScript,
      amount: commitValue,
    },
  });
  tx.addOutputAddress(args.recoveryAddress, recoveredAmount, scureNetwork);

  // Sign leaf 1 via Schnorr against the BIP-341 sighash for the
  // recovery's input 0. Same manual finalize pattern as the reveal
  // helper (scure 1.2.x can't auto-finalize this tapscript shape).
  const sighash = tx.preimageWitnessV1(
    0,
    [args.recovery.commitOutputScript],
    btc.SignatureHash.DEFAULT,
    [commitValue],
    undefined,
    args.recovery.leafScript,
    0xc0,
  );
  const signature = schnorr.sign(sighash, args.userRecoveryPrivKey);
  tx.updateInput(
    0,
    {
      finalScriptWitness: [signature, args.recovery.leafScript, args.recovery.controlBlock],
    },
    true,
  );

  return {
    recoveryHex: tx.hex,
    recoveryTxid: tx.id,
    recoveryAmountSats: Number(recoveredAmount),
    recoveryFeeSats: Number(recoveryFee),
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

/**
 * Compute the txid of an unsigned commit PSBT. The commit's txid
 * is determined by its inputs + outputs + lockTime + version — not
 * by signatures or witnesses (txid excludes the witness on SegWit
 * spends). So we can pre-compute the reveal's input reference
 * before the user has signed the commit.
 */
