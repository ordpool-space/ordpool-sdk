import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Network } from '../network';
import { KnownOrdinalWalletType } from './wallet.service.types';

/**
 * Audit gate. Asserts that the Pipeline B harness does NOT lie about
 * wallet identity at the SDK boundary.
 *
 * History: before commit 26730b0, the SDK dispatched per-wallet input-
 * script construction via a switch that only handled four wallet
 * names. Five wallets (wizz, okx, phantom, alby, binance) hit a
 * `default → throw 'Unknown wallet'` branch. To make Pipeline B 49/49
 * green anyway, three harnesses (wizz, okx, phantom) passed
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
        'wizz', 'okx', 'phantom', 'alby', 'binance',
      ]),
    );
  });

  it('the harness runOperation exists and threads input.walletType into every builder/signer call (no lying)', () => {
    const src = fs.readFileSync(HARNESS_PATH, 'utf8');

    // Anchor: the audited surface must exist. A rename of runOperation
    // fails HERE, loudly, instead of silently emptying the audit (the
    // pre-2026-09-04 version regexed for buildAndSignMintVia*, which the
    // runOperation refactor had removed, so its loop matched nothing and
    // the gate passed vacuously forever).
    const anchors = src.match(/window\.ordpoolSdkHarness\.runOperation = async/g) ?? [];
    expect(anchors.length).toBe(1);

    // Identity-argument positions: the wallet type handed to the PSBT
    // builder and to the signer registry IS the wallet identity. Both
    // must be the caller's `input.walletType` pass-through.
    expect(src).toMatch(/createTransaction\(\s*\n?\s*input\.walletType/);
    expect(src).toMatch(/findSignerOrThrow\(input\.walletType\)/);
    expect(src.match(/findSignerOrThrow\(\s*KnownOrdinalWalletType\./g) ?? []).toEqual([]);

    // A hardcoded KnownOrdinalWalletType literal in a builder call is a
    // lie UNLESS it sits inside a per-wallet named helper whose name
    // matches the literal (the Alby SW-bypass helpers are alby-only by
    // construction). Split the harness into `window.ordpoolSdkHarness.X`
    // sections and enforce per section.
    const sections = src.split(/window\.ordpoolSdkHarness\./).slice(1);
    // Sanity that the split found the assignment sections at all: the
    // audited runOperation must be among them.
    expect(sections.map(sec => (sec.match(/^(\w+)/) ?? [])[1])).toContain('runOperation');
    const violations: string[] = [];
    for (const section of sections) {
      const name = (section.match(/^(\w+)/) ?? [])[1] ?? '(unnamed)';
      const literalCalls = section.match(/createTransaction\(\s*\n?\s*KnownOrdinalWalletType\.(\w+)/g) ?? [];
      for (const call of literalCalls) {
        const literal = (call.match(/KnownOrdinalWalletType\.(\w+)/) ?? [])[1];
        if (!name.toLowerCase().includes(literal.toLowerCase())) {
          violations.push(`${name} hardcodes KnownOrdinalWalletType.${literal} in a createTransaction call`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every Proven capability in WALLET_MATRIX is backed by a live (non-fixme) roundtrip spec', () => {
    // Ties the matrix's Proven claims to the spec files that justify
    // them: deleting or fixme-ing a roundtrip spec while the matrix
    // keeps advertising Proven to the cat21.space wallet picker fails
    // HERE. `Proven` is defined as "a real regtest e2e roundtrip …
    // green in CI" — no file, no claim.
    const { WALLET_MATRIX, WalletCapability, CapabilitySupport } = require('./wallet-capabilities');
    const SPEC_SUFFIX_BY_CAPABILITY: Record<string, string> = {
      [WalletCapability.Cat21Mint]: 'mint-roundtrip',
      [WalletCapability.Cat21Transfer]: 'transfer-roundtrip',
      [WalletCapability.Cat21OfferCreate]: 'create-offer-roundtrip',
      [WalletCapability.Cat21OfferAccept]: 'accept-offer-roundtrip',
      [WalletCapability.Inscription]: 'inscribe-roundtrip',
      [WalletCapability.InscriptionParentChild]: 'inscribe-child-roundtrip',
      [WalletCapability.SignMessage]: 'sign-message-roundtrip',
    };
    // xpub has no browser binary; its Proven rows are backed by the
    // regtest psbt-export specs asserted elsewhere in this file.
    const PROVEN_OUTSIDE_PIPELINE_B = new Set(['xpub']);

    const violations: string[] = [];
    for (const row of WALLET_MATRIX) {
      if (PROVEN_OUTSIDE_PIPELINE_B.has(row.wallet)) continue;
      for (const [capability, entry] of Object.entries(row.capabilities) as [string, { support: string }][]) {
        if (entry.support !== CapabilitySupport.Proven) continue;
        const specFile = `${row.wallet}-${SPEC_SUFFIX_BY_CAPABILITY[capability]}.spec.ts`;
        const specPath = path.join(SPECS_DIR, specFile);
        if (!fs.existsSync(specPath)) {
          violations.push(`${row.wallet}/${capability} is Proven but ${specFile} does not exist`);
          continue;
        }
        const content = fs.readFileSync(specPath, 'utf8');
        const liveTests = (content.match(/\btest(?:\.only)?\(/g) ?? []).length;
        if (liveTests === 0) {
          violations.push(`${row.wallet}/${capability} is Proven but ${specFile} has no live test( — all fixme'd?`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no live roundtrip spec contradicts an Unsupported matrix claim (except documented binary-evidence cases)', () => {
    // The reverse direction: a green roundtrip spec for a capability the
    // matrix calls Unsupported is a live contradiction — either users
    // are denied a workable capability, or the spec proves something
    // other than the shipping path and must be documented as such.
    const { WALLET_MATRIX, WalletCapability, CapabilitySupport } = require('./wallet-capabilities');
    const SPEC_SUFFIX_BY_CAPABILITY: Record<string, string> = {
      [WalletCapability.Cat21Mint]: 'mint-roundtrip',
      [WalletCapability.Cat21Transfer]: 'transfer-roundtrip',
      [WalletCapability.Cat21OfferCreate]: 'create-offer-roundtrip',
      [WalletCapability.Cat21OfferAccept]: 'accept-offer-roundtrip',
      [WalletCapability.Inscription]: 'inscribe-roundtrip',
      [WalletCapability.InscriptionParentChild]: 'inscribe-child-roundtrip',
      [WalletCapability.SignMessage]: 'sign-message-roundtrip',
    };
    // No exemptions: every live spec must agree with the matrix. (The
    // former alby-transfer SW-bypass spec was deleted with the rest of
    // the bypass machinery — bypass evidence is not proof.)
    const BINARY_EVIDENCE_ONLY = new Set<string>();

    const violations: string[] = [];
    for (const row of WALLET_MATRIX) {
      for (const [capability, entry] of Object.entries(row.capabilities) as [string, { support: string }][]) {
        if (entry.support !== CapabilitySupport.Unsupported) continue;
        const specFile = `${row.wallet}-${SPEC_SUFFIX_BY_CAPABILITY[capability]}.spec.ts`;
        const specPath = path.join(SPECS_DIR, specFile);
        if (!fs.existsSync(specPath)) continue;
        if (BINARY_EVIDENCE_ONLY.has(specFile)) continue;
        const content = fs.readFileSync(specPath, 'utf8');
        const liveTests = (content.match(/\btest(?:\.only)?\(/g) ?? []).length;
        if (liveTests > 0) {
          violations.push(
            `${row.wallet}/${capability} is Unsupported but ${specFile} has ${liveTests} live test(s) — ` +
            `reconcile the matrix or document the spec in BINARY_EVIDENCE_ONLY`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the CI shard matrix runs exactly the Pipeline-B-drivable wallet set', () => {
    // The drivable-wallet set exists in three hand-copied places: this
    // gate's carve-outs, the workflow's shard matrix, and the connector
    // registry. A new drivable wallet whose specs exist but has no CI
    // shard would pass every other gate while its specs never run.
    const WALLETS_WITHOUT_PIPELINE_B = new Set(['xpub', 'binance']);
    const drivable = (Object.values(KnownOrdinalWalletType) as string[])
      .filter(v => !WALLETS_WITHOUT_PIPELINE_B.has(v))
      .sort();
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github', 'workflows', 'e2e-playwright.yml'), 'utf8');
    const shardWallets = [...workflow.matchAll(/- \{ wallet: (\w+),?/g)]
      .map(m => m[1])
      .sort();
    expect(shardWallets).toEqual(drivable);
  });

  it('every PIPELINE-B-DRIVABLE wallet has a *-inscribe-roundtrip.spec.ts file', () => {
    // Same carve-outs as mint: xpub (no browser binary; covered by
    // e2e/regtest/psbt-export-inscribe-roundtrip.spec.ts) and binance
    // (the v1.17.2 binary doesn't inject window.binancew3w.bitcoin
    // — see the mint coverage carve-out for the full rationale).
    //
    // A wallet may also ship `<wallet>-inscribe-connect-blocked.spec.ts`
    // when the wallet's SW currently can't even reach the inscribe
    // path (Phantom v26.x — its SW has no `btc_*` handlers, so the
    // dapp's `connect` call rejects before any PSBT can be built).
    // The blocked-spec asserts the rejection path; when the wallet
    // adds the missing surface, the rename flips back to
    // `-inscribe-roundtrip.spec.ts` and the assertion is upgraded.
    const WALLETS_WITHOUT_PIPELINE_B = new Set(['xpub', 'binance']);
    const variants = (Object.values(KnownOrdinalWalletType) as string[])
      .filter(v => !WALLETS_WITHOUT_PIPELINE_B.has(v));
    const specs = fs.readdirSync(SPECS_DIR);
    const missing = variants.filter(
      v =>
        !specs.includes(`${v}-inscribe-roundtrip.spec.ts`) &&
        !specs.includes(`${v}-inscribe-connect-blocked.spec.ts`),
    );
    if (missing.length > 0) {
      throw new Error(
        `Pipeline-B-drivable wallets in KnownOrdinalWalletType with NO inscribe-roundtrip ` +
        `(or inscribe-connect-blocked) spec: ${missing.join(', ')}.\n` +
        `Add the matching <wallet>-inscribe-roundtrip.spec.ts in e2e/playwright/specs/.`,
      );
    }
  });

  it('xpub flow has an end-to-end regtest inscribe-roundtrip spec (psbt-export-inscribe-roundtrip)', () => {
    // The xpub carve-out from Pipeline B requires an SDK-level + a
    // regtest-level pin for inscribe too. The regtest spec stands
    // in bitcoin-cli walletprocesspsbt as the external offline
    // wallet and proves psbtExportSigner roundtrips an inscribe
    // commit byte-for-byte.
    const REGTEST_DIR = path.join(REPO_ROOT, 'e2e', 'regtest');
    const specs = fs.readdirSync(REGTEST_DIR);
    expect(specs).toContain('psbt-export-inscribe-roundtrip.spec.ts');
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
    //     back). Covered instead by the regtest spec
    //     `e2e/regtest/psbt-export-roundtrip.spec.ts`, which stands
    //     in `bitcoin-cli walletprocesspsbt` as the external offline
    //     wallet and runs the SDK → external-sign → finalize-and-
    //     broadcast loop end-to-end against bitcoind + electrs.
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
    //
    // Connect-blocked variant: a wallet may instead ship
    // `<wallet>-mint-connect-blocked.spec.ts` when its SW currently
    // rejects the connect step before any PSBT can be built (Phantom
    // v26.x). That spec asserts the rejection path; when the wallet
    // exposes the missing surface, the rename flips back to
    // `-mint-roundtrip.spec.ts` and the assertion is upgraded.
    const WALLETS_WITHOUT_PIPELINE_B = new Set(['xpub', 'binance']);
    const variants = (Object.values(KnownOrdinalWalletType) as string[])
      .filter(v => !WALLETS_WITHOUT_PIPELINE_B.has(v));
    const specs = fs.readdirSync(SPECS_DIR);
    const missing = variants.filter(
      v =>
        !specs.includes(`${v}-mint-roundtrip.spec.ts`) &&
        !specs.includes(`${v}-mint-connect-blocked.spec.ts`),
    );
    if (missing.length > 0) {
      throw new Error(
        `Pipeline-B-drivable wallets in KnownOrdinalWalletType with NO mint-roundtrip ` +
        `(or mint-connect-blocked) spec: ${missing.join(', ')}.\n` +
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
      // signSingleFundingInput dereferences window.binancew3w.bitcoin
      // at call time; on an install without the surface this throws
      // synchronously rather than emitting a deferred error on the
      // Observable. Either shape is a clean failure (no silent
      // no-op, no broadcast attempt); pin the actual shape so
      // future refactors can't accidentally swallow the error.
      expect(() =>
        binanceSigner.signSingleFundingInput({
          psbtBytes: new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]),
          paymentAddress: 'bc1qexample',
          network: 'mainnet' as Network,
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
    // Pin that the SDK's build path works for xpub even though
    // there's no browser-extension binary to drive. This is the
    // unit-side guard.
    // Inline require to dodge circular spec ordering.
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

  it('xpub flow has an end-to-end regtest roundtrip spec (psbt-export-roundtrip)', () => {
    // The xpub carve-out from Pipeline B requires an SDK-level
    // pin AND a regtest-level pin. The regtest spec stands in
    // bitcoin-cli walletprocesspsbt as the external offline wallet
    // (canonical BIP-174 implementation) and proves
    // psbtExportSigner consumes what every conformant signer emits.
    const REGTEST_DIR = path.join(REPO_ROOT, 'e2e', 'regtest');
    const specs = fs.readdirSync(REGTEST_DIR);
    expect(specs).toContain('psbt-export-roundtrip.spec.ts');
  });
});
