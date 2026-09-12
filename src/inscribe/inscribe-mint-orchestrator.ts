import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { ContentScanPort } from '../cat21-core/ports';
import { selectFunding } from '../cat21-core/select-funding';
import { changeDustFloor } from '../cat21-script/address-format';
import { AnnotatedFundingUtxo, FundingRecommendation } from '../cat21-fee/funding-safety';
import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import {
  compressLikeOrd,
  type InscriptionContentEncoding,
  type OrdCompressedBody,
} from './inscribe-compression.helper';
import { loadBrotliWasm, type BrotliWasmSource } from './brotli-wasm-encoder';
import type { InscribeSatSource } from './inscription-commit.helper';
import type { ChildRevealParent } from './inscription-child-reveal.helper';
import {
  simulateBatchInscribeFees,
  type BatchInscribeMode,
  type BatchParent,
  type CreateBatchInscribeTransactionsArgs,
} from './inscription-batch.helper';
import { OrdEnvelopeField } from './inscription-envelope';
import { SimulateInscribeFeesArgs, SimulateInscribeFeesResult, simulateInscribeFees } from './inscription-fee.helper';
import type { InscriptionPropertiesInput } from './inscription-properties';
import { synthesizeEnvelopeFields, type CreateInscribeTransactionsArgs } from './inscription.service.helper';
import { prepareInscribeFundingInput } from './inscription-input-adapter';
import {
  InscribeAndBroadcastResult,
  inscribeAndBroadcast,
  inscribeBatchAndBroadcast,
} from './inscribe-orchestrator';

/**
 * High-level inscribe API. Plain class, no signals. Sibling of
 * `Cat21MintOrchestrator`: the SDK owns this orchestration; a consumer IMPORTS
 * it ready-made and binds its `subscribe(listener)` callback to whatever
 * reactivity it uses in ONE line. The orchestrator wires wallet-backed commit
 * signing internally (the signer registry, via `inscribeAndBroadcast`) and the
 * fee/selection logic (the shared `simulateInscribeFees` + the force-scanning
 * `selectFunding`); the consumer supplies only its I/O (electrs/ord/broadcast)
 * as `InscribeOrchestratorDeps` and the connected wallet via `setWallet`.
 *
 * # Two-tx model
 *
 * Every inscribe produces a commit + reveal pair. The simulation grid shows the
 * sum of both fees + the funding requirement. `mint()` calls
 * `inscribeAndBroadcast`, which signs the commit's single funding input via the
 * wallet, broadcasts commit, signs the reveal with the ephemeral key, and
 * broadcasts the reveal. The ephemeral bearer key lands on
 * `successResult.ephemeral` — persistence is a consumer concern.
 */

/**
 * The per-mint payload the consumer wires in via `setContent`. `body` +
 * `contentType` land in the inscription envelope; `tip` becomes the reveal's
 * vout[1]; the rest are optional ord envelope tags. `recipient` defaults to the
 * connected wallet's ordinals address when unset.
 */
import { failInscribe, inscribeUserMessage } from './inscribe-errors';
import { selectPaddingUtxo } from './padding-utxo';
import { batchParentFromInscriptionId } from './parent-resolve';

/**
 * What is being inscribed: a file, or a delegate that points at another
 * inscription's content (ord's `--delegate` with no `--file`). One or the
 * other, so a screen can ask the question once and hide what does not apply.
 */
export type InscribeSource =
  | { kind: 'file'; body: Uint8Array; contentType?: string }
  | { kind: 'delegate'; delegate: string };

/**
 * The sat to inscribe onto, ord's `--satpoint` / `--sat`: either a sat inside
 * the funding coin, or a sat in another taproot coin (a rare sat at the
 * ordinals address). Omitted, the inscription lands on the funding coin's
 * first sat, which is what an ordinary inscribe does.
 *
 * Either kind may need `paddingUtxo` when the sat sits less than a dust limit
 * into its coin; the error then says how many sats that coin needs.
 */
export type InscribeSatTarget =
  | { kind: 'in-funding'; offset: number }
  | { kind: 'in-utxo'; utxo: InscribeSatSource; offset: number };

export interface InscribeContent {
  /** File or delegate. */
  source: InscribeSource;
  envelopeFields?: ReadonlyArray<OrdEnvelopeField>;
  /** Optional reveal vout[1] tip. */
  tip?: { address: string; value: number };
  note?: string;
  parent?: string;
  contentEncoding?: InscriptionContentEncoding;
  /** Pointer (tag 0x02) sat offset; must be < 546. */
  pointer?: number;
  /** CBOR metadata (tag 0x05), pre-encoded; chunked over 520. */
  metadata?: Uint8Array;
  /** Metaprotocol identifier (tag 0x07), UTF-8. */
  metaprotocol?: string;
  /** Rune-name commitment (tag 0x0d) as the rune's u128 value. */
  rune?: bigint;
  /** CBOR properties (tag 0x11), pre-encoded; chunked over 520. */
  properties?: Uint8Array;
  /** Properties-encoding hint (tag 0x13); only alongside properties. */
  propertyEncoding?: 'br';
  /**
   * Tag push-encoding choice. `false` (default) = data push (ord-standard,
   * charm-free); `true` = pushnum for tags 1–16 (1 byte smaller, ord's
   * `vindicated` charm). Threads to both the fee preview and the mint.
   */
  minimalTagPush?: boolean;
  /** Override for the inscription's recipient. Defaults to wallet.ordinalsAddress. */
  recipient?: string;
  /** The inscription's title, ord's `--title`. */
  title?: string;
  /** Traits in order, a batchfile's `traits:`. */
  traits?: InscriptionPropertiesInput['traits'];
  /** Inscriptions this one is a gallery of, ord's `--gallery`. */
  gallery?: InscriptionPropertiesInput['gallery'];
  /** Compress title/traits/gallery as `--compress` does. Needs `deps.brotliWasm`. */
  compressProperties?: boolean;
  /**
   * Compress the body as ord's `--compress` does: brotli, kept only when the
   * result is strictly smaller. The orchestrator compresses during recompute,
   * prices the compressed body in the preview and sets `contentEncoding`
   * itself; `snapshot.compression` carries what it saved. Needs
   * `deps.brotliWasm`. A file source only.
   */
  compressBody?: boolean;
  /** The inscription output's value, ord's `--postage`. Default 546. */
  postageSats?: number;
  /**
   * The sat to inscribe onto. With `kind: 'in-funding'` the coin holding it
   * must be chosen via `setSelectedUtxo`; the automatic pick would use
   * another coin, and so another sat.
   */
  satTarget?: InscribeSatTarget;
  /** A second payment UTXO, when the chosen sat needs padding (see `InscribeSatTarget`). */
  paddingUtxo?: TxnOutput;
  /** The commit's own fee rate, ord's `--commit-fee-rate`. Default: the fee rate. */
  commitFeeRatePerVbyte?: number;
}

