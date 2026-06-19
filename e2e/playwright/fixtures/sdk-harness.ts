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

import { firstValueFrom } from 'rxjs';
import { signTransaction } from 'sats-connect';
import { base64 } from '@scure/base';
import { p2wpkh, p2tr } from '@scure/btc-signer';

import { xverseConnector } from '../../../src/wallet/connectors/xverse.connector';
import { xverseSigner } from '../../../src/wallet/signers/xverse.signer';
import { unisatConnector } from '../../../src/wallet/connectors/unisat.connector';
import { leatherConnector } from '../../../src/wallet/connectors/leather.connector';
import { cat21walletConnector } from '../../../src/wallet/connectors/cat21wallet.connector';
import { wizzConnector } from '../../../src/wallet/connectors/wizz.connector';
import { okxConnector } from '../../../src/wallet/connectors/okx.connector';
import { phantomConnector } from '../../../src/wallet/connectors/phantom.connector';
import { oylConnector } from '../../../src/wallet/connectors/oyl.connector';
import { albyConnector } from '../../../src/wallet/connectors/alby.connector';
// Shared PSBT→wire-tx-hex helper used by both production signers
// and the harness. Full "WE finalize, WE broadcast" reasoning in
// /Work/ordpool/WALLETS.md.
import { extractWireTxFromPsbt } from '../../../src/wallet/psbt-extract';
import { BIP341_KEYPATH_SIGHASHES } from '../../../src/wallet/sighash';
import { createTransaction } from '../../../src/cat21-mint/cat21.service.helper';
import { createInscribeTransactions } from '../../../src/inscribe/inscription.service.helper';
import { schnorr } from '@noble/curves/secp256k1';
import { Network, toBitcoinNetworkType, toScureNetwork } from '../../../src/network';
import { KnownOrdinalWalletType } from '../../../src/wallet/wallet.service.types';
import type { TxnOutput } from '../../../src/cat21-mint/cat21.service.types';

