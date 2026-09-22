import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { Network } from '../network';
import { KnownOrdinalWalletType } from './wallet.service.types';
import { WalletService } from './wallet.service';

/**
 * Detection is a property of the PAGE, not of the subscriber.
 *
 * Every surface that renders a wallet list subscribes to `wallets$`, and
 * without a shared subscription each one starts its own poll train: N times
 * the work, N independent answers, and `rescanWallets()` reaching only the
 * subscribers that happen to be alive. This asserts the sweep is shared by
 * counting the detection reads the service actually performs.
 */
describe('wallets$ runs ONE detection sweep for all subscribers', () => {
  const storage = {
    getValue: () => null,
    setValue: () => undefined,
    removeValue: () => undefined,
  } as unknown as ConstructorParameters<typeof WalletService>[0]['storage'];

  it('a second subscriber joins the running sweep instead of starting one', async () => {
    const win = window as unknown as Record<string, unknown>;
    win['unisat'] = { requestAccounts: () => Promise.resolve([]) };

    const service = new WalletService({ storage, network: Network.Mainnet });

    // Count the reads the sweep performs. A per-subscriber sweep polls at its
    // own cadence, so two subscribers would roughly double this.
    const reads = { count: 0 };
    const original = (service as unknown as { getInstalledWallets: () => unknown })
      .getInstalledWallets.bind(service);
    (service as unknown as { getInstalledWallets: () => unknown }).getInstalledWallets = () => {
      reads.count++;
      return original();
    };

    const hasUnisat = (b: { installedWallets: { type: KnownOrdinalWalletType }[] }) =>
      b.installedWallets.some((w) => w.type === KnownOrdinalWalletType.unisat);

    const first = firstValueFrom(service.wallets$.pipe(filter(hasUnisat), take(1)));
    const second = firstValueFrom(service.wallets$.pipe(filter(hasUnisat), take(1)));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b); // the same object, so the same sweep produced both
    expect(reads.count).toBeLessThanOrEqual(2);
  }, 20_000);
});
