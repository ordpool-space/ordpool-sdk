import { Page } from '@playwright/test';

import { boundByE2eTimeout } from './e2e-expect';

import { ALBY_LNDHUB_PLACEHOLDER_URL } from './alby-offline-routes';
import { PASSWORD_BY_WALLET, TEST_MNEMONIC } from './wallet-test-vectors';

/**
 * Seed an Alby account from the BIP-39 test seed — PROGRAMMATICALLY via Alby's
 * service-worker message bus (setPassword → addAccount → setMnemonic), NOT a UI
 * onboard: Alby has no restore-from-seed onboarding UI, and its popup confirm()
 * never resolves headless. Envelope shape per Alby's common/lib/msg.ts. Returns
 * the created accountId. Shared by the e2e specs + the local wallet-runner.
 */
export async function seedAlbyAccount(
  page: Page,
  opts: { bitcoinNetwork?: 'bitcoin' | 'regtest'; password?: string; mnemonic?: string } = {},
): Promise<string> {
  boundByE2eTimeout(page);
  const password = opts.password ?? PASSWORD_BY_WALLET.alby;
  const mnemonic = opts.mnemonic ?? TEST_MNEMONIC;
  const bitcoinNetwork = opts.bitcoinNetwork ?? 'regtest';

  const result = await page.evaluate(async ({ password, mnemonic, bitcoinNetwork, lndhubUrl }) => {
    const c = (globalThis as unknown as { chrome: { runtime: {
      sendMessage: (msg: unknown) => Promise<unknown>;
    } } }).chrome;
    const send = (action: string, args: Record<string, unknown>) =>
      c.runtime.sendMessage({ application: 'LBE', prompt: true, action, args, origin: { internal: true } }) as Promise<{ data?: unknown; error?: string } | null>;

    const setPwResp = await send('setPassword', { password });
    const addAccResp = await send('addAccount', {
      name: 'ordpool-e2e',
      connector: 'lndhub',
      config: { url: lndhubUrl, login: 'x', password: 'x' },
      bitcoinNetwork,
    }) as { data?: { accountId: string }; error?: string } | null;
    const accountId = addAccResp?.data?.accountId;
    const setMnemoResp = accountId ? await send('setMnemonic', { id: accountId, mnemonic }) : null;
    return { setPwResp, addAccResp, accountId, setMnemoResp };
  }, { password, mnemonic, bitcoinNetwork, lndhubUrl: ALBY_LNDHUB_PLACEHOLDER_URL });

  if (!result.accountId) {
    throw new Error(`Alby addAccount failed: ${JSON.stringify(result.addAccResp)}`);
  }
  return result.accountId;
}
