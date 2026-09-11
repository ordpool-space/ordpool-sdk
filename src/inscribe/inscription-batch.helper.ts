import { secp256k1 } from '@noble/curves/secp256k1';

import { getMinimumUtxoSize } from '../cat21-script/address-format';

import { buildBatchInscriptionScript } from './inscription-envelope';
import type { BatchEnvelope } from './inscription-envelope';
import { resolveInscribePostage } from './inscription-commit.helper';
import type { InscribeCommitResult } from './inscription-commit.helper';
import { buildChildInscribeRevealTx } from './inscription-child-reveal.helper';
import type { ChildRevealParent } from './inscription-child-reveal.helper';
import type { InscriptionPropertiesInput } from './inscription-properties';
import { assertRevealWithinStandardWeight, deriveRevealPubkeyXonly } from './inscription-reveal.helper';
import {
  assembleInscribeTransactions,
  planInscribeCommit,
  synthesizeBatchEntryFields,
} from './inscription.service.helper';
import { failInscribe } from './inscribe-errors';
import type {
  CreateInscribeTransactionsArgs,
  CreateInscribeTransactionsResult,
} from './inscription.service.helper';

/**
 * Several inscriptions in one commit and one reveal, as `ord wallet batch`
 * builds them (cat21-ord src/wallet/batch/plan.rs and file.rs).
 *
 * Every inscription's envelope sits in the same reveal tapscript, in order,
 * so inscription i is `<revealTxid>i<i>`. Each envelope carries a pointer to
 * where its inscription lands, which is what the mode decides:
 *
 * | mode | reveal outputs | inscription i lands on |
 * |---|---|---|
 * | `separate-outputs` | one per inscription, each `postage` | the first sat of output i |
 * | `shared-output` | one, `postage` × N | sat `postage × i` of that output |
 * | `same-sat` | one, `postage` | the first sat of that output, all of them |
 * | `satpoints` | one per inscription, each the value of that inscription's own UTXO, which the reveal spends | the first sat of its own UTXO, carried to output i |
 *
 * ord writes the pointer for every batch inscription, including 0 (as an
 * empty value), so the envelopes match ord's byte for byte.
 */

/** ord's batch modes. */
export type BatchInscribeMode = 'separate-outputs' | 'shared-output' | 'same-sat' | 'satpoints';

/** One inscription in a batch: ord's batchfile entry. */
export interface BatchInscriptionEntry {
  /** Body bytes. Omit for a delegate-only inscription. */
  body?: Uint8Array;
  contentType?: string;
  contentEncoding?: CreateInscribeTransactionsArgs['contentEncoding'];
  /** Pre-encoded CBOR, e.g. from `encodeJsonMetadata`. */
  metadata?: Uint8Array;
  metaprotocol?: string;
  delegate?: string;
  gallery?: InscriptionPropertiesInput['gallery'];
  title?: string;
  /** Traits, a batchfile entry's `traits:`, in order. */
  traits?: InscriptionPropertiesInput['traits'];
  /** Compress `gallery`/`title`/`traits` as `--compress` does. Needs the brotli wasm loaded. */
  compressProperties?: boolean;
  /** Where this inscription goes. `separate-outputs` and `satpoints`; defaults to `recipientAddress`. */
  destination?: string;
  /**
   * `satpoints` mode only: the wallet UTXO whose first sat this inscription
   * goes on (ord's per-entry `satpoint`, offset 0 only). The reveal spends
   * it, and the inscription output carries exactly its value.
   */
  satpoint?: ChildRevealParent['utxo'];
}

export interface CreateBatchInscribeTransactionsArgs
  extends Pick<CreateInscribeTransactionsArgs,
    'paymentOutput' | 'paymentPublicKey' | 'paymentAddress' | 'feeRatePerVbyte'
    | 'tip' | 'walletType' | 'minimalTagPush' | 'network' | 'satOffset' | 'commitFeeRatePerVbyte' | 'noLimit'> {
  mode: BatchInscribeMode;
  /** The inscriptions, in order. At least one. */
  inscriptions: ReadonlyArray<BatchInscriptionEntry>;
  /** Postage per inscription, ord's batch-level `postage`. Default 546. */
  postageSats?: number;
  /**
   * Destination of the one output in `shared-output` and `same-sat`, and of
   * every `separate-outputs` entry without its own `destination`.
   */
  recipientAddress: string;
}

