/**
 * Reverse-DNS hostname resolution for display IPs.
 *
 * Split out of `webserver.ts` (v1.43.0): the web server owned the lookup, an in-flight
 * set and a negative cache purely because that is where the IP happened to arrive. None
 * of it is HTTP — it is "given an IP, find a name, without ever stalling a request or
 * hammering a resolver that has no PTR record".
 *
 * Two guards, both of which existed before and are kept verbatim:
 * - a hard timeout, because Node's DNS has none (a broken resolver otherwise left the
 *   promise pending for the adapter's lifetime, D5 v1.8.1),
 * - a negative cache, because a DHCP client without a PTR record is the LAN norm and
 *   would otherwise trigger a fresh lookup plus timer on every 15/30 s poll (L6).
 */

import dns from "node:dns/promises";
import { oneLine } from "./coerce";
import { DNS_NEGATIVE_CACHE_MS, DNS_REVERSE_TIMEOUT_MS } from "./constants";
import type { AdapterInterface } from "./types";

/**
 * Decides whether a reverse-DNS lookup should be attempted for a client IP. Skips when
 * the client already has a hostname, a lookup for that IP is already in flight, or the
 * IP resolved to no hostname within the negative-cache window (the LAN norm for DHCP
 * clients without a PTR record \u2014 L6). Pure so the negative-cache decision is unit-testable
 * without driving real DNS or timers. v1.38.0 (I8).
 *
 * @param opts                 Reverse-DNS decision inputs.
 * @param opts.hasHostname     True if the client already has a resolved hostname.
 * @param opts.inFlight        True if a lookup for this IP is already running.
 * @param opts.lastNegative    Timestamp (ms) of the last no-hostname result, or undefined.
 * @param opts.now             Current time in ms.
 * @param opts.negativeCacheMs Negative-cache window in ms.
 */
export function shouldAttemptReverseDns(opts: {
  hasHostname: boolean;
  inFlight: boolean;
  lastNegative: number | undefined;
  now: number;
  negativeCacheMs: number;
}): boolean {
  if (opts.hasHostname || opts.inFlight) {
    return false;
  }
  if (opts.lastNegative !== undefined && opts.now - opts.lastNegative < opts.negativeCacheMs) {
    return false;
  }
  return true;
}

/** What the resolver needs to be told about the client whose IP it is looking up. */
export interface HostnameTarget {
  /** Short client id — used for log anchors only. */
  id: string;
  /** Cookie identifying the client to the registry when the lookup returns. */
  cookie: string;
  /** Whether this client already carries a hostname (then nothing is looked up). */
  hasHostname: boolean;
}

/** Callback invoked with a successfully resolved hostname. */
export type HostnameSink = (cookie: string, hostname: string) => Promise<void>;

/**
 * Resolves display IPs to hostnames in the background, with a deadline, an in-flight
 * guard and a negative cache. One instance per web server; `clear()` on shutdown.
 */
export class HostnameResolver {
  private readonly adapter: AdapterInterface;
  private readonly sink: HostnameSink;
  /** IPs whose reverse lookup is currently running — prevents duplicate work. */
  private readonly inFlight = new Set<string>();
  /**
   * IP → time a lookup last yielded no hostname. Re-queried only after
   * {@link DNS_NEGATIVE_CACHE_MS}; pruned by {@link prune}, dropped by {@link clear}.
   */
  private readonly negativeCache = new Map<string, number>();

  /**
   * @param adapter Adapter surface (logging + managed timers).
   * @param sink    Receives `(cookie, hostname)` for a successful lookup — the registry's
   *                update path, which is a no-op if the client vanished meanwhile (M5).
   */
  constructor(adapter: AdapterInterface, sink: HostnameSink) {
    this.adapter = adapter;
    this.sink = sink;
  }

  /**
   * Start a lookup for `ip` unless it is pointless (client already named, lookup running,
   * or the IP is known to have no PTR record). Fire-and-forget by design — a page request
   * must never wait for DNS.
   *
   * @param target The client the IP belongs to.
   * @param ip     Remote IP observed for that client.
   */
  resolve(target: HostnameTarget, ip: string): void {
    // I8: the skip decision lives in the pure `shouldAttemptReverseDns` so the
    // negative-cache window is unit-testable without driving real DNS.
    if (
      !shouldAttemptReverseDns({
        hasHostname: target.hasHostname,
        inFlight: this.inFlight.has(ip),
        lastNegative: this.negativeCache.get(ip),
        now: Date.now(),
        negativeCacheMs: DNS_NEGATIVE_CACHE_MS,
      })
    ) {
      return;
    }
    this.inFlight.add(ip);
    // v1.8.1 (D5): hard deadline — Node's DNS has NO timeout, so a broken resolver
    // (captive portal, misconfiguration) left the promise pending forever and pinned the
    // IP in `inFlight` for the adapter's lifetime. v1.34.0: adapter-managed timer, cleared
    // as soon as `dns.reverse` wins the race, so nothing dangles across a restart.
    let timeoutHandle: ioBroker.Timeout | undefined;
    const timeout = new Promise<string[]>((_, reject) => {
      timeoutHandle = this.adapter.setTimeout(
        () => reject(new Error("dns reverse-lookup timeout")),
        DNS_REVERSE_TIMEOUT_MS,
      );
    });
    Promise.race([dns.reverse(ip), timeout])
      .then(names => {
        const name = names[0];
        if (name) {
          // v1.32.0 A4: the IP→hostname resolution is the anchor for "why does display X
          // have hostname Y?". L1(a): a PTR label is attacker-influenceable — flatten it.
          this.adapter.log.debug(`resolveHostname: ip=${ip} → hostname=${oneLine(name)}`);
          this.sink(target.cookie, name).catch(err =>
            this.adapter.log.debug(`resolveHostname: persist for ${target.id} failed — ${String(err)}`),
          );
        } else {
          this.negativeCache.set(ip, Date.now()); // no PTR — remember (L6)
        }
      })
      .catch(err => {
        // v1.32.0 A3: reverse DNS fails on a LAN often and legitimately → debug, but with
        // a diagnostic anchor. L6: cache the failure so it is not retried every poll.
        this.negativeCache.set(ip, Date.now());
        this.adapter.log.debug(
          `resolveHostname: ip=${ip} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        if (timeoutHandle) {
          this.adapter.clearTimeout(timeoutHandle);
        }
        this.inFlight.delete(ip);
      });
  }

  /**
   * Drop expired negative-cache entries so the map stays bounded by recently-seen no-PTR
   * IPs rather than every IP ever seen (L6). Called from the web server's cleanup pass.
   *
   * @param now Current time in ms.
   * @returns How many entries were dropped.
   */
  prune(now: number): number {
    let removed = 0;
    for (const [ip, ts] of this.negativeCache) {
      if (now - ts >= DNS_NEGATIVE_CACHE_MS) {
        this.negativeCache.delete(ip);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Forget all bookkeeping (web server stop). v1.28.3 (HW1): a slow lookup started just
   * before the stop would otherwise keep its IP pinned in `inFlight` for up to five
   * seconds — long enough to matter when the adapter restarts inside that window.
   */
  clear(): void {
    this.inFlight.clear();
    this.negativeCache.clear();
  }

  /** In-flight lookup count — test seam. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Negative-cache size — test seam. */
  get negativeCacheSize(): number {
    return this.negativeCache.size;
  }
}
