import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { ContentScanPort } from '../cat21-core/ports';
import { selectFunding } from '../cat21-core/select-funding';
import { changeDustFloor } from '../cat21-script/address-format';
import { AnnotatedFundingUtxo, FundingRecommendation } from '../cat21-fee/funding-safety';
import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import type { InscriptionContentEncoding } from './inscribe-compression.helper';
import { loadBrotliWasm, type BrotliWasmSource } from './brotli-wasm-encoder';
import type { InscribeSatSource } from './inscription-commit.helper';
import { OrdEnvelopeField } from './inscription-envelope';
import { SimulateInscribeFeesArgs, SimulateInscribeFeesResult, simulateInscribeFees } from './inscription-fee.helper';
import type { InscriptionPropertiesInput } from './inscription-properties';
import { synthesizeEnvelopeFields, type CreateInscribeTransactionsArgs } from './inscription.service.helper';
import { prepareInscribeFundingInput } from './inscription-input-adapter';
import { InscribeAndBroadcastResult, inscribeAndBroadcast } from './inscribe-orchestrator';

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
import { failInscribe } from './inscribe-errors';

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
}

/** Everything a consumer template needs, emitted on every state change. */
export interface InscribeSnapshot {
  state: InscribeMintState;
  feeRate: number | null;
  selectedUtxo: TxnOutput | null;
  content: InscribeContent | null;
  simulations: InscribeUtxoSimulation[];
  fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
  errorMessage: string | null;
  successResult: InscribeAndBroadcastResult | null;
  /** Non-null while the wallet is being asked to sign; see `InscribeSigningStep`. */
  signing: InscribeSigningStep | null;
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

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

/** Deterministic dummy x-only pubkey — only sizes the envelope (all 32-byte keys equal). */
const DUMMY_PUBKEY_XONLY = new Uint8Array(32).fill(0x02);

export class InscribeMintOrchestrator {
  private wallet: InscribeWalletContext | null = null;
  private utxos: TxnOutput[] = [];
  // Monotonic guard: a setter/wallet-change bumps this; an in-flight async
  // recompute whose captured seq is stale drops its result instead of
  // overwriting a newer snapshot (the plain-class replacement for switchMap).
  private recomputeSeq = 0;
  private snap: InscribeSnapshot = {
    state: 'idle',
    feeRate: null,
    selectedUtxo: null,
    content: null,
    simulations: [],
    fundingRecommendation: EMPTY_RECOMMENDATION,
    errorMessage: null,
    successResult: null,
    signing: null,
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
      this.patch({ feeRate: null, selectedUtxo: null, content: null, errorMessage: null, successResult: null });
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
      this.patch({ state: 'error', errorMessage: `Failed to load UTXOs: ${errMsg(err)}` });
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
    this.patch({ content });
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
    if (!content) throw new Error('No inscription content set');
    await this.ensureBrotli(content);

    this.patch({
      state: 'minting',
      errorMessage: null,
      successResult: null,
      signing: { step: 1, of: walletPromptsFor(content), what: 'commit' },
    });
    try {
      const result = await firstValueFrom(
        inscribeAndBroadcast({
          walletType: wallet.type,
          paymentOutput: selected,
          paymentPublicKey: hex.decode(wallet.paymentPublicKey),
          paymentAddress: wallet.paymentAddress,
          recipientAddress: content.recipient ?? wallet.ordinalsAddress,
          ...contentInputs(content),
          envelopeFields: content.envelopeFields,
          feeRatePerVbyte: feeRate,
          tip: content.tip,
          note: content.note,
          parent: content.parent,
          contentEncoding: content.contentEncoding,
          pointer: content.pointer,
          metadata: content.metadata,
          metaprotocol: content.metaprotocol,
          rune: content.rune,
          properties: content.properties,
          propertyEncoding: content.propertyEncoding,
          minimalTagPush: content.minimalTagPush,
          title: content.title,
          traits: content.traits,
          gallery: content.gallery,
          compressProperties: content.compressProperties,
          postageSats: content.postageSats,
          paddingUtxo: content.paddingUtxo,
          commitFeeRatePerVbyte: content.commitFeeRatePerVbyte,
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
      this.patch({ state: 'error', errorMessage: errMsg(err), signing: null });
      throw err;
    }
  }

  /** "Inscribe another" — wipe form state, keep the wallet. */
  reset(): void {
    this.patch({
      feeRate: null,
      selectedUtxo: null,
      content: null,
      simulations: [],
      fundingRecommendation: EMPTY_RECOMMENDATION,
      errorMessage: null,
      successResult: null,
      signing: null,
      state: this.wallet ? 'ready' : 'idle',
    });
  }

  // --- internals ----------------------------------------------------------

  private async recompute(): Promise<void> {
    const seq = ++this.recomputeSeq;
    const wallet = this.wallet;
    const feeRate = this.snap.feeRate;
    const content = this.snap.content;
    if (!wallet || !feeRate || !content || this.utxos.length === 0) {
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION });
      return;
    }
    const paymentPublicKey = hex.decode(wallet.paymentPublicKey);
    const recipient = content.recipient ?? wallet.ordinalsAddress;
    // Content that cannot be inscribed (a malformed gallery id, a missing
    // wasm for compressProperties, ...) is reported once, instead of every
    // funding row turning up "insufficient" without a reason.
    try {
      await this.ensureBrotli(content);
      synthesizeEnvelopeFields({ ...content, ...contentInputs(content) } as unknown as CreateInscribeTransactionsArgs);
    } catch (err) {
      if (seq !== this.recomputeSeq) return;
      this.patch({ simulations: [], fundingRecommendation: EMPTY_RECOMMENDATION, errorMessage: errMsg(err) });
      return;
    }
    if (seq !== this.recomputeSeq) return;
    if (this.snap.errorMessage !== null && this.snap.state !== 'error') this.patch({ errorMessage: null });

    const simulations = this.utxos.map<InscribeUtxoSimulation>((utxo) => {
      try {
        const fundingInput = prepareInscribeFundingInput({
          utxo,
          paymentPublicKey,
          paymentAddress: wallet.paymentAddress,
          isSimulation: true,
          network: this.deps.network,
        });
        const simulation = simulateInscribeFees(this.simulationArgs(content, wallet, recipient, feeRate, fundingInput));
        // The UTXO must fund the whole commit (commitOutputValueSats +
        // commitFeeSats); simulateInscribeFees reports the requirement but
        // doesn't reject. Flag unusable rows so the picker greys them out.
        const insufficient = utxo.value < simulation.fundingRequirementSats;
        return {
          utxo,
          simulation,
          insufficient,
          preview: insufficient ? null : previewOf(simulation, content),
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
      target = simulateInscribeFees(this.simulationArgs(content, wallet, recipient, feeRate, fundingInput)).fundingRequirementSats;
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
          this.utxos,
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

/** The screen-facing figures of one simulated funding coin. */
function previewOf(sim: SimulateInscribeFeesResult, content: InscribeContent): InscribePreview {
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
    walletPrompts: walletPromptsFor(content),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
