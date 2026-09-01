import { Page } from '@playwright/test';
/**
 * Drive a Leather-family wallet through onboarding from the BIP-39 test seed to
 * a signed-in dashboard: welcome → "Use existing key" → 12 per-word seed inputs
 * → set password → dashboard (send/receive/balance/bitcoin).
 *
 * Leather AND its fork Cat21 Wallet share this exact flow (identical bundle
 * testids: `sign-in-link`, `set-or-enter-password-input`, `set-password-btn`),
 * so onboard-cat21wallet.ts delegates here. Shared by the e2e specs + the local
 * wallet-runner (matches onboard-okx.ts / onboard-phantom.ts).
 */
export declare function onboardLeather(page: Page, extensionId: string, opts?: {
    password?: string;
    mnemonic?: string;
}): Promise<void>;
//# sourceMappingURL=onboard-leather.d.ts.map