import { describe, expect, it, jest } from '@jest/globals';

import { Network } from '../../network';
import { deriveWatchOnlyAddresses } from './derive-watch-only';
import { scanWatchOnly, AddressProbe } from './scan-watch-only';

const BIP86_ACCOUNT_XPUB =
  'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';

/** The mainnet BIP-86 receive addresses (proven in derive-watch-only.spec). */
function receiveAddresses(count: number): string[] {
  return deriveWatchOnlyAddresses({
    extendedPublicKey: BIP86_ACCOUNT_XPUB, network: Network.Mainnet, scriptType: 'p2tr', count,
  }).map(a => a.address);
}

const EMPTY: AddressProbe = { funded: false };

/** Build a probe from an address→state map, defaulting to EMPTY. */
function probeFrom(map: Record<string, AddressProbe>) {
  return (address: string) => Promise.resolve(map[address] ?? EMPTY);
}

describe('scanWatchOnly — auto-pick', () => {

  it('picks the cat-bearing address for ordinals and the richest for payment (different indexes)', async () => {
    const [a0, a1, a2, a3] = receiveAddresses(4);
    const res = await scanWatchOnly({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      gapLimit: 4,
      probe: probeFrom({
        [a0]: { funded: true, fundedSats: 1_000 },
        [a2]: { funded: false, hasCat: true },
        [a3]: { funded: true, fundedSats: 50_000 },
      }),
    });
    expect(res.ordinals.address).toBe(a2);   // the only cat
    expect(res.ordinalsReason).toBe('cat');
    expect(res.payment.address).toBe(a3);    // richest (50k > 1k)
    expect(res.paymentReason).toBe('funds');
    expect(res.scanned.length).toBe(4);
    void a1;
  });

  it('falls back to receive index 0 for both roles when nothing is found', async () => {
    const [a0] = receiveAddresses(1);
    const res = await scanWatchOnly({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      gapLimit: 5,
      probe: probeFrom({}), // all empty
    });
    expect(res.ordinals.address).toBe(a0);
    expect(res.ordinalsReason).toBe('default');
    expect(res.payment.address).toBe(a0);
    expect(res.paymentReason).toBe('default');
  });

  it('picks the LOWEST-index cat when several addresses hold cats', async () => {
    const [, a1, , a3] = receiveAddresses(4);
    const res = await scanWatchOnly({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      gapLimit: 4,
      probe: probeFrom({
        [a1]: { funded: false, hasCat: true },
        [a3]: { funded: false, hasCat: true },
      }),
    });
    expect(res.ordinals.address).toBe(a1);
  });

  it('when the same address holds both a cat and funds, it serves both roles', async () => {
    const [a0, a1] = receiveAddresses(2);
    const res = await scanWatchOnly({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      gapLimit: 2,
      probe: probeFrom({
        [a1]: { funded: true, fundedSats: 10_000, hasCat: true },
      }),
    });
    expect(res.ordinals.address).toBe(a1);
    expect(res.payment.address).toBe(a1);
    void a0;
  });

  it('probes exactly gapLimit addresses, concurrently', async () => {
    const probe = jest.fn((_a: string) => Promise.resolve(EMPTY));
    await scanWatchOnly({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      gapLimit: 7,
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(7);
  });

  it('rejects gapLimit < 1', async () => {
    await expect(scanWatchOnly({
      extendedPublicKey: BIP86_ACCOUNT_XPUB,
      network: Network.Mainnet,
      scriptType: 'p2tr',
      gapLimit: 0,
      probe: probeFrom({}),
    })).rejects.toThrow(/gapLimit/);
  });
});
