import Bonjour from "bonjour-service";
import { DEFAULT_SERVICE_NAME, HA_VERSION, MDNS_ADDRESS_CHECK_INTERVAL_MS } from "./constants";
import { errText } from "./err-text";
import { chosenAddress, localNets, type LocalNet } from "./network-address";
import { advertisedBaseUrl, hostNets } from "./network";
import type { AdapterConfig, AdapterInterface } from "./types";

type PublishedService = ReturnType<InstanceType<typeof Bonjour>["publish"]>;

/** bonjour-service 1.4.4 hands its options to multicast-dns unchanged, but types them as the service record only. */
type MdnsSocketOptions = Partial<Bonjour.ServiceConfig> & { interface?: string; bind?: string };

/**
 * The multicast socket for a bind setting. The chosen address is the only one the adapter
 * sends on (krobi 2026-10-03, fleet master network-address.ts; review 2026-11-07, R-20):
 * multicast-dns joins the group and sends on that interface. The socket stays on every
 * address — bound to the interface address it would receive no multicast on Linux
 * (multicast-dns 7.2.5 `socket.bind(port, opts.bind || opts.interface)`). The address field
 * is IPv4 only (`onlyIp4`). Every address names no interface here — {@link announcements} then sends from each
 * own network's interface.
 *
 * @param bind The effective bind setting.
 */
export function mdnsSocketOptions(bind: string | undefined): MdnsSocketOptions {
  const chosen = chosenAddress(bind);
  return chosen === undefined ? {} : { interface: chosen, bind: "0.0.0.0" };
}

/** One announcement: the socket it goes out on, the base URL its TXT record carries, whether bonjour probes the name. */
export interface Announcement {
  /** Where the multicast socket binds and which interface it sends on. */
  socket: MdnsSocketOptions;
  /** The base URL of hassemu as a display in this network reaches it. */
  baseUrl: string;
  /** Whether bonjour probes the name first — only where no second announcement of this host answers the probe. */
  probe: boolean;
}

/**
 * The announcements for a bind setting — an announcement goes out without anybody asking, so it is not one address
 * chosen for every display (werkbank standard on D17, correction of 2026-11-15; model: iobroker.fakeroku
 * `ssdp-responder.ts` `openSenders`, one sender per interface):
 * - a chosen address: one announcement, from its interface ({@link mdnsSocketOptions});
 * - every address: one announcement per own IPv4 network (master `localNets`), from that network's interface and with
 *   its address — multicast-dns 7.2.5 joins and sends on `interface`, and an answer goes to the group on it, never to
 *   the asker, so a display hears the address of its own network (krobi 2026-11-11 19:34 as the fleet rule). hassemu
 *   picks none of them, and none is put back (no Docker, VM or VPN filter).
 * With HTTPS and a certificate name (K4) every announcement names that name instead of the address. Several
 * announcements carry one name on different links, which mDNS allows — but bonjour-service 1.4.4 takes a sibling's
 * answer on the shared port 5353 for a conflict (`registry.probe`: any answer for the name stops the service), so only a
 * single announcement probes its name first. The mDNS socket is IPv4 (`udp4`): a host without an IPv4 network
 * announces nothing until one comes (the address check).
 *
 * @param bind   The effective bind setting.
 * @param port   The listen port.
 * @param secure The HTTPS part (`name`: the certificate's name), or nothing for plain HTTP.
 * @param nets   The host's networks (test seam; read fresh by default).
 * @returns The announcements; none when the host sits in no IPv4 network.
 */
export function announcements(
  bind: string | undefined,
  port: number,
  secure?: { name: string | undefined } | null,
  nets: readonly LocalNet[] = localNets(),
): Announcement[] {
  const chosen = chosenAddress(bind);
  if (chosen !== undefined) {
    return [{ socket: mdnsSocketOptions(bind), baseUrl: advertisedBaseUrl(chosen, port, secure), probe: true }];
  }
  const v4 = hostNets(bind, nets).filter(n => n.family === "IPv4");
  return v4.map(n => ({
    socket: { interface: n.address, bind: "0.0.0.0" },
    baseUrl: advertisedBaseUrl(n.address, port, secure),
    probe: v4.length === 1,
  }));
}

/** One running announcement: its bonjour instance and the published service. */
interface Announced {
  bonjour: Bonjour | null;
  published: PublishedService | null;
}

