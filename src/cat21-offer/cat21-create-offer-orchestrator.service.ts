import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { base64, hex } from '@scure/base';
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
import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { twoPassFeeSimulation } from '../cat21-fee/fee-simulation.helper';
import { Cat21Service } from '../cat21-mint/cat21.service';
import { RecommendedFees, TxnOutput } from '../cat21-mint/cat21.service.types';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { CatOutpoint } from '../cat21-share/cat-outpoint';
import { Network, toScureNetwork } from '../network';
import { bitcoinNetwork } from '../network-token';
import { PaymentAddress } from '../wallet/address-types';
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
export interface BuyOfferTargetCat extends CatOutpoint {
  catNumber: number;
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
  readonly sellerPaymentAddress = signal<PaymentAddress | null>(null);

  /** Sats the buyer offers (this is the "ask" the seller's eventual payout output carries — `priceSats + CAT21_POSTAGE_SATS`). */
  readonly priceSats = signal<number | null>(null);

  /** Where the cat lands after the seller signs + broadcasts. Default = connected wallet's ordinals address. */
  readonly buyerReceiveAddress = signal<string | null>(null);

  readonly feeRate = signal<number | null>(null);

  /**
   * User's explicit funding-UTXO pick from the buyer-side picker.
   * When null the orchestrator auto-picks the largest covering UTXO.
   * Set from the UI so the buyer can reject an asset-carrying UTXO
   * (inscription / rune / cat / rare sat) the auto-picker would
   * happily spend.
   */
  readonly selectedFundingUtxo = signal<TxnOutput | null>(null);

  // --- Internals (declared above derived streams to control field-init order) ---
  private lastWalletAddress: string | null = null;
  private readonly priceSatsSubject = new BehaviorSubject<number | null>(null);
  private readonly feeRateSubject = new BehaviorSubject<number | null>(null);
  private readonly selectedFundingUtxoSubject = new BehaviorSubject<TxnOutput | null>(null);
  // Subject mirrors of the target/seller/buyer-receive signals. The buy-offer
  // fee depends on all three (the seller cat input's script, the seller
  // payout output's script, and the buyer receive output's script all change
  // the vsize), so simulation$ must re-fire when any change. BehaviorSubject
  // (not toObservable) for the same plain-Injector reason as the other mirrors.
  private readonly targetCatSubject = new BehaviorSubject<BuyOfferTargetCat | null>(null);
  private readonly sellerPaymentAddressSubject = new BehaviorSubject<PaymentAddress | null>(null);
  private readonly buyerReceiveAddressSubject = new BehaviorSubject<string | null>(null);

