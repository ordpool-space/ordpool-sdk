import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { KnownOrdinalWalletType } from './wallet.service.types';

/**
 * Audit gate. Asserts that the Pipeline B harness does NOT lie about
 * wallet identity at the SDK boundary.
 *
 * History: before commit 26730b0, the SDK dispatched per-wallet input-
 * script construction via a switch that only handled four wallet
 * names. Six wallets (oyl, wizz, okx, phantom, alby, binance) hit a
 * `default → throw 'Unknown wallet'` branch. To make Pipeline B 49/49
 * green anyway, four harnesses (wizz, okx, oyl, phantom) passed
 * `KnownOrdinalWalletType.unisat` to `createTransaction` while
 * advertising they were testing the actual wallet — the harness lied
 * at the API boundary. Alby bypassed the SDK API entirely via a
 * parallel scure build that has since been deleted.
 *
 * After 26730b0 the SDK dispatches on address format, so harnesses
 * no longer need to lie. This test pins that they DON'T.
 *
 * Rules:
 *   1. Each `buildAndSignMintVia<Wallet>` MUST pass
 *      `KnownOrdinalWalletType.<wallet>` (case-insensitive name match)
 *      to its `createTransaction` call. No harness may pass a
 *      different wallet type.
 *   2. Each variant of `KnownOrdinalWalletType` MUST have a
 *      corresponding `<wallet>-mint-roundtrip.spec.ts` file.
 *
 * If either rule fails, the message lists the offending harness or
 * the missing spec so the audit is one-line.
 */
// Paths resolved from this spec's location (src/wallet/) up to the
// repo root, then into e2e/playwright/.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_PATH = path.join(REPO_ROOT, 'e2e', 'playwright', 'fixtures', 'sdk-harness.ts');
const SPECS_DIR = path.join(REPO_ROOT, 'e2e', 'playwright', 'specs');

