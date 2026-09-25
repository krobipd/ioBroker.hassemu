import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  HA_VERSION,
  SESSION_TTL_MS,
  CLEANUP_INTERVAL_MS,
  LOGIN_SCHEMA,
  OAUTH_ACCESS_TOKEN_TTL_S,
  SESSIONS_CAP,
  REQUEST_ERROR_COOLDOWN_MS,
  REQUEST_ERROR_COOLDOWN_CAP,
  COOKIE_MAX_AGE_S,
  WS_MAX_PAYLOAD_BYTES,
  DEFAULT_SERVICE_NAME,
  HTTP_CONNECTION_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_CONNECTIONS_CHECK_INTERVAL_MS,
  AUTH_CODE_TTL_MS,
} from "./constants";
import {
  coerceString,
  coerceUuid,
  describeUntrusted,
  isValidRedirectUri,
  mayAutoRedirect,
  oneLine,
  safeStringEqual,
} from "./coerce";
import { errText } from "./err-text";
import { evictOldest } from "./object-utils";
import {
  buildRedirectUrl,
  renderAuthorizeContinue,
  renderAuthorizeError,
  renderAuthorizeForm,
  renderAuthorizeRedirect,
} from "./auth-page";
import { registerHaWebSocket } from "./ha-websocket";
import { registerMobileAppRoutes } from "./mobile-app-routes";
import { HostnameResolver } from "./hostname-resolver";
import { tPage } from "./i18n";
import type { ClientRegistry } from "./client-registry";
import type { GlobalConfig } from "./global-config";
import { renderLandingPage } from "./landing-page";
import { advertisedBaseUrl } from "./network";
import { resolveRedirect, resolveRedirectWithChain } from "./redirect-resolver";
import { renderRedirectWrapper } from "./redirect-wrapper";
import { TargetHealth, probeTarget, type TargetProbe } from "./target-health";
import type { AdapterConfig, AdapterInterface, ClientRecord, SessionData } from "./types";

// v1.22.0 (F5): `safeStringEqual` lives in `coerce.ts` — a generic crypto helper.
// v1.32.0: `renderRedirectWrapper` lives in `redirect-wrapper.ts`, next to `landing-page.ts`
// and `auth-page.ts`; `evictOldest` is the shared helper from `object-utils.ts`.

/** Adapter surface the WebServer depends on — adds `namespace` for the setup page. */
export type WebServerAdapter = AdapterInterface & Pick<ioBroker.Adapter, "namespace">;

/**
 * Light-my-request injection surface — exposed read-only as a TEST-ONLY seam so
 * unit tests can drive routes without opening a real socket. Not used in production.
 */
export type WebserverInject = FastifyInstance["inject"];

/** Browser cookie name. Client identity lives here — auto-sent on every page navigation. */
export const CLIENT_COOKIE = "hassemu_client";

/**
 * Route option marking an endpoint as reachable without authentication. The auth
 * guard reads `req.routeOptions.config.public` (fastify 5 accessor) instead of a
 * hand-maintained path whitelist — public/protected is now declared AT the route,
 * so adding an endpoint can't forget to update a second list (the C7 redirect_check
 * bug). Default (no config) = protected. v1.37.0 (M6).
 */
const PUBLIC_ROUTE = { config: { public: true } } as const;

/** The HTTP server's time limits (constants; a test seam shortens them). */
export interface HttpLimits {
  /** Socket inactivity limit — see {@link HTTP_CONNECTION_TIMEOUT_MS}. */
  connectionTimeoutMs: number;
  /** Time to receive a request — see {@link HTTP_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs: number;
  /** How often Node checks connections against the request limit. */
  checkIntervalMs: number;
}

const DEFAULT_HTTP_LIMITS: HttpLimits = {
  connectionTimeoutMs: HTTP_CONNECTION_TIMEOUT_MS,
  requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
  checkIntervalMs: HTTP_CONNECTIONS_CHECK_INTERVAL_MS,
};

/**
 * Fastify web server emulating the HA REST API.
 *
 * Each incoming request is identified by cookie → {@link ClientRegistry} entry; new clients
 * get a channel created on first hit. Express was swapped for Fastify in 1.1.0 for first-party
 * cookie support, schema validation and a lighter runtime.
 */
export class WebServer {
  private readonly adapter: WebServerAdapter;
  private readonly config: AdapterConfig;
  private readonly registry: ClientRegistry;
  private readonly globalConfig: GlobalConfig;
  private readonly app: FastifyInstance;
  public readonly sessions: Map<string, SessionData> = new Map();
  /**
   * Issued OAuth2 authorization codes, kept SEPARATE from the login-flow
   * `sessions` map (both are short-lived UUID→SessionData). An unauthenticated
   * `POST /auth/login_flow` flood can fill `sessions` and evict old flow-ids, but
   * it can no longer evict a victim's in-flight auth code. v1.36.0 (S2).
   */
  public readonly codeSessions: Map<string, SessionData> = new Map();
  /**
   * Mobile-App webhook registrations from `POST /api/mobile_app/registrations`
   * (v1.29.1). Key = webhookId (URL secret), Value = owning client cookie id.
   * Subsequent `POST /api/webhook/<id>` requests are validated against this
   * map. FIFO-capped at {@link WEBHOOK_REGISTRATIONS_CAP}; entries whose
   * owning client was removed are pruned in {@link cleanupSessions} (v1.35.2).
   *
   * Reused for Shelly Wall Display FW 2.6.0+ onboarding — the on-device HA
   * Companion App requires this endpoint to complete device registration
   * after the OAuth2 sign-in. Without it the App refuses to proceed with "The
   * 'Mobile App' integration is required to use the app, but it is not available
   * on your Home Assistant server."
   *
   * **Design — in-memory only, by intent.** The map is NOT persisted across
   * adapter restarts. Restart-recovery relies on the
   * `POST /api/webhook/<unknown-id>` branch returning HTTP 200 with a
   * truly EMPTY body — the HA Companion App reads that as a stale webhook
   * and re-runs `registerDevice`, which on hassemu issues a fresh
   * webhookId. (Source, at tag 2026.9.0: home-assistant/android
   * IntegrationRepositoryImpl.kt:172-177 — re-registration on `200` with an empty body,
   * `404` or `410`; the empty `200` stays for older app versions.)
   *
   * If a future refactor changes the unknown-webhookId response from
   * `200 empty` to `404` or to any non-empty body (even JSON `null`),
   * displays will silently break across adapter restarts. Keep that
   * response shape OR add real persistence here.
   */
  public readonly webhookRegistrations: Map<string, string> = new Map();
  /**
   * v1.32.0 F1: last redirect-target seen per client by `/api/redirect_check`.
   * Used to log only-on-change (instead of every 30s poll). Pruned in
   * {@link cleanupSessions} against `registry.listAll()` — stale entries from
   * removed clients are dropped within max 5 min.
   */
  private readonly lastRedirectTargetByClient: Map<string, string | null> = new Map();
  /**
   * v1.39.0: reachability tracker for redirect targets. Feeds the wrapper's
   * target-down card via `/api/redirect_check` (`targetReachable`) and the
   * initial render — probes on demand with a shared cache, no own timer.
   */
  private readonly targetHealth: TargetHealth;
  private cleanupTimer: ioBroker.Interval | null = null;
  /**
   * Test-only injection surface ({@link WebserverInject}). v1.14.0 (H8): bound
   * once in the constructor instead of via a getter — a getter allocated a new
   * bound function on every `s.inject({...})` call, and tests call it in loops.
   */
  public readonly inject!: WebserverInject;
  public readonly instanceUuid: string;
  /** ioBroker system language for the setup page — resolved on startup. */
  public readonly systemLanguage: string;
  /**
   * Reverse-DNS resolution for display IPs. Owns its own deadline, in-flight guard and
   * negative cache — none of which is an HTTP concern, which is why it moved out of this
   * class in v1.43.0 (see `hostname-resolver.ts`).
   */
  private readonly hostnames: HostnameResolver;
  /**
   * Per-message cooldown timestamps for 5xx error logging. First occurrence
   * of a unique message logs at warn; repeats within {@link REQUEST_ERROR_COOLDOWN_MS}
   * fall to debug to prevent log-spam under attack/probe traffic.
   */
  private readonly errorLogCooldown: Map<string, number> = new Map();
  /**
   * ONE window for invalid-credential warnings, not one per address: keyed per IP, 300
   * attempts from 300 addresses (IPv4 aliases in the LAN, or a rotated X-Forwarded-For
   * with trustProxy) were 300 warn lines (audit 2026-09-25, H5). The first attempt of a
   * window is a warn; the next warn after the window reports how many followed.
   */
  private invalidCreds: { windowStart: number; suppressed: number; addresses: Set<string> } = {
    windowStart: 0,
    suppressed: 0,
    addresses: new Set(),
  };