/** mDNS service for Home Assistant discovery via bonjour-service */
export class MDNSService {
  private readonly adapter: AdapterInterface;
  private readonly config: AdapterConfig;
  /** Shared server UUID (constructor input) — goes into the TXT record. */
  private readonly uuid: string;
  /** The HTTPS part of this start, or null for plain HTTP (K4). */
  private readonly secure: { name: string | undefined } | null;
  /** Where the host's networks come from (test seam). */
  private readonly netsOf: () => readonly LocalNet[];
  /** True between `start()` and `stop()`. */
  private started = false;
  /** The announcements on the air. */
  private announced: Announced[] = [];
  /** The base URLs of the current announcements — what the address check compares. */
  private advertisedKey = "";
  /** Periodic address comparison — only with a wildcard bind, where the address can change. */
  private addressCheck: ioBroker.Interval | undefined;
  private refreshing = false;

  /** Read-only flag — true while at least one announcement is on the air. */
  public isActive(): boolean {
    return this.announced.length > 0;
  }

  /**
   * Creates a new MDNSService instance
   *
   * @param adapter - Adapter interface for logging
   * @param config - Adapter configuration
   * @param uuid - Shared UUID for consistent identity across WebServer and mDNS
   * @param secure - The HTTPS part (`name`: the certificate's name), or nothing for plain HTTP
   * @param netsOf - Source of the host's networks (test seam; default: read fresh)
   */
  constructor(
    adapter: AdapterInterface,
    config: AdapterConfig,
    uuid: string,
    secure?: { name: string | undefined } | null,
    netsOf: () => readonly LocalNet[] = localNets,
  ) {
    this.adapter = adapter;
    this.config = config;
    this.uuid = uuid;
    this.secure = secure ?? null;
    this.netsOf = netsOf;
  }

  /** The announcements the current networks ask for. */
  private plan(): Announcement[] {
    return announcements(this.config.bind, this.config.port, this.secure, this.netsOf());
  }

  /** Start mDNS broadcasting via bonjour-service */
  start(): void {
    this.started = true;
    const plan = this.plan();
    this.advertisedKey = keyOf(plan);
    this.announceAll(plan);
    // With a wildcard bind the networks are the host's, which DHCP can change; the TXT record carries the address as
    // base_url, and HA clients read it from there. The A/AAAA records bonjour builds per announcement, the TXT record
    // only here — so compare once a minute and announce again when it moved (audit 2026-09-25, H10).
    if (chosenAddress(this.config.bind) === undefined) {
      this.addressCheck =
        this.adapter.setInterval(() => void this.refreshIfAddressChanged(), MDNS_ADDRESS_CHECK_INTERVAL_MS) ??
        undefined;
    }
  }

