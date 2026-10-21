/**
 * The EIP-1193-ish account / network change events every injected Bitcoin
 * provider in the UniSat family exposes. Both axes fan into the single
 * `onAccountChange` callback, so a connector listens to both and cares about
 * neither individually.
 */
export interface InjectedProviderEvents {
  on?(event: 'accountsChanged' | 'networkChanged', handler: () => void): void;
  removeListener?(event: 'accountsChanged' | 'networkChanged', handler: () => void): void;
}

/**
 * The UniSat-family provider RPC. UniSat and its fork Wizz expose it
 * identically; Binance exposes a near-variant (see its connector) and so keeps
 * its own declaration extending `InjectedProviderEvents`.
 */
export interface UnisatFamilyProviderApi extends InjectedProviderEvents {
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
}
