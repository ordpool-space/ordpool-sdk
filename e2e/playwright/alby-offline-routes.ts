import type { BrowserContext, Route } from '@playwright/test';

/**
 * The LNDHub URL of the Alby account the specs seed (`seedAlbyAccount`): an
 * address under `.invalid` (RFC 6761), so no host can ever answer for it. The
 * specs need an account to hold the seed, not a Lightning backend.
 */
export const ALBY_LNDHUB_PLACEHOLDER_URL = 'https://example.invalid';

const isLndhubPlaceholder = (url: URL): boolean => url.origin === ALBY_LNDHUB_PLACEHOLDER_URL;

/**
 * Keep Alby's account backend out of the test: every request to the seeded
 * account's LNDHub (`ALBY_LNDHUB_PLACEHOLDER_URL`, `POST /auth` when Alby
 * fetches the balance) is aborted at once, so it fails without a DNS lookup
 * leaving the box.
 *
 * Alby (v3.14.2) reports the failure as an "API error" toast, the same one the
 * lookup failure shows; `installAlbyAutoApprove` waits until the toast stops
 * covering the approval button. Alby made no other request off the box on the
 * alby lane.
 *
 * Install right after the context launches, before the account is seeded.
 */
export async function installAlbyOfflineRoutes(context: BrowserContext): Promise<void> {
  await context.route(isLndhubPlaceholder, (route: Route) => route.abort('failed'));
}