declare global {
  interface Window {
    ordpoolSdkHarness: {
      detectXverse(): boolean;
      connectXverse(network: 'mainnet' | 'testnet3' | 'testnet4' | 'regtest'): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildAndSignMintViaXverse(input: MintRequest): Promise<{ txHex: string }>;
      buildAndSignInscribeViaXverse(input: InscribeRequest): Promise<InscribeSignedResult>;
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
      buildAndSignMintViaUnisat(input: MintRequest): Promise<{ txHex: string }>;
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
      buildAndSignMintViaLeather(input: MintRequest): Promise<{ txHex: string }>;
      detectCat21Wallet(): boolean;
      connectCat21Wallet(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildAndSignMintViaCat21Wallet(input: MintRequest): Promise<{ txHex: string }>;
      detectWizz(): boolean;
      connectWizz(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildAndSignMintViaWizz(input: MintRequest): Promise<{ txHex: string }>;
      detectOkx(): boolean;
      connectOkx(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildAndSignMintViaOkx(input: MintRequest): Promise<{ txHex: string }>;
      detectPhantom(): boolean;
      connectPhantom(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildAndSignMintViaPhantom(input: MintRequest): Promise<{ txHex: string }>;
      detectOyl(): boolean;
      connectOyl(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
      buildAndSignMintViaOyl(input: MintRequest): Promise<{ txHex: string }>;
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
 * reveal is finalized inside `createInscribeTransactions` with the
 * ephemeral key (which the orchestrator zeroes before returning).
 *
 * `bodyHex` and `contentType` define the inscription payload. The
 * `feeRatePerVbyte` is applied identically to commit + reveal per
 * the CPFP universal pattern; the orchestrator simulates fees.
 *
 * `recipientAddress` is where the inscription lands (P2TR
 * recommended for ord-theory clarity); `paymentPubkeyXonly` is the
 * wallet's x-only key that backs the 2-leaf recovery tapscript on
 * the commit output, so the user can recover the postage if the
 * reveal never broadcasts.
 */
export interface InscribeRequest {
  utxo: { txid: string; vout: number; value: number };
  paymentAddress: string;
  paymentPublicKey: string;       // hex (compressed 33-byte)
  paymentPubkeyXonly: string;     // hex (32-byte) for the recovery leaf
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
}

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

window.ordpoolSdkHarness.buildAndSignMintViaXverse = async (input: MintRequest) => {
  const detected = await waitForXverseProvider();
  if (!detected) throw new Error('Xverse provider not injected on the harness page within 15s');
  statusEl().textContent = `building + signing cat21 mint via xverse…`;
  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  const result = createTransaction(
    KnownOrdinalWalletType.xverse,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    /* isSimulation = */ false,
    Network.Regtest,
  );
  const psbtBytes = result.tx.toPSBT();
  log('mint.psbt-built', { bytes: psbtBytes.length, fee: input.feeSats });

  // sats-connect signTransaction with `broadcast: false` — Xverse
  // returns the signed PSBT instead of broadcasting itself. We
  // broadcast via the local electrs from the spec side (Xverse's
  // own broadcast hits our regtest electrs with axios's JSON
  // content-type, which mempool/electrs rejects with HTTP 400).
  const signedPsbtBase64 = await new Promise<string>((resolve, reject) => {
    signTransaction({
      payload: {
        network: { type: toBitcoinNetworkType(Network.Regtest) },
        message: 'Sign Transaction (CAT-21 Mint)',
        psbtBase64: base64.encode(psbtBytes),
        broadcast: false,
        inputsToSign: [{
          address: input.paymentAddress,
          signingIndexes: [0],
          sigHash: 0x01, // SigHash.ALL
        }],
      },
      onFinish: (response) => {
        const psbt = (response as { psbtBase64?: string }).psbtBase64;
        if (!psbt) reject(new Error('Xverse signTransaction returned without psbtBase64'));
        else resolve(psbt);
      },
      onCancel: () => reject(new Error('user cancelled signTransaction')),
    });
  });
  log('mint.signed-psbt-received', { bytes: base64.decode(signedPsbtBase64).length });

  const txHex = extractWireTxFromPsbt(base64.decode(signedPsbtBase64));
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

window.ordpoolSdkHarness.buildAndSignInscribeViaXverse = async (input: InscribeRequest) => {
  const detected = await waitForXverseProvider();
  if (!detected) throw new Error('Xverse provider not injected on the harness page within 15s');
  statusEl().textContent = `building inscribe (commit+reveal) via xverse…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const paymentPubkeyXonly = hexToBytes(input.paymentPubkeyXonly);
  const body = hexToBytes(input.bodyHex);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
    status: { confirmed: true },
  };

  // Layer-4 orchestrator: builds the commit PSBT (unsigned, awaits
  // the wallet) and the reveal hex (already finalized with a fresh
  // ephemeral key that the orchestrator zeroes before returning).
  const inscribed = createInscribeTransactions({
    paymentOutput: txnOutput,
    paymentPublicKey: paymentPubkey,
    paymentAddress: input.paymentAddress,
    paymentPubkeyXonly,
    recipientAddress: input.recipientAddress,
    body,
    contentType: input.contentType,
    feeRatePerVbyte: input.feeRatePerVbyte,
    network: Network.Regtest,
  });
  log('inscribe.built', {
    commitPsbtBytes: inscribed.commitPsbt.length,
    revealHexChars: inscribed.revealHex.length,
    commitTxid: inscribed.commitTxid,
    revealTxid: inscribed.revealTxid,
    commitFee: inscribed.fees.commitFeeSats,
    revealFee: inscribed.fees.revealFeeSats,
  });

  // Xverse signs ONLY the funding input on the commit (input 0).
  // sats-connect's `inputsToSign` is keyed by address; same call
  // shape as the cat21-mint flow above.
  const signedCommitPsbtBase64 = await new Promise<string>((resolve, reject) => {
    signTransaction({
      payload: {
        network: { type: toBitcoinNetworkType(Network.Regtest) },
        message: 'Sign Transaction (Inscription Commit)',
        psbtBase64: base64.encode(inscribed.commitPsbt),
        broadcast: false,
        inputsToSign: [{
          address: input.paymentAddress,
          signingIndexes: [0],
          sigHash: 0x01,
        }],
      },
      onFinish: (response) => {
        const psbt = (response as { psbtBase64?: string }).psbtBase64;
        if (!psbt) reject(new Error('Xverse signTransaction returned without psbtBase64'));
        else resolve(psbt);
      },
      onCancel: () => reject(new Error('user cancelled signTransaction')),
    });
  });
  const commitHex = extractWireTxFromPsbt(base64.decode(signedCommitPsbtBase64));
  log('inscribe.commit-signed', {
    commitHex: commitHex.slice(0, 40) + '…',
    length: commitHex.length,
  });

  return {
    commitHex,
    revealHex: inscribed.revealHex,
    commitTxid: inscribed.commitTxid,
    revealTxid: inscribed.revealTxid,
  };
};

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

void toScureNetwork;
void xverseSigner;

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
window.ordpoolSdkHarness.buildAndSignMintViaUnisat = async (input: MintRequest) => {
  if (!unisatConnector.detect(window)) {
    throw new Error('Unisat provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via unisat…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  const result = createTransaction(
    KnownOrdinalWalletType.unisat,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    /* isSimulation = */ false,
    Network.Regtest,
  );
  const psbtHex = bytesToHex(result.tx.toPSBT());
  log('mint.psbt-built', { bytes: psbtHex.length / 2, fee: input.feeSats });

  // autoFinalized:false matches the convention used across all
  // wallets in the harness (see WALLETS.md → "Signing convention in
  // the Pipeline B harness: WE finalize"). The wallet returns a
  // partial-sig PSBT; @scure/btc-signer.finalize() is the single
  // finalize implementation, called via extractWireTxFromPsbt below.
  const unisat = (window as unknown as {
    unisat: { signPsbt: (h: string, o?: { autoFinalized?: boolean }) => Promise<string> };
  }).unisat;
  const signedPsbtHex = await unisat.signPsbt(psbtHex, { autoFinalized: false });
  log('mint.signed-psbt', { length: signedPsbtHex.length });

  const txHex = extractWireTxFromPsbt(hexToBytes(signedPsbtHex));
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

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
window.ordpoolSdkHarness.buildAndSignMintViaLeather = async (input: MintRequest) => {
  if (!leatherConnector.detect(window)) {
    throw new Error('Leather provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via leather…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  const result = createTransaction(
    KnownOrdinalWalletType.leather,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    /* isSimulation = */ false,
    Network.Regtest,
  );
  const psbtHex = bytesToHex(result.tx.toPSBT());
  log('mint.psbt-built', { bytes: psbtHex.length / 2, fee: input.feeSats });

  const leather = (window as unknown as {
    LeatherProvider: {
      request: (m: 'signPsbt', p: {
        hex: string;
        allowedSighash: number[];
        signAtIndex: number;
        network: string;
        broadcast: boolean;
      }) => Promise<{ result: { hex: string } }>;
    };
  }).LeatherProvider;
  const response = await leather.request('signPsbt', {
    hex: psbtHex,
    allowedSighash: [0x01], // SIGHASH_ALL
    signAtIndex: 0,
    // Leather v6.x's bundle only checks for 'mainnet' | 'signet' |
    // 'testnet' on its Bitcoin signing path — there is no regtest
    // option. Fall back to the same cross-network-keys trick we
    // use for Unisat: tell Leather it's signing for mainnet, and
    // because the P2WPKH script bytes are network-agnostic (the
    // hash is identical whether you encode it as bc1q or bcrt1q),
    // Leather's "is this my address?" check matches against its
    // own mainnet bc1q address and the signing succeeds. We then
    // broadcast the resulting tx to local regtest electrs.
    network: 'mainnet',
    broadcast: false,  // we broadcast via postTx (WE broadcast convention)
  });
  log('mint.signed-psbt', { length: response.result.hex.length });

  const txHex = extractWireTxFromPsbt(hexToBytes(response.result.hex));
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

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
window.ordpoolSdkHarness.buildAndSignMintViaCat21Wallet = async (input: MintRequest) => {
  if (!cat21walletConnector.detect(window)) {
    throw new Error('Cat21 Wallet provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via cat21-wallet…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  // Route through the cat21wallet branch — script shape is shared
  // with Leather (BIP-84 P2WPKH payment), but the SDK's
  // createInput sets the RBF-signaling sequence (0xfffffffd)
  // specifically for KnownOrdinalWalletType.cat21wallet per the
  // "CAT-21 mints: RBF policy" rule in SDK CLAUDE.md.
  const result = createTransaction(
    KnownOrdinalWalletType.cat21wallet,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    /* isSimulation = */ false,
    Network.Regtest,
  );
  const psbtHex = bytesToHex(result.tx.toPSBT());
  log('mint.psbt-built', { bytes: psbtHex.length / 2, fee: input.feeSats });

  const cat21 = (window as unknown as {
    Cat21Provider: {
      request: (m: 'signPsbt', p: {
        hex: string;
        allowedSighash: number[];
        signAtIndex: number;
        network: string;
        broadcast: boolean;
      }) => Promise<{ result: { hex: string } }>;
    };
  }).Cat21Provider;
  const response = await cat21.request('signPsbt', {
    hex: psbtHex,
    allowedSighash: [0x01], // SIGHASH_ALL
    signAtIndex: 0,
    network: 'mainnet',     // cross-network-keys trick; same as leather mint
    broadcast: false,
  });
  log('mint.signed-psbt', { length: response.result.hex.length });

  const txHex = extractWireTxFromPsbt(hexToBytes(response.result.hex));
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

/**
 * Wizz mint: signPsbt(hex, {autoFinalized:false}) — same shape as
 * Unisat (Wizz is a Unisat fork). Cross-network-keys trick: Wizz
 * itself runs on mainnet but its script-hash matching is HRP-
 * independent, so a regtest-encoded PSBT signs cleanly.
 */
window.ordpoolSdkHarness.buildAndSignMintViaWizz = async (input: MintRequest) => {
  if (!wizzConnector.detect(window)) {
    throw new Error('Wizz provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via wizz…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  // Pass the REAL walletType. Post-26730b0 the SDK dispatches on
  // address format via buildInputScript, so wizz no longer needs to
  // pose as unisat. Pipeline B exercises the wizz code path honestly.
  const result = createTransaction(
    KnownOrdinalWalletType.wizz,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    false,
    Network.Regtest,
  );
  const psbtHex = bytesToHex(result.tx.toPSBT());
  log('mint.psbt-built', { bytes: psbtHex.length / 2, fee: input.feeSats });

  const wizz = (window as unknown as {
    wizz: { signPsbt: (h: string, o?: { autoFinalized?: boolean }) => Promise<string> };
  }).wizz;
  let signedPsbtHex: string;
  try {
    signedPsbtHex = await wizz.signPsbt(psbtHex, { autoFinalized: false });
  } catch (e) {
    const err = e as { code?: number; message?: string; toString?: () => string };
    const msg = err?.message ?? err?.toString?.() ?? JSON.stringify(err);
    const code = err?.code !== undefined ? ` (code=${err.code})` : '';
    throw new Error(`wizz.signPsbt rejected${code}: ${msg}`);
  }
  log('mint.signed-psbt', { length: signedPsbtHex.length });

  const txHex = extractWireTxFromPsbt(hexToBytes(signedPsbtHex));
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

/**
 * OKX mint: window.okxwallet.bitcoin.signPsbt(hex, {autoFinalized:
 * false}) — same shape as Unisat. Cross-network-keys trick applies
 * the same way; OKX's signPsbt matches the script bytes against
 * the wallet's own (mainnet) address.
 */
window.ordpoolSdkHarness.buildAndSignMintViaOkx = async (input: MintRequest) => {
  if (!okxConnector.detect(window)) {
    throw new Error('OKX provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via okx…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  // Pass the REAL walletType — post-26730b0 the SDK no longer
  // dispatches on wallet name, so OKX no longer needs to pose as
  // Unisat.
  const result = createTransaction(
    KnownOrdinalWalletType.okx,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    false,
    Network.Regtest,
  );
  const psbtHex = bytesToHex(result.tx.toPSBT());
  log('mint.psbt-built', { bytes: psbtHex.length / 2, fee: input.feeSats });

  const okxBtc = (window as unknown as {
    okxwallet: { bitcoin: {
      signPsbt: (h: string, o?: {
        autoFinalized?: boolean;
        from?: string;
        toSignInputs?: { index: number; address: string; sighashTypes?: number[]; disableTweakSigner?: boolean }[];
      }) => Promise<string>;
    } };
  }).okxwallet.bitcoin;
  // OKX validates toSignInputs[i].address against its own wallet
  // address-set, which is mainnet-only. Our bcrt1p input has the same
  // script bytes as the wallet's bc1p (HRP swap), so derive the mainnet
  // equivalent of the same pubkey and pass THAT — OKX sees a known
  // address, signs the script, and we use the resulting signature on
  // the regtest tx (script hash is identical).
  const mainnetXonly = paymentPubkey.slice(1, 33);
  const mainnetTaproot = p2tr(mainnetXonly, undefined, toScureNetwork(Network.Mainnet));
  let signedPsbtHex: string;
  try {
    signedPsbtHex = await okxBtc.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: [{
        index: 0,
        address: mainnetTaproot.address!,
        // BIP-341 key-path: DEFAULT (0x00) and ALL (0x01) commit
        // to identical wire bytes; accept either so OKX's policy
        // check passes regardless of which shape the SDK emits.
        sighashTypes: [...BIP341_KEYPATH_SIGHASHES],
        disableTweakSigner: false,
      }],
    });
  } catch (e) {
    const err = e as { code?: number; message?: string; toString?: () => string };
    const msg = err?.message ?? err?.toString?.() ?? JSON.stringify(err);
    const code = err?.code !== undefined ? ` (code=${err.code})` : '';
    throw new Error(`okx.signPsbt rejected${code}: ${msg}`);
  }
  log('mint.signed-psbt', { length: signedPsbtHex.length });

  const txHex = extractWireTxFromPsbt(hexToBytes(signedPsbtHex));
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

/**
 * Oyl mint: window.oyl.signPsbt({psbtBase64, inputsToSign}) →
 * {signedPsbt: base64}. Oyl exposes both bcrt1q + bcrt1p natively
 * when its UI is on regtest, but in headless Pipeline B we stay on
 * Oyl's default (mainnet) and use the cross-network-keys trick as
 * with Unisat/Wizz/OKX.
 */
window.ordpoolSdkHarness.buildAndSignMintViaOyl = async (input: MintRequest) => {
  if (!oylConnector.detect(window)) {
    throw new Error('Oyl provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via oyl…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  // Pass the REAL walletType — the SDK dispatches on address format
  // now, not wallet name.
  const result = createTransaction(
    KnownOrdinalWalletType.oyl,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    false,
    Network.Regtest,
  );
  const psbtBytes = result.tx.toPSBT();
  const psbtHex = bytesToHex(psbtBytes);
  log('mint.psbt-built', { bytes: psbtBytes.length, fee: input.feeSats });

  // Verified by inspecting v1.17.1's static/background/index.js (the
  // signPsbt handler at byte 4708500). The validator expects
  // `body.psbt` (string, hex) — the "A psbt hex is required" error
  // message refers to the *type* of value, not the field name.
  const oyl = (window as unknown as {
    oyl: {
      signPsbt: (a: {
        psbt: string;
        inputsToSign?: { address: string; signingIndexes: number[]; sigHash: number }[];
        broadcast?: boolean;
        finalize?: boolean;
      }) => Promise<{ signedPsbt?: string; signedPsbtHex?: string; psbt?: string }>;
    };
  }).oyl;
  let response: { signedPsbt?: string; signedPsbtHex?: string; psbt?: string };
  try {
    response = await oyl.signPsbt({
      psbt: psbtHex,
      inputsToSign: [{
        address: input.paymentAddress,
        signingIndexes: [0],
        sigHash: 0x01,
      }],
      broadcast: false,
      finalize: false,
    });
  } catch (e) {
    const err = e as { code?: number; message?: string; toString?: () => string };
    const msg = err?.message ?? err?.toString?.() ?? JSON.stringify(err);
    const code = err?.code !== undefined ? ` (code=${err.code})` : '';
    throw new Error(`oyl.signPsbt rejected${code}: ${msg}`);
  }
  log('mint.signed-psbt', {
    length: (response.signedPsbt || response.signedPsbtHex || response.psbt || '').length,
    fields: Object.keys(response),
  });

  // Response may use signedPsbtHex (hex) or signedPsbt/psbt (base64 or hex).
  const signedHex = response.signedPsbtHex || (response.psbt && /^[0-9a-f]+$/i.test(response.psbt) ? response.psbt : undefined);
  const signedBytes = signedHex
    ? hexToBytes(signedHex)
    : base64.decode(response.signedPsbt ?? response.psbt ?? '');
  const txHex = extractWireTxFromPsbt(signedBytes);
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
};

/**
 * Phantom mint: window.phantom.bitcoin.request({method:"btc_signPSBT",
 * params:[Uint8Array, {inputsToSign, finalize:false}]}) → Uint8Array.
 * Dual-address contract; we mint with the BIP-84 P2WPKH payment input
 * to the BIP-86 P2TR recipient. Phantom only ships mainnet so the
 * cross-network-keys trick applies as with the other single-address
 * wallets.
 */
window.ordpoolSdkHarness.buildAndSignMintViaPhantom = async (input: MintRequest) => {
  if (!phantomConnector.detect(window)) {
    throw new Error('Phantom provider not injected on the harness page');
  }
  statusEl().textContent = `building + signing cat21 mint via phantom…`;

  const paymentPubkey = hexToBytes(input.paymentPublicKey);
  const txnOutput: TxnOutput = {
    txid:  input.utxo.txid,
    vout:  input.utxo.vout,
    value: input.utxo.value,
  };
  // Pass the REAL walletType — Phantom's address-format-driven
  // input shape comes out of the universal helper now.
  const result = createTransaction(
    KnownOrdinalWalletType.phantom,
    input.recipientAddress,
    txnOutput,
    paymentPubkey,
    input.paymentAddress,
    BigInt(input.feeSats),
    false,
    Network.Regtest,
  );
  const psbtBytes = result.tx.toPSBT();
  log('mint.psbt-built', { bytes: psbtBytes.length, fee: input.feeSats });

  const phantomBtc = (window as unknown as {
    phantom: {
      bitcoin: {
        request: (a: {
          method: 'btc_signPSBT';
          params: [Uint8Array, {
            inputsToSign: { address: string; signingIndexes: number[]; sigHash?: number }[];
            finalize: boolean;
          }];
        }) => Promise<Uint8Array>;
      };
    };
  }).phantom.bitcoin;
  const signedBytes = await phantomBtc.request({
    method: 'btc_signPSBT',
    params: [
      psbtBytes,
      {
        inputsToSign: [{
          address: input.paymentAddress,
          signingIndexes: [0],
          sigHash: 0x01,
        }],
        finalize: false,
      },
    ],
  });
  log('mint.signed-psbt', { length: signedBytes.length });

  const txHex = extractWireTxFromPsbt(signedBytes);
  log('mint.finalized', { txHex: txHex.slice(0, 40) + '…', length: txHex.length });
  return { txHex };
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
