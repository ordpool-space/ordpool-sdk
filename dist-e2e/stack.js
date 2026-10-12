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
// The Playwright-free part of the e2e surface, the `ordpool-sdk/e2e/stack`
// subpath: where a regtest stack's services answer (`stackPort`, `stackUrl`,
// `slotEnv`, ...), the per-wait bound (`e2eTimeoutMs`) and the bitcoind wallet
// name (`regtestWallet`). For code that must not load @playwright/test, such
// as a backend's jest specs or a seeding script; `ordpool-sdk/e2e` re-exports
// the same bindings beside the browser helpers.
//
// Nothing reachable from here may import @playwright/test: a spec loads this
// file in a fresh process and fails when it does.
__exportStar(require("./e2e-timeout"), exports);
__exportStar(require("./regtest-wallet"), exports);
__exportStar(require("./stack-ports"), exports);
//# sourceMappingURL=stack.js.map