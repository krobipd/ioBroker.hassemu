import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { evictOldest } from "./coerce";
import { TARGET_HEALTH_CACHE_CAP, TARGET_PROBE_CACHE_MS, TARGET_PROBE_TIMEOUT_MS } from "./constants";
import type { AdapterInterface } from "./types";

/**
 * Probe seam for {@link TargetHealth} — production uses {@link probeTarget},
 * tests inject a fake to steer reachability without sockets.
 */
export type TargetProbe = (url: string, timeoutMs: number) => Promise<boolean>;

/**
 * One reachability probe of a redirect target (v1.39.0).
 *
 * "Reachable" means: ANY HTTP response arrives — status codes are deliberately
 * not judged. A target behind a login (401), a misconfigured path (404) or an
 * erroring dashboard (500) still has a server answering, and alarming on those
 * would flood users whose setup works fine in the display. Only a connection
 * failure or timeout counts as down.
 *
 * TLS certificates are NOT verified (`rejectUnauthorized: false`): the probe
 * asks "does something answer", not "is it authentic" — LAN dashboards with
 * self-signed certificates are the norm, and the display's own WebView applies
 * its own trust rules when it loads the target.
 *
 * URLs the probe cannot assess (unparseable, non-http/https) resolve to `true`:
 * a probe limitation must never put a down-card over a display.
 *
 * @param url       Target URL as resolved for the display.
 * @param timeoutMs Abort the attempt after this many milliseconds.
 */
export function probeTarget(url: string, timeoutMs: number): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(true);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    let settled = false;
    const settle = (alive: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(alive);
      }
    };
    const isHttps = parsed.protocol === "https:";
    const options = isHttps
      ? { method: "GET", timeout: timeoutMs, rejectUnauthorized: false }
      : { method: "GET", timeout: timeoutMs };
    const req = (isHttps ? httpsRequest : httpRequest)(parsed, options, res => {
      // Response headers arrived — that is the whole question. Drop the body.
      res.destroy();
      settle(true);
    });
    // `destroy()` after timeout also emits 'error' — the settle guard absorbs it.
    req.on("timeout", () => {
      req.destroy();
      settle(false);
    });
    req.on("error", () => settle(false));
    req.end();
  });
}

/** Cached probe verdict for one target URL. */
interface HealthEntry {
  alive: boolean;
  checkedAt: number;
}

/**
 * Reachability tracker for redirect targets (v1.39.0).
 *
 * Lazily probes on demand — driven by the displays' `/api/redirect_check` polls
 * and the initial wrapper render, never by an own timer, so an idle adapter
 * (no display connected) probes nothing. Results are cached for
 * {@link TARGET_PROBE_CACHE_MS} and concurrent askers of the same URL share one
 * in-flight probe, so N displays on one target cost one probe per poll round.
 *
 * Logs reachability TRANSITIONS at info (down / recovered, once per flip) —
 * a target going away is exactly the "relevant event" tier of the logging
 * strategy, while steady state stays silent.
 */
export class TargetHealth {
  private readonly adapter: AdapterInterface;
  private readonly probe: TargetProbe;
  private readonly cacheMs: number;
  private readonly cache = new Map<string, HealthEntry>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  /**
   * @param adapter Adapter surface (logging).
   * @param probe   Probe implementation ({@link probeTarget} in production).
   * @param cacheMs Result validity window (test seam; default {@link TARGET_PROBE_CACHE_MS}).
   */
  constructor(adapter: AdapterInterface, probe: TargetProbe = probeTarget, cacheMs: number = TARGET_PROBE_CACHE_MS) {
    this.adapter = adapter;
    this.probe = probe;
    this.cacheMs = cacheMs;
  }

  /**
   * Whether `url` currently answers, from cache or via one shared probe.
   *
   * @param url Target URL as resolved for the display.
   */
  async isReachable(url: string): Promise<boolean> {
    const entry = this.cache.get(url);
    if (entry && Date.now() - entry.checkedAt < this.cacheMs) {
      return entry.alive;
    }
    const pending = this.inflight.get(url);
    if (pending) {
      return pending;
    }
    const run = this.probe(url, TARGET_PROBE_TIMEOUT_MS)
      // Fail OPEN: a prober defect is not a target outage — the card is an alarm
      // for the user and a wrongly raised one is worse than none.
      .catch(() => true)
      .then(alive => {
        this.inflight.delete(url);
        const prev = this.cache.get(url)?.alive;
        evictOldest(this.cache, TARGET_HEALTH_CACHE_CAP);
        this.cache.set(url, { alive, checkedAt: Date.now() });
        if (!alive && prev !== false) {
          this.adapter.log.info(`Redirect target not reachable: ${url}`);
        } else if (alive && prev === false) {
          this.adapter.log.info(`Redirect target reachable again: ${url}`);
        }
        return alive;
      });
    this.inflight.set(url, run);
    return run;
  }

  /** Drops cache and in-flight bookkeeping (webserver stop). */
  dispose(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
