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
      mintCat21ViaXverse(input: MintRequest): Promise<{ txId: string }>;
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

window.ordpoolSdkHarness.mintCat21ViaXverse = async (input: MintRequest) => {
  const detected = await waitForXverseProvider();
  if (!detected) throw new Error('Xverse provider not injected on the harness page within 15s');
  statusEl().textContent = `minting cat21 via xverse…`;
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
  const out = await firstValueFrom(
    xverseSigner.signAndBroadcast({
      psbtBytes,
      paymentAddress: input.paymentAddress,
      network: Network.Regtest,
      // xverseSigner ignores both broadcast and promptForSignedPsbt
      // — Xverse signs+broadcasts atomically inside its approval
      // window — but the WalletSigner contract requires them.
      broadcast: (() => { throw new Error('not used by xverseSigner'); }) as never,
      promptForSignedPsbt: (() => { throw new Error('not used by xverseSigner'); }) as never,
    }),
  );
  log('mint.broadcast-result', out);
  return out;
};

function hexToBytes(s: string): Uint8Array {
  const clean = s.startsWith('0x') ? s.slice(2) : s;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

void toScureNetwork;