/** Where one batch inscription lands. */
export interface BatchInscriptionLocation {
  /** Position in the batch; the inscription id is `<revealTxid>i<index>`. */
  index: number;
  /** Reveal output the inscription is on. */
  vout: number;
  /** Sat offset within that output. */
  offset: number;
  destination: string;
}

export interface CreateBatchInscribeTransactionsResult extends CreateInscribeTransactionsResult {
  inscriptions: BatchInscriptionLocation[];
}

/** A parent every inscription in a batch gets: its id and the UTXO the reveal spends and returns. */
export interface BatchParent extends ChildRevealParent {
  /** The parent's inscription id, written into every envelope's `parent` tag. */
  id: string;
}

export interface CreateBatchChildInscribeTransactionsArgs extends CreateBatchInscribeTransactionsArgs {
  /**
   * ord's batch-level `parents`, in order. The reveal spends them at inputs
   * 0..N-1 and returns each at the same output index with its own value;
   * every envelope carries every parent tag. May be empty in `satpoints`
   * mode, where the satpoint UTXOs are the wallet inputs.
   */
  parents: ReadonlyArray<BatchParent>;
}

export interface CreateBatchChildInscribeTransactionsResult
  extends Omit<CreateInscribeTransactionsResult, 'revealHex'> {
  /**
   * The full reveal PSBT. Parent inputs 0..N-1 unsigned; the commit input
   * carries the ephemeral partial signature. The parent signatures from
   * `revealPsbtForWallet` are merged here before it finalizes.
   */
  revealPsbt: Uint8Array;
  /** The same reveal with a bare commit input, for the wallet to sign the parents on. */
  revealPsbtForWallet: Uint8Array;
  parents: ReadonlyArray<BatchParent>;
  inscriptions: BatchInscriptionLocation[];
  /**
   * How many wallet-owned inputs precede the commit input in the reveal:
   * the parents, then the satpoint UTXOs. The wallet signs exactly these
   * (`signChildRevealParentInputs` with this `walletInputCount`).
   */
  walletInputCount: number;
}

interface BatchLayout {
  envelope: Uint8Array;
  ephemeralPrivKey: Uint8Array;
  ephemeralPubkeyXonly: Uint8Array;
  inscriptionOutputs: Array<{ address: string; value: number }>;
  locations: BatchInscriptionLocation[];
}

/**
 * Validate a batch and lay it out as ord does (cat21-ord File::inscriptions
 * and Plan): each inscription's pointer starts at the sum of the parent
 * outputs and advances by one postage per inscription, except in same-sat,
 * where every inscription points at the same sat. The inscription outputs
 * follow the parent returns, so their vouts start at the parent count.
 */