describe('Honest wallet coverage (audit gate)', () => {

  it('enumerates the live KnownOrdinalWalletType set', () => {
    const variants = Object.values(KnownOrdinalWalletType);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants).toEqual(
      expect.arrayContaining([
        'xverse', 'leather', 'unisat', 'cat21wallet',
        'oyl', 'wizz', 'okx', 'phantom', 'alby', 'binance',
      ]),
    );
  });

  it('every harness passes its OWN walletType to createTransaction (no lying)', () => {
    const src = fs.readFileSync(HARNESS_PATH, 'utf8');
    const variants = Object.values(KnownOrdinalWalletType) as string[];

    // Extract every `buildAndSignMintVia<Wallet> = async (...) => { ... }`
    // block and check that the createTransaction inside (if any) is
    // called with KnownOrdinalWalletType.<same wallet>.
    const blockRe = /buildAndSignMintVia(\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\};/g;
    const violations: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(src)) !== null) {
      const walletName = match[1].toLowerCase();   // 'Wizz' → 'wizz'
      const body = match[2];
      // cat21wallet doesn't match by direct name comparison because
      // harness function is `buildAndSignMintViaCat21Wallet`; normalise.
      const normalised = walletName === 'cat21wallet' ? 'cat21wallet' : walletName;
      const expectedToken = `KnownOrdinalWalletType.${normalised}`;
      const createTxCalls = body.match(/KnownOrdinalWalletType\.(\w+)/g) ?? [];
      const lies = createTxCalls.filter(c => c !== expectedToken);
      if (lies.length > 0) {
        violations.push(
          `buildAndSignMintVia${match[1]} passes ${lies.join(', ')} but should pass ${expectedToken}`,
        );
      }
      // The function exists; make sure the wallet name is also a real
      // variant of KnownOrdinalWalletType. If not, the harness invents
      // a wallet that doesn't actually exist in the registry.
      if (!variants.includes(normalised)) {
        violations.push(
          `buildAndSignMintVia${match[1]} targets '${normalised}' which is NOT in KnownOrdinalWalletType`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('every PIPELINE-B-DRIVABLE wallet has a *-mint-roundtrip.spec.ts file', () => {
    // Two structural carve-outs from Pipeline B (real-wallet-binary
    // driven mint roundtrip in regtest). Each must have an SDK-level
    // pin further down so the carve-out isn't a free pass.
    //
    //   xpub: watch-only entry for hardware/desktop wallets
    //     (Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter,
    //     Bitcoin Core). No browser extension to drive via Playwright;
    //     sign step is user-mediated (paste PSBT, paste signed PSBT
    //     back). Different test shape entirely.
    //
    //   binance: signer ships per the "ship every signer" HARD RULE
    //     but the Binance Web3 Wallet binary (v1.17.2 as of this
    //     pin) doesn't inject `window.binancew3w.bitcoin` (only
    //     wallet / ethereum / solana / tron / sui / tonconnect).
    //     Detect-by-signature in `binance.connector.ts` correctly
    //     returns false, so the picker never offers Binance and the
    //     signer is never called. Pipeline B has nothing to drive
    //     against — there is no surface in the binary. When Binance
    //     enables the documented `bitcoin` provider, this carve-out
    //     comes out and a real spec lands.
    const WALLETS_WITHOUT_PIPELINE_B = new Set(['xpub', 'binance']);
    const variants = (Object.values(KnownOrdinalWalletType) as string[])
      .filter(v => !WALLETS_WITHOUT_PIPELINE_B.has(v));
    const specs = fs.readdirSync(SPECS_DIR);
    const missing = variants.filter(v => !specs.includes(`${v}-mint-roundtrip.spec.ts`));
    if (missing.length > 0) {
      throw new Error(
        `Pipeline-B-drivable wallets in KnownOrdinalWalletType with NO mint-roundtrip spec: ${missing.join(', ')}.\n` +
        `Add the matching <wallet>-mint-roundtrip.spec.ts in e2e/playwright/specs/.`,
      );
    }
  });

  it('binance signer ships in the registry and fails cleanly when the wallet surface is absent', () => {
    // The carve-out above is justified only if the Binance signer
    // is actually wired up the way the workspace HARD RULE demands
    // ("Ship every signer we have code for"). Pin both halves:
    //   1. binanceSigner is exported from the WalletSigner registry.
    //   2. signAndBroadcast throws when window.binancew3w is absent,
    //      so a consumer that accidentally calls it without the
    //      runtime gets a clean failure (not a silent no-op).
    const { walletSigners, binanceSigner } = require('./signers');
    expect(walletSigners).toContain(binanceSigner);
    expect(binanceSigner.providerId).toBe(KnownOrdinalWalletType.binance);

    // Drive the no-surface path. In node-jest there's no `window`
    // global, but stubbing it shapes the same "binancew3w missing"
    // path the browser would hit on a non-Binance install.
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      // signAndBroadcast dereferences window.binancew3w.bitcoin at
      // call time; on an install without the surface this throws
      // synchronously rather than emitting a deferred error on the
      // Observable. Either shape is a clean failure (no silent
      // no-op, no broadcast attempt); pin the actual shape so
      // future refactors can't accidentally swallow the error.
      expect(() =>
        binanceSigner.signAndBroadcast({
          psbtBytes: new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]),
          paymentAddress: 'bc1qexample',
          network: 'mainnet',
          broadcast: () => { throw new Error('should not be reached'); },
        }),
      ).toThrow(/binancew3w|bitcoin|undefined/i);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it('xpub flow can build a mint PSBT via the SDK (non-browser path)', () => {
    // Even though xpub doesn't have a Playwright spec, the SDK MUST
    // still build a valid mint PSBT for an xpub-derived address. Pin
    // that by exercising the universal helper directly.
    //
    // This stops the xpub carve-out above from being a free pass: if
    // the SDK's build path breaks for xpub, this fails.
    // Inline import to dodge circular spec ordering.
    const { buildInputScript } = require('../cat21-script/build-input-script');
    const { hex } = require('@scure/base');
    const btc = require('@scure/btc-signer');
    const PUBKEY = hex.decode('030000000000000000000000000000000000000000000000000000000000000001');
    const network = btc.NETWORK;
    const addr = btc.p2wpkh(PUBKEY, network).address;
    const result = buildInputScript({
      paymentAddress: addr,
      paymentPublicKey: PUBKEY,
      isSimulation: false,
      network,
    });
    expect(result.scriptData.script.length).toBe(22);
  });
});
