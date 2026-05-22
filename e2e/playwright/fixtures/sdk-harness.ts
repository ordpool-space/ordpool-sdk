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

import { xverseConnector } from '../../../src/wallet/connectors/xverse.connector';
import { xverseSigner } from '../../../src/wallet/signers/xverse.signer';
import { createTransaction } from '../../../src/cat21-mint/cat21.service.helper';
import { Network, toScureNetwork } from '../../../src/network';
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
    };
  }
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

// Suppress unused-import warnings; these are exposed for later
// iterations (3b: build mint via createTransaction; 3c: sign via
// xverseSigner, broadcast to regtest).
void xverseSigner;
void createTransaction;
void toScureNetwork;
void ({} as TxnOutput);