/**
 * One row in the per-UTXO simulation grid (the expert picker).
 * `insufficient: true` — the UTXO can't cover `fundingRequirementSats` at the
 * current rate; `false` — viable, `simulation` carries the commit + reveal
 * vsize / fee breakdown.
 */
export interface InscribeUtxoSimulation {
  utxo: TxnOutput;
  simulation: SimulateInscribeFeesResult | null;
  insufficient: boolean;
  /** What this coin would cost and produce; `null` when it cannot fund the inscription. */
  preview: InscribePreview | null;
}

/**
 * One computed result per funding coin, everything a screen shows about the
 * cost, taken from the same planning the build runs.
 */
export interface InscribePreview {
  commitVsize: number;
  commitFeeSats: number;
  revealVsize: number;
  revealFeeSats: number;
  /** Commit plus reveal miner fees. */
  totalFeeSats: number;
  /** Sats the inscription itself carries. */
  postageSats: number;
  /** What the funding coin must hold: the commit output plus the commit fee. */
  fundingRequirementSats: number;
  /** Fees plus postage plus any tip: what leaves the wallet. */
  totalSpentSats: number;
  /** How often the wallet asks to sign for this shape. */
  walletPrompts: number;
}

/**
 * What the wallet is being asked to sign right now, emitted before each
 * prompt so a screen can say which signature is coming.
 */
export interface InscribeSigningStep {
  step: number;
  of: number;
  what: 'commit' | 'parent-inputs' | 'satpoint-inputs' | 'parent-and-satpoint-inputs';
}

/**
 * What `compressBody` saved, ord's `--compress` rule applied: the compressed
 * body is inscribed only when it is strictly smaller than the original.
 * `contentEncoding: null` means compressing did not help and the original
 * bytes are what gets inscribed, so a screen can say so instead of showing a
 * saving of zero.
 */
export interface InscribeCompression {
  /** Bytes before compressing. */
  originalSize: number;
  /** Bytes being inscribed; equals `originalSize` when compressing did not help. */
  compressedSize: number;
  /** `originalSize - compressedSize`; 0 when compressing did not help. */
  savedBytes: number;
  /** The `content_encoding` being written, or `null` when the original is inscribed. */
  contentEncoding: 'br' | null;
}

/**
 * The second coin spent to pad a chosen sat's alignment output. A sat sitting
 * less than a dust limit into its coin leaves the sats before it as an output
 * too small to relay; this coin covers the difference, and every sat of it
 * returns in that output.
 */
export interface InscribePadding {
  /** The coin being spent as padding. */
  utxo: TxnOutput;
  /** Sats the padding output was short of its dust floor. */
  shortfallSats: number;
  /** `true` when the orchestrator sourced the coin, `false` when `paddingUtxo` was set. */
  automatic: boolean;
}

/** A parent the orchestrator located, as a screen shows it. */
export interface InscribeResolvedParent {
  id: string;
  /** The address it sits at, and returns to. */
  address: string;
  /** Sats in the coin holding it; it returns with exactly this value. */
  value: number;
  /** `<txid>:<vout>` of the coin the reveal spends and hands back. */
  outpoint: string;
}

/** State machine the consumer's template branches on. Sibling of the cat21 mint. */
export type InscribeMintState =
  | 'idle' | 'loading-utxos' | 'ready' | 'minting' | 'success' | 'error';

/** The connected wallet's addresses + type; the consumer supplies it. */
export interface InscribeWalletContext {
  type: KnownOrdinalWalletType;
  ordinalsAddress: string;
  paymentAddress: string;
  /** hex-encoded payment public key. */
  paymentPublicKey: string;
  /**
   * hex-encoded ordinals public key, x-only or compressed. Needed to spend
   * anything sitting at the ordinals address, which today means a batch naming
   * its parents by id (`parentIds`).
   */
  ordinalsPublicKey?: string;
}

/** I/O the orchestrator delegates to the consumer's infra — all plain async. */
export interface InscribeOrchestratorDeps {
  /** Spendable UTXOs at the payment address (electrs). */
  getUtxos(paymentAddress: string): Promise<TxnOutput[]>;
  /** Content classification for the force-scan funding safety (ord + cat21-ord). */
  scan: ContentScanPort;
  /** Broadcast a signed tx hex; resolves to the txid. Called for commit AND reveal. */
  broadcast(signedTxHex: string): Promise<string>;
  network: Network;
  /**
   * The hosted `wasm/brotli_wasm_bg.wasm` (URL) or its bytes. Needed for
   * `compressProperties`, which compresses inside the synchronous builder.
   */
  brotliWasm?: BrotliWasmSource;
  /**
   * Base URL of an ord server with the JSON API, e.g.
   * `https://ord.ordpool.space`. Needed to resolve a batch's `parentIds`.
   */
  ordBaseUrl?: string;
}

