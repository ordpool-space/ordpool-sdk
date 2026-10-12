import { Locator, Page } from '@playwright/test';
/** The part of a Playwright `Locator` a dismissal step needs. */
export type DismissControl = Pick<Locator, 'click' | 'waitFor'>;
/**
 * Dismiss UniSat's "a new version is available" modal.
 *
 * UniSat asks its wallet API whether a newer build exists, and the modal
 * appears on the first dashboard open whenever the answer is above the pinned
 * build. `installUnisatOfflineRoutes` answers with the captured config
 * (version 1.7.19 against the pinned 1.7.15), so under the shield it shows on
 * every onboarding. It is layered ABOVE the compatibility notice: Playwright
 * reports the notice checkbox as visible, enabled and stable while
 * `.row-container` from `.popover-container` intercepts every click, so the
 * failure would name the checkbox and not the thing covering it.
 *
 * The modal carries no data-testid, so it is anchored on the one string only
 * it contains; "Skip" alone would also match the notice below it.
 */
export declare function dismissUnisatUpdateNag(page: Page): Promise<void>;
/** The update modal's steps once it shows: Skip, then the modal is gone. */
export declare function dismissUnisatUpdateNagControls(c: {
    skip: DismissControl;
    modal: DismissControl;
}): Promise<void>;
/**
 * Dismiss the "Compatibility Tips" notice ("Please be aware that: For Ordinals
 * assets, Rare sats are not supported.") UniSat 1.7.15 shows over the home
 * screen after onboarding. Returns whether it was there.
 *
 * It showed on every onboarding of all four address types under
 * `installUnisatOfflineRoutes`; the probe stays because what decides it is
 * UniSat's, not ours.
 */
export declare function dismissUnisatNotice(page: Page): Promise<boolean>;
/**
 * The notice's steps once it shows. OK counts down ("OK (3s)", "OK (2s)", ...)
 * and ignores clicks until its label is plain "OK", so `okReady` is OK carrying
 * exactly that label: the state in which it takes the click. Then the notice
 * is gone, or this fails naming OK rather than a later click it would cover.
 */
export declare function dismissUnisatNoticeControls(c: {
    checkbox: DismissControl;
    okReady: DismissControl;
    ok: DismissControl;
}): Promise<void>;
/**
 * Drive UniSat onboarding from the BIP-39 test seed to the home tab.
 * Shared by the e2e specs AND the local wallet-runner (matches
 * onboard-okx.ts / onboard-phantom.ts / onboard-cat21wallet.ts).
 *
 * `addressTypeIndex` folds in the matrix variant: when set, the matching
 * address-type card is picked before continuing. UniSat is mainnet-only, so
 * roundtrip specs derive the regtest bcrt1 equivalents from the same pubkey.
 */
export declare function onboardUnisat(page: Page, extensionId: string, opts?: {
    addressTypeIndex?: number;
    password?: string;
    mnemonicWords?: string[];
}): Promise<void>;
/**
 * Wait until UniSat's install tab can no longer reject an approval: it has
 * booted past its root route, or the wallet will never open it.
 *
 * On a fresh install the background opens `index.html` in a new tab once its
 * own initialisation is done. That tab boots through the root route, which
 * rejects any pending approval when it is not the notification window
 * (`BoostScreen`: `isNotification || rejectApproval()`), so the approval popup
 * closes and the dapp gets 4001 "User rejected the request". The tab arrives
 * on the wallet's schedule, not onboarding's, and sometimes not at all: when
 * Chrome's `onInstalled` reaches the worker before the wallet has registered
 * its listener, the wallet never opens it (`unisat-install-tab.ts` has the
 * mechanism). Both outcomes are settled. A tab still on its root route, a
 * background that has not finished initialising, or one whose next poll may
 * still open the tab, is not.
 *
 * Needs the wallet's offline routes (`installUnisatOfflineRoutes`,
 * `installWizzOfflineRoutes`) on the context from launch: they record when the
 * background finished initialising. Without them this fails in state
 * `background-initialising`.
 */
export declare function waitForUnisatInstallTabSettled(onboardPage: Page, extensionId: string): Promise<void>;
//# sourceMappingURL=onboard-unisat.d.ts.map