  /**
   * Announce again when the networks changed. bonjour-service 1.4.4 has no TXT update (`service.js` builds the TXT
   * record once per publish; `registry.register` keeps a second record beside the first), so the old announcements say
   * goodbye and new ones are published.
   */
  async refreshIfAddressChanged(): Promise<void> {
    if (!this.started || this.refreshing) {
      return;
    }
    const plan = this.plan();
    const next = keyOf(plan);
    if (next === this.advertisedKey) {
      return;
    }
    this.refreshing = true;
    try {
      this.adapter.log.info(
        `mDNS: address changed ${this.advertisedKey || "(none)"} → ${next || "(none)"} — announcing again`,
      );
      await this.withdraw(false);
      // a stop during the goodbye ends it here — nothing goes on the air after stop()
      if (!this.started) {
        return;
      }
      this.advertisedKey = next;
      this.announceAll(plan);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Publish every announcement of the plan.
   *
   * @param plan The announcements ({@link announcements}).
   */
  private announceAll(plan: readonly Announcement[]): void {
    if (plan.length === 0) {
      this.adapter.log.debug("mDNS: this host sits in no IPv4 network — nothing to announce");
      return;
    }
    for (const one of plan) {
      this.announce(one);
    }
    this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
  }

  /**
   * Publish one announcement.
   *
   * @param plan The socket and the base URL of this announcement.
   */
  private announce(plan: Announcement): void {
    const serviceName = this.config.serviceName || DEFAULT_SERVICE_NAME;
    let bonjour: Bonjour | null = null;

    try {
      bonjour = new Bonjour(plan.socket);

      // L35: all TXT values below are non-empty by construction (no conditional
      // drop happens here) — build the advertised record.
      const txt: Record<string, string> = {
        base_url: plan.baseUrl,
        internal_url: plan.baseUrl,
        version: HA_VERSION,
        uuid: this.uuid,
        location_name: serviceName,
        // Legacy key: HA core dropped it from the announcement in 2026.7.0 (#173090) and no
        // Companion app reads it; kept for closed-source clients. TXT values are strings.
        requires_api_password: this.config.authRequired ? "True" : "False",
      };

      const entry: Announced = {
        bonjour,
        published: bonjour.publish({
          name: serviceName,
          type: "home-assistant",
          protocol: "tcp",
          port: this.config.port,
          txt,
          probe: plan.probe,
        }),
      };

      // v1.15.0 (D12): bonjour raises bind errors (e.g. port 5353 taken) ASYNCHRONOUSLY in its
      // dgram sockets — the try/catch around this does not see them. The event hands over
      // whatever was emitted, so the text goes through errText (a string event read
      // `undefined` off `.message` — audit 2026-09-25, H13). It ends this announcement only.
      entry.published?.on?.("error", (err: unknown) => {
        this.adapter.log.warn(`mDNS async publish error: ${errText(err)}`);
        this.drop(entry);
      });

      this.announced.push(entry);
      this.adapter.log.debug(`mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local at ${plan.baseUrl}`);
    } catch (err) {
      this.adapter.log.warn(`mDNS failed to start: ${errText(err)}`);
      // Release the bonjour instance, or its UDP socket leaks for the adapter's lifetime —
      // `stop()` only reaches announcements on the air.
      try {
        bonjour?.destroy();
      } catch {
        /* destroy may throw — we only want the resource released */
      }
    }
  }

  /**
   * Take one announcement off the air without a goodbye — its socket failed.
   *
   * @param entry The announcement.
   */
  private drop(entry: Announced): void {
    const at = this.announced.indexOf(entry);
    if (at !== -1) {
      this.announced.splice(at, 1);
    }
    try {
      entry.bonjour?.destroy();
    } catch {
      /* best effort */
    }
    entry.bonjour = null;
    entry.published = null;
  }

  /**
   * Stop mDNS broadcasting. Resolves once the goodbye announcements have left the
   * sockets and the sockets are released — `onUnload` awaits this before reporting
   * done, so the process is not torn down mid-goodbye.
   *
   * @param shuttingDown pass `true` from the onUnload path — there we skip the
   *   managed fallback timer (adapter-core refuses managed timers during shutdown;
   *   the awaited promise takes its place). Defaults to `false` for the runtime
   *   re-init path, where the adapter keeps running and the fallback matters.
   */
  stop(shuttingDown = false): Promise<void> {
    this.started = false;
    if (this.addressCheck) {
      this.adapter.clearInterval(this.addressCheck);
      this.addressCheck = undefined;
    }
    return this.withdraw(shuttingDown);
  }

  /**
   * Say goodbye on every announcement and release the sockets, all at once — {@link stop} without ending the address
   * check.
   *
   * @param shuttingDown See {@link stop}.
   */
  private withdraw(shuttingDown: boolean): Promise<void> {
    if (this.announced.length === 0) {
      return Promise.resolve();
    }
    const all = this.announced;
    this.announced = [];
    const goodbyes = all.map(entry => this.goodbye(entry, shuttingDown));
    this.adapter.log.debug("mDNS: Service stopped");
    return Promise.all(goodbyes).then(() => undefined);
  }

  /**
   * Say goodbye on one announcement and release its sockets.
   *
   * @param entry        The announcement.
   * @param shuttingDown See {@link stop}.
   */
  private goodbye(entry: Announced, shuttingDown: boolean): Promise<void> {
    const { published, bonjour } = entry;
    entry.published = null;
    entry.bonjour = null;

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
      } catch (err) {
        this.adapter.log.warn(`mDNS could not stop cleanly: ${errText(err)}`);
        destroy();
      }
    });
  }
}

/**
 * What the address check compares: the base URLs of the announcements, in order.
 *
 * @param plan The announcements.
 */
function keyOf(plan: readonly Announcement[]): string {
  return plan.map(a => a.baseUrl).join(", ");
}