/** Everything a consumer template needs, emitted on every state change. */
export interface InscribeSnapshot {
  state: InscribeMintState;
  feeRate: number | null;
  selectedUtxo: TxnOutput | null;
  content: InscribeContent | null;
  /** The batch being inscribed, when `setBatch` was used instead of `setContent`. */
  batch: InscribeBatchContent | null;
  simulations: InscribeUtxoSimulation[];
  fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
  /** The developer-facing failure text, for logs and existing error handling. */
  errorMessage: string | null;
  /**
   * The same failure written for the person inscribing, when the SDK has one
   * (every `InscribeInputError` carries one). `null` whenever `errorMessage`
   * is, and equal to it for a failure with no person-facing wording, so a
   * screen can show this and never need a fallback.
   */
  userMessage: string | null;
  successResult: InscribeAndBroadcastResult | null;
  /** Non-null while the wallet is being asked to sign; see `InscribeSigningStep`. */
  signing: InscribeSigningStep | null;
  /**
   * What `compressBody` saved, `null` when nothing is being compressed. For a
   * batch it is the total over every entry that compresses.
   */
  compression: InscribeCompression | null;
  /**
   * The coin padding a chosen sat's alignment output, `null` when the sat needs
   * no padding. Sourced by the orchestrator unless `paddingUtxo` was set.
   */
  padding: InscribePadding | null;
  /**
   * The parents a batch's `parentIds` resolved to, `null` when none were named.
   * The reveal spends each and hands it straight back.
   */
  parents: ReadonlyArray<InscribeResolvedParent> | null;
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

/**
 * Several inscriptions in one commit and reveal, ord's batch. Entries use the
 * same `source` union as a single inscription; the mode decides where each
 * lands (see `BatchInscribeMode`). With `parents`, or in `satpoints` mode, the
 * reveal spends wallet UTXOs, so the wallet signs twice.
 */
export interface InscribeBatchContent {
  mode: BatchInscribeMode;
  inscriptions: ReadonlyArray<{
    source: InscribeSource;
    contentEncoding?: InscriptionContentEncoding;
    metadata?: Uint8Array;
    metaprotocol?: string;
    title?: string;
    traits?: InscriptionPropertiesInput['traits'];
    gallery?: InscriptionPropertiesInput['gallery'];
    compressProperties?: boolean;
    /** Compress this entry's body, as on a single inscription. */
    compressBody?: boolean;
    /** Where this inscription goes; `separate-outputs` and `satpoints` only. */
    destination?: string;
    /** The wallet UTXO this inscription's sat sits on; `satpoints` mode only. */
    satpoint?: ChildRevealParent['utxo'];
  }>;
  /** Parents spent and returned by the reveal, named in every envelope. */
  parents?: ReadonlyArray<BatchParent>;
  /**
   * Parents named by inscription id; the orchestrator asks ord where each one
   * sits and builds the input itself, putting what it found on
   * `snapshot.parents`. Needs `deps.ordBaseUrl` and the wallet's
   * `ordinalsPublicKey`. Ignored when `parents` is given.
   */
  parentIds?: ReadonlyArray<string>;
  /** Postage per inscription. Default 546; not allowed in `satpoints` mode. */
  postageSats?: number;
  /** Where inscriptions without their own destination go. Defaults to the wallet's ordinals address. */
  recipient?: string;
  tip?: { address: string; value: number };
  commitFeeRatePerVbyte?: number;
  minimalTagPush?: boolean;
}

/** The builder inputs for a content's source and sat target. */
function contentInputs(content: InscribeContent): {
  body?: Uint8Array; contentType?: string; delegate?: string;
  satOffset?: number; satSource?: InscribeSatSource;
} {
  const source = content.source.kind === 'file'
    ? { body: content.source.body, contentType: content.source.contentType }
    : { delegate: content.source.delegate };
  const target = content.satTarget;
  const sat = target === undefined
    ? {}
    : target.kind === 'in-funding'
      ? { satOffset: target.offset }
      : { satSource: { ...target.utxo, offset: target.offset } };
  return { ...source, ...sat };
}

/** The batch builder's args for a wallet + fee rate. */
function batchArgs(
  batch: InscribeBatchContent,
  wallet: InscribeWalletContext,
  feeRate: number,
  network: Network,
  paymentOutput: TxnOutput,
): CreateBatchInscribeTransactionsArgs & { parents: ReadonlyArray<BatchParent> } {
  return {
    mode: batch.mode,
    inscriptions: batch.inscriptions.map(entry => ({
      ...entry,
      ...contentInputs({ source: entry.source } as InscribeContent),
    })),
    parents: batch.parents ?? [],
    postageSats: batch.postageSats,
    recipientAddress: batch.recipient ?? wallet.ordinalsAddress,
    paymentOutput,
    paymentPublicKey: hex.decode(wallet.paymentPublicKey),
    paymentAddress: wallet.paymentAddress,
    feeRatePerVbyte: feeRate,
    commitFeeRatePerVbyte: batch.commitFeeRatePerVbyte,
    tip: batch.tip,
    minimalTagPush: batch.minimalTagPush,
    walletType: wallet.type,
    network,
  };
}

/** Deterministic dummy x-only pubkey — only sizes the envelope (all 32-byte keys equal). */
const DUMMY_PUBKEY_XONLY = new Uint8Array(32).fill(0x02);

export class InscribeMintOrchestrator {
  private wallet: InscribeWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  // Monotonic guard: a setter/wallet-change bumps this; an in-flight async
  // recompute whose captured seq is stale drops its result instead of
  // overwriting a newer snapshot (the plain-class replacement for switchMap).
  private recomputeSeq = 0;
  // Compressing is the expensive step, so each body's result is kept until the
  // body itself goes away: recompute runs on every fee-rate change and mint
  // needs the exact bytes the preview priced.
  private readonly compressedBodies = new WeakMap<Uint8Array, Map<string, OrdCompressedBody>>();
  // Classifying a coin is a network round trip, and recompute runs on every
  // fee-rate change, so each verdict is kept for the session.
  private readonly scanVerdicts = new Map<string, boolean>();
  private readonly resolvedParents = new Map<string, BatchParent>();
  private snap: InscribeSnapshot = {
    state: 'idle',
    feeRate: null,
    selectedUtxo: null,
    content: null,
    batch: null,
    simulations: [],
    fundingRecommendation: EMPTY_RECOMMENDATION,
    errorMessage: null,
    userMessage: null,
    successResult: null,
    signing: null,
    compression: null,
    padding: null,
    parents: null,
  };
  private readonly listeners = new Set<(s: InscribeSnapshot) => void>();

