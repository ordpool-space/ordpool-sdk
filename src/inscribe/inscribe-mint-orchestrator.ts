import { firstValueFrom, from } from 'rxjs';
import { hex } from '@scure/base';

import { ContentScanPort } from '../cat21-core/ports';
import { selectFunding } from '../cat21-core/select-funding';
import { AnnotatedFundingUtxo, FundingRecommendation } from '../cat21-fee/funding-safety';
import { Network } from '../network';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import type { InscriptionContentEncoding } from './inscribe-compression.helper';
import { OrdEnvelopeField } from './inscription-envelope';
import { SimulateInscribeFeesResult, simulateInscribeFees } from './inscription-fee.helper';
import { prepareInscribeFundingInput } from './inscription-input-adapter';
import { InscribeAndBroadcastResult, inscribeAndBroadcast } from './inscribe-orchestrator';

/**
 * FRAMEWORK-AGNOSTIC high-level inscribe API. Plain class — no Angular, no
 * `@Injectable`, no signals. Sibling of `Cat21MintOrchestrator`: the SDK owns
 * this orchestration; a consumer IMPORTS it ready-made and binds its
 * `subscribe(listener)` callback to whatever reactivity it uses in ONE line.
 * The orchestrator wires wallet-backed commit signing internally (the signer
 * registry, via `inscribeAndBroadcast`) and the fee/selection logic (the shared
 * `simulateInscribeFees` + the force-scanning `selectFunding`); the consumer
 * supplies only its I/O (electrs/ord/broadcast) as `InscribeOrchestratorDeps`
 * and the connected wallet via `setWallet`.
 *
 * The Angular `InscribeMintOrchestrator`
 * (`inscribe-mint-orchestrator.service.ts`) is a parallel Angular-signal
 * implementation composing the same lower-level helpers
 * (`simulateInscribeFees` / `inscribeAndBroadcast`); it re-exports the shared
 * content/simulation/state types from this file but does not share this class.
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
export interface InscribeContent {
  body: Uint8Array;
  contentType?: string;
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
  /** Delegate inscription id (tag 0x0b); ord serves the delegate's content. */
  delegate?: string;
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
}

const EMPTY_RECOMMENDATION: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo> = {
  status: 'insufficient',
  recommended: null,
  candidates: [],
};

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
    if (!selected) {
      throw new Error(
        rec.status === 'expert-required'
          ? 'Select a funding UTXO (the available coins carry assets)'
          : 'No UTXO selected',
      );
    }
    if (!content) throw new Error('No inscription content set');

    this.patch({ state: 'minting', errorMessage: null, successResult: null });
    try {
      const result = await firstValueFrom(
        inscribeAndBroadcast({
          walletType: wallet.type,
          paymentOutput: selected,
          paymentPublicKey: hex.decode(wallet.paymentPublicKey),
          paymentAddress: wallet.paymentAddress,
          recipientAddress: content.recipient ?? wallet.ordinalsAddress,
          body: content.body,
          contentType: content.contentType,
          envelopeFields: content.envelopeFields,
          feeRatePerVbyte: feeRate,
          tip: content.tip,
          note: content.note,
          parent: content.parent,
          contentEncoding: content.contentEncoding,
          pointer: content.pointer,
          metadata: content.metadata,
          metaprotocol: content.metaprotocol,
          delegate: content.delegate,
          rune: content.rune,
          properties: content.properties,
          propertyEncoding: content.propertyEncoding,
          minimalTagPush: content.minimalTagPush,
          network: this.deps.network,
          broadcast: (txHex: string) => from(this.deps.broadcast(txHex)),
          promptForSignedPsbt: promptForSignedPsbt
            ? (unsigned) => from(promptForSignedPsbt(unsigned))
            : undefined,
        }),
      );
      this.patch({ state: 'success', successResult: result });
      return result;
    } catch (err) {
      this.patch({ state: 'error', errorMessage: errMsg(err) });
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

    const simulations = this.utxos.map<InscribeUtxoSimulation>((utxo) => {
      try {
        const fundingInput = prepareInscribeFundingInput({
          utxo,
          paymentPublicKey,
          paymentAddress: wallet.paymentAddress,
          isSimulation: true,
          network: this.deps.network,
        });
        const simulation = simulateInscribeFees({
          feeRatePerVbyte: feeRate,
          body: content.body,
          contentType: content.contentType,
          envelopeFields: content.envelopeFields,
          minimalTagPush: content.minimalTagPush,
          fundingInput,
          senderChangeAddress: wallet.paymentAddress,
          recipientAddress: recipient,
          ephemeralPubkeyXonly: DUMMY_PUBKEY_XONLY,
          tip: content.tip,
          walletType: wallet.type,
          network: this.deps.network,
        });
        // The UTXO must fund the whole commit (commitOutputValueSats +
        // commitFeeSats); simulateInscribeFees reports the requirement but
        // doesn't reject. Flag unusable rows so the picker greys them out.
        return { utxo, simulation, insufficient: utxo.value < simulation.fundingRequirementSats };
      } catch {
        return { utxo, simulation: null, insufficient: true };
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
      target = simulateInscribeFees({
        feeRatePerVbyte: feeRate,
        body: content.body,
        contentType: content.contentType,
        envelopeFields: content.envelopeFields,
        minimalTagPush: content.minimalTagPush,
        fundingInput,
        senderChangeAddress: wallet.paymentAddress,
        recipientAddress: recipient,
        ephemeralPubkeyXonly: DUMMY_PUBKEY_XONLY,
        tip: content.tip,
        walletType: wallet.type,
        network: this.deps.network,
      }).fundingRequirementSats;
    } catch {
      target = null;
    }

    let fundingRecommendation: FundingRecommendation<TxnOutput & AnnotatedFundingUtxo>;
    if (target === null) {
      fundingRecommendation = EMPTY_RECOMMENDATION;
    } else {
      try {
        // `target` already reflects the WITH-CHANGE commit fee (simulated
        // against a large synthetic funding input). Adding the 546-sat dust
        // floor gives the change-headroom preferred target: a real coin >= this
        // keeps its commit change above dust, so the realised commit fee-rate
        // lands on the typed rate instead of absorbing a sub-dust leftover into
        // the fee. selectFunding falls back to a tight coin when none has
        // headroom (bounded over-pay, never a false insufficient).
        const preferredTarget = target + 546;
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

  private patch(next: Partial<InscribeSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l(this.snap);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
