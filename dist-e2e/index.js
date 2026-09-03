"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
// Public e2e helper surface, compiled to dist-e2e/ (tsconfig.e2e.json) and
// exposed as the `ordpool-sdk/e2e` subpath. Consumers import the wallet
// onboarders + regtest helpers from here instead of copying the raw .ts out of
// node_modules (Node/Playwright won't strip-types .ts under node_modules; the
// compiled JS here needs no transpile step).
//
// @playwright/test is an OPTIONAL peer dep: only importers of this subpath need
// it (the compiled onboarders require it at runtime, resolved from the
// consumer's own copy). Non-testing consumers of ordpool-sdk/core never load
// this file and need nothing.
//
// The regtest HTTP stub (e2e/regtest/fees-electrs-stub.mjs) is NOT part of this
// surface: it is run as a script (`node .../fees-electrs-stub.mjs`), never
// imported, so it stays a plain .mjs shipped in the tarball.
__exportStar(require("./playwright/onboard-unisat"), exports);
__exportStar(require("./playwright/onboard-wizz"), exports);
__exportStar(require("./playwright/wizz-offline-routes"), exports);
__exportStar(require("./playwright/onboard-leather"), exports);
__exportStar(require("./playwright/onboard-okx"), exports);
__exportStar(require("./playwright/onboard-phantom"), exports);
__exportStar(require("./playwright/onboard-alby"), exports);
__exportStar(require("./playwright/onboard-cat21wallet"), exports);
__exportStar(require("./playwright/onboard-xverse"), exports);
__exportStar(require("./playwright/wallet-onboarders"), exports);
__exportStar(require("./playwright/wallet-test-vectors"), exports);
__exportStar(require("./playwright/approval-popup"), exports);
__exportStar(require("./playwright/wait-helpers"), exports);
__exportStar(require("./playwright/browser-error-guard"), exports);
__exportStar(require("./playwright/radix-checkbox"), exports);
__exportStar(require("./playwright/cat21wallet-sign-popup"), exports);
__exportStar(require("./regtest/regtest-helpers"), exports);
//# sourceMappingURL=index.js.map