  /**
   * @param adapter        Adapter instance used for logging, timers and namespace.
   * @param config         Resolved runtime config.
   * @param registry       Multi-client registry.
   * @param globalConfig   Global redirect override.
   * @param instanceUuid   Stable UUID shared with the mDNS advert.
   * @param systemLanguage ioBroker system language (`en`, `de`, …) used for the setup page.
   * @param targetProbe    Reachability probe for redirect targets (test seam; default {@link probeTarget}).
   * @param httpLimits     HTTP time limits (test seam; default {@link DEFAULT_HTTP_LIMITS}).
   */
  constructor(
    adapter: WebServerAdapter,
    config: AdapterConfig,
    registry: ClientRegistry,
    globalConfig: GlobalConfig,
    instanceUuid: string,
    systemLanguage: string = "en",
    targetProbe: TargetProbe = probeTarget,
    httpLimits: HttpLimits = DEFAULT_HTTP_LIMITS,
  ) {
    this.adapter = adapter;
    this.config = config;
    this.registry = registry;
    this.globalConfig = globalConfig;
    this.instanceUuid = instanceUuid;
    this.systemLanguage = systemLanguage;
    this.targetHealth = new TargetHealth(adapter, targetProbe);
    // M5: update-only. A byCookie miss is a deliberate no-op — the client was removed
    // while the lookup ran, and minting one here would create a ghost with a cookie no
    // display owns.
    this.hostnames = new HostnameResolver(adapter, (cookie, hostname) => registry.updateHostname(cookie, hostname));
    // v1.25.0 (C11): trustProxy is opt-in through the config — enable it only when the
    // adapter runs BEHIND a trusted reverse proxy that terminates TLS. With
    // trustProxy=true Fastify takes `req.ip` from `X-Forwarded-For` (instead of the
    // socket), `req.protocol` from `X-Forwarded-Proto` etc. — provided the proxy cleans
    // these headers (otherwise any client can fake its visible address → falsified logs
    // and per-IP burst detection of broken cookies, and the per-IP throttle for new
    // clients is defeated; the registry's global cap, independent of the address,
    // limits that damage — GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW).
    // HTTP limits (audit 2026-09-25, H1). fastify's defaults leave every limit at 0: a request
    // running during the stop kept `app.close()` waiting on a keep-alive socket (measured
    // > 20 s against `common.stopTimeout` 2 s), and a stalled header or body held a socket
    // forever. `forceCloseConnections: true` destroys every socket on close. The server is
    // built here because the request limit must reach `http.createServer` itself — fastify's
    // own `requestTimeout` option is set after the server exists and was measured
    // ineffective. With a server factory fastify applies neither the inactivity limit nor
    // its keep-alive timeout (lib/server.js 310-341), so both are set on the server here.
    this.app = Fastify({
      logger: false,
      trustProxy: this.config.trustProxy === true,
      forceCloseConnections: true,
      serverFactory: (handler, options) => {
        const server = http.createServer(
          { requestTimeout: httpLimits.requestTimeoutMs, connectionsCheckingInterval: httpLimits.checkIntervalMs },
          handler,
        );
        // fastify always hands over its keep-alive timeout (default 72 s).
        server.keepAliveTimeout = (options as { keepAliveTimeout: number }).keepAliveTimeout;
        server.setTimeout(httpLimits.connectionTimeoutMs);
        return server;
      },
    });
    // v1.14.0 (H8): bind inject once, not on every getter access.
    (this as { inject: WebserverInject }).inject = this.app.inject.bind(this.app);
  }

  /** Human-readable service name advertised in responses and mDNS. */
  get serviceName(): string {
    return this.config.serviceName || DEFAULT_SERVICE_NAME;
  }

  /** Resolved listener address once `start()` has completed, or null otherwise. */
  get boundAddress(): { address: string; port: number } | null {
    const addr = this.app.server.address();
    if (!addr || typeof addr === "string") {
      return null;
    }
    return { address: addr.address, port: addr.port };
  }

  // --- lifecycle ---

  /** Registers plugins and starts the HTTP listener. */
  async start(): Promise<void> {
    // v1.14.0 (H9): defensive — should start() ever be called twice (a refactor, a
    // test setup bug), clear the timer of the previous run instead of leaking it.
    if (this.cleanupTimer) {
      this.adapter.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.app.register(fastifyCookie);
    // The OAuth2 spec requires `application/x-www-form-urlencoded` for `/auth/token`,
    // and real HA reference clients (frontend / Wall Display SDK) follow it. Fastify
    // only has a JSON body parser by default — without this plugin `/auth/token`
    // answers a form body with 415 and the sign-in hangs completely. Tests through
    // `app.inject({payload:{...}})` serialise to JSON and hide that.
    await this.app.register(fastifyFormbody);
    // v1.34.0: minimal read-only WebSocket for the HA Companion App. Its
    // `registerDevice` makes a best-effort `auth/current_user` WS call after the
    // REST registration; without a WS endpoint that fails (and the username is
    // not stored). Registered before the routes so `{ websocket: true }` works.
    await this.app.register(fastifyWebsocket, {
      options: { maxPayload: WS_MAX_PAYLOAD_BYTES },
      // @fastify/websocket 11.3.1 routes every socket error here, and its default handler
      // terminates at once. For a frame ws itself rejects (1009 message too big) ws has already
      // started the close with its reason — terminating right after it lost that close frame to
      // a connection reset (Windows CI saw 1006). A socket ws is closing is left to ws; anything
      // else (a throwing route handler) is dropped as before.
      errorHandler: (err, socket) => {
        this.adapter.log.debug(`WS error: ${errText(err)}`);
        if (socket.readyState === socket.CLOSING || socket.readyState === socket.CLOSED) {
          return;
        }
        socket.terminate();
      },
    });
    this.setupAuthGuard();
    this.setupErrorHandler();
    this.setupRoutes();

    const bind = this.config.bind || "0.0.0.0";
    try {
      await this.app.listen({ port: this.config.port, host: bind });
    } catch (err) {
      // `listen` rejects with a NodeJS.ErrnoException in practice — the code is still read
      // guarded and the text goes through errText, like every other caught value.
      const fields: { code?: unknown } = typeof err === "object" && err !== null ? err : {};
      const msg =
        fields.code === "EADDRINUSE"
          ? `Port ${this.config.port} is already in use — another service is bound to it`
          : `Server error during startup: ${errText(err)}`;
      this.adapter.log.error(msg);
      throw err;
    }
    this.adapter.log.debug(`Web server listening on ${bind}:${this.config.port}`);

    // C6 (v1.36.0): auth on but no password set → blank-password logins are now
    // rejected, so the API stays locked until a real password is configured. The
    // display (GET /) is unaffected (whitelisted). Warn so the operator knows.
    if (this.config.authRequired && this.config.password === "") {
      this.adapter.log.warn(
        "Authentication is enabled but no password is configured — the HA API stays locked until you set a password in the adapter settings (the display itself is unaffected).",
      );
    }

    this.cleanupTimer = this.adapter.setInterval(() => this.cleanupSessions(), CLEANUP_INTERVAL_MS) ?? null;
  }

  /** Stops the listener and cancels the session cleanup timer. */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      this.adapter.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.terminateWebSockets();
    try {
      await this.app.close();
      this.adapter.log.debug("Web server stopped");
    } catch (err) {
      // v1.18.0 (G6+G8): debug instead of error — during an intended shutdown
      // (onUnload) a close error is mostly an "already closed" race without
      // consequence. The caller (main.ts onUnload) does not log it twice.
      this.adapter.log.debug(`Web server stop error: ${errText(err)}`);
    }
    this.hostnames.dispose();
    // v1.39.0: drop target-health bookkeeping; an in-flight probe self-destroys
    // on its own timeout and writes nowhere after dispose.
    this.targetHealth.dispose();
  }