  constructor(private readonly deps: InscribeOrchestratorDeps) {}

  getSnapshot(): InscribeSnapshot {
    return this.snap;
  }

  /**
   * Subscribe to snapshot changes. Fires immediately with the current snapshot,
   * then on every change. Returns an unsubscribe fn — bind in one line.
   */
  subscribe(listener: (s: InscribeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snap);
    return () => this.listeners.delete(listener);
  }

  /** Set (or clear) the connected wallet. On a genuine change, resets + refetches. */
  async setWallet(wallet: InscribeWalletContext | null): Promise<void> {
    const changed = (this.wallet?.ordinalsAddress ?? null) !== (wallet?.ordinalsAddress ?? null);
    this.wallet = wallet;
    this.recomputeSeq++; // invalidate any in-flight recompute from the old wallet
    if (changed) {
      this.patch({ feeRate: null, selectedUtxo: null, content: null, batch: null, errorMessage: null, userMessage: null, successResult: null, compression: null, padding: null, parents: null });
    }
    if (!wallet) {
      this.utxos = [];
      this.patch({ state: 'idle', simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    this.patch({ state: 'loading-utxos' });
    try {
      this.utxos = await this.deps.getUtxos(wallet.paymentAddress);
      this.patch({ state: 'ready' });
    } catch (err) {
      this.utxos = [];
      const message = `Failed to load UTXOs: ${errMsg(err)}`;
      this.patch({ state: 'error', errorMessage: message, userMessage: message });
      return;
    }
    await this.recompute();
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.patch({ feeRate: rate });
    void this.recompute();
  }

  setSelectedUtxo(utxo: TxnOutput | null): void {
    this.patch({ selectedUtxo: utxo });
  }

  setContent(content: InscribeContent | null): void {
    this.patch({ content, batch: null });
    void this.recompute();
  }

  /**
   * Inscribe several at once (ord's batch) instead of one. Clears any single
   * content; `mint()` then builds the batch. With parents, or in `satpoints`
   * mode, the wallet signs twice and the snapshot's `signing` says so.
   */
  setBatch(batch: InscribeBatchContent | null): void {
    this.patch({ batch, content: null });
    void this.recompute();
  }

  /**
   * Execute the inscribe: pick (explicit override, else the safe auto-clean
   * recommendation — never an asset coin unless the user chose it), then
   * `inscribeAndBroadcast` (build commit + reveal, wallet-sign the commit's
   * single funding input, broadcast both). Watch-only wallets bridge through
   * `promptForSignedPsbt`.
   */
  async mint(
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>,
  ): Promise<InscribeAndBroadcastResult> {
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    const content = this.snap.content;
    const batch = this.snap.batch;
    const rec = this.snap.fundingRecommendation;
    const selected: TxnOutput | null =
      this.snap.selectedUtxo ?? (rec.status === 'auto' ? rec.recommended : null);

    if (!wallet) throw new Error('No wallet connected');
    if (!feeRate) throw new Error('No fee rate set');
    if (content?.satTarget?.kind === 'in-funding' && this.snap.selectedUtxo === null) {
      // The automatic pick would put the inscription on a sat of another coin.
      failInscribe('sat-utxo-must-be-selected',
        'Select the UTXO that holds the sat to inscribe onto (satOffset counts within it)',
        'Choose the coin that holds the sat you want to inscribe on; the automatic choice would use a different coin.');
    }
    if (!selected) {
      throw new Error(
        rec.status === 'expert-required'
          ? 'Select a funding UTXO (the available coins carry assets)'
          : 'No UTXO selected',
      );
    }
    if (!content && !batch) throw new Error('No inscription content set');
    if (batch) return this.mintBatch(wallet, feeRate, batch, selected, promptForSignedPsbt);
    if (!content) throw new Error('No inscription content set');
    await this.ensureBrotli(content);
    // Compressing is cached per body, so this is the same bytes the preview
    // priced rather than a second run of the encoder.
    let ready = await this.resolveCompression(content, this.recomputeSeq);
    ready = await this.resolvePadding(ready, wallet, this.recomputeSeq);

    this.patch({
      state: 'minting',
      errorMessage: null,
      successResult: null,
      signing: { step: 1, of: walletPromptsFor(ready), what: 'commit' },
    });
    try {
      const result = await firstValueFrom(
        inscribeAndBroadcast({
          walletType: wallet.type,
          paymentOutput: selected,
          paymentPublicKey: hex.decode(wallet.paymentPublicKey),
          paymentAddress: wallet.paymentAddress,
          recipientAddress: ready.recipient ?? wallet.ordinalsAddress,
          ...contentInputs(ready),
          envelopeFields: ready.envelopeFields,
          feeRatePerVbyte: feeRate,
          tip: ready.tip,
          note: ready.note,
          parent: ready.parent,
          contentEncoding: ready.contentEncoding,
          pointer: ready.pointer,
          metadata: ready.metadata,
          metaprotocol: ready.metaprotocol,
          rune: ready.rune,
          properties: ready.properties,
          propertyEncoding: ready.propertyEncoding,
          minimalTagPush: ready.minimalTagPush,
          title: ready.title,
          traits: ready.traits,
          gallery: ready.gallery,
          compressProperties: ready.compressProperties,
          postageSats: ready.postageSats,
          paddingUtxo: ready.paddingUtxo,
          commitFeeRatePerVbyte: ready.commitFeeRatePerVbyte,
          network: this.deps.network,
          broadcast: (txHex: string) => from(this.deps.broadcast(txHex)),
          promptForSignedPsbt: promptForSignedPsbt
            ? (unsigned) => from(promptForSignedPsbt(unsigned))
            : undefined,
        }),
      );
      this.patch({ state: 'success', successResult: result, signing: null });
      return result;
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err), userMessage: inscribeUserMessage(err), signing: null });
      throw err;
    }
  }

