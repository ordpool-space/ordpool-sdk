/**
 * @test-kind unit
 * Real:   reachableHosts, offlineLaunchArgs, offlineBrowserArgs, walletLaunchArgs, netLogArgs, offlineLaunchSwitches,
 *         assertPortRefuses, launchWalletContext, launchOfflineBrowser, launchOfflineContext
 * Faked:  chromium.launch and chromium.launchPersistentContext (the browser launch, @playwright/test's BrowserType
 *         signature), returning a placeholder; net.connect in the refusal case, emitting the 'connect' a listener sends
 * Proves: the exceptions come from the regtest environment and nothing else, the switches spell them the way
 *         Chromium matches them, a wallet gets its own launch switches, a browser without an extension gets the
 *         same offline switches and net log, the net log lands where the env says, and every launch refuses to
 *         start when the dead proxy port answers
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const mockLaunchPersistentContext = jest.fn(async () => ({ placeholder: 'context' }));
const mockLaunch = jest.fn(async () => ({ placeholder: 'browser' }));
jest.mock('@playwright/test', () => ({ chromium: { launchPersistentContext: mockLaunchPersistentContext, launch: mockLaunch } }));

import {
  assertPortRefuses,
  launchOfflineBrowser,
  launchOfflineContext,
  launchWalletContext,
  netLogArgs,
  offlineBrowserArgs,
  offlineLaunchArgs,
  offlineLaunchSwitches,
  reachableHosts,
  walletLaunchArgs,
} from './launch-wallet-context';

describe('reachableHosts', () => {
  it('is loopback alone for the default stack', () => {
    expect(reachableHosts({})).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('a moved host port moves nothing: it is still localhost', () => {
    expect(reachableHosts({ E2E_ELECTRS_HOST_PORT: '13010' })).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('adds the host of every regtest service URL and of the Xverse electrs override, then the extra hosts', () => {
    expect(reachableHosts({
      REGTEST_ELECTRS_URL: 'http://172.17.0.1:3010',
      REGTEST_ORD_URL: 'http://ord.regtest.test:8080',
      REGTEST_ORD_STOCK_URL: 'http://ord-stock.regtest.test:8081',
      XVERSE_REGTEST_ELECTRS_URL: 'http://[fd00::5]:3010',
    }, ['app.local'])).toEqual([
      'localhost', '127.0.0.1', '[::1]', '172.17.0.1', 'ord.regtest.test', 'ord-stock.regtest.test', '[fd00::5]', 'app.local',
    ]);
  });

  it('a service on localhost adds nothing twice', () => {
    expect(reachableHosts({ REGTEST_ORD_URL: 'http://localhost:18080' }, ['127.0.0.1'])).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });
});

describe('offlineLaunchArgs', () => {
  it('resolver rules spell IPv6 bare, the bypass list bracketed, the proxy is the dead port', () => {
    expect(offlineLaunchArgs(['localhost', '127.0.0.1', '[::1]', 'ord.regtest.test'])).toEqual([
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1, EXCLUDE ord.regtest.test',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=localhost;127.0.0.1;[::1];ord.regtest.test',
    ]);
  });
});

describe('walletLaunchArgs', () => {
  const offline = [
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1',
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
  ];

  it('loads the one extension, keeps the browser offline, adds OKX its anti-automation switch', () => {
    expect(walletLaunchArgs({ wallet: 'okx', extensionPath: '/ext/okx' }, {})).toEqual([
      '--disable-extensions-except=/ext/okx',
      '--load-extension=/ext/okx',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...offline,
      '--disable-blink-features=AutomationControlled',
    ]);
  });

  it('another wallet gets no OKX switch; caller switches come last', () => {
    expect(walletLaunchArgs({ wallet: 'phantom', extensionPath: '/ext/phantom', args: ['--x'] }, {})).toEqual([
      '--disable-extensions-except=/ext/phantom',
      '--load-extension=/ext/phantom',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...offline,
      '--x',
    ]);
  });

  it('extra hosts reach both switches', () => {
    expect(walletLaunchArgs({ extensionPath: '/e', extraHosts: ['app.local'] }, {}).slice(4)).toEqual([
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1, EXCLUDE app.local',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=localhost;127.0.0.1;[::1];app.local',
    ]);
  });
});

describe('netLogArgs', () => {
  it('writes nothing without ORDPOOL_E2E_NET_LOG_DIR', () => {
    expect(netLogArgs('okx', {})).toEqual([]);
  });

  it('names one file per launch inside the directory, which it creates', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'netlog-')), 'nested');
    const [first] = netLogArgs('okx', { ORDPOOL_E2E_NET_LOG_DIR: dir });
    const [second] = netLogArgs(undefined, { ORDPOOL_E2E_NET_LOG_DIR: dir });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(first).toMatch(new RegExp(`^--log-net-log=${dir}/okx-${process.pid}-\\d+\\.json$`));
    expect(second).toMatch(new RegExp(`^--log-net-log=${dir}/context-${process.pid}-\\d+\\.json$`));
  });
});

describe('assertPortRefuses', () => {
  it('resolves for a port nothing listens on', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((r) => server.close(() => r()));
    await expect(assertPortRefuses('127.0.0.1', port)).resolves.toBeUndefined();
  });

  it('throws, naming the port, when something accepts', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(assertPortRefuses('127.0.0.1', port)).rejects.toThrow(`127.0.0.1:${port} accepts connections`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('launchWalletContext', () => {
  it('launches headed on a fresh profile with the wallet args', async () => {
    mockLaunchPersistentContext.mockClear();
    const context = await launchWalletContext({ wallet: 'okx', extensionPath: '/ext/okx' });
    expect(context).toEqual({ placeholder: 'context' });
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
    expect(mockLaunchPersistentContext.mock.calls[0]).toEqual(['', {
      headless: false,
      args: [
        '--disable-extensions-except=/ext/okx',
        '--load-extension=/ext/okx',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1',
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
        '--disable-blink-features=AutomationControlled',
      ],
    }]);
  });

  it('passes a persistent profile through', async () => {
    mockLaunchPersistentContext.mockClear();
    await launchWalletContext({ wallet: 'xverse', extensionPath: '/ext/xverse', userDataDir: '/seed/dir' });
    expect((mockLaunchPersistentContext.mock.calls[0] as unknown[])[0]).toBe('/seed/dir');
  });
});

describe('offlineBrowserArgs', () => {
  it('is the wallet launch less the extension: no sandbox, no /dev/shm, offline, then the caller switches', () => {
    expect(offlineBrowserArgs({ args: ['--x'] }, {})).toEqual([
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
      '--x',
    ]);
    expect(walletLaunchArgs({ extensionPath: '/e', args: ['--x'] }, {}).slice(2)).toEqual(offlineBrowserArgs({ args: ['--x'] }, {}));
  });

  it('takes the regtest hosts from env and the extra hosts from the caller', () => {
    expect(offlineBrowserArgs({ extraHosts: ['app.local'] }, { REGTEST_ORD_URL: 'http://ord.regtest.test:8080' }).slice(2)).toEqual([
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1, EXCLUDE ord.regtest.test, EXCLUDE app.local',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=localhost;127.0.0.1;[::1];ord.regtest.test;app.local',
    ]);
  });
});

describe('offlineLaunchSwitches', () => {
  it('adds no net log without ORDPOOL_E2E_NET_LOG_DIR', () => {
    expect(offlineLaunchSwitches({ name: 'xpub' }, {})).toEqual(offlineBrowserArgs({}, {}));
  });

  it('ends with the net log named after the launch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netlog-'));
    const switches = offlineLaunchSwitches({ name: 'xpub' }, { ORDPOOL_E2E_NET_LOG_DIR: dir });
    expect(switches.slice(0, -1)).toEqual(offlineBrowserArgs({}, {}));
    expect(switches[switches.length - 1]).toMatch(new RegExp(`^--log-net-log=${dir}/xpub-${process.pid}-\\d+\\.json$`));
  });
});

/** What every launch without an extension passes on the default stack, no net log. */
const OFFLINE_SWITCHES = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
];

