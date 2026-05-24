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
import { Transaction as btcTx, p2wpkh, p2tr } from '@scure/btc-signer';

import { xverseConnector } from '../../../src/wallet/connectors/xverse.connector';
import { xverseSigner } from '../../../src/wallet/signers/xverse.signer';
import { unisatConnector } from '../../../src/wallet/connectors/unisat.connector';
import { leatherConnector } from '../../../src/wallet/connectors/leather.connector';
import { createTransaction } from '../../../src/cat21-mint/cat21.service.helper';
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
      detectLeather(): boolean;
      connectLeather(): Promise<{
        type: KnownOrdinalWalletType;
        ordinalsAddress: string;
        ordinalsPublicKey: string;
        paymentAddress: string;
        paymentPublicKey: string;
        signingSupported: boolean;
      }>;
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
 * Convention (see /Work/ordpool/WALLETS.md → "Signing convention in
 * the Pipeline B harness: WE finalize"): every wallet's
 * `buildAndSignMintVia<Wallet>` asks the wallet for a partial-sig
 * PSBT, then funnels through this single helper to finalize +
 * extract the wire-format raw tx. One finalize implementation
 * across all wallets — no per-wallet "did this one auto-finalize?"
 * branching.
 */
function extractWireTxFromPsbt(signedPsbtBytes: Uint8Array): string {
  const tx = btcTx.fromPSBT(signedPsbtBytes);
  tx.finalize();
  return bytesToHex(tx.extract());
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
