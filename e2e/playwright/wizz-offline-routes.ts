import { BrowserContext } from '@playwright/test';

/**
 * Wizz is a mainnet-only wallet: its dashboard and its sign-approval
 * popup fetch the account's BTC balance from external esplora hosts
 * (mempool.space plus a Tor mirror). CI has NO outbound internet, so
 * those fetches fail, the sign popup renders "Failed to load balance",
 * and its Sign button stays disabled forever, so a roundtrip spec times
 * out waiting for the button to become clickable.
 *
 * Fulfil the esplora balance + history endpoints with valid EMPTY
 * responses so Wizz loads a zero balance and enables Sign. Signing a
 * PSBT needs no funds; the regtest funding + broadcast run through the
 * SDK harness and the local electrs (localhost:3000), never these
 * external hosts, so a zero mainnet balance does not affect the tx.
 *
 * Only external hosts are mocked; every localhost request (the harness
 * on :4500, electrs on :3000, ord on :8080/:8081) passes through
 * untouched. configs.wizz.cash has no valid offline payload, so it is
 * aborted (Wizz mounts fine without it).
 */
export async function installWizzOfflineRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/configs.wizz.cash/**', route => route.abort());

  const ESPLORA_ZERO = {
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 0,
  };

  await context.route('**/api/address/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return route.continue();
    }
    const path = url.pathname;
    // /address/<addr>/txs and /address/<addr>/utxo -> empty array.
    if (/\/(txs|utxo)(\/|$)/.test(path)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    // /address/<addr> summary -> zero chain + mempool stats (balance 0).
    const addr = decodeURIComponent(path.split('/api/address/')[1]?.split('/')[0] ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ address: addr, chain_stats: ESPLORA_ZERO, mempool_stats: ESPLORA_ZERO }),
    });
  });
}
