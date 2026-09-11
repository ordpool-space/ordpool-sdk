import { secp256k1 } from '@noble/curves/secp256k1';

import { getMinimumUtxoSize } from '../cat21-script/address-format';

import { buildBatchInscriptionScript } from './inscription-envelope';
import type { BatchEnvelope } from './inscription-envelope';
import { resolveInscribePostage } from './inscription-commit.helper';
import type { InscriptionPropertiesInput } from './inscription-properties';
import { deriveRevealPubkeyXonly } from './inscription-reveal.helper';
import {
  assembleInscribeTransactions,
  synthesizeBatchEntryFields,
} from './inscription.service.helper';
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
 *
 * ord writes the pointer for every batch inscription, including 0 (as an
 * empty value), so the envelopes match ord's byte for byte.
 */

/** ord's batch modes, minus `satpoints`, which needs sat targeting. */
export type BatchInscribeMode = 'separate-outputs' | 'shared-output' | 'same-sat';

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
  /** Compress `gallery`/`title` as `--compress` does. Needs the brotli wasm loaded. */
  compressProperties?: boolean;
  /** Where this inscription goes. `separate-outputs` only; defaults to `recipientAddress`. */
  destination?: string;
}

export interface CreateBatchInscribeTransactionsArgs
  extends Pick<CreateInscribeTransactionsArgs,
    'paymentOutput' | 'paymentPublicKey' | 'paymentAddress' | 'feeRatePerVbyte'
    | 'tip' | 'walletType' | 'minimalTagPush' | 'network'> {
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

/**
 * Build the commit and signed reveal for a batch. Pure function modulo the
 * ephemeral key; see `createInscribeTransactions` for the key's lifecycle.
 */
export function createBatchInscribeTransactions(
  args: CreateBatchInscribeTransactionsArgs,
): CreateBatchInscribeTransactionsResult {
  const { mode, inscriptions } = args;
  if (mode !== 'separate-outputs' && mode !== 'shared-output' && mode !== 'same-sat') {
    throw new Error(`unknown batch mode ${String(mode)}`);
  }
  if (inscriptions.length === 0) {
    throw new Error('a batch must contain at least one inscription');
  }
  if (mode !== 'separate-outputs' && inscriptions.some(entry => entry.destination !== undefined)) {
    throw new Error(`individual inscription destinations cannot be set in \`${mode}\` mode`);
  }
  for (const [i, entry] of inscriptions.entries()) {
    const ids = (entry.gallery ?? []).map(item => (typeof item === 'string' ? item : item.id));
    if (new Set(ids).size !== ids.length) {
      throw new Error(`inscription ${i}: duplicate gallery item`);
    }
  }
  const postage = resolveInscribePostage(args.postageSats);

  // Pointers and outputs, per ord's File::inscriptions and Plan: the pointer
  // starts at the sum of the parent outputs (none here) and advances by one
  // postage per inscription, except in same-sat, where every inscription
  // points at the same sat.
  const locations: BatchInscriptionLocation[] = inscriptions.map((entry, i) => ({
    index: i,
    vout: mode === 'separate-outputs' ? i : 0,
    offset: mode === 'shared-output' ? postage * i : 0,
    destination: mode === 'separate-outputs' ? entry.destination ?? args.recipientAddress : args.recipientAddress,
  }));
  const pointers = inscriptions.map((_, i) => (mode === 'same-sat' ? 0 : postage * i));
  const inscriptionOutputs = mode === 'separate-outputs'
    ? locations.map(l => ({ address: l.destination, value: postage }))
    : [{ address: args.recipientAddress, value: mode === 'shared-output' ? postage * inscriptions.length : postage }];

  for (const output of inscriptionOutputs) {
    const dust = getMinimumUtxoSize(output.address);
    if (output.value < dust) {
      throw new Error(`reveal output of ${output.value} sats to ${output.address} is below its ${dust}-sat dust limit`);
    }
  }

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
      compressProperties: entry.compressProperties,
      parents: [],
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

  const result = assembleInscribeTransactions(args, {
    envelope,
    ephemeralPrivKey,
    ephemeralPubkeyXonly,
    inscriptionOutputs,
  });
  return { ...result, inscriptions: locations };
}
