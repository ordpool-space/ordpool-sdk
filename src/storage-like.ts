/**
 * Minimal contract for browser-side key/value persistence the SDK
 * needs (cat21 mint history, last-connected-wallet snapshot). The
 * consumer passes an implementation to `new WalletService({ storage,
 * network })`. Browser consumers wrap `localStorage`; pure-Node
 * consumers (bots, CLIs) pass an in-memory shim. The SDK doesn't care
 * what's behind the interface.
 */
export interface StorageLike {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
  removeItem(key: string): void;
}
