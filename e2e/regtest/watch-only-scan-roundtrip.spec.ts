/**
 * Watch-only scan / auto-pick proven against real electrs on regtest.
 *
 * The unit test (`src/wallet/xpub/scan-watch-only.spec.ts`) pins the
 * ranking logic with a mock probe. This proves the full chain —
 * derive real addresses from an account extended key, then rank them
 * by REAL on-chain state read from electrs — end to end:
 *
 *   1. Generate a fresh testnet account key (random seed, m/86'/1'/0'),
 *      so the scan window is isolated from the shared ordpool-e2e state.
 *   2. Derive its receive addresses with the SDK helper.
 *   3. Fund two different indexes on-chain from ordpool-e2e (a small
 *      amount at one, a larger amount at another).
 *   4. Run `scanWatchOnly` with a probe wired to real electrs
 *      (`getUtxos` → funded / fundedSats).
 *   5. Assert it auto-picks the richest funded index for payment and
 *      defaults ordinals to receive index 0 (no cat present).
 *
 * Cat DETECTION is the consumer probe's job (electrs alone can't tell a
 * cat UTXO from a plain one — that needs the cat index / ordpool-parser),
 * so the `hasCat` ranking is unit-proven; this spec proves the
 * derive → electrs-probe → pick chain for the funds path.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { HDKey } from '@scure/bip32';
import { randomBytes } from '@noble/hashes/utils';

import { Network } from '../../src/network';
import { deriveWatchOnlyAddresses } from '../../src/wallet/xpub/derive-watch-only';
import { scanWatchOnly, AddressProbe } from '../../src/wallet/xpub/scan-watch-only';
import {
  getUtxos,
  mineBlocks,
  rpc,
  waitForElectrsSync,
  waitForUtxoAt,
} from './regtest-helpers';

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const GAP = 8;

/** Real electrs probe: an address is funded iff it holds any UTXO. */
async function electrsProbe(address: string): Promise<AddressProbe> {
  const utxos = await getUtxos(address);
  if (utxos.length === 0) return { funded: false };
  return { funded: true, fundedSats: utxos.reduce((sum, u) => sum + u.value, 0) };
}

function fundFromE2e(address: string, btc: string): void {
  rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', address, btc);
}

describe('watch-only scan auto-pick vs real electrs (regtest)', () => {

  let accountTpub: string;
  let receive: { address: string; index: number }[];

  beforeAll(async () => {
    // Fresh, isolated account key (m/86'/1'/0', testnet prefixes).
    const account = HDKey.fromMasterSeed(randomBytes(32), TESTNET_VERSIONS).derive("m/86'/1'/0'");
    accountTpub = account.publicExtendedKey;

    receive = deriveWatchOnlyAddresses({
      extendedPublicKey: accountTpub,
      network: Network.Regtest,
      scriptType: 'p2tr',
      count: GAP,
    }).map(a => ({ address: a.address, index: a.index }));
  });

  it('picks the richest funded index for payment, defaults ordinals to index 0', async () => {
    // Fund index 2 with a small amount, index 5 with a larger one.
    fundFromE2e(receive[2].address, '0.0010');
    fundFromE2e(receive[5].address, '0.0050');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForUtxoAt(receive[2].address, 100_000); // 0.001 BTC
    await waitForUtxoAt(receive[5].address, 500_000); // 0.005 BTC

    const res = await scanWatchOnly({
      extendedPublicKey: accountTpub,
      network: Network.Regtest,
      scriptType: 'p2tr',
      gapLimit: GAP,
      probe: electrsProbe,
    });

    // Payment = richest funded (index 5, 0.005 > 0.001).
    expect(res.payment.address).toBe(receive[5].address);
    expect(res.payment.index).toBe(5);
    expect(res.paymentReason).toBe('funds');
    expect(res.scanned[5].probe.fundedSats).toBe(500_000);
    expect(res.scanned[2].probe.fundedSats).toBe(100_000);

    // No cat present → ordinals defaults to receive index 0.
    expect(res.ordinals.address).toBe(receive[0].address);
    expect(res.ordinalsReason).toBe('default');

    // The derived addresses are the ones that actually received on-chain,
    // i.e. the SDK's derivation matches where electrs saw the funds.
    const funded2 = await getUtxos(receive[2].address);
    const funded5 = await getUtxos(receive[5].address);
    expect(funded2.length).toBeGreaterThan(0);
    expect(funded5.length).toBeGreaterThan(0);
  });
});
