import type { BrowserContext, Page } from '@playwright/test';
/**
 * The cat21-ord instance Cat21 Wallet reads: `https://ord.cat21.space`, a
 * constant in the wallet (`CAT21_ORD_DEFAULT_BASE_URL`,
 * `packages/services/src/infrastructure/api/cat21-ord/cat21-ord-api.utils.ts`).
 * The wallet has no setting that moves it.
 */
export declare const CAT21_WALLET_ORD_HOST: RegExp;
/**
 * A mainnet address as the regtest address of the same output script, or
 * `null` for anything that is not a mainnet address.
 */
export declare function mainnetAddressOnRegtest(segment: string): string | null;
/**
 * The regtest cat21-ord URL that answers one of the wallet's requests to
 * `ord.cat21.space`: same path and query on `ordUrl`, with every mainnet
 * address in the path replaced by its regtest twin.
 *
 * The wallet runs on mainnet, so it asks for its mainnet addresses (the
 * dashboard's `GET /address/<address>` per account). The specs fund and mint
 * at the regtest addresses of the same keys, and a regtest ord refuses a
 * mainnet address (`require_network`), so the address is translated and the
 * answer is the regtest chain's own: the outputs, inscriptions and cat numbers
 * the specs created there. `/address` answers carry no address string, so the
 * body needs no translation back.
 */
export declare function cat21OrdRegtestUrl(url: URL, ordUrl: string): string;
/**
 * Answer Cat21 Wallet's cat21-ord reads from the regtest cat21-ord the stack
 * runs, instead of our production `ord.cat21.space`.
 *
 * Each request is forwarded to `ordUrl` (default: the regtest helpers'
 * `REGTEST_ORD_URL`, `http://localhost:8080`) with its mainnet addresses
 * translated (`cat21OrdRegtestUrl`), and the regtest ord's response is
 * returned to the wallet as it came. A cat21-ord that is not running fails the
 * request rather than falling back to production.
 *
 * Install right after the context launches, before onboarding: the dashboard
 * reads `/address` for every account as soon as the wallet is unlocked.
 */
export declare function installCat21WalletOrdRoutes(context: BrowserContext, opts?: {
    ordUrl?: string;
}): Promise<void>;
/**
 * Whether the browser cancelled `request` because its page navigated away or
 * closed (`net::ERR_ABORTED`): its page no longer waits for an answer, so there
 * is none to forward, and `route.fetch` rejects for it. Any other failure,
 * such as the regtest cat21-ord refusing the connection, is not this.
 */
export declare function wasCancelledByItsPage(request: {
    failure(): {
        errorText: string;
    } | null;
}): boolean;
/**
 * Close a Cat21 Wallet page without sending its pending cat21-ord reads to the
 * network.
 *
 * A page closed while `installCat21WalletOrdRoutes` forwards one of its reads
 * leaves that read paused in the browser; when the page's DevTools session
 * goes away the browser lets it continue to `ord.cat21.space`, where the
 * offline launch blocks it, and it shows in the net log as blocked. Navigating
 * the page away first makes the browser cancel those reads (`net::ERR_ABORTED`)
 * before anything is sent, and only then is the page closed.
 */
export declare function closeCat21WalletPage(page: Page): Promise<void>;
//# sourceMappingURL=cat21wallet-ord-routes.d.ts.map