  /**
   * Build, sign and broadcast a batch. With parents, or in `satpoints` mode,
   * the wallet signs twice: the commit, then the reveal's wallet inputs; the
   * snapshot's `signing` announces each before it happens.
   */
  private async mintBatch(
    wallet: InscribeWalletContext,
    feeRate: number,
    batch: InscribeBatchContent,
    selected: TxnOutput,
    promptForSignedPsbt?: (unsigned: { base64: string; hex: string }) => Promise<string>,
  ): Promise<InscribeAndBroadcastResult> {
    const prompts = (batch.parents?.length ?? batch.parentIds?.length ?? 0) > 0 || batch.mode === 'satpoints' ? 2 : 1;
    this.patch({
      state: 'minting',
      errorMessage: null,
      successResult: null,
      signing: { step: 1, of: prompts, what: 'commit' },
    });
    try {
      await this.ensureBatchBrotli(batch);
      let ready = await this.resolveBatchCompression(batch, this.recomputeSeq);
      ready = await this.resolveBatchParents(ready, wallet, this.recomputeSeq);
      const args = batchArgs(ready, wallet, feeRate, this.deps.network, selected);
      // The commit is broadcast first; once it is out, the wallet is asked
      // for the reveal's own inputs. Marking the step there works for every
      // wallet, including those that sign without a prompt callback.
      let broadcasts = 0;
      const result = await firstValueFrom(
        inscribeBatchAndBroadcast({
          ...args,
          walletType: wallet.type,
          parents: args.parents.length > 0 ? args.parents : undefined,
          broadcast: (txHex: string) => from(this.deps.broadcast(txHex).then((txId) => {
            if (++broadcasts === 1 && prompts === 2) {
              this.patch({ signing: { step: 2, of: 2, what: revealSignatureKind(batch) } });
            }
            return txId;
          })),
          promptForSignedPsbt: promptForSignedPsbt
            ? (unsigned) => from(promptForSignedPsbt(unsigned))
            : undefined,
        }),
      );
      this.patch({ state: 'success', successResult: result, signing: null });
      return result;
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err), userMessage: inscribeUserMessage(err), signing: null });
      throw err;
    }
  }

  /** "Inscribe another" — wipe form state, keep the wallet. */
  reset(): void {
    this.patch({
      feeRate: null,
      selectedUtxo: null,
      content: null,
      batch: null,
      simulations: [],
      fundingRecommendation: EMPTY_RECOMMENDATION,
      errorMessage: null,
      userMessage: null,
      successResult: null,
      signing: null,
      compression: null,
      padding: null,
      parents: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const seq = ++this.recomputeSeq;
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    const content = this.snap.content;
    const batch = this.snap.batch;
    if (wallet && feeRate && batch && this.utxos.length > 0) {
      await this.recomputeBatch(seq, wallet, feeRate, batch);
      return;
    }
    // Content that cannot be inscribed (a malformed gallery id, a missing
    // wasm for compressProperties, ...) is reported once, instead of every
    // funding row turning up "insufficient" without a reason. Compressing
    // happens here too, so the rows price the body that will be inscribed.
    let ready = content;
    if (content) {
      try {
        await this.ensureBrotli(content);
        ready = await this.resolveCompression(content, seq);
        synthesizeEnvelopeFields({ ...ready, ...contentInputs(ready) } as unknown as CreateInscribeTransactionsArgs);
      } catch (err) {
        if (seq !== this.recomputeSeq) return;
        this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION, errorMessage: errMsg(err), userMessage: inscribeUserMessage(err) });
        return;
      }
      if (seq !== this.recomputeSeq) return;
    } else if (!batch && this.snap.compression !== null) {
      this.patch({ compression: null });
    }
    if (!wallet || !feeRate || !ready || this.utxos.length === 0) {
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    // A chosen sat may need a second coin; sourcing it changes the commit's
    // shape, so it happens before anything is priced.
    try {
      ready = await this.resolvePadding(ready, wallet, seq);
    } catch (err) {
      if (seq !== this.recomputeSeq) return;
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION, errorMessage: errMsg(err), userMessage: inscribeUserMessage(err) });
      return;
    }
    if (seq !== this.recomputeSeq) return;
    const recipient = ready.recipient ?? wallet.ordinalsAddress;
    // The padding coin is spent by this transaction, so it cannot fund it too.
    const fundingCandidates = ready.paddingUtxo === undefined
      ? this.utxos
      : this.utxos.filter((u) => !(u.txid === ready.paddingUtxo?.txid && u.vout === ready.paddingUtxo?.vout));
    if (this.snap.errorMessage !== null && this.snap.state !== 'error') this.patch({ errorMessage: null, userMessage: null });

    const simulations = fundingCandidates.map<InscribeUtxoSimulation>((utxo) => {
      try {
        const fundingInput = prepareInscribeFundingInput({
          utxo,
          paymentPublicKey,
          paymentAddress: wallet.paymentAddress,
          isSimulation: true,
          network: this.deps.network,
        });
        const simulation = simulateInscribeFees(this.simulationArgs(ready, wallet, recipient, feeRate, fundingInput));
        // The UTXO must fund the whole commit (commitOutputValueSats +
        // commitFeeSats); simulateInscribeFees reports the requirement but
        // doesn't reject. Flag unusable rows so the picker greys them out.
        const insufficient = utxo.value < simulation.fundingRequirementSats;
        return {
          utxo,
          simulation,
          insufficient,
          preview: insufficient ? null : previewOf(simulation, ready, walletPromptsFor(ready)),
        };
      } catch {
        return { utxo, simulation: null, insufficient: true, preview: null };
      }
    });

    // The funding target is the requirement against a synthetic large-value
    // input (depends on content + fee + input script type, not the coin's
    // value), so coin-selection safety is known before any coin is chosen.
    let target: number | null = null;
    try {
      const fundingInput = prepareInscribeFundingInput({
        utxo: { txid: '0'.repeat(64), vout: 0, value: 100_000_000, status: { confirmed: true } },
        paymentPublicKey,
        paymentAddress: wallet.paymentAddress,
        isSimulation: true,
        network: this.deps.network,
      });
      target = simulateInscribeFees(this.simulationArgs(ready, wallet, recipient, feeRate, fundingInput)).fundingRequirementSats;
    } catch {
      target = null;
    }

    let fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
    if (target === null) {
      fundingRecommendation = EMPTY_RECOMMENDATION;
    } else {
      try {
        // `target` already reflects the WITH-CHANGE commit fee (simulated
        // against a large synthetic funding input). Adding the change address's
        // OWN dust floor (the same one the commit builder uses, via
        // `getMinimumUtxoSize(paymentAddress)`) gives the change-headroom
        // preferred target: a real coin >= this keeps its commit change above
        // dust, so the realised commit fee-rate lands on the typed rate instead
        // of absorbing a sub-dust leftover into the fee. A hardcoded 546 would be
        // too conservative for a P2WPKH/P2TR payment address (294/330) and would
        // fall back to a dust-cliff coin that over-pays. selectFunding still
        // falls back to a tight coin when none has headroom.
        const preferredTarget = target + changeDustFloor(wallet.paymentAddress);
        fundingRecommendation = await selectFunding<TxnOutput>(
          fundingCandidates,
          target,
          this.deps.scan,
          preferredTarget,
        );
      } catch {
        fundingRecommendation = EMPTY_RECOMMENDATION;
      }
    }
    if (seq !== this.recomputeSeq) return; // a newer input superseded this run
    this.patch({ simulations, fundingRecommendation });
  }

  /** The same grid and funding pick as a single inscription, for a batch. */
  private async recomputeBatch(
    seq: number,
    wallet: InscribeWalletContext,
    feeRate: number,
    batch: InscribeBatchContent,
  ): Promise<void> {
    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    let ready = batch;
    // Parents named by id still make the reveal spend a wallet coin, so the
    // prompt count follows what resolution produced, not what was passed in.
    const promptsFor = (b: InscribeBatchContent): number =>
      (b.parents?.length ?? b.parentIds?.length ?? 0) > 0 || b.mode === 'satpoints' ? 2 : 1;
    const prompts = promptsFor(batch);
    const simulateFor = (utxo: TxnOutput): SimulateInscribeFeesResult =>
      simulateBatchInscribeFees(batchArgs(ready, wallet, feeRate, this.deps.network, utxo), {
        fundingInput: prepareInscribeFundingInput({
          utxo, paymentPublicKey, paymentAddress: wallet.paymentAddress,
          isSimulation: true, network: this.deps.network,
        }),
        senderChangeAddress: wallet.paymentAddress,
        ephemeralPubkeyXonly: DUMMY_PUBKEY_XONLY,
        changeDustLimitSats: changeDustFloor(wallet.paymentAddress),
      });

    try {
      await this.ensureBatchBrotli(batch);
      ready = await this.resolveBatchCompression(batch, seq);
      ready = await this.resolveBatchParents(ready, wallet, seq);
      simulateFor({ txid: '0'.repeat(64), vout: 0, value: 100_000_000, status: { confirmed: true } });
    } catch (err) {
      if (seq !== this.recomputeSeq) return;
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION, errorMessage: errMsg(err), userMessage: inscribeUserMessage(err) });
      return;
    }
    if (seq !== this.recomputeSeq) return;
    if (this.snap.errorMessage !== null && this.snap.state !== 'error') this.patch({ errorMessage: null, userMessage: null });

    const simulations = this.utxos.map<InscribeUtxoSimulation>((utxo) => {
      try {
        const simulation = simulateFor(utxo);
        const insufficient = utxo.value < simulation.fundingRequirementSats;
        return {
          utxo,
          simulation,
          insufficient,
          preview: insufficient ? null : previewOf(simulation, { tip: ready.tip } as InscribeContent, prompts),
        };
      } catch {
        return { utxo, simulation: null, insufficient: true, preview: null };
      }
    });

    let target: number | null = null;
    try {
      target = simulateFor({ txid: '0'.repeat(64), vout: 0, value: 100_000_000, status: { confirmed: true } })
        .fundingRequirementSats;
    } catch {
      target = null;
    }
    const fundingRecommendation = target === null
      ? EMPTY_RECOMMENDATION
      : await selectFunding<TxnOutput>(
        this.utxos, target, this.deps.scan, target + changeDustFloor(wallet.paymentAddress),
      ).catch(() => EMPTY_RECOMMENDATION);
    if (seq !== this.recomputeSeq) return;
    this.patch({ simulations, fundingRecommendation });
  }

  /**
   * The batch with its `parentIds` resolved to real inputs. Each id is looked
   * up once: a parent does not move while a batch is being priced, and
   * recompute runs on every fee-rate change.
   */
  private async resolveBatchParents(
    batch: InscribeBatchContent,
    wallet: InscribeWalletContext,
    seq: number,
  ): Promise<InscribeBatchContent> {
    const ids = batch.parents === undefined ? batch.parentIds ?? [] : [];
    if (ids.length === 0) {
      if (this.snap.parents !== null) this.patchIfCurrent(seq, { parents: null });
      return batch;
    }
    if (this.deps.ordBaseUrl === undefined) {
      failInscribe('parent-not-found',
        'resolving parentIds needs ordBaseUrl in the orchestrator deps',
        'Parent inscriptions cannot be looked up here.');
    }
    if (wallet.ordinalsPublicKey === undefined) {
      failInscribe('parent-not-owned',
        'resolving parentIds needs the wallet\'s ordinalsPublicKey',
        'Your wallet did not provide the key needed to spend the parent inscription.');
    }
    const parents: BatchParent[] = [];
    for (const id of ids) {
      let resolved = this.resolvedParents.get(id);
      if (resolved === undefined) {
        resolved = await batchParentFromInscriptionId(id, {
          ordBaseUrl: this.deps.ordBaseUrl,
          ordinalsPublicKey: wallet.ordinalsPublicKey,
          network: this.deps.network,
        });
        this.resolvedParents.set(id, resolved);
      }
      parents.push(resolved);
    }
    this.patchIfCurrent(seq, {
      parents: parents.map((p) => ({
        id: p.id,
        address: p.returnAddress,
        value: p.utxo.value,
        outpoint: `${p.utxo.txid}:${p.utxo.vout}`,
      })),
    });
    return { ...batch, parents };
  }

  /** Load the brotli wasm when any entry compresses its properties. */
  private async ensureBatchBrotli(batch: InscribeBatchContent): Promise<void> {
    if (!batch.inscriptions.some(e => e.compressProperties)) return;
    await this.ensureBrotli({ compressProperties: true } as InscribeContent);
  }

  /**
   * The fee simulation for `content` funded by `fundingInput`: the same
   * envelope fields and options the build will use (title, traits, gallery,
   * parent, metadata, delegate, pointer, postage, sat targeting, commit fee
   * rate), so the preview and the signed transaction agree.
   */
  private simulationArgs(
    content: InscribeContent,
    wallet: InscribeWalletContext,
    recipient: string,
    feeRate: number,
    fundingInput: SimulateInscribeFeesArgs['fundingInput'],
  ): SimulateInscribeFeesArgs {
    const fields = [
      ...synthesizeEnvelopeFields({ ...content, ...contentInputs(content) } as unknown as CreateInscribeTransactionsArgs),
      ...(content.envelopeFields ?? []),
    ];
    return {
      feeRatePerVbyte: feeRate,
      commitFeeRatePerVbyte: content.commitFeeRatePerVbyte,
      postageSats: content.postageSats,
      ...contentInputs(content),
      envelopeFields: fields,
      minimalTagPush: content.minimalTagPush,
      fundingInput,
      senderChangeAddress: wallet.paymentAddress,
      recipientAddress: recipient,
      ephemeralPubkeyXonly: DUMMY_PUBKEY_XONLY,
      tip: content.tip,
      walletType: wallet.type,
      paddingInput: content.paddingUtxo === undefined ? undefined : prepareInscribeFundingInput({
        utxo: content.paddingUtxo,
        paymentPublicKey: hex.decode(wallet.paymentPublicKey),
        paymentAddress: wallet.paymentAddress,
        isSimulation: true,
        network: this.deps.network,
      }),
      network: this.deps.network,
    };
  }

  /**
   * Compress a body exactly as `ord wallet inscribe --compress` does, once per
   * body and content type. The result is the original bytes when compressing
   * did not shrink them, which is ord's own rule.
   */
  private async compressOne(body: Uint8Array, contentType: string | undefined): Promise<OrdCompressedBody> {
    const key = contentType ?? '';
    let byType = this.compressedBodies.get(body);
    const hit = byType?.get(key);
    if (hit !== undefined) return hit;
    if (this.deps.brotliWasm === undefined) {
      failInscribe('brotli-wasm-missing',
        'compressBody needs the brotli wasm: pass brotliWasm in the orchestrator deps',
        'Compressing the file is not available here.');
    }
    const out = await compressLikeOrd(body, contentType, this.deps.brotliWasm);
    if (byType === undefined) {
      byType = new Map();
      this.compressedBodies.set(body, byType);
    }
    byType.set(key, out);
    return out;
  }

  /**
   * The content as it will actually be inscribed: with `compressBody` the
   * compressed bytes and the `content_encoding` that goes with them, so the
   * preview prices the same body the build writes. Also publishes the saving
   * on the snapshot.
   */
  private async resolveCompression(content: InscribeContent, seq: number): Promise<InscribeContent> {
    if (content.compressBody !== true || content.source.kind !== 'file') {
      if (this.snap.compression !== null) this.patchIfCurrent(seq, { compression: null });
      return content;
    }
    const { body, contentType } = content.source;
    const out = await this.compressOne(body, contentType);
    this.patchIfCurrent(seq, { compression: compressionOf([{ original: body.length, out }]) });
    return {
      ...content,
      source: { ...content.source, body: out.body },
      contentEncoding: out.contentEncoding ?? content.contentEncoding,
    };
  }

  /** {@link resolveCompression} per entry; the snapshot carries the totals. */
  private async resolveBatchCompression(batch: InscribeBatchContent, seq: number): Promise<InscribeBatchContent> {
    if (!batch.inscriptions.some(e => e.compressBody === true && e.source.kind === 'file')) {
      if (this.snap.compression !== null) this.patchIfCurrent(seq, { compression: null });
      return batch;
    }
    const saved: Array<{ original: number; out: OrdCompressedBody }> = [];
    const inscriptions = [];
    for (const entry of batch.inscriptions) {
      if (entry.compressBody !== true || entry.source.kind !== 'file') {
        inscriptions.push(entry);
        continue;
      }
      const out = await this.compressOne(entry.source.body, entry.source.contentType);
      saved.push({ original: entry.source.body.length, out });
      inscriptions.push({
        ...entry,
        source: { ...entry.source, body: out.body },
        contentEncoding: out.contentEncoding ?? entry.contentEncoding,
      });
    }
    this.patchIfCurrent(seq, { compression: compressionOf(saved) });
    return { ...batch, inscriptions };
  }

  /**
   * The content as it will be inscribed, with a padding coin when the chosen
   * sat needs one and none was supplied. The coin is spent, so only coins the
   * content scan calls clean are eligible, exactly as the funding pick demands;
   * a coin the scan cannot reach is left alone rather than risked.
   *
   * Throws when the sat needs padding and nothing covers it, so the reason
   * reaches the screen instead of every funding row reading "insufficient".
   */
  private async resolvePadding(content: InscribeContent, wallet: InscribeWalletContext, seq: number): Promise<InscribeContent> {
    const target = content.satTarget;
    if (target === undefined) {
      if (this.snap.padding !== null) this.patchIfCurrent(seq, { padding: null });
      return content;
    }
    const paddingAddress = target.kind === 'in-utxo' ? target.utxo.address : wallet.paymentAddress;

    if (content.paddingUtxo !== undefined) {
      const chosen = selectPaddingUtxo([content.paddingUtxo], { satOffset: target.offset, paddingAddress });
      if (chosen.kind === 'not-needed') {
        this.patch({ padding: null });
        failInscribe('padding-not-needed',
          `a padding coin was given for a sat at offset ${target.offset}, which needs none`,
          'This sat does not need a second coin: it sits far enough into its own coin.',
          { satOffset: target.offset });
      }
      if (chosen.kind === 'none-covers') {
        this.patch({ padding: null });
        failInscribe('sat-offset-needs-padding',
          `the given padding coin holds ${content.paddingUtxo.value} sats, short of the ${chosen.shortfallSats} needed`,
          `The coin you chose to pad with is too small: it needs to hold at least ${chosen.shortfallSats} sats.`,
          { shortfallSats: chosen.shortfallSats, satOffset: target.offset });
      }
      this.patchIfCurrent(seq, { padding: { utxo: content.paddingUtxo, shortfallSats: chosen.shortfallSats, automatic: false } });
      return content;
    }

    // Coins this transaction already spends cannot pad it as well.
    const excludeOutpoints = [
      ...(target.kind === 'in-utxo' ? [`${target.utxo.txid}:${target.utxo.vout}`] : []),
      ...(this.snap.selectedUtxo ? [`${this.snap.selectedUtxo.txid}:${this.snap.selectedUtxo.vout}`] : []),
    ];
    const needed = selectPaddingUtxo(this.utxos, { satOffset: target.offset, paddingAddress, excludeOutpoints });
    if (needed.kind === 'not-needed') {
      if (this.snap.padding !== null) this.patchIfCurrent(seq, { padding: null });
      return content;
    }

    const clean = await this.cleanCoins(this.utxos, excludeOutpoints);
    const picked = selectPaddingUtxo(clean, { satOffset: target.offset, paddingAddress, excludeOutpoints });
    if (picked.kind !== 'selected') {
      this.patch({ padding: null });
      failInscribe('no-padding-coin-available',
        `the chosen sat needs a padding input of at least ${needed.shortfallSats} sats and no spendable coin covers it`,
        `This sat sits ${target.offset} sats into its coin, so it needs a second coin of at least ${needed.shortfallSats} sats to go with it, and none of your coins can be used for that.`,
        { shortfallSats: needed.shortfallSats, satOffset: target.offset });
    }
    this.patchIfCurrent(seq, { padding: { utxo: picked.utxo, shortfallSats: picked.shortfallSats, automatic: true } });
    return { ...content, paddingUtxo: picked.utxo };
  }

  /** The coins the content scan calls clean; a coin it cannot reach is not one. */
  private async cleanCoins(utxos: ReadonlyArray<TxnOutput>, exclude: ReadonlyArray<string>): Promise<TxnOutput[]> {
    const excluded = new Set(exclude);
    const eligible = utxos.filter((u) => !excluded.has(`${u.txid}:${u.vout}`));
    await Promise.all(eligible.map(async (u) => {
      const outpoint = `${u.txid}:${u.vout}`;
      if (this.scanVerdicts.has(outpoint)) return;
      try {
        this.scanVerdicts.set(outpoint, (await this.deps.scan.classify(outpoint)) === 'clean');
      } catch {
        this.scanVerdicts.set(outpoint, false);
      }
    }));
    return eligible.filter((u) => this.scanVerdicts.get(`${u.txid}:${u.vout}`) === true);
  }

  /** Load the brotli wasm when the content compresses its properties. */
  private async ensureBrotli(content: InscribeContent): Promise<void> {
    if (!content.compressProperties) return;
    if (this.deps.brotliWasm === undefined) {
      failInscribe('brotli-wasm-missing',
        'compressProperties needs the brotli wasm: pass brotliWasm in the orchestrator deps',
        'Compressing the title, traits and gallery is not available here.');
    }
    await loadBrotliWasm(this.deps.brotliWasm);
  }

  /**
   * Patch only while this recompute is still the current one. An older run
   * finishing after a newer one would otherwise publish a result for inputs
   * the user has already changed.
   */
  private patchIfCurrent(seq: number, next: Partial<InscribeSnapshot>): void {
    if (seq !== this.recomputeSeq) return;
    this.patch(next);
  }

  private patch(next: Partial<InscribeSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l(this.snap);
  }
}

