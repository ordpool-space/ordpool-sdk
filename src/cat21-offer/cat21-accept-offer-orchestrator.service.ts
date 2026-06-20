import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { Observable, Subscription, catchError, of, switchMap, tap, throwError } from 'rxjs';

import { Cat21Service } from '../cat21-mint/cat21.service';
import { Network } from '../network';
import { bitcoinNetwork } from '../network-token';
import { findSignerOrThrow } from '../wallet/signers';
import { WalletService } from '../wallet/wallet.service';
import {
  Cat21OfferValidation,
  Cat21OfferValidationResult,
} from './cat21-offer.types';
import { validateCat21BuyOfferPsbt } from './cat21-offer.helper';

/**
 * The seller's view of a pasted offer PSBT after validation. Carries
 * the parsed details a UI surfaces in a "is this what you want to
 * accept?" panel before the user signs.
 */
export interface ParsedOffer {
  /** Raw bytes of the (still buyer-signed-only) PSBT. */
  psbtBytes: Uint8Array;
  /** Cat being sold (txid:vout — sat 0 of this UTXO is the cat sat). */
  catUtxo: { txid: string; vout: number };
  /** Buyer's payout — sats arriving at the seller's address. */
  pricePaidSats: number;
  /** 546 cat-postage that comes back to the seller's payout output. */
  postageSats: number;
}

/**
 * State machine for the seller-side accept-offer flow:
 *  - `idle` — nothing pasted yet.
 *  - `parsed` — paste decoded + validated successfully; seller can review.
 *  - `invalid` — paste decoded but failed validation (wrong cat, low price, missing sig).
 *  - `accepting` — wallet signing input 0; broadcast in flight.
 *  - `success` — broadcast OK; `successTxId` holds the txid.
 *  - `error` — something failed mid-accept; `errorMessage` holds the reason.
 */
export type AcceptOfferState =
  | 'idle'
  | 'parsed'
  | 'invalid'
  | 'accepting'
  | 'success'
  | 'error';

/**
 * Seller-side CAT-21 buy-offer accept. Pastes a base64 PSBT, validates
 * (right cat / right price / right address / sniping-proof shape),
 * lets the seller sign input 0, broadcasts.
 *
 * Validation uses `validateCat21BuyOfferPsbt` from the helper layer —
 * the seller's UI never reimplements protocol invariants.
 */
@Injectable({ providedIn: 'root' })
export class Cat21AcceptOfferOrchestrator {
  private wallet = inject(WalletService);
  private cat21 = inject(Cat21Service);
  private network = inject(bitcoinNetwork);

  // --- Writable inputs ----------------------------------------------------

  /** Offer artifact pasted by the seller (base64 or hex). */
  readonly pastedOffer = signal<string | null>(null);

  /**
   * Minimum price the seller is willing to accept. The validator rejects
   * offers below this floor before any signing happens. UI typically
   * shows the floor next to the price and warns when a paste falls below.
   */
  readonly floorPriceSats = signal<number>(0);

  /**
   * The cat the seller is selling (txid + vout). When set, validation
   * checks input 0 against this UTXO and rejects offers for the wrong
   * cat. UI typically derives this from the seller's selected cat-to-sell.
   */
  readonly expectedCatUtxo = signal<{ txid: string; vout: number } | null>(null);

  /**
   * The address the seller wants the payment to land at. When set,
   * validation rejects offers whose Output 1 (seller payment) doesn't
   * decode to this exact address. Strongly recommended; matches
   * `validateCat21BuyOfferPsbt`'s `expectedSellerPaymentAddress` arg.
   */
  readonly expectedSellerPaymentAddress = signal<string | null>(null);

  // --- Output state -------------------------------------------------------

  readonly state = signal<AcceptOfferState>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly successTxId = signal<string | null>(null);

  /** Parsed + validated offer (set only when validation succeeds). */
  readonly parsedOffer = signal<ParsedOffer | null>(null);

  /**
   * Latest validation result (success or failure). Surfaces the typed
   * rejection reason in the UI without re-parsing.
   */
  readonly validationResult = signal<Cat21OfferValidation | null>(null);

  readonly connectedWallet = toSignal(this.wallet.connectedWallet$, { initialValue: null });

  readonly canAccept = computed(() => this.state() === 'parsed' && !!this.connectedWallet());

  // --- Setup --------------------------------------------------------------

  private lastWalletAddress: string | null = null;

  /**
   * Auto-reset paste + parse state when the wallet's ordinals address
   * actually changes. Field-init order before any derived stream
   * (none here, but kept for symmetry with the other orchestrators).
   */
  private readonly walletChangeSub: Subscription = this.wallet.connectedWallet$.subscribe((w) => {
    if (!w) {
      if (this.lastWalletAddress !== null) this.resetFormFields();
      this.lastWalletAddress = null;
      return;
    }
    if (this.lastWalletAddress === null || this.lastWalletAddress === w.ordinalsAddress) {
      this.lastWalletAddress = w.ordinalsAddress;
      return;
    }
    this.lastWalletAddress = w.ordinalsAddress;
    this.resetFormFields();
  });

  // --- Commands -----------------------------------------------------------

