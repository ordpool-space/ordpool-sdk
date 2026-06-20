/**
 * Harness entry point bundled by esbuild for the Xverse E2E specs
 * under `e2e/playwright/specs/`. The bundle imports the real SDK
 * connectors / signers + helpers and exposes them on `window` so
 * Playwright can drive them via `page.evaluate`.
 *
 * Nothing under here imports Angular. Connector + signer + helper
 * code is plain TS that depends on `sats-connect`, `@noble/curves`,
 * `@scure/base`, `@scure/btc-signer`. esbuild bundles all of that
 * into a single ESM file for the browser.
 */

import { firstValueFrom, of } from 'rxjs';
import { p2wpkh, p2tr } from '@scure/btc-signer';

import { xverseConnector } from '../../../src/wallet/connectors/xverse.connector';
import { unisatConnector } from '../../../src/wallet/connectors/unisat.connector';
import { leatherConnector } from '../../../src/wallet/connectors/leather.connector';
import { cat21walletConnector } from '../../../src/wallet/connectors/cat21wallet.connector';
import { wizzConnector } from '../../../src/wallet/connectors/wizz.connector';
import { okxConnector } from '../../../src/wallet/connectors/okx.connector';
import { phantomConnector } from '../../../src/wallet/connectors/phantom.connector';
import { oylConnector } from '../../../src/wallet/connectors/oyl.connector';
import { albyConnector } from '../../../src/wallet/connectors/alby.connector';
import { findSignerOrThrow } from '../../../src/wallet/signers';
import { createTransaction } from '../../../src/cat21-mint/cat21.service.helper';
import { createInscribeTransactions } from '../../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../../src/network';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';
import type { TxnOutput } from '../../../src/cat21-mint/cat21.service.types';