  /**
   * Hard-close every WebSocket before `app.close()` waits on them.
   *
   * `@fastify/websocket`'s preClose hook sends each client a `close()` — the closing
   * HANDSHAKE, not a disconnect — and then waits for the peer's answer. A display that
   * lost power never answers, and the per-socket heartbeat that would terminate it after
   * 30 s is already cleared by the time the adapter shuts down. Measured against the real
   * server: `stop()` took **30 s** with one such socket (ws's own `closeTimeout`) versus
   * 2 ms with a display that answers — while the host only grants `common.stopTimeout`
   * before killing the process, so `onUnload` never reached its callback and the whole
   * ordered shutdown of v1.38.2 was cut off. `terminate()` drops the TCP connection at
   * once; the same measurement with this call in place returns in 0 ms.
   *
   * A display cannot lose anything by it: the adapter is going away, and the wrapper
   * page reconnects on its own once the server is back.
   */
  private terminateWebSockets(): void {
    try {
      const wss = (this.app as unknown as { websocketServer?: { clients?: Set<{ terminate(): void }> } })
        .websocketServer;
      const clients = wss?.clients;
      if (!clients || clients.size === 0) {
        return;
      }
      const count = clients.size;
      for (const socket of clients) {
        try {
          socket.terminate();
        } catch {
          /* already gone — nothing to release */
        }
      }
      this.adapter.log.debug(`Web server stop: terminated ${count} websocket(s) before closing`);
    } catch (err) {
      // The plugin may not be registered yet (stop() before a completed start()).
      this.adapter.log.debug(`Web server stop: no websockets to terminate (${errText(err)})`);
    }
  }

  // v1.14.0 (H8): `inject` is a readonly field now (declared above, bound once in the
  // constructor). The former getter allocated a new function on every access.