  /**
   * Decode + validate the pasted offer. Sets `parsedOffer` + `validationResult`
   * + transitions `state` to `parsed` or `invalid`. Pure transition — no
   * wallet calls. Safe to call repeatedly as the user edits the paste.
   */
  setPastedOffer(paste: string | null): void {
    const trimmed = paste && paste.trim() ? paste.trim() : null;
    this.pastedOffer.set(trimmed);
    if (!trimmed) {
      this.parsedOffer.set(null);
      this.validationResult.set(null);
      this.state.set('idle');
      return;
    }

    let psbtBytes: Uint8Array;
    try {
      psbtBytes = decodePastedPsbt(trimmed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.validationResult.set({ ok: false, reason: 'missing-seller-input', detail: msg });
      this.parsedOffer.set(null);
      this.state.set('invalid');
      return;
    }

    const expectedCat = this.expectedCatUtxo();
    if (!expectedCat) {
      // Without an expected cat the validator has nothing to compare;
      // the UI is incomplete. Stay in idle until the seller selects which
      // cat they're selling.
      this.state.set('idle');
      return;
    }

    let validation: Cat21OfferValidation;
    try {
      validation = validateCat21BuyOfferPsbt({
        psbt: psbtBytes,
        expectedSellerUtxo: expectedCat,
        floorPriceSats: this.floorPriceSats(),
        expectedSellerPaymentAddress: this.expectedSellerPaymentAddress() ?? undefined,
        network: this.network as Network,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      validation = { ok: false, reason: 'missing-seller-input', detail: msg };
    }
    this.validationResult.set(validation);
    this.errorMessage.set(null);

    if (validation.ok) {
      this.parsedOffer.set({
        psbtBytes,
        catUtxo: expectedCat,
        pricePaidSats: validation.pricePaidSats,
        postageSats: validation.postageSats,
      });
      this.state.set('parsed');
    } else {
      this.parsedOffer.set(null);
      this.state.set('invalid');
    }
  }

  setFloorPriceSats(sats: number): void {
    if (!Number.isFinite(sats) || sats < 0) return;
    this.floorPriceSats.set(Math.floor(sats));
    // Re-validate against the new floor if a paste is in the box.
    const paste = this.pastedOffer();
    if (paste) this.setPastedOffer(paste);
  }

  setExpectedCatUtxo(utxo: { txid: string; vout: number } | null): void {
    this.expectedCatUtxo.set(utxo);
    const paste = this.pastedOffer();
    if (paste) this.setPastedOffer(paste);
  }

  setExpectedSellerPaymentAddress(address: string | null): void {
    this.expectedSellerPaymentAddress.set(
      address && address.trim() ? address.trim() : null,
    );
    const paste = this.pastedOffer();
    if (paste) this.setPastedOffer(paste);
  }

  /**
   * Sign input 0 (the seller's cat UTXO) at the ordinals address and
   * broadcast. Requires a validated paste (`state === 'parsed'`) and
   * a connected wallet.
   */
  acceptOffer(): Observable<{ txId: string }> {
    const wallet = this.connectedWallet();
    const offer = this.parsedOffer();
    if (!wallet) return throwError(() => new Error('No wallet connected'));
    if (!offer) return throwError(() => new Error('No validated offer to accept'));

    this.state.set('accepting');
    this.errorMessage.set(null);
    this.successTxId.set(null);

    try {
      const signer = findSignerOrThrow(wallet.type);
      return signer
        .signOfferAccept({
          psbtBytes: offer.psbtBytes,
          ordinalsAddress: wallet.ordinalsAddress,
          network: this.network,
          broadcast: (txHex) => this.cat21.postTransaction(txHex),
        })
        .pipe(
          tap(({ txId }) => {
            this.successTxId.set(txId);
            this.state.set('success');
          }),
          catchError((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.errorMessage.set(msg);
            this.state.set('error');
            return throwError(() => err);
          }),
        );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage.set(msg);
      this.state.set('error');
      return throwError(() => err);
    }
  }

  /** Wipe paste + parse result. Keeps the wallet connected. */
  reset(): void {
    this.resetFormFields();
    this.errorMessage.set(null);
    this.successTxId.set(null);
    this.state.set('idle');
  }

  // --- Internals ----------------------------------------------------------

  private resetFormFields(): void {
    this.pastedOffer.set(null);
    this.parsedOffer.set(null);
    this.validationResult.set(null);
    this.floorPriceSats.set(0);
    this.expectedCatUtxo.set(null);
    this.expectedSellerPaymentAddress.set(null);
  }
}

/**
 * Decode a base64- or hex-encoded PSBT to raw bytes. Same sniff logic
 * as `psbt-export.signer.ts` — kept duplicated here so the offer flow
 * doesn't depend on the watch-only signer module.
 */
function decodePastedPsbt(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Pasted offer is empty');
  if (trimmed.startsWith('cHNidP')) return base64.decode(trimmed);
  if (/^70736274ff/i.test(trimmed) && trimmed.length % 2 === 0) {
    return hex.decode(trimmed.toLowerCase());
  }
  throw new Error('Offer must be base64 or hex PSBT (start: "cHNidP" or "70736274ff")');
}
