import Bonjour from "bonjour-service";
import { DEFAULT_SERVICE_NAME, HA_VERSION, MDNS_ADDRESS_CHECK_INTERVAL_MS } from "./constants";
import { errText } from "./err-text";
import { advertisedBaseUrl, isWildcardBind } from "./network";
import type { AdapterConfig, AdapterInterface } from "./types";

type PublishedService = ReturnType<InstanceType<typeof Bonjour>["publish"]>;

/** mDNS service for Home Assistant discovery via bonjour-service */
export class MDNSService {
  private readonly adapter: AdapterInterface;
  private readonly config: AdapterConfig;
  /** Shared server UUID (constructor input). Exposed read-only for the unit tests only — no production reader (main.ts already holds the uuid). v1.37.0 (L25). */
  public readonly uuid: string;
  private active = false;
  private bonjour: Bonjour | null = null;
  private published: PublishedService | null = null;
  /** The base URL the current announcement carries. */
  private advertisedBase = "";
  /** Periodic address comparison — only with a wildcard bind, where the address can change. */
  private addressCheck: ioBroker.Interval | undefined;
  private refreshing = false;
  /** Where the advertised base URL comes from (test seam). */
  private readonly baseUrlOf: () => string;

  /** Read-only flag — true between successful `start()` and `stop()`. */
  public isActive(): boolean {
    return this.active;
  }

  /**
   * Creates a new MDNSService instance
   *
   * @param adapter - Adapter interface for logging
   * @param config - Adapter configuration
   * @param uuid - Shared UUID for consistent identity across WebServer and mDNS
   * @param baseUrlOf - Source of the advertised base URL (test seam; default: bind address or LAN address)
   */
  constructor(adapter: AdapterInterface, config: AdapterConfig, uuid: string, baseUrlOf?: () => string) {
    this.adapter = adapter;
    this.config = config;
    this.uuid = uuid;
    this.baseUrlOf = baseUrlOf ?? (() => advertisedBaseUrl(config.bind, config.port));
  }

  /** Start mDNS broadcasting via bonjour-service */
  start(): void {
    this.advertisedBase = this.baseUrlOf();
    this.announce();
    // With a wildcard bind the advertised address is the host's LAN address, which DHCP can
    // change; the TXT record carries it as base_url, and HA clients read it from there. The
    // A/AAAA records bonjour builds per announcement, the TXT record only here — so compare
    // once a minute and announce again when it moved (audit 2026-09-25, H10).
    if (this.active && isWildcardBind(this.config.bind)) {
      this.addressCheck =
        this.adapter.setInterval(() => void this.refreshIfAddressChanged(), MDNS_ADDRESS_CHECK_INTERVAL_MS) ??
        undefined;
    }
  }

  /**
   * Announce again when the advertised address changed. bonjour-service 1.4.4 has no TXT
   * update (`service.js` builds the TXT record once per publish; `registry.register` keeps a
   * second record beside the first), so the old service says goodbye and a new one is
   * published.
   */
  async refreshIfAddressChanged(): Promise<void> {
    if (!this.active || this.refreshing) {
      return;
    }
    const next = this.baseUrlOf();
    if (next === this.advertisedBase) {
      return;
    }
    this.refreshing = true;
    try {
      this.adapter.log.info(`mDNS: address changed ${this.advertisedBase} → ${next} — announcing again`);
      await this.withdraw(false);
      this.advertisedBase = next;
      this.announce();
    } finally {
      this.refreshing = false;
    }
  }

