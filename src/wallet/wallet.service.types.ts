import { Observable } from 'rxjs';
import { AddressPurpose } from 'sats-connect';

import { Network } from '../network';


/**
 * Minimal shape of `window` for wallet detection. Real browser
 * extensions inject these properties; in tests we pass a stub
 * object with whatever subset we want present.
 */
export interface WindowLike {
  XverseProviders?: unknown;
  LeatherProvider?: unknown;
  HiroWalletProvider?: unknown;
  unisat?: unknown;
}


/**
 * A wallet connector handles the READ side of a wallet integration:
 * detect whether the wallet is installed, then connect to it to
 * retrieve the user's addresses. Sign-side lives in `signers/`.
 *
 * Each connector is a pure object — no DI dependency, no class
 * instantiation. The `WalletService` holds a registry of these.
 */
export interface WalletConnector {
  readonly providerId: KnownOrdinalWalletType;
  readonly wallet: KnownOrdinalWallet;
  /** True if a matching `WalletSigner` exists in `signers/` for this wallet. */
  readonly signingSupported: boolean;
  detect(win: WindowLike | undefined): boolean;
  connect(network: Network): Observable<WalletInfo>;
}

export enum KnownOrdinalWalletType {
  xverse = 'xverse',
  leather = 'leather',
  unisat = 'unisat'
}

export interface KnownOrdinalWallet {
  type: KnownOrdinalWalletType;
  label: string;
  subLabel?: string;
  logo: string;
  downloadLink: string;
}

export const KnownOrdinalWallets: { [K in KnownOrdinalWalletType]: KnownOrdinalWallet } = {
  [KnownOrdinalWalletType.xverse]: {
    type: KnownOrdinalWalletType.xverse,
    label: 'Xverse',
    logo: '/resources/ordinal-wallets/btc-xverse-logo.png',
    downloadLink: 'https://www.xverse.app/download'
  },
  [KnownOrdinalWalletType.leather]: {
    type: KnownOrdinalWalletType.leather,
    label: 'Leather',
    logo: '/resources/ordinal-wallets/btc-leather-logo.png',
    downloadLink: 'https://leather.io/install-extension'
  },
  [KnownOrdinalWalletType.unisat]: {
    type: KnownOrdinalWalletType.unisat,
    label: 'Unisat',
    // subLabel: '(not fully supported)',
    logo: '/resources/ordinal-wallets/btc-unisat-logo.svg',
    downloadLink: 'https://unisat.io/download'
  }
};

export interface WalletInfo {
  type: KnownOrdinalWalletType;

  ordinalsAddress: string;
  ordinalsPublicKey: string;

  paymentAddress: string;
  paymentPublicKey: string;

  /**
   * Whether ordpool ships a tested `WalletSigner` for this wallet.
   * Read flows ignore it; mint flows gate on it. See `signers/`.
   */
  signingSupported: boolean;
}


export interface XverseAddressResponse {
  addresses: {
    address: string,
    publicKey: string,
    purpose: AddressPurpose.Ordinals | AddressPurpose.Payment
  }[];
}

export interface LeatherAddressResponse {
  jsonrpc: string;
  id: string;
  result: {
    addresses: LeatherAddress[];
  };
}

export type LeatherAddress = LeatherBtcAddress | LeatherStxAddress;

export interface LeatherBtcAddress {
  symbol: 'BTC';
  type: string;
  address: string;
  publicKey: string;
  derivationPath: string;
  tweakedPublicKey?: string;
}

export interface LeatherStxAddress {
  symbol: 'STX';
  address: string;
}