  /**
   * Deletes every entry of `map` for which `shouldDelete` returns true and
   * returns the count removed — so the cleanup passes below stay their essence
   * (a predicate + a count) instead of five copies of the iterate/delete/count
   * loop. v1.37.0 (I13).
   *
   * @param map          Map to prune in place.
   * @param shouldDelete Predicate `(value, key) => boolean`; true drops the entry.
   */
  private static pruneWhere<V>(map: Map<string, V>, shouldDelete: (value: V, key: string) => boolean): number {
    let removed = 0;
    for (const [key, value] of map) {
      if (shouldDelete(value, key)) {
        map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * A session that is still within its lifetime, or undefined — an expired one is dropped on
   * the spot. The periodic cleanup alone let a code live up to 15 min (its 5-min interval on
   * top of the 10-min lifetime; audit 2026-09-25, H8).
   *
   * @param map   Session map.
   * @param key   Untrusted key (flow id or code).
   * @param ttlMs Lifetime.
   */
  private static takeFresh(map: Map<string, SessionData>, key: unknown, ttlMs: number): SessionData | undefined {
    if (typeof key !== "string") {
      return undefined;
    }
    const session = map.get(key);
    if (session && Date.now() - session.created >= ttlMs) {
      map.delete(key);
      return undefined;
    }
    return session;
  }

  /** Periodic cleanup of expired in-flight auth sessions and stale redirect-target entries. */
  public cleanupSessions(): void {
    const now = Date.now();
    // S2 (v1.36.0): auth codes live in the separate codeSessions map — prune it too.
    const expired = (s: SessionData): boolean => now - s.created > SESSION_TTL_MS;
    const cleanedSessions =
      WebServer.pruneWhere(this.sessions, expired) + WebServer.pruneWhere(this.codeSessions, expired);
    if (cleanedSessions > 0) {
      this.adapter.log.debug(`Session cleanup: removed ${cleanedSessions} expired sessions`);
    }

    // v1.32.0 F1: prune lastRedirectTargetByClient against currently known
    // clients. A removed client leaves a stale entry that would never get
    // cleared otherwise — bounded growth over months.
    const activeClients = new Set(this.registry.listAll().map(r => r.id));
    const prunedTargets = WebServer.pruneWhere(
      this.lastRedirectTargetByClient,
      (_target, clientId) => !activeClients.has(clientId),
    );
    if (prunedTargets > 0) {
      this.adapter.log.debug(`Cleanup: pruned ${prunedTargets} stale redirect-target entries`);
    }

    // v1.35.2: prune webhook registrations whose owning client was removed
    // (remove button / stale-GC). Without this, an orphaned display keeps
    // getting 200s on its webhook instead of falling into re-registration.
    // ownerId === "" means "unowned" (authRequired=false registration without
    // a Bearer token) — those have no client to check against and must stay.
    const prunedWebhooks = WebServer.pruneWhere(
      this.webhookRegistrations,
      ownerId => ownerId !== "" && !activeClients.has(ownerId),
    );
    if (prunedWebhooks > 0) {
      this.adapter.log.debug(`Cleanup: pruned ${prunedWebhooks} webhook registrations of removed clients`);
    }

    // L6: bounded by the recently-seen no-PTR IPs, not by every IP ever seen.
    this.hostnames.prune(now);
  }

  /**
   * Cooldown decision for logging 5xx errors. Returns `true` for the first sighting of
   * a `key` within {@link REQUEST_ERROR_COOLDOWN_MS} and marks the entry — repeats
   * return `false` until the window has passed. The map is FIFO-capped at
   * {@link REQUEST_ERROR_COOLDOWN_CAP}.
   *
   * @param key Unique error identifier (usually `error.message`).
   * @param now Current time in ms (testable).
   */
  public shouldEmitRequestErrorWarn(key: string, now: number): boolean {
    return this.emitOncePerWindow(this.errorLogCooldown, key, now);
  }

  /**
   * First-observation-per-window decision shared by the 5xx-error and the invalid-
   * credentials dedup. Returns `true` for the first `key` within
   * {@link REQUEST_ERROR_COOLDOWN_MS}, then `false` until the window lapses; the map is
   * FIFO-capped at {@link REQUEST_ERROR_COOLDOWN_CAP}. Each caller passes its OWN map
   * (I1) so the two dedup classes can't evict each other under load.
   *
   * @param map The caller's dedup map (mutated in place).
   * @param key Unique identifier for the event being deduplicated.
   * @param now Current time in ms.
   */
  private emitOncePerWindow(map: Map<string, number>, key: string, now: number): boolean {
    const lastSeen = map.get(key) ?? 0;
    if (lastSeen !== 0 && now - lastSeen <= REQUEST_ERROR_COOLDOWN_MS) {
      return false;
    }
    if (!map.has(key)) {
      evictOldest(map, REQUEST_ERROR_COOLDOWN_CAP);
    }
    map.set(key, now);
    return true;
  }

  /**
   * Record the target a client was just served and report whether it CHANGED.
   *
   * One bookkeeping place for both display-facing routes: `GET /` (every 15 s while a
   * display sits on the landing page) and `/api/redirect_check` (every 30 s). Both are
   * high-frequency and both are only worth a log line when the answer moved — the map
   * behind it is pruned against the live clients in {@link cleanupSessions}.
   *
   * A transient (throttled) record is never noted: it owns no `resolvedUrl` to write,
   * no log line is worth its fresh random id, and every such request used to leave an
   * entry in the map until the next cleanup pass — under the very flood the throttle
   * exists for, that was the memory growing instead of the object DB (audit
   * 2026-09-15, D2).
   *
   * @param client Display the target was resolved for.
   * @param target The resolved URL, or null for the landing page.
   * @returns true when this differs from what the client was served last.
   */
  private noteRedirectTarget(client: ClientRecord, target: string | null): boolean {
    if (!client.persistent) {
      return false;
    }
    const previous = this.lastRedirectTargetByClient.get(client.id);
    if (previous === target) {
      return false;
    }
    this.lastRedirectTargetByClient.set(client.id, target);
    return true;
  }

  /**
   * Log a resolved-target line at the level its frequency deserves: `debug` when the
   * target changed (the diagnostic anchor), `silly` for the steady state that repeats
   * every 15 s per display. Volume moves a line down a level, it never removes it
   * (`reference_iobroker_logging_levels`).
   *
   * @param changed Whether the target differs from the previous answer.
   * @param line    The message to write.
   */
  private logTargetLine(changed: boolean, line: string): void {
    if (changed) {
      this.adapter.log.debug(line);
    } else {
      this.adapter.log.silly(line);
    }
  }

  /**
   * Inserts a session, dropping the oldest entry if {@link SESSIONS_CAP} is exceeded.
   *
   * @param key  Login-flow id.
   * @param data Session payload.
   */
  private storeSession(key: string, data: SessionData): void {
    evictOldest(this.sessions, SESSIONS_CAP);
    this.sessions.set(key, data);
  }

  /**
   * Store an issued OAuth2 authorization code in the SEPARATE `codeSessions` map
   * (S2) so a login-flow flood cannot evict it. Same FIFO cap as the flow map.
   *
   * @param code Auth code (UUID).
   * @param data Session payload.
   */
  private storeCode(code: string, data: SessionData): void {
    evictOldest(this.codeSessions, SESSIONS_CAP);
    this.codeSessions.set(code, data);
  }

  // --- client identification ---

  /**
   * v1.15.0 (F6): the one place that turns `req.ip` into a coerced string|null. Before,
   * `coerceString(req.ip)` was inlined three times in the identify/login/token handlers.
   *
   * @param req Fastify request (uses `req.ip`).
   */
  private static getClientIp(req: FastifyRequest): string | null {
    const ip = coerceString(req.ip);
    // With trustProxy the value is a client-supplied X-Forwarded-For entry — only a real
    // address counts (`<b>x</b>` was stored as a display's IP, audit 2026-09-25, H4).
    return ip !== null && net.isIP(ip) !== 0 ? ip : null;
  }

  /**
   * Extract the Bearer access token from a request's Authorization header, or ""
   * if absent. Uses a typeof guard (Fastify yields `string[]` for a duplicated
   * header) instead of an `as string` cast, and centralises the `Bearer `-strip
   * that was duplicated in the auth guard + the mobile_app handler. v1.36.0 (C9).
   *
   * @param req Fastify request.
   */
  private static bearerToken(req: FastifyRequest): string {
    return WebServer.bearerTokenFrom(req.headers.authorization);
  }

  /**
   * Extract the Bearer token from a raw `Authorization` header value. Uses a typeof guard
   * (Fastify yields `string[]` for a duplicated header) instead of an `as string` cast.
   * Split from {@link bearerToken} so the mobile-app routes can resolve a client from the
   * header they already hold, without depending on the whole request type. v1.36.0 (C9).
   *
   * @param authorization Raw header value.
   */
  private static bearerTokenFrom(authorization: unknown): string {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return "";
    }
    return authorization.substring("Bearer ".length).trim();
  }

  private async identify(req: FastifyRequest, reply: FastifyReply): Promise<ClientRecord> {
    const cookie = coerceUuid(req.cookies?.[CLIENT_COOKIE]);
    const ip = WebServer.getClientIp(req);
    // v1.17.0 (C8): pass the UA on so displays behind the same NAT do not end up in
    // the same pending lock (see the identifyOrCreate comment).
    const userAgent = coerceString(req.headers["user-agent"]);
    // HEAD never mints a display: uptime monitors, scanners and both Companion apps'
    // connectivity checks (android DefaultConnectivityChecker.kt:100-104, iOS
    // ConnectivityChecker.swift:224-228) send HEAD without a cookie (audit 2026-09-25, H2).
    const record = await this.registry.identifyOrCreate(cookie, ip, { userAgent, create: req.method !== "HEAD" });
    // v1.32.0 A1: cookie-state explizit traced. Drei Branches:
    //   hit          — cookie matched a known client, no setCookie needed
    //   stale/new    — cookie present but unknown, OR no cookie at all → new client created
    if (cookie === record.cookie) {
      // `silly`, not `debug`: this fires on EVERY request of every display — the wrapper
      // polls every 30 s and the landing page reloads every 15 s, so a single unconfigured
      // display alone produced ~5 800 debug lines a day saying nothing changed. The
      // diagnostically interesting cookie states (stale / missing) stay on debug below.
      // `reference_iobroker_logging_levels`: excessive volume moves down a level, it does
      // not disappear.
      this.adapter.log.silly(`identify: cookie-hit client=${record.id} ip=${ip ?? "?"}`);
    } else if (record.persistent) {
      const reason = cookie ? "cookie-stale (unknown)" : "no-cookie";
      this.adapter.log.debug(`identify: ${reason}, new client=${record.id} ip=${ip ?? "?"}`);
      // v1.25.0 (C11): cookie `secure: true` under TLS — the browser then sends the
      // cookie over HTTPS only. With trustProxy=true `req.protocol` comes from the
      // `X-Forwarded-Proto` header. Default without trustProxy: `req.protocol === 'http'`
      // (the adapter is HTTP only), so the cookie is not secure — otherwise the browser
      // would never send it.
      const useSecure = req.protocol === "https";
      // v1.32.0 A2: trace the cookie secure decision — with a wrong trustProxy setting
      // the display may never send the cookie back.
      this.adapter.log.debug(`identify: setting cookie secure=${useSecure} (req.protocol=${req.protocol})`);
      reply.setCookie(CLIENT_COOKIE, record.cookie, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: useSecure,
        maxAge: COOKIE_MAX_AGE_S,
      });
    }
    // A transient record owns nothing — no cookie above, no name, so no reverse lookup either:
    // under the very flood the throttle exists for, each request sent a PTR query whose
    // answer had nowhere to go (audit 2026-09-25, H3).
    if (ip && record.persistent) {
      this.hostnames.resolve({ id: record.id, cookie: record.cookie, hasHostname: !!record.hostname }, ip);
    }
    return record;
  }

  // --- auth guard ---

  /**
   * Pre-handler hook that protects the API when `authRequired=true`. Real HA requires
   * `Authorization: Bearer <token>` for all of `/api/*` except the `/api/` heartbeat; before
   * this guard, `/api/states`, `/api/services`, `/api/events` and `/api/error_log` answered
   * unauthenticated.
   *
   * Public or protected is declared per route (`PUBLIC_ROUTE`), not in a path list here.
   * `/api/discovery_info` stays public: HA core removed the endpoint in 2022 (#64534) and no
   * Companion app asks for it any more, but closed-source clients may still do.
   *
   * With `authRequired=false` the hook does nothing.
   */
  private setupAuthGuard(): void {
    this.app.addHook("preHandler", async (req, reply) => {
      if (!this.config.authRequired) {
        return;
      }
      // Public/protected is declared per route via `{ config: { public: true } }`
      // (PUBLIC_ROUTE), read here from the matched route. Default = protected.
      // A forgotten public marker fails closed (401 = the C7 bug), never open.
      // The public set is: `/`, `/api/`, `/api/discovery_info`, `/manifest.json`,
      // `/health`, `/api/redirect_check`, all `/auth/*`, `/api/websocket` (in-band
      // WS auth) and `/api/webhook/:id` (URL-secret). v1.37.0 (M6).
      const routeConfig = req.routeOptions?.config as { public?: boolean } | undefined;
      if (routeConfig?.public === true) {
        return;
      }
      const path = (req.url ?? "/").split("?")[0];
      const token = WebServer.bearerToken(req);
      if (!token) {
        this.adapter.log.debug(`Auth required for ${path} — missing Bearer token`);
        reply.status(401).send({ error: "unauthorized" });
        return;
      }
      const client = this.registry.getByToken(token);
      if (!client) {
        this.adapter.log.debug(`Auth required for ${path} — unknown Bearer token`);
        reply.status(401).send({ error: "invalid_token" });
        return;
      }
      // OK — handler runs
    });
  }

  // --- error handling ---

  private setupErrorHandler(): void {
    this.app.setErrorHandler((err: unknown, _req, reply) => {
      // Fastify hands over whatever a handler threw or rejected with — measured at fastify
      // 5.12.3 (`lib/wrap-thenable.js` → `reply.send(err)`): a plain object or a string
      // arrives here as it is. So the two Fastify fields are read guarded, and the text
      // comes from errText — a bare `.message` reads `undefined` off a thrown string and
      // would collapse every such error onto the "unknown" dedup key below.
      const fields: { validation?: unknown; statusCode?: unknown } = typeof err === "object" && err !== null ? err : {};
      const message = errText(err);
      if (fields.validation) {
        this.adapter.log.debug(`Validation error: ${message}`);
        reply.status(400).send({ error: "Invalid request", details: message });
        return;
      }
      // Fastify body-parsing / client errors already set statusCode in 4xx range
      const code = typeof fields.statusCode === "number" ? fields.statusCode : 500;
      if (code >= 400 && code < 500) {
        this.adapter.log.debug(`Client error ${code}: ${message}`);
        reply.status(code).send({ error: message });
        return;
      }
      // 5xx: an attacker can trigger many 500s with malformed paths / oversized bodies.
      // Per-message dedup map with a 60 s cooldown — the first occurrence of a unique
      // message is a warn, every repeat inside the window goes to debug.
      // Memory `feedback_no_log_spam`.
      const key = message || "unknown";
      if (this.shouldEmitRequestErrorWarn(key, Date.now())) {
        this.adapter.log.warn(`Request error: ${message}`);
      } else {
        this.adapter.log.debug(`Request error (repeat): ${message}`);
      }
      reply.status(500).send({ error: "Internal server error" });
    });
  }

  // --- routes ---

  private setupRoutes(): void {
    this.setupApiRoutes();
    this.setupAuthRoutes();
    this.setupWebSocket();
    this.setupMiscRoutes();
    this.setupNotFound();
  }

  /**
   * HA `/api/config`-shaped object. Single source for REST `/api/config`, the
   * Companion webhook `get_config` and the WebSocket `get_config` command.
   * `mobile_app` in `components` advertises the integration the HA Companion App
   * probes during onboarding (v1.29.1, Shelly FW 2.6.0+).
   */
  private buildHaConfig(): Record<string, unknown> {
    return {
      components: ["http", "api", "frontend", "homeassistant", "mobile_app"],
      config_dir: "/config",
      elevation: 0,
      latitude: 0,
      longitude: 0,
      location_name: this.serviceName,
      time_zone: "UTC",
      unit_system: { length: "km", mass: "g", temperature: "°C", volume: "L" },
      version: HA_VERSION,
      whitelist_external_dirs: [],
    };
  }

  private setupApiRoutes(): void {
    // CRITICAL: trailing slash — HA clients check this endpoint for discovery
    this.app.get("/api/", PUBLIC_ROUTE, () => ({ message: "API running." }));

    this.app.get("/api/config", () => this.buildHaConfig());

    // HA core removed this endpoint in 2022 (#64534) and no Companion app asks for it any
    // more; kept because closed-source clients (the Shelly built-in page) may still do.
    this.app.get("/api/discovery_info", PUBLIC_ROUTE, () => {
      // v1.17.0 (E11): never `req.hostname` — the Host header is client-controlled, and
      // `Host: attacker.lan` would point other HA clients at a wrong URL. The bound address,
      // identical to the mDNS advert; an IPv6 address in brackets (H10).
      const baseUrl = advertisedBaseUrl(this.config.bind, this.config.port);
      return {
        base_url: baseUrl,
        external_url: null,
        internal_url: baseUrl,
        location_name: this.serviceName,
        // Follows authRequired (it used to be a hardcoded `true`).
        requires_api_password: this.config.authRequired,
        uuid: this.instanceUuid,
        version: HA_VERSION,
      };
    });

    for (const path of ["/api/states", "/api/services", "/api/events"]) {
      this.app.get(path, () => []);
    }
    this.app.get("/api/error_log", () => "");

    // The HA Companion App's device registration + its webhook — a protocol of its own,
    // registered from `mobile-app-routes.ts`. The registration map stays owned by this
    // class because `cleanupSessions` prunes it against the live clients.
    registerMobileAppRoutes(this.app, {
      adapter: this.adapter,
      registrations: this.webhookRegistrations,
      clientForBearer: authorization => {
        const token = WebServer.bearerTokenFrom(authorization);
        return token ? this.registry.getByToken(token) : null;
      },
      buildHaConfig: () => this.buildHaConfig(),
    });
  }

  /**
   * Issue a fresh authorization code and persist it in the sessions map.
   *
   * Single source for both the JSON login flow (`/auth/login_flow/<flowId>` →
   * `create_entry`) and the browser OAuth2 flow (`/auth/authorize` →
   * auto-submit redirect page). The code is exchanged for tokens at `/auth/token`
   * (`grant_type = authorization_code`); the same codeSessions map is consumed there.
   *
   * @param clientId Identity of the requesting display (always known — the flow
   *                 starts from an identified request). v1.37.0 (L10).
   */
  private issueAuthorizationCode(clientId: string): string {
    const code = crypto.randomUUID();
    this.storeCode(code, { created: Date.now(), clientId });
    return code;
  }

  /**
   * Shared validation for GET and POST `/auth/authorize`. On failure it sets the
   * `400 text/html` reply and returns the rendered error page; on success it
   * returns the validated (string-typed) `client_id` / `redirect_uri`. Never
   * redirects on failure — the endpoint must not become an open redirector.
   *
   * @param reply        Fastify reply (status + content-type set on failure).
   * @param method       `"GET"` or `"POST"` — only used to label the debug log.
   * @param responseType The OAuth2 `response_type` (must be `"code"`).
   * @param clientId     The OAuth2 `client_id` (must be a string).
   * @param redirectUri  The OAuth2 `redirect_uri` (must be a string + allowlisted).
   */
  private validateAuthorizeRequest(
    reply: FastifyReply,
    method: "GET" | "POST",
    responseType: unknown,
    clientId: unknown,
    redirectUri: unknown,
  ): { ok: true; clientId: string; redirectUri: string } | { ok: false; html: string } {
    // L46: one place to set the 400/text-html reply + render the error page, so
    // the three rejection branches show only what varies (reason + detail + log).
    const fail = (reason: string, detail: string): { ok: false; html: string } => {
      reply.status(400).type("text/html");
      return { ok: false, html: renderAuthorizeError(reason, detail, this.systemLanguage) };
    };
    if (responseType !== "code") {
      this.adapter.log.debug(
        `Authorize ${method} rejected: response_type=${describeUntrusted(responseType)} (expected 'code')`,
      );
      return fail("unsupported_response_type", "This authorization server supports `response_type=code` only.");
    }
    if (typeof clientId !== "string" || typeof redirectUri !== "string") {
      this.adapter.log.debug(
        `Authorize ${method} rejected: missing client_id or redirect_uri (cid=${typeof clientId}, ru=${typeof redirectUri})`,
      );
      return fail("invalid_request", "Missing or invalid `client_id` or `redirect_uri` parameter.");
    }
    if (!isValidRedirectUri(clientId, redirectUri)) {
      this.adapter.log.debug(
        `Authorize ${method} rejected: redirect_uri "${oneLine(redirectUri)}" not allowed for client_id "${oneLine(clientId)}"`,
      );
      return fail("invalid_redirect_uri", "The `redirect_uri` parameter is not on the allowlist for this client.");
    }
    return { ok: true, clientId, redirectUri };
  }

  /**
   * Issue an auth code, build the redirect target and answer with the redirect page — or,
   * when the target is neither a Companion app nor the host the browser is on, with a page
   * that asks before continuing (audit 2026-09-25, H6). One decision point for every grant.
   *
   * @param reply         Fastify reply (content-type set to text/html).
   * @param displayId     Identity of the requesting display (always known).
   * @param oauthClientId The validated OAuth2 `client_id`.
   * @param redirectUri   Already-validated `redirect_uri` to append the code to.
   * @param state         Optional OAuth2 `state` round-tripped verbatim.
   * @param requestHost   The `Host` the request came in on.
   */
  private issueAuthorizeRedirect(
    reply: FastifyReply,
    displayId: string,
    oauthClientId: string,
    redirectUri: string,
    state: string | undefined,
    requestHost: unknown,
  ): string {
    const code = this.issueAuthorizationCode(displayId);
    const target = buildRedirectUrl(redirectUri, code, state);
    reply.type("text/html");
    if (mayAutoRedirect(oauthClientId, redirectUri, requestHost)) {
      return renderAuthorizeRedirect(target);
    }
    const host = WebServer.hostOf(redirectUri);
    this.adapter.log.debug(
      `Authorize: redirect_uri host ${oneLine(host)} is foreign to client_id ${oneLine(oauthClientId)} — asking before continuing`,
    );
    return renderAuthorizeContinue(target, host, this.systemLanguage);
  }

  /**
   * The host part of a validated URL, for display and logs.
   *
   * @param url A URL that passed the redirect validation.
   */
  private static hostOf(url: string): string {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }

  /**
   * Best-effort token revocation, shared by `POST /auth/revoke` (HA ≥2022.9)
   * and the legacy `POST /auth/token` with `action=revoke`. The HA Companion
   * sends the refresh token; we look it up and clear both the refresh and the
   * access token of the owning client. Always succeeds from the caller's view —
   * an unknown/missing token still yields 200 (matches HA, which never leaks
   * whether a token existed). Source: AuthenticationRepositoryImpl.revokeSession.
   *
   * @param token Refresh token to revoke (from the `token` form field).
   */
  private async revokeToken(token: string | undefined): Promise<void> {
    const refresh = typeof token === "string" ? token : "";
    const owner = refresh ? this.registry.getByRefreshToken(refresh) : null;
    if (owner) {
      await this.registry.setTokens(owner.id, null, null);
      this.adapter.log.debug(`Token revoked — client ${owner.id}`);
    } else {
      this.adapter.log.debug("Revoke: unknown/missing token — returning 200 (HA behavior)");
    }
  }

  /**
   * Validate submitted login credentials in constant time. An EMPTY submitted
   * password is ALWAYS rejected: with the default blank `config.password`, an
   * empty submission would otherwise match (`safeStringEqual("", "")`) and grant
   * access — so a blank password must never authenticate. Both comparisons run
   * unconditionally (no `&&` short-circuit) to avoid leaking which field was
   * wrong via response timing. v1.36.0 (C6).
   *
   * @param username Submitted username (untrusted).
   * @param password Submitted password (untrusted).
   */
  private credentialsValid(username: unknown, password: unknown): boolean {
    if (typeof username !== "string" || typeof password !== "string" || password.length === 0) {
      return false;
    }
    const userOk = safeStringEqual(username, this.config.username);
    const passOk = safeStringEqual(password, this.config.password);
    return userOk && passOk;
  }

  /**
   * Log an invalid-credentials attempt: the first of a {@link REQUEST_ERROR_COOLDOWN_MS}
   * window at warn, every further one at debug; the first warn after the window names how
   * many followed and from how many addresses. The summary appears with that next attempt —
   * no timer of its own. Log-dedup only — NOT a lockout (removed in v1.31.0, stays removed).
   * v1.37.0 (M3), one global window since audit 2026-09-25 (H5).
   *
   * @param ip Client IP, or null.
   */
  private logInvalidCredentials(ip: string | null): void {
    const now = Date.now();
    const w = this.invalidCreds;
    const where = ip ? ` (IP ${ip})` : "";
    if (w.windowStart !== 0 && now - w.windowStart <= REQUEST_ERROR_COOLDOWN_MS) {
      w.suppressed++;
      if (ip && w.addresses.size < REQUEST_ERROR_COOLDOWN_CAP) {
        w.addresses.add(ip);
      }
      this.adapter.log.debug(`Invalid credentials (repeat)${where}`);
      return;
    }
    const summary =
      w.suppressed > 0
        ? ` — ${w.suppressed} further attempt(s) from ${w.addresses.size} address(es) in the previous window were logged at debug`
        : "";
    this.adapter.log.warn(`Invalid credentials${where}${summary}`);
    this.invalidCreds = { windowStart: now, suppressed: 0, addresses: new Set() };
  }

  private setupAuthRoutes(): void {
    this.app.get("/auth/providers", PUBLIC_ROUTE, () => [
      { name: "Home Assistant Local", type: "homeassistant", id: null },
    ]);

    // Browser-OAuth2 flow at GET/POST /auth/authorize — used by the HA Companion apps (also
    // the one from the Shelly app store). Source-verified flow:
    //   home-assistant/android ConnectionViewModel.kt:185-190 @2026.9.0 (client_id android +
    //     redirect_uri homeassistant://auth-callback)
    //   home-assistant/core indieauth.py:verify_redirect_uri @2026.9.3
    //   home-assistant/frontend src/data/auth.ts:redirectWithAuthCode
    // No HEAD twin: fastify answers HEAD with the GET handler, and a HEAD here issued an
    // authorization code nobody would ever read (audit 2026-09-25, H2).
    this.app.get<{
      Querystring: { response_type?: string; client_id?: string; redirect_uri?: string; state?: unknown };
    }>("/auth/authorize", { ...PUBLIC_ROUTE, exposeHeadRoute: false }, async (req, reply) => {
      const { response_type, client_id, redirect_uri } = req.query ?? {};
      // A repeated `state` parameter arrives as an array — a string or nothing (H7).
      const state = coerceString(req.query?.state) ?? undefined;

      // v1.32.0 D2: rejection paths are traced — triage for "why does OAuth abort"
      const v = this.validateAuthorizeRequest(reply, "GET", response_type, client_id, redirect_uri);
      if (!v.ok) {
        return v.html;
      }

      const client = await this.identify(req, reply);

      // No auth required → issue the code right away and redirect.
      if (!this.config.authRequired) {
        this.adapter.log.debug(`Authorize auto-grant — client ${client.id}`);
        return this.issueAuthorizeRedirect(reply, client.id, v.clientId, v.redirectUri, state, req.host);
      }

      // v1.32.0 D1: trace the form render — if the Companion never submits the form, the
      // log shows it was rendered at all.
      this.adapter.log.debug(
        `Authorize form rendered — client_id=${oneLine(v.clientId)} redirect_uri-host=${oneLine(WebServer.hostOf(v.redirectUri))}`,
      );
      reply.type("text/html");
      return renderAuthorizeForm(
        { clientId: v.clientId, redirectUri: v.redirectUri, state },
        undefined,
        this.systemLanguage,
      );
    });

    this.app.post<{
      Body: {
        response_type?: string;
        client_id?: string;
        redirect_uri?: string;
        state?: unknown;
        username?: string;
        password?: string;
      };
    }>("/auth/authorize", PUBLIC_ROUTE, async (req, reply) => {
      const { response_type, client_id, redirect_uri, username, password } = req.body ?? {};
      // A JSON body can carry any type for `state` — a string or nothing (H7).
      const state = coerceString(req.body?.state) ?? undefined;

      const v = this.validateAuthorizeRequest(reply, "POST", response_type, client_id, redirect_uri);
      if (!v.ok) {
        return v.html;
      }

      const client = await this.identify(req, reply);

      // No auth required → straight to redirect even on POST.
      if (!this.config.authRequired) {
        return this.issueAuthorizeRedirect(reply, client.id, v.clientId, v.redirectUri, state, req.host);
      }

      const ip = WebServer.getClientIp(req);
      if (!this.credentialsValid(username, password)) {
        this.logInvalidCredentials(ip);
        reply.status(401).type("text/html");
        return renderAuthorizeForm(
          { clientId: v.clientId, redirectUri: v.redirectUri, state },
          tPage("authInvalidCredentials", this.systemLanguage),
          this.systemLanguage,
        );
      }

      this.adapter.log.debug(`Authorize grant — client ${client.id}`);
      return this.issueAuthorizeRedirect(reply, client.id, v.clientId, v.redirectUri, state, req.host);
    });

    this.app.post("/auth/login_flow", PUBLIC_ROUTE, async (req, reply) => {
      const client = await this.identify(req, reply);
      const flowId = crypto.randomUUID();
      this.storeSession(flowId, { created: Date.now(), clientId: client.id });
      this.adapter.log.debug(`Auth flow created: ${flowId} for client ${client.id}`);

      return {
        type: "form",
        flow_id: flowId,
        handler: ["homeassistant", null],
        step_id: "init",
        data_schema: LOGIN_SCHEMA,
        description_placeholders: null,
        errors: null,
      };
    });

    this.app.post<{
      Params: { flowId: string };
      Body: { username?: string; password?: string };
    }>(
      "/auth/login_flow/:flowId",
      {
        ...PUBLIC_ROUTE,
        schema: {
          params: {
            type: "object",
            properties: { flowId: { type: "string", minLength: 1 } },
            required: ["flowId"],
          },
        },
      },
      async (req, reply) => {
        const flowId = req.params.flowId;
        const session = WebServer.takeFresh(this.sessions, flowId, SESSION_TTL_MS);
        if (!session) {
          // v1.8.0: after the session TTL (10 min) this fires for every legitimate
          // returning user — nothing to act on. debug, not warn.
          this.adapter.log.debug(`Unknown flow_id: ${oneLine(flowId)}`);
          reply.status(400);
          return { type: "abort", flow_id: flowId, reason: "unknown_flow" };
        }

        if (this.config.authRequired) {
          const ip = WebServer.getClientIp(req);
          const { username, password } = req.body ?? {};
          if (!this.credentialsValid(username, password)) {
            this.logInvalidCredentials(ip);
            reply.status(400);
            return {
              type: "form",
              flow_id: flowId,
              handler: ["homeassistant", null],
              step_id: "init",
              data_schema: LOGIN_SCHEMA,
              errors: { base: "invalid_auth" },
              description_placeholders: null,
            };
          }
        }

        this.sessions.delete(flowId);
        // L22: reuse issueAuthorizationCode instead of duplicating its body — one
        // code-issue site, and its JSDoc's "single source" claim is true again.
        const code = this.issueAuthorizationCode(session.clientId);
        this.adapter.log.debug("Auth flow completed — code issued");

        return {
          version: 1,
          type: "create_entry",
          flow_id: flowId,
          handler: ["homeassistant", null],
          result: code,
          description: null,
          description_placeholders: null,
        };
      },
    );

    // HA ≥2022.9 logout: POST /auth/revoke with form field `token` (the refresh
    // token). Always 200 with empty body. Public via its route config (PUBLIC_ROUTE).
    // Source: AuthenticationRepositoryImpl.revokeSession.
    this.app.post<{ Body: { token?: string } }>("/auth/revoke", PUBLIC_ROUTE, async req => {
      await this.revokeToken(req.body?.token);
      return {};
    });

    this.app.post<{
      Body: { code?: string; grant_type?: string; refresh_token?: string; action?: string; token?: string };
    }>("/auth/token", PUBLIC_ROUTE, async (req, reply) => {
      const { code, grant_type, refresh_token, action } = req.body ?? {};

      // Legacy logout (HA <2022.9): POST /auth/token with action=revoke + token.
      // Newer apps use /auth/revoke; we accept both so a 400 never surfaces.
      if (action === "revoke") {
        await this.revokeToken(req.body?.token ?? refresh_token);
        return {};
      }

      // L38: get + null-check instead of has + get + non-null-assertion. M7: each
      // grant is a named method with its own invariant, the route is the dispatcher.
      const session =
        grant_type === "authorization_code"
          ? WebServer.takeFresh(this.codeSessions, code, AUTH_CODE_TTL_MS)
          : undefined;
      if (session && code) {
        return this.handleAuthCodeGrant(code, session, reply);
      }

      if (grant_type === "refresh_token") {
        return this.handleRefreshGrant(refresh_token, reply);
      }

      // A wrong grant_type is a client format error, not a server concern — hence
      // debug only (legitimate client bugs must not flood the log).
      this.adapter.log.debug(`Token exchange failed: grant_type=${describeUntrusted(grant_type)}`);
      reply.status(400);
      return { error: "invalid_request", error_description: "Invalid or expired code" };
    });
  }

  /**
   * `authorization_code` grant: consume the one-time code, mint access + refresh
   * tokens and persist them to the client BEFORE returning them — a crash between
   * issue and persist would otherwise hand the client a token the server never
   * knew, giving `invalid_grant` on the first refresh. `session.clientId` is
   * always set (L10). v1.37.0 (M7).
   *
   * @param code    The consumed authorization code (removed from codeSessions here).
   * @param session The code's session (holds the owning clientId).
   * @param reply   Reply to set the 400 status on when the grant is refused.
   */
  private async handleAuthCodeGrant(
    code: string,
    session: SessionData,
    reply: FastifyReply,
  ): Promise<
    { access_token: string; token_type: string; refresh_token: string; expires_in: number } | { error: string }
  > {
    this.codeSessions.delete(code);
    // The flow is bound to the display's identity in step 1 only; steps 2 and 3 run on
    // flow id and code. A display that started the flow while the new-client throttle
    // was active got a TRANSIENT identity, which the registry never tracks — setToken
    // for it is a silent no-op, and the tokens handed out were never stored: every API
    // call 401, the first refresh 400, the Companion app drops the session (audit
    // 2026-09-15, B2). Refuse honestly; the display retries later with a persistent one.
    if (!this.registry.getById(session.clientId)) {
      this.adapter.log.debug(
        `Token grant refused — client ${session.clientId} has no persistent identity yet (new-client throttle)`,
      );
      reply.status(400);
      return { error: "invalid_grant" };
    }
    const token = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    await this.registry.setTokens(session.clientId, token, refreshToken);
    this.adapter.log.debug(`Display authenticated — client ${session.clientId}`);
    return {
      access_token: token,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
    };
  }

  /**
   * `refresh_token` grant: validate the incoming refresh token against issued
   * ones (was previously accepting any string, security fix v1.2.0) and mint a
   * fresh access token. The refresh token is NOT rotated: HA core itself never
   * returns a new one on refresh, and the HA Android Companion stores the token it
   * SENT (AuthenticationRepositoryImpl.kt:119-133 at 2026.9.0), ignoring any rotated response —
   * v1.28.3's RFC-6819 rotation killed the Companion token on first refresh.
   * v1.37.0 (M7).
   *
   * @param refreshToken The incoming refresh token from the request body.
   * @param reply        Fastify reply (status set to 400 on an unknown token).
   */
  private async handleRefreshGrant(
    refreshToken: string | undefined,
    reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const incoming = typeof refreshToken === "string" ? refreshToken : "";
    const ownerRecord = incoming ? this.registry.getByRefreshToken(incoming) : null;
    if (!ownerRecord) {
      this.adapter.log.debug("Refresh token rejected — unknown or missing");
      reply.status(400);
      return { error: "invalid_grant", error_description: "Invalid refresh token" };
    }
    const newAccess = crypto.randomUUID();
    await this.registry.setToken(ownerRecord.id, newAccess);
    this.adapter.log.debug(`Refresh-token-grant — client=${ownerRecord.id} new access_token issued`);
    return {
      access_token: newAccess,
      token_type: "Bearer",
      refresh_token: incoming,
      expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
    };
  }

  /**
   * Register `/api/websocket`. The endpoint's protocol — in-band handshake, heartbeat and
   * the source-verified command table — lives in `ha-websocket.ts`; this class only hands
   * it the four things it needs.
   */
  private setupWebSocket(): void {
    registerHaWebSocket(this.app, {
      adapter: this.adapter,
      clientForToken: token => this.registry.getByToken(token),
      // Bound to the refresh token like HA core (websocket_api/auth.py:116-117) — the access
      // token rotates on every refresh. Without a refresh token the access token decides.
      sessionAlive: s => {
        const client = this.registry.getById(s.clientId);
        if (!client) {
          return false;
        }
        return s.refreshToken !== null
          ? client.refreshToken === s.refreshToken
          : this.registry.getByToken(s.accessToken) === client;
      },
      instanceUuid: this.instanceUuid,
      userName: () => this.config.username || this.serviceName,
      buildHaConfig: () => this.buildHaConfig(),
    });
  }

  private setupMiscRoutes(): void {
    // Liveness only — no config leak. Earlier versions exposed the global
    // redirect URL via /health which is unauthenticated; removed in v1.2.0.
    // v1.5.0: the `config: { mdns, auth }` block went too — it leaked the auth state
    // without authentication, which an attacker on the network could use for
    // reconnaissance (quickly mapping instances with auth disabled).
    this.app.get("/health", PUBLIC_ROUTE, () => ({
      status: "ok",
      adapter: "hassemu",
      version: HA_VERSION,
    }));

    this.app.get("/manifest.json", PUBLIC_ROUTE, () => ({
      // `name` MUST be "Home Assistant" exactly — the HA Companion App
      // verifies the server identity by parsing this field. Source:
      // home-assistant/android DefaultConnectivityChecker.kt:isHomeAssistant
      // checks `name === "Home Assistant"`. Anything else (e.g. `serviceName`
      // = "ioBroker") fails the onboarding probe with "Server is not Home
      // Assistant".
      name: "Home Assistant",
      short_name: "Home Assistant",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#03a9f4",
    }));

    // Root — HTML wrapper (iframe + auto reload), or the landing page when there is no URL.
    //
    // v1.7.0 (A3): instead of a 302 we serve an iframe page that polls /api/redirect_check
    // every 30 s. When the mode/URL setting changes (a user edit in the adapter), the
    // display picks the change up and calls `location.reload()` — without a soft reboot
    // of the display. Before, the user had to reboot the display by hand.
    //
    // WebViews such as the Shelly Wall Display render iframes and JavaScript correctly.
    // Whoever wants a plain 302 (a browser test, a bookmarklet, …) can enter the target
    // URL directly — the wrapper only runs for `/`.
    this.app.get("/", PUBLIC_ROUTE, async (req, reply) => {
      const client = await this.identify(req, reply);
      // v1.32.0 B1: the resolver chain as a triage anchor. Without it a maintainer had
      // to read the resolver code to understand why exactly this URL was picked for
      // this client.
      const { url, chain } = resolveRedirectWithChain(client, this.globalConfig.redirect);
      // Only-on-change, the same discipline `/api/redirect_check` has had since v1.32.0
      // (F1) — and needed more here, because the landing page reloads every 15 s (twice
      // as often as the poll). An unconfigured display used to write ~5 800 identical
      // "→ landing" lines a day; the state that matters is the CHANGE.
      const changed = this.noteRedirectTarget(client, url ?? null);
      if (changed) {
        await this.registry.setResolvedUrl(client.id, url ?? null);
      }
      if (!url) {
        this.logTargetLine(changed, `GET / client=${client.id} → landing (chain=${chain})`);
        return reply
          .status(200)
          .type("text/html; charset=utf-8")
          .send(renderLandingPage(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
      }
      this.logTargetLine(changed, `GET / client=${client.id} → URL (chain=${chain})`);
      // v1.39.0: probe the target (cached) so a display that COLD-boots while the
      // target is down gets the target-down card with its very first page instead
      // of a black iframe until the poll rounds catch up.
      // A HEAD answer has no body to show a card in — no probe for it (H2).
      const targetReachable = req.method === "HEAD" ? true : await this.targetHealth.isReachable(url);
      return reply
        .status(200)
        .type("text/html; charset=utf-8")
        .send(renderRedirectWrapper(url, client.id, this.systemLanguage, client.ip, targetReachable));
    });

    // /api/redirect_check — the display polls it every 30 s; when the target has changed
    // (a user edit) the wrapper calls `location.reload()`. Cookie-based — the display
    // sends its `hassemu_client` cookie by itself.
    this.app.get("/api/redirect_check", PUBLIC_ROUTE, async (req, reply) => {
      const client = await this.identify(req, reply);
      const url = resolveRedirect(client, this.globalConfig.redirect);
      // v1.32.0 F1: trace on change only. Every poll (every 30 s × N displays) would
      // flood the log — only a change of target is worth a line. The first poll after
      // a restart is logged too, because the map is empty.
      const prev = this.lastRedirectTargetByClient.get(client.id);
      const next = url ?? null;
      if (this.noteRedirectTarget(client, next)) {
        this.adapter.log.debug(
          `redirect_check client=${client.id}: ${prev === undefined ? "first-poll" : (prev ?? "none")} → ${next ?? "none"}`,
        );
        await this.registry.setResolvedUrl(client.id, next);
      }
      // v1.39.0: verdict for the wrapper's target-down card. A `null` target is
      // reported reachable so no card flashes while the wrapper reloads to the
      // landing page. v1.43.0 (A1): that reload is what this sentence claimed for
      // five releases without it being true — the poll only reloaded on a
      // non-empty, DIFFERENT target, so withdrawing the choice left the display on
      // its old dashboard. The guarantee now lives in `decidePollAction`
      // (redirect-wrapper.ts), which the tests execute; do not re-assert it here.
      const targetReachable = next === null || req.method === "HEAD" ? true : await this.targetHealth.isReachable(next);
      return { target: next, targetReachable };
    });
  }

  private setupNotFound(): void {
    this.app.setNotFoundHandler((req, reply) => {
      this.adapter.log.debug(`404: ${req.method} ${req.url}`);
      reply.status(404).send({ error: "Not Found", path: req.url });
    });
  }
}