  /** Publish the service with the current {@link advertisedBase}. */
  private announce(): void {
    const baseUrl = this.advertisedBase;
    const serviceName = this.config.serviceName || DEFAULT_SERVICE_NAME;

    try {
      this.bonjour = new Bonjour();

      // L35: all TXT values below are non-empty by construction (no conditional
      // drop happens here) — build the advertised record.
      const txt: Record<string, string> = {
        base_url: baseUrl,
        internal_url: baseUrl,
        version: HA_VERSION,
        uuid: this.uuid,
        location_name: serviceName,
        // Legacy key: HA core dropped it from the announcement in 2026.7.0 (#173090) and no
        // Companion app reads it; kept for closed-source clients. TXT values are strings.
        requires_api_password: this.config.authRequired ? "True" : "False",
      };

      this.published = this.bonjour.publish({
        name: serviceName,
        type: "home-assistant",
        protocol: "tcp",
        port: this.config.port,
        txt,
      });

      // v1.15.0 (D12): bonjour raises bind errors (e.g. port 5353 taken) ASYNCHRONOUSLY in its
      // dgram sockets — the try/catch around this does not see them. The event hands over
      // whatever was emitted, so the text goes through errText (a string event read
      // `undefined` off `.message` — audit 2026-09-25, H13).
      this.published.on?.("error", (err: unknown) => {
        this.adapter.log.warn(`mDNS async publish error: ${errText(err)}`);
        this.active = false;
        try {
          this.bonjour?.destroy();
        } catch {
          /* best effort */
        }
        this.bonjour = null;
        this.published = null;
      });

      this.active = true;

      this.adapter.log.debug(`mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local at ${baseUrl}`);
      this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
    } catch (err) {
      this.adapter.log.warn(`mDNS failed to start: ${errText(err)}`);
      // Release the bonjour instance, or its UDP socket leaks for the adapter's lifetime —
      // `stop()` short-circuits on `!this.active` and would clean nothing.
      try {
        this.bonjour?.destroy();
      } catch {
        /* destroy may throw — we only want the resource released */
      }
      this.bonjour = null;
      this.published = null;
    }
  }

  /**
   * Stop mDNS broadcasting. Resolves once the goodbye announcement has left the
   * socket and the sockets are released — `onUnload` awaits this before reporting
   * done, so the process is not torn down mid-goodbye.
   *
   * @param shuttingDown pass `true` from the onUnload path — there we skip the
   *   managed fallback timer (adapter-core refuses managed timers during shutdown;
   *   the awaited promise takes its place). Defaults to `false` for the runtime
   *   re-init path, where the adapter keeps running and the fallback matters.
   */
  stop(shuttingDown = false): Promise<void> {
    if (this.addressCheck) {
      this.adapter.clearInterval(this.addressCheck);
      this.addressCheck = undefined;
    }
    return this.withdraw(shuttingDown);
  }

  /**
   * Say goodbye and release the sockets — {@link stop} without ending the address check.
   *
   * @param shuttingDown See {@link stop}.
   */
  private withdraw(shuttingDown: boolean): Promise<void> {
    if (!this.active) {
      return Promise.resolve();
    }
    this.active = false;
    const published = this.published;
    const bonjour = this.bonjour;
    this.published = null;
    this.bonjour = null;

    // I1: give the mDNS goodbye a chance to leave the socket buffer before the
    // sockets are destroyed. `published.stop(cb)` sends the unregister (TTL=0)
    // announcement asynchronously and then calls `cb`; `destroy()` closes the
    // sockets. So destroy from the stop-callback instead of destroying immediately
    // (which dropped the goodbye). Best-effort: in the synchronous onUnload path
    // js-controller may end the process before the goodbye leaves the buffer, so a
    // guaranteed goodbye isn't achievable — this only improves the odds without
    // blocking unload. (Verified against bonjour-service 1.4.4, the installed version: registry.stop takes
    // a callback and teardown announces before invoking it.) v1.37.0 (I1).
    return new Promise<void>(resolve => {
      let destroyed = false;
      const destroy = (): void => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        try {
          bonjour?.destroy();
        } catch {
          /* best effort — we just want the socket released */
        }
        resolve();
      };
      try {
        if (published?.stop) {
          published.stop(destroy);
          if (!shuttingDown) {
            // Runtime re-init (onReady H7): the adapter keeps running, so arm a
            // short fallback to release the sockets if stop's callback never fires.
            // Skipped on shutdown — a managed timer would only warn there, and the
            // host's own stop timeout is the backstop for a callback that never comes.
            this.adapter.setTimeout(destroy, 300);
          }
        } else {
          destroy();
        }
        this.adapter.log.debug("mDNS: Service stopped");
      } catch (err) {
        this.adapter.log.warn(`mDNS could not stop cleanly: ${errText(err)}`);
        destroy();
      }
    });
  }
}