describe('launchOfflineBrowser', () => {
  it('launches headless with the offline switches and passes launch options through', async () => {
    mockLaunch.mockClear();
    const browser = await launchOfflineBrowser({ name: 'site-routes', options: { slowMo: 7 } });
    expect(browser).toEqual({ placeholder: 'browser' });
    expect(mockLaunch.mock.calls).toEqual([[{ slowMo: 7, headless: true, args: OFFLINE_SWITCHES }]]);
  });

  it('launches headed when asked', async () => {
    mockLaunch.mockClear();
    await launchOfflineBrowser({ headless: false });
    expect(mockLaunch.mock.calls).toEqual([[{ headless: false, args: OFFLINE_SWITCHES }]]);
  });
});

describe('launchOfflineContext', () => {
  it('launches one headless persistent context on a fresh profile with the context options', async () => {
    mockLaunchPersistentContext.mockClear();
    const context = await launchOfflineContext({ name: 'xpub', options: { viewport: { width: 1280, height: 900 } } });
    expect(context).toEqual({ placeholder: 'context' });
    expect(mockLaunchPersistentContext.mock.calls).toEqual([['', {
      viewport: { width: 1280, height: 900 },
      headless: true,
      args: OFFLINE_SWITCHES,
    }]]);
  });
});

describe('every launch checks the dead proxy first', () => {
  /** net.connect answering as if something listened on the dead proxy port. */
  function deadProxyAccepts(): jest.SpyInstance {
    const realNet = jest.requireActual<typeof net>('node:net');
    return jest.spyOn(realNet, 'connect').mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { destroy: () => undefined });
      setImmediate(() => socket.emit('connect'));
      return socket as unknown as net.Socket;
    });
  }

  it.each([
    ['launchOfflineBrowser', () => launchOfflineBrowser()],
    ['launchOfflineContext', () => launchOfflineContext()],
    ['launchWalletContext', () => launchWalletContext({ extensionPath: '/ext/okx' })],
  ])('%s refuses and launches nothing', async (_name, launch) => {
    mockLaunch.mockClear();
    mockLaunchPersistentContext.mockClear();
    const spy = deadProxyAccepts();
    try {
      await expect(launch()).rejects.toThrow('127.0.0.1:9 accepts connections');
      expect(spy.mock.calls).toEqual([[9, '127.0.0.1']]);
      expect(mockLaunch.mock.calls.length + mockLaunchPersistentContext.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
