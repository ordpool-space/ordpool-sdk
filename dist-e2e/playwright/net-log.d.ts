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
    source: {
        id: number;
        type: number;
    };
    params?: Record<string, unknown>;
}
export interface NetLog {
    constants: {
        logEventTypes: Record<string, number>;
        logEventPhase: Record<string, number>;
    };
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
export declare function parseNetLog(text: string): NetLog;
/** `127.0.0.1:443` -> `127.0.0.1`, `[::1]:443` -> `::1`. */
export declare function addressHost(address: string): string;
/** 127.0.0.0/8, `::1` and the IPv4-mapped form of 127.0.0.0/8. */
export declare function isLoopbackIp(ip: string): boolean;
/** The host of a resolver job's `host` param: `https://a.example`, `a.example:5228`, `[::1]:80`. */
export declare function resolverJobHost(host: string): string;
/** Check one net log against the hosts the browser was allowed to reach. */
export declare function checkNetLog(log: NetLog, hosts: readonly string[]): NetLogReport;
//# sourceMappingURL=net-log.d.ts.map