function layOutBatch(
  args: CreateBatchInscribeTransactionsArgs,
  parents: ReadonlyArray<BatchParent>,
): BatchLayout {
  const { mode, inscriptions } = args;
  if (mode !== 'separate-outputs' && mode !== 'shared-output' && mode !== 'same-sat' && mode !== 'satpoints') {
    throw new Error(`unknown batch mode ${String(mode)}`);
  }
  if (inscriptions.length === 0) {
    failInscribe('batch-empty', 'a batch must contain at least one inscription',
      'Add at least one inscription to the batch.');
  }
  if ((args.satOffset ?? 0) !== 0 && mode !== 'same-sat') {
    failInscribe('batch-sat-offset-not-allowed',
      '`satOffset` can only be set in `same-sat` mode, as ord allows `sat` / `satpoint` only there',
      'Inscribing onto a chosen sat in a batch only works when every inscription goes on the same sat.');
  }
  if ((mode === 'shared-output' || mode === 'same-sat') && inscriptions.some(entry => entry.destination !== undefined)) {
    failInscribe('batch-destination-not-allowed',
      `individual inscription destinations cannot be set in \`${mode}\` mode`,
      'In this batch mode every inscription lands on one output, so they share one destination.',
      { mode });
  }
  // ord's File::load rules for per-entry satpoints.
  if (mode === 'satpoints') {
    if (args.postageSats !== undefined) {
      failInscribe('batch-postage-not-allowed',
        '`postage` cannot be set in `satpoints` mode: each inscription\'s own UTXO is its postage',
        'When each inscription goes on its own chosen sat, its coin decides the size; remove the postage.');
    }
    const seen = new Set<string>();
    for (const [i, entry] of inscriptions.entries()) {
      if (entry.satpoint === undefined) {
        failInscribe('batch-satpoint-required',
          `inscription ${i}: \`satpoints\` mode needs a satpoint for every inscription`,
          `Inscription ${i + 1} has no sat chosen. In this mode every inscription needs its own.`,
          { index: i });
      }
      const key = `${entry.satpoint.txid}:${entry.satpoint.vout}`;
      if (seen.has(key)) {
        failInscribe('batch-duplicate-satpoint', `duplicate satpoint ${key}:0`,
          'Two inscriptions were given the same sat; each needs its own.', { satpoint: `${key}:0` });
      }
      seen.add(key);
    }
  } else if (inscriptions.some(entry => entry.satpoint !== undefined)) {
    failInscribe('batch-satpoint-not-allowed',
      'specifying `satpoint` in an inscription only works in `satpoints` mode',
      'Per-inscription sats only work in the mode where each inscription goes on its own chosen sat.');
  }
  for (const [i, entry] of inscriptions.entries()) {
    const ids = (entry.gallery ?? []).map(item => (typeof item === 'string' ? item : item.id));
    if (new Set(ids).size !== ids.length) {
      failInscribe('duplicate-gallery-item', `inscription ${i}: duplicate gallery item`,
        `Inscription ${i + 1} lists the same gallery item twice.`, { index: i });
    }
  }
  const parentSats = parents.reduce((sum, p) => sum + p.utxo.value, 0);
  // Per inscription: the batch postage, or in satpoints mode its UTXO's value.
  const postages = inscriptions.map(entry =>
    mode === 'satpoints' ? (entry.satpoint as ChildRevealParent['utxo']).value : resolveInscribePostage(args.postageSats));
  const before = (i: number) => postages.slice(0, i).reduce((sum, v) => sum + v, 0);
  const ownOutputs = mode === 'separate-outputs' || mode === 'satpoints';

  const locations: BatchInscriptionLocation[] = inscriptions.map((entry, i) => ({
    index: i,
    vout: parents.length + (ownOutputs ? i : 0),
    offset: mode === 'shared-output' ? before(i) : 0,
    destination: ownOutputs ? entry.destination ?? args.recipientAddress : args.recipientAddress,
  }));
  const pointers = inscriptions.map((_, i) => parentSats + (mode === 'same-sat' ? 0 : before(i)));
  const inscriptionOutputs = ownOutputs
    ? locations.map((l, i) => ({ address: l.destination, value: postages[i] }))
    : [{ address: args.recipientAddress, value: mode === 'shared-output' ? before(inscriptions.length) : postages[0] }];

  for (const output of inscriptionOutputs) {
    const dust = getMinimumUtxoSize(output.address);
    if (output.value < dust) {
      failInscribe('output-below-dust',
        `reveal output of ${output.value} sats to ${output.address} is below its ${dust}-sat dust limit`,
        `A postage of ${output.value} sats is below the ${dust}-sat minimum an output needs at this address.`,
        { value: output.value, dustLimit: dust });
    }
  }

  const parentIds = parents.map(p => p.id);
  const envelopes: BatchEnvelope[] = inscriptions.map((entry, i) => ({
    contentType: entry.contentType,
    body: entry.body,
    fields: synthesizeBatchEntryFields({
      contentEncoding: entry.contentEncoding,
      metadata: entry.metadata,
      metaprotocol: entry.metaprotocol,
      delegate: entry.delegate,
      gallery: entry.gallery,
      title: entry.title,
      traits: entry.traits,
      compressProperties: entry.compressProperties,
      parents: parentIds,
      pointer: pointers[i],
    }),
  }));

  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPubkeyXonly = deriveRevealPubkeyXonly(ephemeralPrivKey);
  const envelope = buildBatchInscriptionScript({
    revealPubkeyXonly: ephemeralPubkeyXonly,
    envelopes,
    minimalTagPush: args.minimalTagPush,
  });
  return { envelope, ephemeralPrivKey, ephemeralPubkeyXonly, inscriptionOutputs, locations };
}

/**
 * Build the commit and signed reveal for a batch. Pure function modulo the
 * ephemeral key; see `createInscribeTransactions` for the key's lifecycle.
 */
export function createBatchInscribeTransactions(
  args: CreateBatchInscribeTransactionsArgs,
): CreateBatchInscribeTransactionsResult {
  if (args.mode === 'satpoints') {
    throw new Error('`satpoints` mode spends wallet UTXOs in the reveal; use createBatchChildInscribeTransactions');
  }
  const layout = layOutBatch(args, []);
  const result = assembleInscribeTransactions(args, layout);
  return { ...result, inscriptions: layout.locations };
}