  /** Write-through: keep each signal and its RxJS-mirror subject in lockstep. */
  private writeTargetCat(v: BuyOfferTargetCat | null): void {
    this.targetCat.set(v);
    this.targetCatSubject.next(v);
  }
  private writeSellerPaymentAddress(v: PaymentAddress | null): void {
    this.sellerPaymentAddress.set(v);
    this.sellerPaymentAddressSubject.next(v);
  }
  private writeBuyerReceiveAddress(v: string | null): void {
    this.buyerReceiveAddress.set(v);
    this.buyerReceiveAddressSubject.next(v);
  }

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
      if (!this.buyerReceiveAddress()) this.writeBuyerReceiveAddress(w.ordinalsAddress);
      return;
    }
    this.lastWalletAddress = w.ordinalsAddress;
    this.resetFormFields();
    this.writeBuyerReceiveAddress(w.ordinalsAddress);
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
    this.selectedFundingUtxoSubject,
    this.targetCatSubject,
    this.sellerPaymentAddressSubject,
    this.buyerReceiveAddressSubject,
  ]).pipe(
    // computeSimulation reads target/seller/buyerReceive from their signals
    // (written in lockstep with the subjects above); the extra sources are
    // present to RE-FIRE the stream when any of them change.
    map(([fundingUtxos, wallet, priceSats, feeRate, selected]) =>
      this.computeSimulation(fundingUtxos, wallet, priceSats, feeRate, selected),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // --- Commands -----------------------------------------------------------

  setTargetCat(cat: BuyOfferTargetCat | null): void {
    this.writeTargetCat(cat);
  }

  /**
   * Set the seller's PAYMENT address (where sale proceeds land). The
   * branded `PaymentAddress` type makes the "is this really a payment
   * address, not an ordinals one?" question un-skippable at every
   * callsite — either the value came from `parseBuyOfferQueryParams`
   * (which brands the URL `payTo=` param at ingress) or the caller
   * used `toPaymentAddress()` on a raw string. See SDK HARD RULE
   * "Never derive a payment address from an on-chain lookup".
   */
  setSellerPaymentAddress(address: PaymentAddress | null): void {
    this.writeSellerPaymentAddress(address);
  }

  setPriceSats(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const floored = Math.floor(price);
    this.priceSats.set(floored);
    this.priceSatsSubject.next(floored);
  }

  setBuyerReceiveAddress(address: string | null): void {
    this.writeBuyerReceiveAddress(address && address.trim() ? address.trim() : null);
  }

  setFeeRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.feeRate.set(rate);
    this.feeRateSubject.next(rate);
  }

  /**
   * Push the buyer's funding-UTXO pick (or null to auto-pick). Called
   * from the picker UI whenever the buyer clicks a row in the
   * scanner-annotated funding list.
   */
  setSelectedFundingUtxo(utxo: TxnOutput | null): void {
    this.selectedFundingUtxo.set(utxo);
    this.selectedFundingUtxoSubject.next(utxo);
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

    const sim = this.computeSimulation(
      this.lastFundingUtxosSnapshot,
      wallet,
      priceSats,
      feeRate,
      this.selectedFundingUtxo(),
    );
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
      this.writeBuyerReceiveAddress(w.ordinalsAddress);
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
    this.writeTargetCat(null);
    this.writeSellerPaymentAddress(null);
    this.priceSats.set(null);
    this.priceSatsSubject.next(null);
    // Don't clear buyerReceiveAddress here — the walletChangeSub
    // restores it to the new wallet's ordinals address anyway.
    this.feeRate.set(null);
    this.feeRateSubject.next(null);
    this.selectedFundingUtxo.set(null);
    this.selectedFundingUtxoSubject.next(null);
  }

  private computeSimulation(
    fundingUtxos: TxnOutput[],
    wallet: WalletInfo | null,
    priceSats: number | null,
    feeRate: number | null,
    selected: TxnOutput | null = null,
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
    // Buyer's explicit pick wins when still in the list AND covers.
    // Fallback to auto-pick for the pre-picker path.
    const selectedStillPresent = selected
      ? fundingUtxos.find((u) => u.txid === selected.txid && u.vout === selected.vout)
      : undefined;
    const pick = selectedStillPresent && selectedStillPresent.value >= targetSpend
      ? selectedStillPresent
      : pickLargestFundingUtxoThatCovers<TxnOutput & FundingUtxo>({
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
      // The pre-pick used a 220 vB fee ceiling; twoPassFeeSimulation
      // may return a higher `finalFeeSats` for wider inputs (multi-
      // input P2SH-P2WPKH, legacy). If the real total-in doesn't
      // cover the real requirement, surface insufficient EXPLICITLY
      // rather than silently clamping change to 0 and letting the
      // build step throw at sign time. The UI's "insufficient"
      // branch renders a clear message; the raw-error path did not.
      if (totalIn < requiredOut) {
        return { simulation: null, insufficient: true };
      }
      const changeSats = totalIn - requiredOut;
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
      walletType: wallet.type,
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
    // Input 0 is the seller's cat UTXO — they sign it later, so we
    // tell computePsbtVsize to fake a taproot key-path witness there
    // instead of trying to sign with our dummy key.
    return {
      vsize: computePsbtVsize({
        psbt: built.psbt,
        network: toScureNetwork(this.network as Network),
        nonSignableInputs: [0],
      }),
    };
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
      walletType: wallet.type,
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