declare global {
  interface Window {
    ordpoolSdkHarness: {
      /**
       * Generic operation dispatcher. Builds the operation's PSBT via
       * the SDK, asks the wallet's signer for that operation
       * (`signSingleFundingInput` for mint + inscribe-commit, future
       * methods for RBF / CPFP / etc.), and returns the signed
       * wire-tx bytes. Spec broadcasts.
       *
       * Wallet-specific test quirks (cross-network-keys "tell the
       * mainnet-only wallet it's signing mainnet, hand it regtest
       * PSBT bytes" trick used by Leather / Unisat / Wizz / OKX / Oyl
       * / Phantom) are handled inside this method; specs stay
       * wallet-agnostic.
       *
       * Alby has its own build-only entry (`buildInscribePsbtForAlby`
       * + buildCat21MintPsbtForAlby`) because its public RPC is
       * structurally unreachable from the harness origin — see
       * `alby-mint-roundtrip.spec.ts` for the SW-bypass writeup.
       * Phantom mint / inscribe specs assert connect-step rejection
       * and never reach runOperation.
       */
      runOperation(input: RunOperationMintInput): Promise<RunOperationMintResult>;
      runOperation(input: RunOperationInscribeInput): Promise<RunOperationInscribeResult>;
      runOperation(input: RunOperationInput): Promise<RunOperationResult>;

      detectXverse(): boolean;
      connectXverse(network: 'mainnet' | 'testnet3' | 'testnet4' | 'regtest'): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      detectUnisat(): boolean;
      connectUnisat(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      /** Derive the bcrt1q + bcrt1p addresses from a mainnet pubkey. */
      deriveRegtestAddresses(paymentPublicKeyHex: string): {
        paymentAddress: string;
        ordinalsAddress: string;
      };
      /**
       * Subscribe to Unisat onAccountChange and capture the
       * post-change WalletInfo via re-connect. Returns a promise
       * that resolves the next time the event fires. The test
       * triggers the event by calling
       * `window.unisat.switchNetwork('mainnet'|'testnet')`.
       */
      armUnisatAccountChangeProbe(): Promise<{
        ordinalsAddress: string;
        paymentAddress: string;
        paymentPublicKey: string;
      }>;
      detectLeather(): boolean;
      connectLeather(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      detectCat21Wallet(): boolean;
      connectCat21Wallet(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      detectWizz(): boolean;
      connectWizz(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      detectOkx(): boolean;
      connectOkx(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      detectPhantom(): boolean;
      connectPhantom(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      detectOyl(): boolean;
      connectOyl(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildInscribePsbtForAlby(input: InscribeRequest): { commitPsbtHex: string; revealHex: string; commitTxid: string; revealTxid: string; ephemeralPrivKeyHex: string; ephemeralPubkeyXonlyHex: string };
      detectAlby(): boolean;
      connectAlby(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      /**
       * Alby mint — pure PSBT build (no signing). Returns the
       * unfinalized PSBT bytes the Alby spec then hands to Alby's
       * background-script signPsbt. Builds via the real SDK API
       * (`createTransaction(KnownOrdinalWalletType.alby, ...)`).
       */
      buildCat21MintPsbtForAlby(input: {
        utxo: { txid: string; vout: number; value: number };
        paymentAddress: string;
        paymentPublicKey: string;
        recipientAddress: string;
        feeSats: number;
      }): { psbtHex: string };
    };
  }
}

export interface MintRequest {
  utxo: { txid: string; vout: number; value: number };
  paymentAddress: string;
  paymentPublicKey: string;     // hex
  recipientAddress: string;
  feeSats: number;
}

/**
 * Inscribe request shape. The wallet only signs the COMMIT — the
 * reveal is finalized inside `createInscribeTransactions` with a
 * fresh ephemeral key. That ephemeral key is then RETURNED on the
 * result (`ephemeral.privKey`) so the consumer can rebuild
 * alternate reveals later (redirect, RBF, recover-to-self, bundle).
 * Consumers persist it the same way they persist any other
 * money-bearing hot key.
 *
 * `bodyHex` and `contentType` define the inscription payload. The
 * `feeRatePerVbyte` is applied identically to commit + reveal per
 * the CPFP universal pattern; the orchestrator simulates fees.
 * `recipientAddress` is where the inscription lands (P2TR
 * recommended for ord-theory clarity).
 */
export interface InscribeRequest {
  utxo: { txid: string; vout: number; value: number };
  paymentAddress: string;
  paymentPublicKey: string;       // hex (compressed 33-byte)
  recipientAddress: string;
  bodyHex: string;                // inscription body bytes, hex
  contentType?: string;
  feeRatePerVbyte: number;
}

export interface InscribeSignedResult {
  /** Wallet-signed commit, broadcastable wire tx hex. */
  commitHex: string;
  /** Orchestrator-signed reveal, broadcastable wire tx hex. */
  revealHex: string;
  /** SegWit commit txid (witness-independent — matches whatever the wallet finalizes). */
  commitTxid: string;
  /** Reveal txid (already finalized). */
  revealTxid: string;
  /**
   * Ephemeral private key as hex (bearer instrument for the commit
   * output). Consumers persist this; specs assert it's returned.
   */
  ephemeralPrivKeyHex: string;
  /** Ephemeral x-only pubkey as hex. */
  ephemeralPubkeyXonlyHex: string;
}

/* ──────────────────────────  Generic dispatch  ────────────────────────── */

/**
 * Common funding-input shape used by every operation. Same shape as
 * `MintRequest.utxo` and `InscribeRequest.utxo`, hoisted for reuse.
 */
export interface RunOperationFundingInput {
  utxo: { txid: string; vout: number; value: number };
  paymentAddress: string;
  paymentPublicKey: string; // hex
}

export interface RunOperationMintInput extends RunOperationFundingInput {
  kind: 'mint';
  /** Wallet identifier — string-equivalent to KnownOrdinalWalletType. */
  walletType: `${KnownOrdinalWalletType}`;
  recipientAddress: string;
  feeSats: number;
}

export interface RunOperationInscribeInput extends RunOperationFundingInput {
  kind: 'inscribe';
  /** Wallet identifier — string-equivalent to KnownOrdinalWalletType. */
  walletType: `${KnownOrdinalWalletType}`;
  recipientAddress: string;
  bodyHex: string;
  contentType?: string;
  feeRatePerVbyte: number;
}

export type RunOperationInput = RunOperationMintInput | RunOperationInscribeInput;

export interface RunOperationMintResult {
  kind: 'mint';
  /** Wallet-signed, scure-finalized wire-tx hex. Spec broadcasts. */
  txHex: string;
}

export interface RunOperationInscribeResult {
  kind: 'inscribe';
  /** Wallet-signed commit wire-tx hex. */
  commitHex: string;
  /** Ephemeral-key-signed reveal wire-tx hex. */
  revealHex: string;
  /** Computed commit txid (SegWit witness-independent). */
  commitTxid: string;
  /** Computed reveal txid. */
  revealTxid: string;
  /** Ephemeral bearer key as hex. */
  ephemeralPrivKeyHex: string;
  /** Ephemeral x-only pubkey as hex. */
  ephemeralPubkeyXonlyHex: string;
}

export type RunOperationResult = RunOperationMintResult | RunOperationInscribeResult;

const statusEl = () => document.getElementById('status')!;
const outputEl = () => document.getElementById('output')!;

function log(label: string, payload: unknown): void {
  const line = `[${new Date().toISOString()}] ${label}: ${JSON.stringify(payload, null, 2)}`;
  outputEl().textContent = `${outputEl().textContent}\n${line}`;
}

/**
 * Xverse's content script injects `window.XverseProviders`
 * asynchronously after page load. Poll until it's there before
 * any sats-connect call; otherwise getAddress hangs and the page
 * never resolves.
 */
async function waitForXverseProvider(timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (xverseConnector.detect(window)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

window.ordpoolSdkHarness = {
  detectXverse(): boolean {
    return xverseConnector.detect(window);
  },

  async connectXverse(network) {
    const detected = await waitForXverseProvider();
    if (!detected) {
      throw new Error('Xverse provider not injected on the harness page within 15s');
    }
    statusEl().textContent = `connecting to xverse on ${network}…`;
    const networkEnum =
      network === 'mainnet'  ? Network.Mainnet  :
      network === 'testnet3' ? Network.Testnet3 :
      network === 'testnet4' ? Network.Testnet4 :
                                Network.Regtest;
    const info = await firstValueFrom(xverseConnector.connect(networkEnum));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectXverse.result', info);
    return info;
  },

  detectUnisat(): boolean {
    return unisatConnector.detect(window);
  },

  async connectUnisat() {
    // Unisat injects window.unisat via its content script. Poll for
    // it the same way the Xverse path does.
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (unisatConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!unisatConnector.detect(window)) {
      throw new Error('Unisat provider not injected on the harness page within 15s');
    }
    statusEl().textContent = `connecting to unisat…`;
    // unisatConnector.connect ignores the network arg (Unisat's
    // network is selected internally via the wallet UI), so pass
    // Mainnet for symmetry.
    const info = await firstValueFrom(unisatConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectUnisat.result', info);
    return info;
  },

  async armUnisatAccountChangeProbe() {
    // Subscribe to onAccountChange. When the event fires we re-call
    // connect() to fetch the NEW WalletInfo (the SDK contract).
    // Wrap the whole thing in a promise the test can await.
    return new Promise<{ ordinalsAddress: string; paymentAddress: string; paymentPublicKey: string }>((resolve, reject) => {
      if (!unisatConnector.onAccountChange) {
        reject(new Error('unisatConnector.onAccountChange is missing'));
        return;
      }
      const unsubscribe = unisatConnector.onAccountChange(() => {
        unsubscribe();
        firstValueFrom(unisatConnector.connect(Network.Mainnet))
          .then(info => {
            statusEl().textContent = `account changed: ${info.paymentAddress}`;
            log('unisat.account-change.refetched', info);
            resolve({
              ordinalsAddress: info.ordinalsAddress,
              paymentAddress: info.paymentAddress,
              paymentPublicKey: info.paymentPublicKey,
            });
          })
          .catch(reject);
      });
      log('unisat.account-change.armed', { subscribed: true });
    });
  },

  detectLeather(): boolean {
    return leatherConnector.detect(window);
  },

  async connectLeather() {
    // Leather injects window.LeatherProvider via its content script.
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (leatherConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!leatherConnector.detect(window)) {
      throw new Error('Leather provider not injected on the harness page within 15s');
    }
    statusEl().textContent = `connecting to leather…`;
    // leatherConnector.connect ignores the network arg (Leather
    // doesn't accept one on the getAddresses RPC).
    const info = await firstValueFrom(leatherConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectLeather.result', info);
    return info;
  },

  detectCat21Wallet(): boolean {
    return cat21walletConnector.detect(window);
  },
  async connectCat21Wallet() {
    // Cat21 Wallet injects window.Cat21Provider; it can also be
    // discovered via the WBIP004 window.btc_providers array.
    // cat21walletConnector.detect() handles both paths.
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (cat21walletConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!cat21walletConnector.detect(window)) {
      // Diagnostic dump — what providers ARE visible on the harness?
      // Surface lets us tell "wallet injected at LeatherProvider only"
      // (stale-build / shim-only) from "wallet didn't inject at all"
      // (content-script ran but Cat21Provider Object.defineProperty
      // is gone from inpage.js) from "different binary entirely".
      const w = window as unknown as Record<string, unknown>;
      const probe = (key: string) => {
        const v = w[key] as { isCat21?: boolean; isLeather?: boolean } | undefined;
        if (!v) return `${key}=undefined`;
        return `${key}={isCat21:${v.isCat21}, isLeather:${v.isLeather}}`;
      };
      const btcProviders = w.btc_providers;
      const dump = [
        probe('Cat21Provider'),
        probe('LeatherProvider'),
        probe('HiroWalletProvider'),
        `btc_providers=${Array.isArray(btcProviders) ? JSON.stringify((btcProviders as Array<{ id?: string }>).map(p => p?.id)) : typeof btcProviders}`,
      ].join('  ');
      log('connectCat21Wallet.no-provider', dump);
      throw new Error('Cat21 Wallet provider not injected on the harness page within 15s. ' + dump);
    }
    statusEl().textContent = `connecting to cat21-wallet…`;
    const info = await firstValueFrom(cat21walletConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectCat21Wallet.result', info);
    return info;
  },

  detectWizz(): boolean {
    return wizzConnector.detect(window);
  },

  async connectWizz() {
    // Wizz is a Unisat fork; its content script injects window.wizz.
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (wizzConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!wizzConnector.detect(window)) {
      throw new Error('Wizz provider not injected on the harness page within 15s');
    }
    statusEl().textContent = `connecting to wizz…`;
    // wizzConnector.connect ignores the network arg (network is
    // selected via the wallet UI, like Unisat).
    //
    // Wizz's per-tab session router (background.js byte 2285200)
    // rejects requestAccounts with -32603 "Connection error,
    // please try again" while `tabCheckin` is in-flight — the
    // wallet itself is telling us to retry. The bug is fatal for
    // a single-shot caller because tabCheckin can take several
    // hundred ms after window.wizz appears + getNetwork resolves.
    //
    // Retry on -32603 only; any other rejection propagates so we
    // don't mask real bugs. Crucially, the popup hasn't opened on
    // a -32603 (we see no approval URL on the failing attempts in
    // CI), so retrying doesn't orphan a stale popup.
    let info;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        info = await firstValueFrom(wizzConnector.connect(Network.Mainnet));
        if (attempt > 1) log('connectWizz.recovered', { attempt });
        break;
      } catch (e) {
        lastErr = e;
        const err = e as { code?: number };
        if (err?.code !== -32603) break;
        log('connectWizz.retry-32603', { attempt });
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!info) {
      const err = lastErr as { code?: number; message?: string; toString?: () => string };
      const msg = err?.message ?? err?.toString?.() ?? JSON.stringify(err);
      const code = err?.code !== undefined ? ` (code=${err.code})` : '';
      throw new Error(`wizzConnector.connect rejected${code}: ${msg}`);
    }
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectWizz.result', info);
    return info;
  },

  detectOkx(): boolean { return okxConnector.detect(window); },
  async connectOkx() {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (okxConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!okxConnector.detect(window)) throw new Error('OKX provider not injected within 15s');
    statusEl().textContent = `connecting to okx…`;
    const info = await firstValueFrom(okxConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectOkx.result', info);
    return info;
  },

  detectPhantom(): boolean { return phantomConnector.detect(window); },
  async connectPhantom() {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (phantomConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!phantomConnector.detect(window)) throw new Error('Phantom provider not injected within 15s');
    statusEl().textContent = `connecting to phantom…`;
    const info = await firstValueFrom(phantomConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectPhantom.result', info);
    return info;
  },

  detectOyl(): boolean { return oylConnector.detect(window); },
  async connectOyl() {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (oylConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!oylConnector.detect(window)) throw new Error('Oyl provider not injected within 15s');
    statusEl().textContent = `connecting to oyl…`;
    const info = await firstValueFrom(oylConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectOyl.result', info);
    return info;
  },

  detectAlby(): boolean { return albyConnector.detect(window); },
  async connectAlby() {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      if (albyConnector.detect(window)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!albyConnector.detect(window)) throw new Error('Alby provider not injected within 15s');
    statusEl().textContent = `connecting to alby…`;
    const info = await firstValueFrom(albyConnector.connect(Network.Mainnet));
    statusEl().textContent = `connected: ${info.paymentAddress}`;
    log('connectAlby.result', info);
    return info;
  },
};

// Tiny sanity tag for the spec to confirm the bundle loaded.
(window as unknown as { ordpoolSdkHarnessReady: true }).ordpoolSdkHarnessReady = true;
// Poll once for diagnostic status, but don't block module load.
waitForXverseProvider(1_000).then(detected => {
  statusEl().textContent = `harness ready — Xverse detected: ${detected}`;
});



function hexToBytes(s: string): Uint8Array {
  const clean = s.startsWith('0x') ? s.slice(2) : s;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Derive the bcrt1q (BIP-84) + bcrt1p (BIP-86) addresses from the
 * compressed pubkey Unisat exposes via connectUnisat. Used by the
 * mint-roundtrip spec: Unisat itself only ships mainnet/signet/
 * testnet, but BIP-84/86 keys are network-agnostic — the underlying
 * script hash is identical, only the bech32 HRP differs. By feeding
 * Unisat's signPsbt a regtest-encoded PSBT (whose input script
 * bytes are byte-for-byte equal to the mainnet equivalent), the
 * wallet's `formatOptionsToSignInputs` matches the script-derived
 * address against `this.address` AS DECODED WITH ITS OWN
 * networkType (mainnet) — and they match, because the hash is
 * the same. Wallet signs. We broadcast via local electrs.
 */
window.ordpoolSdkHarness.deriveRegtestAddresses = (paymentPublicKeyHex: string) => {
  const pubkey = hexToBytes(paymentPublicKeyHex);
  const regtest = toScureNetwork(Network.Regtest);
  const payment = p2wpkh(pubkey, regtest);
  // Taproot ordinals address from the same compressed pubkey:
  // x-only is the 32 bytes after the parity prefix.
  const xonly = pubkey.slice(1, 33);
  const ordinals = p2tr(xonly, undefined, regtest);
  return {
    paymentAddress: payment.address!,
    ordinalsAddress: ordinals.address!,
  };
};

/**
 * Build a CAT-21 mint PSBT via the SDK and have Unisat sign it
 * with `autoFinalized: true` so we get a broadcast-ready raw tx
 * hex back. The spec broadcasts via local electrs (same reason as
 * Xverse: Unisat's pushPsbt hits the wallet's vendor backend, not
 * our regtest electrs).
 *
 * Unisat itself runs on mainnet; the cross-network trick works
 * because P2WPKH script bytes are HRP-independent. See
 * deriveRegtestAddresses comment for the full reasoning.
 */


/**
 * Build a CAT-21 mint PSBT via the SDK and have Leather sign it
 * with `broadcast: false` (Leather's only sign-only option — it
 * returns the signed PSBT hex). The spec broadcasts via local
 * electrs from the postTx call (per the "WE broadcast" convention).
 *
 * Leather's getAddresses returns the BIP-84 / BIP-86 derivations
 * directly on mainnet — no cross-network trick needed; we just
 * pass `network: 'devnet'` (Leather's equivalent of regtest) to
 * keep its UI from rejecting our bcrt1 addresses.
 */

/**
 * Cat21 Wallet mint — same Bitcoin signPsbt RPC shape as Leather
 * (Cat21 Wallet is forked from Leather). The wallet signs the PSBT
 * and hands the signed bytes back; we finalize via scure and
 * broadcast via input.broadcast (WE broadcast convention).
 *
 * Uses the cross-network-keys trick: Cat21 Wallet is mainnet-only
 * by ADR-7, so we tell it `network: 'mainnet'` while passing a
 * regtest-encoded PSBT. The P2WPKH script hash is HRP-agnostic so
 * the wallet's "is this my address?" check matches against its
 * mainnet bc1q derivation and signing succeeds.
 */

/**
 * Wizz mint: signPsbt(hex, {autoFinalized:false}) — same shape as
 * Unisat (Wizz is a Unisat fork). Cross-network-keys trick: Wizz
 * itself runs on mainnet but its script-hash matching is HRP-
 * independent, so a regtest-encoded PSBT signs cleanly.
 */

/**
 * OKX mint: window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized:
 * false}) — same shape as Unisat. Cross-network-keys trick applies
 * the same way; OKX's signPsbt matches the script bytes against
 * the wallet's own (mainnet) address.
 */

/**
 * Oyl mint: window.oyl.signPsbt({psbtBase64, inputsToSign}) →
 * {signedPsbt: base64}. Oyl exposes both bcrt1q + bcrt1p natively
 * when its UI is on regtest, but in headless Pipeline B we stay on
 * Oyl's default (mainnet) and use the cross-network-keys trick as
 * with Unisat/Wizz/OKX.
 */

/**
 * Phantom mint: window.phantom.bitcoin.request({method:"btc_signPSBT",
 * params:[Uint8Array, {inputsToSign, finalize:false}]}) → Uint8Array.
 * Dual-address contract; we mint with the BIP-84 P2WPKH payment input
 * to the BIP-86 P2TR recipient. Phantom only ships mainnet so the
 * cross-network-keys trick applies as with the other single-address
 * wallets.
 */

/**
 * Shared inscribe orchestrator entry. All wallet-specific inscribe
 * harness methods call this first to get the unsigned commit PSBT
 * + the already-signed reveal hex + the ephemeral key, then they
 * only differ in how they ask the wallet to sign the commit's
 * input 0.
 */
function orchestrateInscribe(input: InscribeRequest): {
  commitPsbt: Uint8Array;
  revealHex: string;
  commitTxid: string;
  revealTxid: string;
  ephemeralPrivKeyHex: string;
  ephemeralPubkeyXonlyHex: string;
} {
  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const body = hexToBytes(input.bodyHex);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
    status: { confirmed: true },
  };
  const r = createInscribeTransactions({
    paymentOutput: txnOutput,
    paymentPublicKey: paymentPubkey,
    paymentAddress: input.paymentAddress,
    recipientAddress: input.recipientAddress,
    body,
    contentType: input.contentType,
    feeRatePerVbyte: input.feeRatePerVbyte,
    network: Network.Regtest,
  });
  return {
    commitPsbt: r.commitPsbt,
    revealHex: r.revealHex,
    commitTxid: r.commitTxid,
    revealTxid: r.revealTxid,
    ephemeralPrivKeyHex: bytesToHex(r.ephemeral.privKey),
    ephemeralPubkeyXonlyHex: bytesToHex(r.ephemeral.pubkeyXonly),
  };
}







window.ordpoolSdkHarness.buildInscribePsbtForAlby = (input: InscribeRequest) => {
  // Alby's signing path runs through the REAL SDK in the spec (NWC
  // signMessage doesn't expose signPsbt; Alby Hub does). The harness
  // only ships the unsigned commit PSBT + the reveal artifacts; the
  // spec hands the PSBT to Hub via Alby's API and finalizes there.
  const o = orchestrateInscribe(input);
  return {
    commitPsbtHex: bytesToHex(o.commitPsbt),
    revealHex: o.revealHex,
    commitTxid: o.commitTxid,
    revealTxid: o.revealTxid,
    ephemeralPrivKeyHex: o.ephemeralPrivKeyHex,
    ephemeralPubkeyXonlyHex: o.ephemeralPubkeyXonlyHex,
  };
};

/**
 * Alby mint via the REAL SDK API. Goes through `createTransaction`
 * with the actual walletType — the universal address-format-driven
 * helper produces a P2TR input shape with `sighashType` OMITTED
 * (SIGHASH_DEFAULT, BIP-341-equivalent to SIGHASH_ALL on key-path
 * spends), which is exactly what Alby's bitcoinjs-lib signer wants.
 *
 * No sighash workaround needed at the harness layer — the SDK
 * itself does the right thing now.
 */
window.ordpoolSdkHarness.buildCat21MintPsbtForAlby = (input) => {
  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid: input.utxo.txid,
    vout: input.utxo.vout,
    value: input.utxo.value,
  };
  const result = createTransaction(
    KnownOrdinalWalletType.alby,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    false,
    Network.Regtest,
  );
  const psbtHex = bytesToHex(result.tx.toPSBT());
  log('mint.psbt-built-for-alby', { bytes: psbtHex.length / 2, fee: input.feeSats });
  return { psbtHex };
};

/* ──────────────────────────  runOperation  ────────────────────────── */

/**
 * Wallets that natively support a regtest network argument on their
 * sign RPC: Xverse (sats-connect `Regtest`), Cat21 Wallet (forked
 * from Leather with `'regtest'` added), Alby (network-agnostic
 * Taproot signing through its SW handler). Every other wallet binary
 * is mainnet-only and we lie about the network to make them sign
 * regtest-encoded PSBT bytes (the script bytes are HRP-independent
 * so the wallet's "is this my address?" check passes against its
 * mainnet view of the same key).
 */
function signerNetworkFor(walletType: KnownOrdinalWalletType): Network {
  switch (walletType) {
    case KnownOrdinalWalletType.xverse:
    case KnownOrdinalWalletType.cat21wallet:
    case KnownOrdinalWalletType.alby:
      return Network.Regtest;
    default:
      return Network.Mainnet;
  }
}

/**
 * Wallet-side `paymentAddress` translation. The PSBT itself always
 * encodes regtest semantics (bcrt1q / bcrt1p funding addresses);
 * mainnet-only wallets that validate `toSignInputs[i].address`
 * against their own address set need to see the equivalent mainnet
 * address — which is structurally the same key, just with the
 * mainnet HRP. We derive it here once per call.
 */
function walletSidePaymentAddressFor(
  walletType: KnownOrdinalWalletType,
  paymentAddress: string,
  paymentPublicKey: Uint8Array,
): string {
  switch (walletType) {
    case KnownOrdinalWalletType.xverse:
    case KnownOrdinalWalletType.cat21wallet:
    case KnownOrdinalWalletType.alby:
      // Regtest-native wallets see the bcrt1* address as-is.
      return paymentAddress;
    case KnownOrdinalWalletType.okx: {
      // OKX default = BIP-86 P2TR. Translate to mainnet bc1p.
      const xonly = paymentPublicKey.slice(1, 33);
      return p2tr(xonly, undefined, toScureNetwork(Network.Mainnet)).address!;
    }
    default: {
      // All other mainnet-only wallets default to BIP-84 P2WPKH funding.
      return p2wpkh(paymentPublicKey, toScureNetwork(Network.Mainnet)).address!;
    }
  }
}

window.ordpoolSdkHarness.runOperation = async (input: RunOperationInput): Promise<RunOperationResult> => {
  if (input.walletType === KnownOrdinalWalletType.alby) {
    throw new Error(
      'runOperation: Alby requires the SW-bypass path. Use buildCat21MintPsbtForAlby / buildInscribePsbtForAlby and sign via seedPage.',
    );
  }
  if (input.walletType === KnownOrdinalWalletType.phantom) {
    throw new Error(
      'runOperation: Phantom v26.x SW lacks btc_* handlers; the connect step fails before any sign happens. Specs assert connect rejection.',
    );
  }

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const signer = findSignerOrThrow(input.walletType);
  const sNetwork = signerNetworkFor(input.walletType);
  const walletPaymentAddress = walletSidePaymentAddressFor(
    input.walletType,
    input.paymentAddress,
    paymentPubkey,
  );

  if (input.kind === 'mint') {
    const txnOutput: TxnOutput = {
      txid:  input.utxo.txid,
      vout:  input.utxo.vout,
      value: input.utxo.value,
    };
    const built = createTransaction(
      input.walletType,
      input.recipientAddress,
      txnOutput,
      paymentPubkey,
      input.paymentAddress,
      BigInt(input.feeSats),
      /* isSimulation = */ false,
      Network.Regtest,
    );
    const psbtBytes = built.tx.toPSBT(0);

    let capturedTxHex: string | undefined;
    await firstValueFrom(signer.signSingleFundingInput({
      psbtBytes,
      paymentAddress: walletPaymentAddress,
      network: sNetwork,
      broadcast: (txHex: string) => {
        capturedTxHex = txHex;
        // Return a stable fake-txid so the signer's Observable can resolve.
        // The real broadcast happens in the spec, against local electrs.
        return of('0'.repeat(64));
      },
    }));
    if (!capturedTxHex) {
      throw new Error('runOperation(mint): signer never invoked the broadcast callback');
    }
    return { kind: 'mint', txHex: capturedTxHex };
  }

  // inscribe
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
    status: { confirmed: true },
  };
  const body = hexToBytes(input.bodyHex);
  const inscribed = createInscribeTransactions({
    paymentOutput: txnOutput,
    paymentPublicKey: paymentPubkey,
    paymentAddress: input.paymentAddress,
    recipientAddress: input.recipientAddress,
    body,
    contentType: input.contentType,
    feeRatePerVbyte: input.feeRatePerVbyte,
    network: Network.Regtest,
  });

  let capturedCommitHex: string | undefined;
  await firstValueFrom(signer.signSingleFundingInput({
    psbtBytes: inscribed.commitPsbt,
    paymentAddress: walletPaymentAddress,
    network: sNetwork,
    broadcast: (txHex: string) => {
      capturedCommitHex = txHex;
      return of('0'.repeat(64));
    },
  }));
  if (!capturedCommitHex) {
    throw new Error('runOperation(inscribe): signer never invoked the broadcast callback');
  }

  return {
    kind: 'inscribe',
    commitHex: capturedCommitHex,
    revealHex: inscribed.revealHex,
    commitTxid: inscribed.commitTxid,
    revealTxid: inscribed.revealTxid,
    ephemeralPrivKeyHex: bytesToHex(inscribed.ephemeral.privKey),
    ephemeralPubkeyXonlyHex: bytesToHex(inscribed.ephemeral.pubkeyXonly),
  };
};
