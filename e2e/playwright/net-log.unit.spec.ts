/**
 * @test-kind unit
 * Real:   parseNetLog, checkNetLog, addressHost, isLoopbackIp, resolverJobHost
 * Faked:  nothing; the inputs are Chrome net logs captured 2026-10-11 from Chrome for Testing
 *         148.0.7778.96 (Playwright 1.60 persistent context, macOS) in net-log-fixtures/, cut to the event
 *         types checkNetLog reads, query strings removed
 * Proves: a log with the network up reports every connect, datagram and lookup that left the machine; the
 *         same browser under offlineLaunchArgs reports none and lists its failed requests as blocked
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { addressHost, checkNetLog, isLoopbackIp, parseNetLog, resolverJobHost } from './net-log';

const fixture = (name: string): string => fs.readFileSync(path.resolve(__dirname, 'net-log-fixtures', name), 'utf8');
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** The distinct entries of a list, sorted. */
const distinct = (xs: string[]): string[] => [...new Set(xs)].sort();

describe('checkNetLog on captured logs', () => {
  it('network up: every external connect, datagram and lookup is a leak', () => {
    // Chromium with no launch rules, navigating to example.com, https://47.57.9.204/ and wss://echo.websocket.org
    // and idling: its own background requests (clients2 time, ListAccounts, folae, GCM checkin) go out too.
    const report = checkNetLog(parseNetLog(fixture('chromium-148-online.json')), LOOPBACK);
    expect(distinct(report.leaks.filter((l) => l.startsWith('dns-lookup ')))).toEqual([
      'dns-lookup accounts.google.com',
      'dns-lookup android.clients.google.com',
      'dns-lookup clients2.google.com',
      'dns-lookup echo.websocket.org',
      'dns-lookup example.com',
      'dns-lookup mtalk.google.com',
      'dns-lookup www.google.com',
    ]);
    expect(report.leaks).toContain('tcp-connect 47.57.9.204:443');
    expect(report.leaks).toContain('tcp-connect [2a00:1450:400c:c04::bc]:5228');
    expect(report.leaks).toContain('udp-send 192.168.178.1:53');
    expect(report.leaks).toContain('udp-send 142.251.127.139:443');
    expect(report.probes).toContain('udp-connect [2001:4860:4860::8888]:443');
  });

  it('network up, WebRTC: the STUN name query and both STUN datagrams are leaks', () => {
    // Proxy flags only, no resolver rules: one STUN server by name, one by IP literal.
    const report = checkNetLog(parseNetLog(fixture('chromium-148-webrtc-proxy-only.json')), LOOPBACK);
    expect(distinct(report.leaks)).toEqual([
      'dns-query stun.l.google.com',
      'udp-send 192.168.178.1:53',
      'udp-send 74.125.250.129:19302',
      'udp-send [2001:4860:4864:5:8000::1]:19302',
    ]);
  });

  it('under offlineLaunchArgs: nothing leaves, the attempts are listed as blocked', () => {
    const report = checkNetLog(parseNetLog(fixture('chromium-148-offline.json')), LOOPBACK);
    expect(report.leaks).toEqual([]);
    expect(distinct(report.blocked)).toEqual([
      'GET http://clients2.google.com/time/1/current',
      'GET https://47.57.9.204/',
      'GET https://example.com/',
      'GET https://www.google.com/async/folae',
      'GET wss://echo.websocket.org/',
      'POST https://accounts.google.com/ListAccounts',
      'POST https://android.clients.google.com/checkin',
    ]);
    expect(distinct(report.probes)).toEqual(['udp-connect [2001:4860:4860::8888]:443']);
  });
});

describe('checkNetLog rules', () => {
  const constants = {
    logEventTypes: { TCP_CONNECT_ATTEMPT: 1, UDP_CONNECT: 2, UDP_BYTES_SENT: 3, HOST_RESOLVER_MANAGER_JOB: 4, HOST_RESOLVER_DNS_TASK: 5 },
    logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 },
  };
  const ev = (type: number, phase: number, id: number, params?: Record<string, unknown>) => ({ type, phase, source: { id, type: 0 }, params });

  it('an allowed host name and the addresses the log shows it resolving to are local', () => {
    const log = {
      constants,
      events: [
        ev(4, 1, 7, { host: 'http://electrs.regtest.test:3010' }),
        ev(5, 2, 7, { results: [{ endpoints: [{ address: '10.0.0.5', port: 0 }] }] }),
        ev(1, 1, 8, { address: '10.0.0.5:3010' }),
        ev(1, 1, 9, { address: '10.0.0.6:3010' }),
      ],
    };
    expect(checkNetLog(log, [...LOOPBACK, 'electrs.regtest.test']).leaks).toEqual(['tcp-connect 10.0.0.6:3010']);
    expect(checkNetLog(log, LOOPBACK).leaks).toEqual([
      'dns-lookup electrs.regtest.test',
      'tcp-connect 10.0.0.5:3010',
      'tcp-connect 10.0.0.6:3010',
    ]);
  });

  it('a connected UDP socket that sends is a leak, one that only connects is a probe', () => {
    const log = {
      constants,
      events: [
        ev(2, 1, 1, { address: '8.8.8.8:53' }),
        ev(3, 0, 1, { byte_count: 28 }),
        ev(2, 1, 2, { address: '[2001:4860:4860::8888]:443' }),
        ev(2, 1, 3, { address: '127.0.0.53:53' }),
        ev(3, 0, 3, { byte_count: 40 }),
      ],
    };
    expect(checkNetLog(log, LOOPBACK)).toEqual({
      leaks: ['udp-send 8.8.8.8:53'],
      blocked: [],
      probes: ['udp-connect [2001:4860:4860::8888]:443'],
    });
  });
});

describe('net-log parsing helpers', () => {
  it('parseNetLog closes a log cut off after an event', () => {
    const cut = '{"constants":{"logEventTypes":{},"logEventPhase":{}},"events":[\n{"type":1,"phase":0,"source":{"id":1,"type":0}},\n';
    expect(parseNetLog(cut).events).toEqual([{ type: 1, phase: 0, source: { id: 1, type: 0 } }]);
  });

  it('addressHost strips the port and IPv6 brackets', () => {
    expect(addressHost('127.0.0.1:9')).toBe('127.0.0.1');
    expect(addressHost('[::1]:4500')).toBe('::1');
    expect(addressHost('[2a00:1450:400c:c04::bc]:5228')).toBe('2a00:1450:400c:c04::bc');
  });

  it('isLoopbackIp: 127/8, ::1 and the mapped form, nothing else', () => {
    expect(['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1'].map(isLoopbackIp)).toEqual([true, true, true, true]);
    expect(['10.0.0.1', '128.0.0.1', '2001:4860:4860::8888', '::'].map(isLoopbackIp)).toEqual([false, false, false, false]);
  });

  it('resolverJobHost reads the three shapes Chromium logs', () => {
    expect(resolverJobHost('https://www.google.com')).toBe('www.google.com');
    expect(resolverJobHost('mtalk.google.com:5228')).toBe('mtalk.google.com');
    expect(resolverJobHost('http://[::1]:4500')).toBe('::1');
  });
});
