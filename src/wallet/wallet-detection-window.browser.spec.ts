import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { Network } from '../network';
import { KnownOrdinalWalletType } from './wallet.service.types';
import { WalletService } from './wallet.service';

/**
 * Detection must not depend on machine speed.
 *
 * An extension injects its inpage script whenever its service worker gets
 * round to it. A fixed poll count closes the window at a wall-clock instant,
 * so the same browser with the same extensions answers differently under
 * load, and the user is told the wallet is not installed.
 *
 * The injection here lands AFTER the window a four-poll sweep would have had
 * (0, 500, 1000, 1500 ms), which is what makes this spec able to fail.
 */
describe('wallet detection keeps asking until the answer settles', () => {
  const storage = {
    getValue: () => null,
    setValue: () => undefined,
    removeValue: () => undefined,
  } as unknown as ConstructorParameters<typeof WalletService>[0]['storage'];

  const makeService = () => new WalletService({ storage, network: Network.Mainnet });

  it('detects a provider injected after the old fixed window had closed', async () => {
    const win = window as unknown as Record<string, unknown>;
    delete win['unisat'];
    const service = makeService();

    const detected = firstValueFrom(
      service.wallets$.pipe(
        filter((b) => b.installedWallets.some((w) => w.type === KnownOrdinalWalletType.unisat)),
        take(1),
      ),
    );

    // 2600 ms: past 1500, so a four-poll sweep would already have completed.
    setTimeout(() => {
      win['unisat'] = { requestAccounts: () => Promise.resolve([]) };
    }, 2_600);

    const buckets = await detected;
    expect(buckets.installedWallets.map((w) => w.type)).toContain(
      KnownOrdinalWalletType.unisat,
    );
  }, 20_000);
});
