import { Page } from '@playwright/test';
/**
 * Drive OKX v4.1.0 onboarding from welcome to dashboard. Multi-page,
 * multi-iframe flow (CI iterations 22-31, 2026-05-31):
 *   - Welcome: "Your portal to Web3" → Import wallet (CDP click +
 *     programmatic fallback; native click absorbed by anti-bot).
 *   - "Seed phrase or private key" picker on the same page.
 *   - 12-box seed form opens in #ui-ses-iframe; Confirm.
 *   - "Secure your wallet" opens on a NEW page; Password preselected;
 *     Next button (also in iframe).
 *   - "Set password" form inside the same iframe; Confirm.
 *   - "Welcome to OKX Wallet — Let's explore Web3" gate; Start your
 *     Web3 journey button.
 *
 * Requires the context to be launched with
 * `--disable-blink-features=AutomationControlled` so navigator.webdriver
 * is hidden — without this the welcome-screen click is absorbed.
 */
export declare function onboardOkx(page: Page, extensionId: string, opts?: {
    password?: string;
    mnemonicWords?: string;
}): Promise<Page>;
//# sourceMappingURL=onboard-okx.d.ts.map