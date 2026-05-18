// jest-preset-angular needs the zoneless test environment bootstrapped
// before any spec imports @angular/core. This loads the JIT compiler
// facade so partial-compilation output (ng-packagr fesm2022) can run.
import 'jest-preset-angular/setup-env/zoneless';

// Adds support for TextEncoder and TextDecoder
// see https://stackoverflow.com/a/68468204
// see https://github.com/jsdom/jsdom/issues/2524
//
// It patches the global objects TextEncoder, TextDecoder, and Uint8Array
// which are missing, or improperly implemented (Uint8Array is a node Buffer) in the JSDOM environment.
// This should ensure full compatibility with browser global objects in our Jest testing environment.

import * as util from 'util';

(global as any).TextEncoder = util.TextEncoder;
(global as any).TextDecoder = util.TextDecoder;
(global as any).Uint8Array = Uint8Array;

import { DecompressionStream } from 'stream/web';
(global as any).DecompressionStream = DecompressionStream;

// WebCrypto polyfill for jsdom — the OTS verifier uses crypto.subtle.digest
// for SHA-1 / SHA-256. Real browsers expose this; jsdom doesn't, so we
// borrow Node's webcrypto and bind it to globalThis.crypto.
//
// jsdom installs its own `globalThis.crypto` that's a partial polyfill
// (e.g. randomUUID) but lacks .subtle. We replace it wholesale via
// Object.defineProperty because it's a getter on jsdom's window/global.
import { webcrypto } from 'crypto';
Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true, writable: true });
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
