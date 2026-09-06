import crypto from "node:crypto";
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
} from "./constants";
import { coerceString, coerceUuid, isValidRedirectUri, oneLine, safeStringEqual } from "./coerce";
import { evictOldest } from "./object-utils";
import { buildRedirectUrl, renderAuthorizeError, renderAuthorizeForm, renderAuthorizeRedirect } from "./auth-page";
import { registerHaWebSocket } from "./ha-websocket";
import { registerMobileAppRoutes } from "./mobile-app-routes";
import { HostnameResolver } from "./hostname-resolver";
import { tPage } from "./i18n";
import type { ClientRegistry } from "./client-registry";
import type { GlobalConfig } from "./global-config";
import { renderLandingPage } from "./landing-page";
import { resolveAdvertisedHost } from "./network";
import { resolveRedirect, resolveRedirectWithChain } from "./redirect-resolver";
import { renderRedirectWrapper } from "./redirect-wrapper";
import { TargetHealth, probeTarget, type TargetProbe } from "./target-health";
import type { AdapterConfig, AdapterInterface, ClientRecord, SessionData } from "./types";

// v1.22.0 (F5): `safeStringEqual` ist nach `coerce.ts` verschoben — generischer
// crypto-Helper, kein webserver-spezifischer Belang.

// v1.32.0: `renderRedirectWrapper` ist nach `lib/redirect-wrapper.ts` ausgelagert
// für Symmetrie zu `landing-page.ts` / `auth-page.ts`. `evictOldest` ist shared
// helper aus `coerce.ts`.

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
   * after the OAuth2 sign-in. Without it the App refuses to proceed with a
   * "Mobile-App-Integration nicht verfügbar" error.
   *
   * **Design — in-memory only, by intent.** The map is NOT persisted across
   * adapter restarts. Restart-recovery relies on the
   * `POST /api/webhook/<unknown-id>` branch returning HTTP 200 with a
   * truly EMPTY body — the HA Companion App reads that as a stale webhook
   * and re-runs `registerDevice`, which on hassemu issues a fresh
   * webhookId. (Source, verified at tag 2026.4.4: home-assistant/android
   * IntegrationRepositoryImpl.kt:167-171 — the trigger is
   * `response.code() == 200 && response.body()?.contentLength() == 0L`.)
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
  // I1 (v1.38.0): invalid-credentials dedup gets its OWN FIFO map so a burst of
  // distinct-message 5xx errors can't evict the per-IP credential-warn entries (and
  // vice-versa) — the two dedup classes must not share one eviction budget.
  private readonly invalidCredsCooldown: Map<string, number> = new Map();

  /**
   * @param adapter        Adapter instance used for logging, timers and namespace.
   * @param config         Resolved runtime config.
   * @param registry       Multi-client registry.
   * @param globalConfig   Global redirect override.
   * @param instanceUuid   Stable UUID shared with the mDNS advert.
   * @param systemLanguage ioBroker system language (`en`, `de`, …) used for the setup page.
   * @param targetProbe    Reachability probe for redirect targets (test seam; default {@link probeTarget}).
   */
  constructor(
    adapter: WebServerAdapter,
    config: AdapterConfig,
    registry: ClientRegistry,
    globalConfig: GlobalConfig,
    instanceUuid: string,
    systemLanguage: string = "en",
    targetProbe: TargetProbe = probeTarget,
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
    // v1.25.0 (C11): trustProxy ist Opt-In über config — nur aktivieren
    // wenn der Adapter HINTER einem trusted Reverse-Proxy mit TLS-
    // Termination läuft. Mit trustProxy=true holt Fastify `req.ip` aus
    // `X-Forwarded-For` (statt aus dem Socket), `req.protocol` aus
    // `X-Forwarded-Proto` etc. — Voraussetzung: der Proxy bereinigt diese
    // Header (sonst kann jeder Client seine sichtbare IP fälschen → verfälscht
    // Logs + die per-IP-Burst-Erkennung defekter Cookies und hebelt die per-IP-
    // Drossel neuer Clients aus; die IP-unabhängige globale Obergrenze der
    // Registry deckelt diesen Schaden — GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW).
    this.app = Fastify({ logger: false, trustProxy: this.config.trustProxy === true });
    // v1.14.0 (H8): inject einmal binden, nicht pro Getter-Access.
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
    // v1.14.0 (H9): defensive — wenn start() jemals doppelt gerufen wird
    // (Refactor, Test-Setup-Bug), Timer aus dem Vorlauf clearen statt zu
    // leaken.
    if (this.cleanupTimer) {
      this.adapter.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.app.register(fastifyCookie);
    // OAuth2-Spec verlangt `application/x-www-form-urlencoded` für `/auth/token`.
    // Echte HA-Reference-Clients (frontend/Wall Display SDK) folgen dem.
    // Fastify hat by-default nur einen JSON-Bodyparser — ohne diesen Plugin
    // beantwortet `/auth/token` mit form-Body 415 und der Login bleibt komplett
    // hängen. Tests via `app.inject({payload:{...}})` serialisieren zu JSON
    // und maskieren das.
    await this.app.register(fastifyFormbody);
    // v1.34.0: minimal read-only WebSocket for the HA Companion App. Its
    // `registerDevice` makes a best-effort `auth/current_user` WS call after the
    // REST registration; without a WS endpoint that fails (and the username is
    // not stored). Registered before the routes so `{ websocket: true }` works.
    await this.app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
    this.setupAuthGuard();
    this.setupErrorHandler();
    this.setupRoutes();

    const bindAddress = this.config.bindAddress || "0.0.0.0";
    try {
      await this.app.listen({ port: this.config.port, host: bindAddress });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const msg =
        e.code === "EADDRINUSE"
          ? `Port ${this.config.port} is already in use — another service is bound to it`
          : `Server error during startup: ${e.message}`;
      this.adapter.log.error(msg);
      throw err;
    }
    this.adapter.log.debug(`Web server listening on ${bindAddress}:${this.config.port}`);

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
      // v1.18.0 (G6+G8): debug statt error — bei intended shutdown
      // (onUnload) ist ein close-error meist ein "already-closed"-Race
      // ohne Konsequenz. Caller (main.ts onUnload) loggt nicht doppelt.
      this.adapter.log.debug(`Web server stop error: ${String(err)}`);
    }
    this.hostnames.clear();
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
      this.adapter.log.debug(`Web server stop: no websockets to terminate (${String(err)})`);
    }
  }

  // v1.14.0 (H8): `inject` ist jetzt ein readonly Field (oben deklariert,
  // im Constructor einmalig gebunden). Der frühere Getter allokierte bei
  // jedem Access eine neue Funktion.

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
   * Cooldown-Decision für 5xx-Error-Logging. Liefert `true` für die erste
   * Beobachtung pro `key` innerhalb {@link REQUEST_ERROR_COOLDOWN_MS} und
   * markiert den Eintrag — Wiederholungen liefern `false` bis das Fenster
   * abgelaufen ist. Map ist FIFO-gedeckelt auf {@link REQUEST_ERROR_COOLDOWN_CAP}.
   *
   * @param key Eindeutiger Error-Identifier (üblicherweise `error.message`).
   * @param now Aktuelle Zeit in ms (testbar).
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
   * @param clientId Display the target was resolved for.
   * @param target   The resolved URL, or null for the landing page.
   * @returns true when this differs from what the client was served last.
   */
  private noteRedirectTarget(clientId: string, target: string | null): boolean {
    const previous = this.lastRedirectTargetByClient.get(clientId);
    if (previous === target) {
      return false;
    }
    this.lastRedirectTargetByClient.set(clientId, target);
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
   * v1.15.0 (F6): zentraler Extract `req.ip → coerced string|null`. Vorher
   * 3× inline `coerceString(req.ip)` in identify/login/token-Handlern.
   *
   * @param req Fastify request (uses `req.ip`).
   */
  private static getClientIp(req: FastifyRequest): string | null {
    return coerceString(req.ip);
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
    // v1.17.0 (C8): UA durchreichen damit NAT-Co-Located Displays nicht
    // im selben Pending-Lock landen (siehe identifyOrCreate-Kommentar).
    const userAgent = coerceString(req.headers["user-agent"]);
    const record = await this.registry.identifyOrCreate(cookie, ip, { userAgent });
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
    } else {
      const reason = cookie ? "cookie-stale (unknown)" : "no-cookie";
      this.adapter.log.debug(`identify: ${reason}, new client=${record.id} ip=${ip ?? "?"}`);
      // v1.25.0 (C11): Cookie `secure: true` wenn TLS — Browser sendet
      // den Cookie dann nur über HTTPS. Bei trustProxy=true kommt
      // `req.protocol` aus `X-Forwarded-Proto`-Header. Default ohne
      // trustProxy: `req.protocol === 'http'` (Adapter ist HTTP only),
      // also Cookie nicht-secure — sonst würde der Browser ihn nie senden.
      const useSecure = req.protocol === "https";
      // v1.32.0 A2: Cookie-Secure-Decision tracen — wenn trustProxy-config
      // falsch ist, kriegt Display den Cookie evtl. nie zurück.
      this.adapter.log.debug(`identify: setting cookie secure=${useSecure} (req.protocol=${req.protocol})`);
      reply.setCookie(CLIENT_COOKIE, record.cookie, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: useSecure,
        maxAge: COOKIE_MAX_AGE_S,
      });
    }
    if (ip) {
      this.hostnames.resolve({ id: record.id, cookie: record.cookie, hasHostname: !!record.hostname }, ip);
    }
    return record;
  }

  // --- auth guard ---

  /**
   * Pre-handler hook der `/api/*`-Routen schützt wenn `authRequired=true`.
   *
   * Vorher: `/api/states`, `/api/services`, `/api/events`, `/api/error_log`,
   * `/api/discovery_info` lieferten unauthenticated alle ihre Daten —
   * pure Information-Disclosure. Echte HA verlangt `Authorization: Bearer
   * <token>` für alle `/api/*` außer dem `/api/`-Heartbeat.
   *
   * Whitelist (kein Auth nötig):
   *   - `/`, `/manifest.json`, `/health`, `/api/` — public Endpoints (Heartbeat, PWA)
   *   - `/api/discovery_info` — HA-Clients fragen das VOR dem Auth-Flow ab um
   *     zu erkennen ob `requires_api_password` true ist (Spec-Verhalten)
   *   - `/auth/*` — der Auth-Flow selbst
   *
   * Bei `authRequired=false`: Hook macht nichts (no-op), bestehender Verhalten.
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
    this.app.setErrorHandler((err, _req, reply) => {
      const error = err as Error & { validation?: unknown; statusCode?: number };
      if (error.validation) {
        this.adapter.log.debug(`Validation error: ${error.message}`);
        reply.status(400).send({ error: "Invalid request", details: error.message });
        return;
      }
      // Fastify body-parsing / client errors already set statusCode in 4xx range
      const code = typeof error.statusCode === "number" ? error.statusCode : 500;
      if (code >= 400 && code < 500) {
        this.adapter.log.debug(`Client error ${code}: ${error.message}`);
        reply.status(code).send({ error: error.message });
        return;
      }
      // 5xx: ein attacker kann mit malformed paths/oversized bodies viele
      // 500er triggern. Per-Message-Dedup-Map mit 60s-Cooldown — das erste
      // Auftreten pro unique message kommt als warn, alle Wiederholungen
      // im 60s-Fenster auf debug. Memory `feedback_no_log_spam`.
      const key = error.message || "unknown";
      if (this.shouldEmitRequestErrorWarn(key, Date.now())) {
        this.adapter.log.warn(`Request error: ${error.message}`);
      } else {
        this.adapter.log.debug(`Request error (repeat): ${error.message}`);
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

    this.app.get("/api/discovery_info", PUBLIC_ROUTE, () => {
      // v1.17.0 (E11): NICHT mehr `req.hostname` — der Host-Header ist
      // client-controlled und ein Angreifer könnte mit `Host: attacker.lan`
      // andere HA-Clients zur falschen URL umleiten. Stattdessen die
      // tatsächlich gebundene Adresse via resolveAdvertisedHost (konkrete
      // bindAddress, sonst getLocalIp) — identisch zum mDNS-Advert.
      const host = resolveAdvertisedHost(this.config.bindAddress);
      const baseUrl = `http://${host}:${this.config.port}`;
      return {
        base_url: baseUrl,
        external_url: null,
        internal_url: baseUrl,
        location_name: this.serviceName,
        // Vorher hardcoded `true` unabhängig von authRequired — strict HA-Clients
        // versuchten Auth auch bei authRequired=false und scheiterten am leeren Login-Flow.
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
        `Authorize ${method} rejected: response_type=${oneLine(String(responseType))} (expected 'code')`,
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
   * Issue an auth code, build the redirect target and render the auto-submit redirect page.
   *
   * @param reply       Fastify reply (content-type set to text/html).
   * @param clientId    Identity of the requesting display (always known).
   * @param redirectUri Already-validated `redirect_uri` to append the code to.
   * @param state       Optional OAuth2 `state` round-tripped verbatim.
   */
  private issueAuthorizeRedirect(
    reply: FastifyReply,
    clientId: string,
    redirectUri: string,
    state: string | undefined,
  ): string {
    const code = this.issueAuthorizationCode(clientId);
    const target = buildRedirectUrl(redirectUri, code, state);
    reply.type("text/html");
    return renderAuthorizeRedirect(target);
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
      await this.registry.setRefreshToken(owner.id, null);
      await this.registry.setToken(owner.id, null);
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
   * Log an invalid-credentials attempt, deduplicated per IP via its OWN cooldown map
   * (I1) — first attempt per IP within the window at warn, repeats at debug. An app
   * retrying with stale credentials after a password change would otherwise flood the
   * log every minute forever. Log-dedup only — NOT a lockout (removed in v1.31.0, stays
   * removed). v1.37.0 (M3).
   *
   * @param ip Client IP, or null.
   */
  private logInvalidCredentials(ip: string | null): void {
    const suffix = ip ? ` (IP ${ip})` : "";
    if (this.emitOncePerWindow(this.invalidCredsCooldown, `invalid-credentials:${ip ?? "?"}`, Date.now())) {
      this.adapter.log.warn(`Invalid credentials${suffix}`);
    } else {
      this.adapter.log.debug(`Invalid credentials (repeat)${suffix}`);
    }
  }

  private setupAuthRoutes(): void {
    this.app.get("/auth/providers", PUBLIC_ROUTE, () => [
      { name: "Home Assistant Local", type: "homeassistant", id: null },
    ]);

    // Browser-OAuth2 flow at GET/POST /auth/authorize. Needed by the
    // HA Companion Android App (Shelly Wall Display FW 2.6.0+ embeds
    // the Companion App). Source-verified flow:
    //   home-assistant/android UrlUtil.kt:buildAuthenticationUrl
    //   home-assistant/core indieauth.py:verify_redirect_uri
    //   home-assistant/frontend src/data/auth.ts:redirectWithAuthCode
    this.app.get<{
      Querystring: { response_type?: string; client_id?: string; redirect_uri?: string; state?: string };
    }>("/auth/authorize", PUBLIC_ROUTE, async (req, reply) => {
      const { response_type, client_id, redirect_uri, state } = req.query ?? {};

      // v1.32.0 D2: rejection-Pfade traced — Triage „warum bricht OAuth ab"
      const v = this.validateAuthorizeRequest(reply, "GET", response_type, client_id, redirect_uri);
      if (!v.ok) {
        return v.html;
      }

      const client = await this.identify(req, reply);

      // No auth required → issue the code right away and redirect.
      if (!this.config.authRequired) {
        this.adapter.log.debug(`Authorize auto-grant — client ${client.id}`);
        return this.issueAuthorizeRedirect(reply, client.id, v.redirectUri, state);
      }

      // v1.32.0 D1: Form-render Trace — wenn Companion die Form nie absendet,
      // sieht User hier dass sie überhaupt gerendert wurde.
      let redirectHost = "?";
      try {
        redirectHost = new URL(v.redirectUri).host || v.redirectUri;
      } catch {
        redirectHost = v.redirectUri;
      }
      this.adapter.log.debug(
        `Authorize form rendered — client_id=${oneLine(v.clientId)} redirect_uri-host=${redirectHost}`,
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
        state?: string;
        username?: string;
        password?: string;
      };
    }>("/auth/authorize", PUBLIC_ROUTE, async (req, reply) => {
      const { response_type, client_id, redirect_uri, state, username, password } = req.body ?? {};

      const v = this.validateAuthorizeRequest(reply, "POST", response_type, client_id, redirect_uri);
      if (!v.ok) {
        return v.html;
      }

      const client = await this.identify(req, reply);

      // No auth required → straight to redirect even on POST.
      if (!this.config.authRequired) {
        return this.issueAuthorizeRedirect(reply, client.id, v.redirectUri, state);
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
      return this.issueAuthorizeRedirect(reply, client.id, v.redirectUri, state);
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
        const session = this.sessions.get(flowId);
        if (!session) {
          // v1.8.0: nach Session-TTL (10 min) feuert das bei jedem
          // legit returning user — nicht actionable. debug, nicht warn.
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
    // token). Always 200 with empty body. Whitelisted by the `/auth/` prefix in
    // the auth guard. Source: AuthenticationRepositoryImpl.revokeSession.
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
      const session = grant_type === "authorization_code" && code ? this.codeSessions.get(code) : undefined;
      if (session && code) {
        return this.handleAuthCodeGrant(code, session);
      }

      if (grant_type === "refresh_token") {
        return this.handleRefreshGrant(refresh_token, reply);
      }

      // „wrong grant_type" ist ein Client-Format-Fehler, kein Server-Concern
      // — daher nur debug (legitime Client-Bugs sollen das Log nicht fluten).
      this.adapter.log.debug(`Token exchange failed: grant_type=${oneLine(String(grant_type))}`);
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
   */
  private async handleAuthCodeGrant(
    code: string,
    session: SessionData,
  ): Promise<{ access_token: string; token_type: string; refresh_token: string; expires_in: number }> {
    this.codeSessions.delete(code);
    const token = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    await this.registry.setToken(session.clientId, token);
    await this.registry.setRefreshToken(session.clientId, refreshToken);
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
   * SENT (AuthenticationRepositoryImpl.kt:147), ignoring any rotated response —
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
      instanceUuid: this.instanceUuid,
      userName: () => this.config.username || this.serviceName,
      buildHaConfig: () => this.buildHaConfig(),
    });
  }

  private setupMiscRoutes(): void {
    // Liveness only — no config leak. Earlier versions exposed the global
    // redirect URL via /health which is unauthenticated; removed in v1.2.0.
    // v1.5.0: auch der `config: { mdns, auth }`-Block raus — Auth-Status leakte
    // unauthenticated und ließ sich von einem Network-Attacker zur Reconnaissance
    // nutzen (auth-disabled Instances quickly mappen).
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
      // = "ioBroker") fails the onboarding probe with "Server ist nicht
      // Home Assistant".
      name: "Home Assistant",
      short_name: "Home Assistant",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#03a9f4",
    }));

    // Root — HTML-Wrapper (iframe + auto-reload), oder Landing-Page wenn keine URL.
    //
    // v1.7.0 (A3): statt 302 liefern wir ein iframe-HTML + 30s-poll auf
    // /api/redirect_check. Wenn die Mode-/URL-Config sich ändert (User edit
    // im Adapter), pollt das Display den Wechsel und macht `location.reload()`
    // — ohne Soft-Reboot des Displays. Vorher musste der User das Display
    // manuell rebooten.
    //
    // WebViews wie Shelly Wall Display rendern iframes + JavaScript korrekt.
    // Falls ein User direkten 302-Redirect will (Browser-Test, Bookmarklet
    // etc.), kann er die Target-URL direkt eingeben — der Wrapper läuft nur
    // beim Aufruf von `/`.
    this.app.get("/", PUBLIC_ROUTE, async (req, reply) => {
      const client = await this.identify(req, reply);
      // v1.32.0 B1: Resolver-Chain als Triage-Anker. Ohne Chain musste der
      // Maintainer den Resolver-Code lesen um zu verstehen warum genau
      // diese URL für diesen Client gewählt wurde.
      const { url, chain } = resolveRedirectWithChain(client, this.globalConfig.redirect);
      // Only-on-change, the same discipline `/api/redirect_check` has had since v1.32.0
      // (F1) — and needed more here, because the landing page reloads every 15 s (twice
      // as often as the poll). An unconfigured display used to write ~5 800 identical
      // "→ landing" lines a day; the state that matters is the CHANGE.
      const changed = this.noteRedirectTarget(client.id, url ?? null);
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
      const targetReachable = await this.targetHealth.isReachable(url);
      return reply
        .status(200)
        .type("text/html; charset=utf-8")
        .send(renderRedirectWrapper(url, client.id, this.systemLanguage, client.ip, targetReachable));
    });

    // /api/redirect_check — Display polled das alle 30s; wenn der target
    // sich geändert hat (User edit), gibt der Wrapper `location.reload()`
    // ab. Cookie-basiert — Display schickt seinen `hassemu_client`-Cookie
    // automatisch mit.
    this.app.get("/api/redirect_check", PUBLIC_ROUTE, async (req, reply) => {
      const client = await this.identify(req, reply);
      const url = resolveRedirect(client, this.globalConfig.redirect);
      // v1.32.0 F1: only-on-change-Trace. Jeder Poll (alle 30s × N Displays)
      // wäre Flood — diagnostisch wertvoll ist nur der Target-Wechsel.
      // First-time-poll-pro-restart wird auch geloggt weil Map leer ist.
      const prev = this.lastRedirectTargetByClient.get(client.id);
      const next = url ?? null;
      if (this.noteRedirectTarget(client.id, next)) {
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
      const targetReachable = next === null ? true : await this.targetHealth.isReachable(next);
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
