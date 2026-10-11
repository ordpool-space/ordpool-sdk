/**
 * Reads a Chrome net log (`--log-net-log`, the JSON `chrome://net-export`
 * writes) and answers one question: did anything leave the machine?
 *
 * Something left when the log shows
 * - a TCP connect attempt to an address that is not local (`tcp-connect`),
 * - a UDP datagram sent to an address that is not local (`udp-send`): DNS to
 *   a LAN or public resolver, QUIC, STUN,
 * - a host-resolver job for a host that is not local (`dns-lookup`): Chromium
 *   ran a real lookup, and on a machine whose resolver is a local stub
 *   (systemd-resolved on 127.0.0.53) the query leaves through the stub, which
 *   the log cannot see,
 * - a query of Chromium's own DNS client for a host that is not local
 *   (`dns-query`), which also covers lookups made outside a resolver job,
 *   such as a WebRTC STUN server's name.
 *
 * Local means a loopback address, an IP literal in `hosts`, or an address the
 * log shows a host in `hosts` resolving to.
 *
 * Two kinds of entries are listed but are not leaks:
 * - `blocked`: a URL request to a host that is not local. It was made and
 *   failed inside the browser (dead proxy, unresolvable name); nothing was sent.
 * - `probes`: a UDP connect to a non-local address with no datagram after it.
 *   Chromium's resolver connects a UDP socket to `2001:4860:4860::8888` to ask
 *   the kernel whether IPv6 is routable; a UDP connect sends nothing.
 */

export interface NetLogEvent {
  type: number;
  phase: number;
  source: { id: number; type: number };
  params?: Record<string, unknown>;
}

export interface NetLog {
  constants: { logEventTypes: Record<string, number>; logEventPhase: Record<string, number> };
  events: NetLogEvent[];
}

export interface NetLogReport {
  /** Traffic that left the machine, one line each: `<kind> <target>`. */
  leaks: string[];
  /** URL requests to a non-local host that failed inside the browser: `<METHOD> <origin><path>`. */
  blocked: string[];
  /** UDP connects to a non-local address without a datagram sent. */
  probes: string[];
}

/**
 * Parse a net log. Chrome completes the file (`]}`) only when the browser
 * shuts down cleanly; a log cut off by a crash or a kill ends after an event
 * and a comma, and is closed here so the events before the cut still count.
 */
export function parseNetLog(text: string): NetLog {
  try {
    return JSON.parse(text) as NetLog;
  } catch {
    return JSON.parse(`${text.replace(/[\s,]+$/, '')}]}`) as NetLog;
  }
}

/** `127.0.0.1:443` -> `127.0.0.1`, `[::1]:443` -> `::1`. */
export function addressHost(address: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (v6) return v6[1];
  return address.replace(/:\d+$/, '');
}

/** 127.0.0.0/8, `::1` and the IPv4-mapped form of 127.0.0.0/8. */
export function isLoopbackIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '');
  return /^127\.\d+\.\d+\.\d+$/.test(v4) || ip === '::1';
}

/** The host of a resolver job's `host` param: `https://a.example`, `a.example:5228`, `[::1]:80`. */
export function resolverJobHost(host: string): string {
  if (host.includes('://')) return new URL(host).hostname.replace(/^\[(.*)\]$/, '$1');
  return addressHost(host);
}

function bare(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

/** Check one net log against the hosts the browser was allowed to reach. */
export function checkNetLog(log: NetLog, hosts: readonly string[]): NetLogReport {
  const typeName = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const BEGIN = log.constants.logEventPhase.PHASE_BEGIN;
  const allowedHosts = new Set(hosts.map(bare));

  // Addresses an allowed host name resolved to, from the results on its job's source.
  const allowedJobSources = new Set<number>();
  for (const e of log.events) {
    if (typeName.get(e.type) === 'HOST_RESOLVER_MANAGER_JOB' && e.phase === BEGIN && typeof e.params?.host === 'string'
      && allowedHosts.has(bare(resolverJobHost(e.params.host)))) {
      allowedJobSources.add(e.source.id);
    }
  }
  const allowedAddresses = new Set<string>();
  for (const e of log.events) {
    if (!allowedJobSources.has(e.source.id)) continue;
    for (const m of JSON.stringify(e.params ?? {}).matchAll(/"address":"([^"]+)"/g)) allowedAddresses.add(bare(m[1]));
  }
  const isLocalIp = (ip: string): boolean => isLoopbackIp(bare(ip)) || allowedHosts.has(bare(ip)) || allowedAddresses.has(bare(ip));

  const leaks: string[] = [];
  const blocked: string[] = [];
  const udpConnects = new Map<number, string>();
  const udpSendSources = new Set<number>();
  for (const e of log.events) {
    const name = typeName.get(e.type);
    const p = e.params ?? {};
    if (name === 'TCP_CONNECT_ATTEMPT' && e.phase === BEGIN && typeof p.address === 'string' && !isLocalIp(addressHost(p.address))) {
      leaks.push(`tcp-connect ${p.address}`);
    } else if (name === 'UDP_BYTES_SENT' && typeof p.address === 'string' && !isLocalIp(addressHost(p.address))) {
      leaks.push(`udp-send ${p.address}`);
      udpSendSources.add(e.source.id);
    } else if (name === 'UDP_BYTES_SENT') {
      udpSendSources.add(e.source.id);
    } else if (name === 'UDP_CONNECT' && e.phase === BEGIN && typeof p.address === 'string' && !isLocalIp(addressHost(p.address))) {
      udpConnects.set(e.source.id, p.address);
    } else if (name === 'HOST_RESOLVER_MANAGER_JOB' && e.phase === BEGIN && typeof p.host === 'string') {
      const host = resolverJobHost(p.host);
      if (!allowedHosts.has(bare(host)) && !isLoopbackIp(bare(host))) leaks.push(`dns-lookup ${host}`);
    } else if (name === 'DNS_TRANSACTION' && e.phase === BEGIN && typeof p.hostname === 'string') {
      const host = p.hostname.replace(/\.$/, '');
      if (!allowedHosts.has(bare(host))) leaks.push(`dns-query ${host}`);
    } else if (name === 'URL_REQUEST_START_JOB' && e.phase === BEGIN && typeof p.url === 'string') {
      const url = new URL(p.url);
      if (/^(https?|wss?):$/.test(url.protocol) && !allowedHosts.has(bare(url.hostname)) && !isLoopbackIp(bare(url.hostname))) {
        blocked.push(`${String(p.method ?? 'GET')} ${url.origin}${url.pathname}`);
      }
    }
  }
  const probes: string[] = [];
  for (const [source, address] of udpConnects) {
    // A connected UDP socket that also sent is already a `udp-send` leak (its
    // UDP_BYTES_SENT carries no address when the socket is connected, so
    // count it here).
    if (udpSendSources.has(source)) leaks.push(`udp-send ${address}`);
    else probes.push(`udp-connect ${address}`);
  }
  return { leaks, blocked, probes };
}