/**
 * How many wallet prompts this content needs. One for the commit today; a
 * reveal that spends parents or chosen-sat coins adds a second, and that
 * shape reaches the orchestrator with batch support.
 */
function walletPromptsFor(_content: InscribeContent): number {
  return 1;
}

/** Which reveal inputs the wallet signs in the second prompt of a batch. */
function revealSignatureKind(batch: InscribeBatchContent): InscribeSigningStep['what'] {
  const hasParents = (batch.parents?.length ?? batch.parentIds?.length ?? 0) > 0;
  const hasSatpoints = batch.mode === 'satpoints';
  if (hasParents && hasSatpoints) return 'parent-and-satpoint-inputs';
  return hasParents ? 'parent-inputs' : 'satpoint-inputs';
}

/** The saving over every body that was compressed. */
function compressionOf(bodies: ReadonlyArray<{ original: number; out: OrdCompressedBody }>): InscribeCompression {
  let originalSize = 0;
  let compressedSize = 0;
  let anyCompressed = false;
  for (const { original, out } of bodies) {
    originalSize += original;
    compressedSize += out.body.length;
    if (out.contentEncoding !== undefined) anyCompressed = true;
  }
  return {
    originalSize,
    compressedSize,
    savedBytes: originalSize - compressedSize,
    contentEncoding: anyCompressed ? 'br' : null,
  };
}

/** The screen-facing figures of one simulated funding coin. */
function previewOf(sim: SimulateInscribeFeesResult, content: InscribeContent, walletPrompts = 1): InscribePreview {
  const postageSats = sim.commitOutputValueSats - sim.revealFeeSats - (content.tip?.value ?? 0);
  return {
    commitVsize: sim.commitVsize,
    commitFeeSats: sim.commitFeeSats,
    revealVsize: sim.revealVsize,
    revealFeeSats: sim.revealFeeSats,
    totalFeeSats: sim.totalFeeSats,
    postageSats,
    fundingRequirementSats: sim.fundingRequirementSats,
    totalSpentSats: sim.totalFeeSats + postageSats + (content.tip?.value ?? 0),
    walletPrompts,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
