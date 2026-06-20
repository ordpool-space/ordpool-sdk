import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import {
  BehaviorSubject,
  Observable,
  Subscription,
  catchError,
  combineLatest,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

import {
  pickLargestFundingUtxoThatCovers,
  type FundingUtxo,
} from '../cat21-fee/coin-selection.helper';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { RecommendedFees, TxnOutput } from '../cat21-mint/cat21.service.types';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { findSignerOrThrow } from '../wallet/signers';
import { WalletService } from '../wallet/wallet.service';
import { WalletInfo } from '../wallet/wallet.service.types';
import { buildCat21BuyOfferPsbt } from './cat21-offer.helper';
import { prepareBuyOfferBuyerInput } from './cat21-offer-input-adapter';
import { Cat21OfferBuyerInput, Cat21OfferSellerInput } from './cat21-offer.types';

/**
 * What the buyer needs to know about the cat they want to bid on.
 * Caller (typically a frontend) fetches this from ord: cat number →
 * inscription → current UTXO at the seller's address.
 *
 * The PSBT pre-populates input 0's `witnessUtxo` from these bytes so
 * the seller can sign offline without a round-trip — that's the
 * "buyer-initiated, sniping-proof" property of ord-style offers.
 */
export interface BuyOfferTargetCat {
  catNumber: number;
  txid: string;
  vout: number;
  /** Always 546 sats for a CAT-21 cat UTXO; carried on the type for safety. */
  value: number;
  /** scriptPubKey of the seller's cat UTXO, raw bytes. */
  scriptPubKey: Uint8Array;
}

export interface CreateOfferSimulation {
  vsize: number;
  feeSats: number;
  changeSats: number;
  buyerFundingUtxo: TxnOutput;
}

export interface CreateOfferSimulationOutcome {
  simulation: CreateOfferSimulation | null;
  insufficient: boolean;
}

/**
 * State machine:
 *  - `idle` — no wallet connected.
 *  - `loading-utxos` — wallet just connected, fetching buyer's UTXOs.
 *  - `ready` — UTXOs loaded; form is interactive.
 *  - `signing` — user clicked Create; wallet is being asked to sign.
 *  - `success` — buyer-side signing finished; `offerArtifact()` carries
 *                the half-signed PSBT. **No broadcast** — the buyer's
 *                PSBT is incomplete (seller's input 0 stays unsigned).
 *  - `error` — something failed; `errorMessage` carries the reason.
 */
export type CreateOfferState =
  | 'idle'
  | 'loading-utxos'
  | 'ready'
  | 'signing'
  | 'success'
  | 'error';

/**
 * Buyer-side CAT-21 buy-offer construction. Produces the half-signed
 * PSBT a buyer shares with the cat's current owner.
 *
 * Per the workspace HARD RULE "Offers can be shared in the wild" the
 * artifact is NOT secret — the orchestrator emits bare base64 (and hex)
 * and the consumer is free to wrap it in any transport (URL, QR, gist).
 *
 * Per `validateCat21Operation`'s contract, all protocol invariants
 * (postage = 546, lockTime = 21, SIGHASH_ALL on every input) are
 * enforced INSIDE `buildCat21BuyOfferPsbt` — the orchestrator only
 * threads inputs and calls the builder.
 *
 * Singleton, signal-first. Mirrors Cat21TransferOrchestrator's wallet-
 * change reset semantics (wipe form on actual wallet swap; preserve
 * across BehaviorSubject re-emissions; defaults `buyerReceiveAddress`
 * to the connected wallet's ordinals address).
 */
@Injectable({ providedIn: 'root' })
export class Cat21CreateOfferOrchestrator {
  private wallet = inject(WalletService);
  private cat21 = inject(Cat21Service);
  private network = inject(bitcoinNetwork);

  // --- Writable inputs ----------------------------------------------------

  /** Which cat the buyer wants to bid on. */
  readonly targetCat = signal<BuyOfferTargetCat | null>(null);

  /** Where the seller wants payment (their own address; usually the seller's payment address). */
  readonly sellerPaymentAddress = signal<string | null>(null);

  /** Sats the buyer offers (this is the "ask" the seller's eventual payout output carries — `priceSats + CAT21_POSTAGE_SATS`). */
  readonly priceSats = signal<number | null>(null);

  /** Where the cat lands after the seller signs + broadcasts. Default = connected wallet's ordinals address. */
  readonly buyerReceiveAddress = signal<string | null>(null);

  readonly feeRate = signal<number | null>(null);

  // --- Internals (declared above derived streams to control field-init order) ---
  private lastWalletAddress: string | null = null;
  private readonly priceSatsSubject = new BehaviorSubject<number | null>(null);
  private readonly feeRateSubject = new BehaviorSubject<number | null>(null);

  // --- Output state -------------------------------------------------------

  readonly state = signal<CreateOfferState>('idle');
  readonly errorMessage = signal<string | null>(null);

  /**
   * The half-signed buy-offer PSBT (base64 + hex). Populated by
   * `createOffer()` on success. This IS the offer artifact the buyer
   * shares with the seller.
   */
  readonly offerArtifact = signal<{ base64: string; hex: string } | null>(null);

  readonly connectedWallet = toSignal(this.wallet.connectedWallet$, { initialValue: null });
  readonly isReady = computed(() => this.state() === 'ready');

  /**
   * Auto-reset form fields when the wallet's ordinals address actually
   * changes. Field-init-order discipline as Cat21TransferOrchestrator
   * (BEFORE the derived streams below).
   */
  private readonly walletChangeSub: Subscription = this.wallet.connectedWallet$.subscribe((w) => {
    if (!w) {
      if (this.lastWalletAddress !== null) this.resetFormFields();
      this.lastWalletAddress = null;
      return;
    }
    if (this.lastWalletAddress === null || this.lastWalletAddress === w.ordinalsAddress) {
      this.lastWalletAddress = w.ordinalsAddress;
      // Default buyerReceive to the connected wallet's ordinals address.
      if (!this.buyerReceiveAddress()) this.buyerReceiveAddress.set(w.ordinalsAddress);
      return;
    }
    this.lastWalletAddress = w.ordinalsAddress;
    this.resetFormFields();
    this.buyerReceiveAddress.set(w.ordinalsAddress);
  });

  // --- Derived streams ----------------------------------------------------

  /**
   * Buyer's funding UTXOs (their payment address). The seller's cat
   * UTXO is at the seller's address — not in this list.
   */
  readonly buyerFundingUtxos$: Observable<TxnOutput[]> = this.wallet.connectedWallet$.pipe(
    startWith(null as WalletInfo | null),
    switchMap((w) => {
      if (!w) {
        this.state.set('idle');
        return of([] as TxnOutput[]);
      }
      this.state.set('loading-utxos');
      return this.cat21.getUtxos(w.paymentAddress).pipe(
        tap(() => this.state.set('ready')),
        catchError((err: unknown) => {
          this.errorMessage.set(
            `Failed to load buyer UTXOs: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.state.set('error');
          return of([] as TxnOutput[]);
        }),
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  readonly recommendedFees$: Observable<RecommendedFees> = this.cat21.recommendedFees$;

  /**
   * Two-pass fee simulation against the largest viable buyer UTXO.
   * Re-emits when target / price / funding / feeRate change.
   */
  readonly simulation$: Observable<CreateOfferSimulationOutcome> = combineLatest([
    this.buyerFundingUtxos$,
    this.wallet.connectedWallet$.pipe(startWith(null as WalletInfo | null)),
    this.priceSatsSubject,
    this.feeRateSubject,
  ]).pipe(
    map(([fundingUtxos, wallet, priceSats, feeRate]) =>
      this.computeSimulation(fundingUtxos, wallet, priceSats, feeRate),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // --- Commands -----------------------------------------------------------

  setTargetCat(cat: BuyOfferTargetCat | null): void {
    this.targetCat.set(cat);
  }

  setSellerPaymentAddress(address: string | null): void {
    this.sellerPaymentAddress.set(address && address.trim() ? address.trim() : null);
  }

  setPriceSats(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const floored = Math.floor(price);
    this.priceSats.set(floored);
    this.priceSatsSubject.next(floored);
  }

  setBuyerReceiveAddress(address: string | null): void {
    this.buyerReceiveAddress.set(address && address.trim() ? address.trim() : null);
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.feeRate.set(rate);
    this.feeRateSubject.next(rate);
  }

  /**
   * Build the buy-offer PSBT, ask the connected wallet to sign all
   * buyer inputs (1..N), and expose the result as `offerArtifact()`.
   * **Does NOT broadcast** — the offer is incomplete until the seller
   * signs input 0 in their own accept flow.
   */
  createOffer(): Observable<{ base64: string; hex: string }> {
    const wallet = this.connectedWallet();
    const target = this.targetCat();
    const sellerAddress = this.sellerPaymentAddress();
    const priceSats = this.priceSats();
    const buyerReceive = this.buyerReceiveAddress();
    const feeRate = this.feeRate();

    if (!wallet) return throwError(() => new Error('No wallet connected'));
    if (!target) return throwError(() => new Error('No target cat selected'));
    if (!sellerAddress) return throwError(() => new Error("No seller payment address"));
    if (!priceSats) return throwError(() => new Error('No price set'));
    if (!buyerReceive) return throwError(() => new Error('No buyer receive address'));
    if (!feeRate) return throwError(() => new Error('No fee rate set'));

    const sim = this.computeSimulation(this.lastFundingUtxosSnapshot, wallet, priceSats, feeRate);
    if (sim.insufficient || !sim.simulation) {
      const msg = 'Insufficient funds for buy-offer at the current price + fee rate';
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => new Error(msg));
    }
    const simulation = sim.simulation;

    this.state.set('signing');
    this.errorMessage.set(null);
    this.offerArtifact.set(null);

    let psbtBytes: Uint8Array;
    try {
      psbtBytes = this.buildOfferPsbt(wallet, target, sellerAddress, priceSats, buyerReceive, simulation);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => err);
    }

    // Buyer signs input 1+ only (their funding UTXOs at their payment
    // address). Input 0 (seller's cat) stays unsigned by design — that
    // omission IS what makes this a buy-offer artifact, not a tx.
    const signer = findSignerOrThrow(wallet.type);

    return signer
      .signOfferCreatePsbt({
        psbtBytes,
        paymentAddress: wallet.paymentAddress,
        fundingInputCount: 1,
        network: this.network,
      })
      .pipe(
        tap((signedPsbtBytes) => {
          const artifact = {
            base64: base64.encode(signedPsbtBytes),
            hex: hex.encode(signedPsbtBytes),
          };
          this.offerArtifact.set(artifact);
          this.state.set('success');
        }),
        map((signedPsbtBytes) => ({
          base64: base64.encode(signedPsbtBytes),
          hex: hex.encode(signedPsbtBytes),
        })),
        catchError((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorMessage.set(msg);
          this.state.set('error');
          return throwError(() => err);
        }),
      );
  }

  /**
   * Wipe form + result back to a fresh create-offer attempt. Keeps the
   * wallet connected; restores `buyerReceiveAddress` to the wallet's
   * ordinals address.
   */
  reset(): void {
    this.resetFormFields();
    this.errorMessage.set(null);
    this.offerArtifact.set(null);
    const w = this.connectedWallet();
    if (w) {
      this.buyerReceiveAddress.set(w.ordinalsAddress);
      this.state.set('ready');
    } else {
      this.state.set('idle');
    }
  }

  // --- Internals ----------------------------------------------------------

  private lastFundingUtxosSnapshot: TxnOutput[] = [];

  private readonly fundingUtxosSnapshotSub = this.buyerFundingUtxos$.subscribe((u) => {
    this.lastFundingUtxosSnapshot = u;
  });

  private resetFormFields(): void {
    this.targetCat.set(null);
    this.sellerPaymentAddress.set(null);
    this.priceSats.set(null);
    this.priceSatsSubject.next(null);
    // Don't clear buyerReceiveAddress here — the walletChangeSub
    // restores it to the new wallet's ordinals address anyway.
    this.feeRate.set(null);
    this.feeRateSubject.next(null);
  }

  private computeSimulation(
    fundingUtxos: TxnOutput[],
    wallet: WalletInfo | null,
    priceSats: number | null,
    feeRate: number | null,
  ): CreateOfferSimulationOutcome {
    const target = this.targetCat();
    const sellerAddress = this.sellerPaymentAddress();
    const buyerReceive = this.buyerReceiveAddress();
    if (!wallet || !priceSats || !feeRate || fundingUtxos.length === 0) {
      return { simulation: null, insufficient: false };
    }
    // Buyer must cover: priceSats (to seller) + postage (their own
    // return, 546) + fee. The cat UTXO contributes 546 sats but flows
    // through to the seller in output 1 (priceSats + postage), so it
    // doesn't reduce the buyer's funding requirement.
    const targetSpend = priceSats + CAT21_POSTAGE_SATS + Math.ceil(feeRate * 220); // ~220 vB ceiling for offer
    const pick = pickLargestFundingUtxoThatCovers<TxnOutput & FundingUtxo>({
      utxos: fundingUtxos as ReadonlyArray<TxnOutput & FundingUtxo>,
      targetSpendSats: targetSpend,
    });
    if (!pick) {
      return { simulation: null, insufficient: true };
    }

    try {
      if (!target || !sellerAddress || !buyerReceive) {
        // Form not complete — return sim only when all inputs are present.
        return { simulation: null, insufficient: false };
      }
      const { vsize, finalFeeSats } = twoPassFeeSimulation({
        simulate: (feeSats) =>
          this.simulateOffer(wallet, target, sellerAddress, priceSats, buyerReceive, pick, feeSats),
        feeRatePerVbyte: feeRate,
      });
      const totalIn = pick.value + CAT21_POSTAGE_SATS;
      const requiredOut = (priceSats + CAT21_POSTAGE_SATS) + CAT21_POSTAGE_SATS + finalFeeSats; // seller-pay + cat-postage-to-buyer + fee
      const changeSats = Math.max(0, totalIn - requiredOut);
      return {
        simulation: {
          vsize,
          feeSats: finalFeeSats,
          changeSats,
          buyerFundingUtxo: pick,
        },
        insufficient: false,
      };
    } catch {
      return { simulation: null, insufficient: true };
    }
  }

  private simulateOffer(
    wallet: WalletInfo,
    target: BuyOfferTargetCat,
    sellerAddress: string,
    priceSats: number,
    buyerReceive: string,
    buyerFunding: TxnOutput,
    feeSats: number,
  ): { vsize: number } {
    const sellerInput: Cat21OfferSellerInput = {
      txid: target.txid,
      vout: target.vout,
      value: target.value,
      scriptPubKey: target.scriptPubKey,
    };
    const buyerInput: Cat21OfferBuyerInput = prepareBuyOfferBuyerInput({
      utxo: buyerFunding,
      paymentPublicKey: hex.decode(wallet.paymentPublicKey),
      paymentAddress: wallet.paymentAddress,
      isSimulation: true,
      network: this.network as Network,
    });
    const built = buildCat21BuyOfferPsbt({
      network: this.network as Network,
      sellerInput,
      buyerInputs: [buyerInput],
      destinations: {
        buyerReceiveAddress: buyerReceive,
        sellerPaymentAddress: sellerAddress,
        buyerChangeAddress: wallet.paymentAddress,
      },
      priceSats,
      feeSats,
    });
    const tx = btc.Transaction.fromPSBT(built.psbt);
    return { vsize: tx.vsize };
  }

  private buildOfferPsbt(
    wallet: WalletInfo,
    target: BuyOfferTargetCat,
    sellerAddress: string,
    priceSats: number,
    buyerReceive: string,
    simulation: CreateOfferSimulation,
  ): Uint8Array {
    const sellerInput: Cat21OfferSellerInput = {
      txid: target.txid,
      vout: target.vout,
      value: target.value,
      scriptPubKey: target.scriptPubKey,
    };
    const buyerInput: Cat21OfferBuyerInput = prepareBuyOfferBuyerInput({
      utxo: simulation.buyerFundingUtxo,
      paymentPublicKey: hex.decode(wallet.paymentPublicKey),
      paymentAddress: wallet.paymentAddress,
      isSimulation: false,
      network: this.network as Network,
    });
    const built = buildCat21BuyOfferPsbt({
      network: this.network as Network,
      sellerInput,
      buyerInputs: [buyerInput],
      destinations: {
        buyerReceiveAddress: buyerReceive,
        sellerPaymentAddress: sellerAddress,
        buyerChangeAddress: wallet.paymentAddress,
      },
      priceSats,
      feeSats: simulation.feeSats,
    });
    return built.psbt;
  }
}
