import Bonjour from "bonjour-service";
import { DEFAULT_SERVICE_NAME, HA_VERSION } from "./constants";
import { resolveAdvertisedHost } from "./network";
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
   */
  constructor(adapter: AdapterInterface, config: AdapterConfig, uuid: string) {
    this.adapter = adapter;
    this.config = config;
    this.uuid = uuid;
  }

  /** Start mDNS broadcasting via bonjour-service */
  start(): void {
    const host = resolveAdvertisedHost(this.config.bindAddress);
    const baseUrl = `http://${host}:${this.config.port}`;
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
        // mDNS-TXT ist string-only — boolean explizit zu „True"/„False" mappen.
        // Vorher hardcoded 'True' unabhängig von authRequired → Spec-Drift (HA-Clients
        // mit strict-mode triggerten Auth-Flow auch bei authRequired=false).
        requires_api_password: this.config.authRequired ? "True" : "False",
      };

      this.published = this.bonjour.publish({
        name: serviceName,
        type: "home-assistant",
        protocol: "tcp",
        port: this.config.port,
        txt,
      });

      // v1.15.0 (D12): Bonjour wirft Bind-Fehler (z.B. Port 5353 belegt)
      // ASYNCHRON in dgram-Sockets — der sync try/catch oben fängt das
      // nicht. Listener auf 'error' anhängen, dann active=false zurücksetzen.
      this.published.on?.("error", (err: Error) => {
        this.adapter.log.warn(`mDNS async publish error: ${err.message}`);
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

      this.adapter.log.debug(
        `mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local on ${host}:${this.config.port}`,
      );
      this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
    } catch (error) {
      const err = error as Error;
      this.adapter.log.warn(`mDNS failed to start: ${err.message}`);
      // Wichtig: bonjour-instance freigeben sonst leakt der UDP-Socket
      // über die Adapter-Lifetime. `stop()` short-circuit'd auf
      // `!this.active` und würde nichts cleanen.
      try {
        this.bonjour?.destroy();
      } catch {
        /* destroy darf re-throwen — wir wollen nur die Resource lossen */
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
    // blocking unload. (Verified against bonjour-service 1.4.2: registry.stop takes
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
      } catch (error) {
        const err = error as Error;
        this.adapter.log.warn(`mDNS could not stop cleanly: ${err.message}`);
        destroy();
      }
    });
  }
}
