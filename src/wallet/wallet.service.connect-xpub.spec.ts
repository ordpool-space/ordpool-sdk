import { describe, expect, it, jest } from '@jest/globals';
import { firstValueFrom } from 'rxjs';

import { Network } from '../network';
import { WalletService } from './wallet.service';
import { KnownOrdinalWalletType } from './wallet.service.types';
import { deriveWatchOnlyAddresses } from './xpub/derive-watch-only';
import { AddressProbe, WatchOnlyScanResult } from './xpub/scan-watch-only';

const BIP86_ACCOUNT_XPUB =
  'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';

function receive(count: number) {
  return deriveWatchOnlyAddresses({
    extendedPublicKey: BIP86_ACCOUNT_XPUB, network: Network.Mainnet, scriptType: 'p2tr', count,
  });
}

/** Manual instantiation with faked deps — mirrors the other WalletService specs. */
function newService() {
  const setValue = jest.fn();
  const next = jest.fn();
  const service = Object.create(WalletService.prototype);
  service.network = Network.Mainnet;
  service.storageService = { setValue };
  service.connectedWallet$ = { next };
  service.accountChangeUnsubscribe = undefined;
  return { service: service as WalletService, setValue, next };
}

describe('WalletService.connectXpub', () => {

  it('assembles a watch-only WalletInfo from the scan and pushes it', async () => {
    const [a0, , a2, a3] = receive(4);
    const { service, setValue, next } = newService();

    const probe = (address: string): Promise<AddressProbe> => {
      if (address === a2.address) return Promise.resolve({ funded: false, hasCat: true });
      if (address === a3.address) return Promise.resolve({ funded: true, fundedSats: 50_000 });
      return Promise.resolve({ funded: false });
    };

    const info = await firstValueFrom(service.connectXpub({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      scriptType: 'p2tr',
      gapLimit: 4,
      probe,
    }));

    expect(info.type).toBe(KnownOrdinalWalletType.xpub);
    // ordinals = the cat-bearing index; payment = the funded index.
    expect(info.ordinalsAddress).toBe(a2.address);
    expect(info.ordinalsPublicKey).toBe(a2.publicKeyHex);
    expect(info.paymentAddress).toBe(a3.address);
    expect(info.paymentPublicKey).toBe(a3.publicKeyHex);
    expect(info.signingSupported).toBe(true);

    // Pushed to the connected-wallet stream + persisted, like connectWallet.
    expect(next).toHaveBeenCalledWith(info);
    expect(setValue).toHaveBeenCalledTimes(1);
    void a0;
  });

  it('pickIdentity overrides the auto-pick with a user-chosen address from the scan', async () => {
    const [a0, a1, a2, a3] = receive(4);
    const { service } = newService();
    const probe = (address: string): Promise<AddressProbe> => {
      if (address === a2.address) return Promise.resolve({ funded: false, hasCat: true });
      if (address === a3.address) return Promise.resolve({ funded: true, fundedSats: 50_000 });
      return Promise.resolve({ funded: false });
    };

    // The consumer showed the user the scan and they picked index 1 for
    // payment instead of the auto-picked richest (index 3).
    const info = await firstValueFrom(service.connectXpub({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      scriptType: 'p2tr',
      gapLimit: 4,
      probe,
      pickIdentity: (scan) => ({
        ordinals: scan.ordinals,                            // keep the auto-picked cat address
        payment: scan.scanned[1].address,                   // override to index 1
      }),
    }));

    expect(info.ordinalsAddress).toBe(a2.address);          // unchanged auto-pick
    expect(info.paymentAddress).toBe(a1.address);           // the override
    expect(info.paymentPublicKey).toBe(a1.publicKeyHex);
    void a0;
  });

  it('defaults both identities to receive index 0 when the chain is empty', async () => {
    const [a0] = receive(1);
    const { service } = newService();
    const info = await firstValueFrom(service.connectXpub({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      scriptType: 'p2tr',
      gapLimit: 5,
      probe: () => Promise.resolve({ funded: false }),
    }));
    expect(info.ordinalsAddress).toBe(a0.address);
    expect(info.paymentAddress).toBe(a0.address);
  });

  it('propagates a derivation error (ambiguous prefix, no scriptType)', async () => {
    const { service } = newService();
    await expect(firstValueFrom(service.connectXpub({
      extendedPublicKey: BIP86_ACCOUNT_XPUB, // plain xpub, no scriptType
      probe: () => Promise.resolve({ funded: false }),
    }))).rejects.toThrow(/ambiguous/);
  });

  it('connectFromScan assembles + pushes a WalletInfo from a user-chosen identity', async () => {
    const [a0, a1, a2] = receive(3);
    const { service, setValue, next } = newService();
    const scan: WatchOnlyScanResult = {
      scanned: [a0, a1, a2].map((address) => ({ address, probe: { funded: false } })),
      ordinals: a0, payment: a0, ordinalsReason: 'default', paymentReason: 'default',
    };

    // The interactive two-step flow: user reviewed the scan and chose index 2
    // for ordinals, index 1 for payment.
    const info = await firstValueFrom(service.connectFromScan(scan, { ordinals: a2, payment: a1 }));

    expect(info.type).toBe(KnownOrdinalWalletType.xpub);
    expect(info.ordinalsAddress).toBe(a2.address);
    expect(info.ordinalsPublicKey).toBe(a2.publicKeyHex);
    expect(info.paymentAddress).toBe(a1.address);
    expect(info.paymentPublicKey).toBe(a1.publicKeyHex);
    expect(next).toHaveBeenCalledWith(info);
    expect(setValue).toHaveBeenCalledTimes(1);
  });

  it('connectFromScan rejects an identity address that is not in the scan', async () => {
    const [a0, a1] = receive(2);
    const outside = receive(5)[4]; // index 4, outside the 2-address scan
    const { service } = newService();
    const scan: WatchOnlyScanResult = {
      scanned: [a0, a1].map((address) => ({ address, probe: { funded: false } })),
      ordinals: a0, payment: a0, ordinalsReason: 'default', paymentReason: 'default',
    };

    await expect(firstValueFrom(service.connectFromScan(scan, { ordinals: outside, payment: a1 })))
      .rejects.toThrow(/must come from scan\.scanned/);
  });
});
