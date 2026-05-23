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
import { Transaction as btcTx } from '@scure/btc-signer';

import { xverseConnector } from '../../../src/wallet/connectors/xverse.connector';
import { xverseSigner } from '../../../src/wallet/signers/xverse.signer';
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

  // Decode signed PSBT, finalize the signed input(s), extract
  // wire-format tx hex.
  const signedTx = btcTx.fromPSBT(base64.decode(signedPsbtBase64));
  signedTx.finalize();
  const txHex = bytesToHex(signedTx.extract());
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

void toScureNetwork;
void xverseSigner;