/**
 * Build the commit and reveal for a batch whose reveal also spends wallet
 * UTXOs: ord's `parents:` in a batchfile, the `satpoints` mode, or both. The
 * reveal then needs the wallet's signatures, like a child inscription's:
 * `revealPsbtForWallet` goes to the wallet (`signChildRevealParentInputs`
 * with `walletInputCount`), and its signatures are merged into `revealPsbt`.
 */
export function createBatchChildInscribeTransactions(
  args: CreateBatchChildInscribeTransactionsArgs,
): CreateBatchChildInscribeTransactionsResult {
  if (args.parents.length === 0 && args.mode !== 'satpoints') {
    throw new Error('parents must not be empty; use createBatchInscribeTransactions for a batch without parents');
  }
  const layout = layOutBatch(args, args.parents);
  const tipValueSats = args.tip?.value ?? 0;
  // In satpoints mode the satpoint UTXOs fund the inscription outputs, so the
  // commit carries only the reveal fee (ord: target_value = reveal_fee).
  const satpointInputs = args.mode === 'satpoints'
    ? args.inscriptions.map(entry => entry.satpoint as ChildRevealParent['utxo'])
    : [];
  const commitPostageSats = args.mode === 'satpoints'
    ? 0
    : layout.inscriptionOutputs.reduce((sum, o) => sum + o.value, 0);
  const childReveal = (
    commit: { txid: string; vout: number; outputScript: Uint8Array; taproot: InscribeCommitResult['taproot']; outputValueSats: number },
    ephemeralPrivKey: Uint8Array,
  ) => buildChildInscribeRevealTx({
    commitTxid: commit.txid,
    commitVout: commit.vout,
    commitOutputValueSats: commit.outputValueSats,
    commitOutputScript: commit.outputScript,
    taproot: commit.taproot,
    ephemeralPrivKey,
    parents: args.parents,
    satpointInputs,
    inscriptionOutputs: layout.inscriptionOutputs,
    tip: args.tip,
    network: args.network,
  });

  const plan = planInscribeCommit(args, {
    envelope: layout.envelope,
    ephemeralPubkeyXonly: layout.ephemeralPubkeyXonly,
    inscriptionOutputs: layout.inscriptionOutputs,
    commitPostageSats,
    // Measured on the real reveal shape, wallet inputs included, at zero fee
    // (the commit output covers only what it funds and the tip).
    measureRevealVsize: (commit) => childReveal({
      txid: '0'.repeat(64),
      vout: 0,
      outputScript: commit.outputScript,
      taproot: commit.taproot,
      outputValueSats: commitPostageSats + tipValueSats,
    }, new Uint8Array(32).fill(0x42)).revealVsize,
  });
  const commitDust = getMinimumUtxoSize(plan.commit.commitAddress);
  if (plan.commit.commitOutputValueSats < commitDust) {
    throw new Error(
      `the commit output of ${plan.commit.commitOutputValueSats} sats is below its ${commitDust}-sat dust limit; ` +
      'raise the fee rate or add a tip',
    );
  }

  const reveal = childReveal({
    txid: plan.commitTxid,
    vout: plan.commit.commitVout,
    outputScript: plan.commit.commitOutputScript,
    taproot: plan.commit.taproot,
    outputValueSats: plan.commit.commitOutputValueSats,
  }, layout.ephemeralPrivKey);
  assertRevealWithinStandardWeight(reveal.revealWeight, args.noLimit);

  return {
    commitPsbt: plan.commit.commitPsbt,
    commitTxid: plan.commitTxid,
    revealPsbt: reveal.revealPsbt,
    revealPsbtForWallet: reveal.revealPsbtForWallet,
    revealTxid: reveal.revealTxid,
    commitAddress: plan.commit.commitAddress,
    fees: plan.fees,
    ephemeral: { privKey: layout.ephemeralPrivKey, pubkeyXonly: layout.ephemeralPubkeyXonly },
    commit: {
      outputScript: plan.commit.commitOutputScript,
      outputValueSats: plan.commit.commitOutputValueSats,
      envelopeScript: layout.envelope,
    },
    parents: args.parents,
    inscriptions: layout.locations,
    walletInputCount: args.parents.length + satpointInputs.length,
  };
}
