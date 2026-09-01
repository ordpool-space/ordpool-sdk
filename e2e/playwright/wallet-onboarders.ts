import { BrowserContext } from '@playwright/test';

import { onboardXverse, primeAndSwitchToRegtest, overrideRegtestElectrsUrl } from './onboard-xverse';
import { onboardUnisat } from './onboard-unisat';
import { onboardLeather } from './onboard-leather';
import { onboardWizz } from './onboard-wizz';
import { onboardOkx } from './onboard-okx';
import { onboardPhantom } from './onboard-phantom';
import { seedAlbyAccount } from './onboard-alby';
import { onboardCat21Wallet } from './onboard-cat21wallet';
import { PASSWORD_BY_WALLET } from './wallet-test-vectors';

export interface WalletOnboarder {
  /** Onboard the wallet in the given context (extensionId = the loaded ext). */
  onboard: (context: BrowserContext, extensionId: string) => Promise<void>;
  /** The onboarding password this wallet needs. */
  password: string;
  /** A VENDOR limitation to surface (a wallet bug, not something we fix). */
  caveat?: string;
}

// ONE place that answers "how do I onboard wallet X" — consumed by the e2e
// specs AND the local regtest wallet-runner. The `onboard-<wallet>.ts` helpers
// take either (page) or (context); this registry normalizes them all to
// (context, extensionId) so a consumer never needs wallet-specific code.
const onPage = (fn: (page: Awaited<ReturnType<BrowserContext['newPage']>>, extensionId: string) => Promise<unknown>) =>
  async (context: BrowserContext, extensionId: string): Promise<void> => {
    await fn(await context.newPage(), extensionId);
  };

export const walletOnboarders: Record<string, WalletOnboarder> = {
  xverse: {
    // Onboard AND switch to regtest + point its electrs at ours — a regtest-
    // ready wallet in one call (global-setup layers a seed-dir cache on top).
    onboard: async (ctx, id) => {
      await onboardXverse(ctx, id);
      await primeAndSwitchToRegtest(ctx, id);
      await overrideRegtestElectrsUrl(ctx, id, process.env.XVERSE_REGTEST_ELECTRS_URL ?? 'http://localhost:3000');
    },
    password: PASSWORD_BY_WALLET.xverse,
  },
  unisat: { onboard: onPage((p, id) => onboardUnisat(p, id)), password: PASSWORD_BY_WALLET.unisat },
  leather: { onboard: onPage((p, id) => onboardLeather(p, id)), password: PASSWORD_BY_WALLET.leather },
  wizz: { onboard: onPage((p, id) => onboardWizz(p, id)), password: PASSWORD_BY_WALLET.wizz },
  okx: { onboard: onPage((p, id) => onboardOkx(p, id)), password: PASSWORD_BY_WALLET.okx },
  cat21wallet: { onboard: onPage((p, id) => onboardCat21Wallet(p, id)), password: PASSWORD_BY_WALLET.cat21wallet },
  phantom: {
    onboard: onPage((p, id) => onboardPhantom(p, id)),
    password: PASSWORD_BY_WALLET.phantom,
    caveat: 'connect blocked — v26 desktop ships btc.js dormant: onboards, but cannot connect or sign',
  },
  alby: {
    // seedAlbyAccount talks to Alby's service worker via chrome.runtime.sendMessage,
    // which only exists on a chrome-extension:// origin — so land on options.html
    // before seeding (mirrors the real alby-*.spec.ts setup); a bare about:blank page
    // has no chrome.runtime and the seed throws.
    onboard: onPage(async (p, id) => {
      await p.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });
      return seedAlbyAccount(p);
    }),
    password: PASSWORD_BY_WALLET.alby,
    caveat: 'sign blocked headless — its popup confirm() never resolves (seeded programmatically via the SW)',
  },
};

/** Wallet names with a reusable onboarder (every wallet the E2E supports). */
export const onboardableWallets = Object.keys(walletOnboarders);
