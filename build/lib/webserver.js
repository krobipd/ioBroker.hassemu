"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var webserver_exports = {};
__export(webserver_exports, {
  CLIENT_COOKIE: () => CLIENT_COOKIE,
  WebServer: () => WebServer
});
module.exports = __toCommonJS(webserver_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_promises = __toESM(require("node:dns/promises"));
var import_cookie = __toESM(require("@fastify/cookie"));
var import_formbody = __toESM(require("@fastify/formbody"));
var import_websocket = __toESM(require("@fastify/websocket"));
var import_fastify = __toESM(require("fastify"));
var import_constants = require("./constants");
var import_coerce = require("./coerce");
var import_auth_page = require("./auth-page");
var import_landing_page = require("./landing-page");
var import_network = require("./network");
var import_redirect_wrapper = require("./redirect-wrapper");
const CLIENT_COOKIE = "hassemu_client";
function mobileRegResponse(webhookId) {
  return { webhook_id: webhookId, cloudhook_url: null, remote_ui_url: null, secret: null };
}
class WebServer {
  adapter;
  config;
  registry;
  globalConfig;
  app;
  sessions = /* @__PURE__ */ new Map();
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
  webhookRegistrations = /* @__PURE__ */ new Map();
  /**
   * v1.32.0 F1: last redirect-target seen per client by `/api/redirect_check`.
   * Used to log only-on-change (instead of every 30s poll). Pruned in
   * {@link cleanupSessions} against `registry.listAll()` — stale entries from
   * removed clients are dropped within max 5 min.
   */
  lastRedirectTargetByClient = /* @__PURE__ */ new Map();
  cleanupTimer = null;
  /**
   * Test-only injection surface ({@link WebserverInject}). v1.14.0 (H8): bound
   * once in the constructor instead of via a getter — a getter allocated a new
   * bound function on every `s.inject({...})` call, and tests call it in loops.
   */
  inject;
  instanceUuid;
  /** ioBroker system language for the setup page — resolved on startup. */
  systemLanguage;
  /** Set of IPs whose reverse DNS lookup is already in-flight — prevents duplicate work. */
  dnsInFlight = /* @__PURE__ */ new Set();
  /**
   * Per-message cooldown timestamps for 5xx error logging. First occurrence
   * of a unique message logs at warn; repeats within {@link REQUEST_ERROR_COOLDOWN_MS}
   * fall to debug to prevent log-spam under attack/probe traffic.
   */
  errorLogCooldown = /* @__PURE__ */ new Map();
  /**
   * @param adapter        Adapter instance used for logging, timers and namespace.
   * @param config         Resolved runtime config.
   * @param registry       Multi-client registry.
   * @param globalConfig   Global redirect override.
   * @param instanceUuid   Stable UUID shared with the mDNS advert.
   * @param systemLanguage ioBroker system language (`en`, `de`, …) used for the setup page.
   */
  constructor(adapter, config, registry, globalConfig, instanceUuid, systemLanguage = "en") {
    this.adapter = adapter;
    this.config = config;
    this.registry = registry;
    this.globalConfig = globalConfig;
    this.instanceUuid = instanceUuid;
    this.systemLanguage = systemLanguage;
    this.app = (0, import_fastify.default)({ logger: false, trustProxy: this.config.trustProxy === true });
    this.inject = this.app.inject.bind(this.app);
  }
  /** Human-readable service name advertised in responses and mDNS. */
  get serviceName() {
    return this.config.serviceName || "ioBroker";
  }
  /** Resolved listener address once `start()` has completed, or null otherwise. */
  get boundAddress() {
    const addr = this.app.server.address();
    if (!addr || typeof addr === "string") {
      return null;
    }
    return { address: addr.address, port: addr.port };
  }
  // --- lifecycle ---
  /** Registers plugins and starts the HTTP listener. */
  async start() {
    var _a;
    if (this.cleanupTimer) {
      this.adapter.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.app.register(import_cookie.default);
    await this.app.register(import_formbody.default);
    await this.app.register(import_websocket.default);
    this.setupAuthGuard();
    this.setupErrorHandler();
    this.setupRoutes();
    const bindAddress = this.config.bindAddress || "0.0.0.0";
    try {
      await this.app.listen({ port: this.config.port, host: bindAddress });
    } catch (err) {
      const e = err;
      const msg = e.code === "EADDRINUSE" ? `Port ${this.config.port} is already in use \u2014 another service is bound to it` : `Server error during startup: ${e.message}`;
      this.adapter.log.error(msg);
      throw err;
    }
    this.adapter.log.debug(`Web server listening on ${bindAddress}:${this.config.port}`);
    this.cleanupTimer = (_a = this.adapter.setInterval(() => this.cleanupSessions(), import_constants.CLEANUP_INTERVAL_MS)) != null ? _a : null;
  }
  /** Stops the listener and cancels the session cleanup timer. */
  async stop() {
    if (this.cleanupTimer) {
      this.adapter.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try {
      await this.app.close();
      this.adapter.log.debug("Web server stopped");
    } catch (err) {
      this.adapter.log.debug(`Web server stop error: ${String(err)}`);
    }
    this.dnsInFlight.clear();
  }
  // v1.14.0 (H8): `inject` ist jetzt ein readonly Field (oben deklariert,
  // im Constructor einmalig gebunden). Der frühere Getter allokierte bei
  // jedem Access eine neue Funktion.
  /** Periodic cleanup of expired in-flight auth sessions and stale redirect-target entries. */
  cleanupSessions() {
    const now = Date.now();
    let cleanedSessions = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.created > import_constants.SESSION_TTL_MS) {
        this.sessions.delete(key);
        cleanedSessions++;
      }
    }
    if (cleanedSessions > 0) {
      this.adapter.log.debug(`Session cleanup: removed ${cleanedSessions} expired sessions`);
    }
    const activeClients = new Set(this.registry.listAll().map((r) => r.id));
    let prunedTargets = 0;
    for (const clientId of this.lastRedirectTargetByClient.keys()) {
      if (!activeClients.has(clientId)) {
        this.lastRedirectTargetByClient.delete(clientId);
        prunedTargets++;
      }
    }
    if (prunedTargets > 0) {
      this.adapter.log.debug(`Cleanup: pruned ${prunedTargets} stale redirect-target entries`);
    }
    let prunedWebhooks = 0;
    for (const [webhookId, ownerId] of this.webhookRegistrations) {
      if (ownerId !== "" && !activeClients.has(ownerId)) {
        this.webhookRegistrations.delete(webhookId);
        prunedWebhooks++;
      }
    }
    if (prunedWebhooks > 0) {
      this.adapter.log.debug(`Cleanup: pruned ${prunedWebhooks} webhook registrations of removed clients`);
    }
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
  shouldEmitRequestErrorWarn(key, now) {
    var _a;
    const lastSeen = (_a = this.errorLogCooldown.get(key)) != null ? _a : 0;
    if (lastSeen !== 0 && now - lastSeen <= import_constants.REQUEST_ERROR_COOLDOWN_MS) {
      return false;
    }
    if (!this.errorLogCooldown.has(key)) {
      (0, import_coerce.evictOldest)(this.errorLogCooldown, import_constants.REQUEST_ERROR_COOLDOWN_CAP);
    }
    this.errorLogCooldown.set(key, now);
    return true;
  }
  /**
   * Inserts a session, dropping the oldest entry if {@link SESSIONS_CAP} is exceeded.
   *
   * @param key  Session key (flow id or auth code).
   * @param data Session payload.
   */
  storeSession(key, data) {
    (0, import_coerce.evictOldest)(this.sessions, import_constants.SESSIONS_CAP);
    this.sessions.set(key, data);
  }
  // --- client identification ---
  /**
   * v1.15.0 (F6): zentraler Extract `req.ip → coerced string|null`. Vorher
   * 3× inline `coerceString(req.ip)` in identify/login/token-Handlern.
   *
   * @param req Fastify request (uses `req.ip`).
   */
  static getClientIp(req) {
    return (0, import_coerce.coerceString)(req.ip);
  }
  async identify(req, reply) {
    var _a;
    const cookie = (0, import_coerce.coerceUuid)((_a = req.cookies) == null ? void 0 : _a[CLIENT_COOKIE]);
    const ip = WebServer.getClientIp(req);
    const userAgent = (0, import_coerce.coerceString)(req.headers["user-agent"]);
    const record = await this.registry.identifyOrCreate(cookie, ip, null, userAgent);
    if (cookie === record.cookie) {
      this.adapter.log.debug(`identify: cookie-hit client=${record.id} ip=${ip != null ? ip : "?"}`);
    } else {
      const reason = cookie ? "cookie-stale (unknown)" : "no-cookie";
      this.adapter.log.debug(`identify: ${reason}, new client=${record.id} ip=${ip != null ? ip : "?"}`);
      const useSecure = req.protocol === "https";
      this.adapter.log.debug(`identify: setting cookie secure=${useSecure} (req.protocol=${req.protocol})`);
      reply.setCookie(CLIENT_COOKIE, record.cookie, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: useSecure,
        maxAge: import_constants.COOKIE_MAX_AGE_S
      });
    }
    if (ip) {
      this.resolveHostnameAsync(record, ip);
    }
    return record;
  }
  resolveHostnameAsync(record, ip) {
    if (record.hostname || this.dnsInFlight.has(ip)) {
      return;
    }
    this.dnsInFlight.add(ip);
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = this.adapter.setTimeout(() => reject(new Error("dns reverse-lookup timeout")), 5e3);
    });
    Promise.race([import_promises.default.reverse(ip), timeout]).then((names) => {
      const name = names[0];
      if (name) {
        this.adapter.log.debug(`resolveHostname: ip=${ip} \u2192 hostname=${name}`);
        this.registry.identifyOrCreate(record.cookie, ip, name).catch(() => {
        });
      }
    }).catch((err) => {
      this.adapter.log.debug(
        `resolveHostname: ip=${ip} failed \u2014 ${err instanceof Error ? err.message : String(err)}`
      );
    }).finally(() => {
      if (timeoutHandle) {
        this.adapter.clearTimeout(timeoutHandle);
      }
      this.dnsInFlight.delete(ip);
    });
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
  setupAuthGuard() {
    this.app.addHook("preHandler", async (req, reply) => {
      var _a;
      if (!this.config.authRequired) {
        return;
      }
      const path = ((_a = req.url) != null ? _a : "/").split("?")[0];
      if (path === "/" || path === "/api/" || path === "/api/discovery_info" || path === "/manifest.json" || path === "/health" || path.startsWith("/auth/") || // v1.34.0: the WebSocket does its own auth in the handshake
      // (`auth_required` → `auth` frame), not via a Bearer header — so the
      // HTTP upgrade itself must pass the guard.
      path === "/api/websocket" || // v1.29.1: Mobile-App webhooks carry the secret in the URL
      // (`webhookId`) — HA core also serves these unauthenticated.
      // Source: home-assistant/core/.../mobile_app/webhook.py.
      path.startsWith("/api/webhook/")) {
        return;
      }
      const authHeader = req.headers.authorization;
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        this.adapter.log.debug(`Auth required for ${path} \u2014 missing Bearer token`);
        reply.status(401).send({ error: "unauthorized" });
        return;
      }
      const token = authHeader.substring("Bearer ".length).trim();
      const client = this.registry.getByToken(token);
      if (!client) {
        this.adapter.log.debug(`Auth required for ${path} \u2014 unknown Bearer token`);
        reply.status(401).send({ error: "invalid_token" });
        return;
      }
    });
  }
  // --- error handling ---
  setupErrorHandler() {
    this.app.setErrorHandler((err, _req, reply) => {
      const error = err;
      if (error.validation) {
        this.adapter.log.debug(`Validation error: ${error.message}`);
        reply.status(400).send({ error: "Invalid request", details: error.message });
        return;
      }
      const code = typeof error.statusCode === "number" ? error.statusCode : 500;
      if (code >= 400 && code < 500) {
        this.adapter.log.debug(`Client error ${code}: ${error.message}`);
        reply.status(code).send({ error: error.message });
        return;
      }
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
  setupRoutes() {
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
  buildHaConfig() {
    return {
      components: ["http", "api", "frontend", "homeassistant", "mobile_app"],
      config_dir: "/config",
      elevation: 0,
      latitude: 0,
      longitude: 0,
      location_name: this.serviceName,
      time_zone: "UTC",
      unit_system: { length: "km", mass: "g", temperature: "\xB0C", volume: "L" },
      version: import_constants.HA_VERSION,
      whitelist_external_dirs: []
    };
  }
  setupApiRoutes() {
    this.app.get("/api/", () => ({ message: "API running." }));
    this.app.get("/api/config", () => this.buildHaConfig());
    this.app.get("/api/discovery_info", () => {
      const host = (0, import_network.resolveAdvertisedHost)(this.config.bindAddress);
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
        version: import_constants.HA_VERSION
      };
    });
    for (const path of ["/api/states", "/api/services", "/api/events"]) {
      this.app.get(path, () => []);
    }
    this.app.get("/api/error_log", () => "");
    this.app.post("/api/mobile_app/registrations", async (req, reply) => {
      var _a, _b, _c, _d, _e;
      const body = (_a = req.body) != null ? _a : {};
      const authHeader = (_b = req.headers.authorization) != null ? _b : "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
      const client = this.registry.getByToken(token);
      const ownerId = (_c = client == null ? void 0 : client.id) != null ? _c : "";
      const webhookId = import_node_crypto.default.randomUUID().replace(/-/g, "");
      (0, import_coerce.evictOldest)(this.webhookRegistrations, import_constants.WEBHOOK_REGISTRATIONS_CAP);
      this.webhookRegistrations.set(webhookId, ownerId);
      this.adapter.log.debug(
        `Mobile-App registration \u2014 client=${ownerId} app_id=${(_d = body.app_id) != null ? _d : "?"} device_name=${(_e = body.device_name) != null ? _e : "?"} \u2192 webhook=${webhookId}`
      );
      reply.status(201);
      return mobileRegResponse(webhookId);
    });
    this.app.put("/api/mobile_app/registrations/:webhookId", async (req, reply) => {
      const id = req.params.webhookId;
      if (!this.webhookRegistrations.has(id)) {
        this.adapter.log.debug(`Mobile-App PUT registration: unknown webhookId=${id.substring(0, 8)}\u2026 \u2014 returning 404`);
        reply.status(404);
        return { error: "unknown_registration" };
      }
      return mobileRegResponse(id);
    });
    this.app.delete(
      "/api/mobile_app/registrations/:webhookId",
      async (req, reply) => {
        const id = req.params.webhookId;
        const wasPresent = this.webhookRegistrations.has(id);
        this.webhookRegistrations.delete(id);
        this.adapter.log.debug(
          `Mobile-App DELETE registration: webhookId=${id.substring(0, 8)}\u2026 removed (was-present=${wasPresent})`
        );
        reply.status(204);
        return null;
      }
    );
    this.app.post("/api/webhook/:webhookId", async (req, reply) => {
      var _a;
      const id = req.params.webhookId;
      if (!this.webhookRegistrations.has(id)) {
        this.adapter.log.debug(
          `Webhook fallthrough: stale id=${id.substring(0, 8)}\u2026 \u2014 App will trigger re-registration`
        );
        return reply.status(200).send();
      }
      const body = (_a = req.body) != null ? _a : {};
      const type = typeof body.type === "string" ? body.type : "";
      this.adapter.log.debug(`Webhook ${id.substring(0, 8)}\u2026 type=${type || "(no type)"}`);
      switch (type) {
        case "get_config":
          return this.buildHaConfig();
        case "get_zones":
          return [];
        case "render_template":
          return {};
        case "update_registration":
          return mobileRegResponse(id);
        case "register_sensor":
          return { success: true };
        case "update_sensor_states":
          return {};
        default:
          return {};
      }
    });
  }
  /**
   * Issue a fresh authorization code and persist it in the sessions map.
   *
   * Single source for both the JSON login flow (`/auth/login_flow/<flowId>`
   * → `create_entry`) and the browser OAuth2 flow (`/auth/authorize` →
   * 302). The code is exchanged for tokens at `/auth/token` (`grant_type =
   * authorization_code`); the existing token-view consumes the same map.
   *
   * @param clientId Identity cookie value of the requesting display, or
   *                 undefined for headless OAuth2-only flows.
   */
  issueAuthorizationCode(clientId) {
    const code = import_node_crypto.default.randomUUID();
    this.storeSession(code, { created: Date.now(), clientId });
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
  validateAuthorizeRequest(reply, method, responseType, clientId, redirectUri) {
    if (responseType !== "code") {
      this.adapter.log.debug(`Authorize ${method} rejected: response_type=${String(responseType)} (expected 'code')`);
      reply.status(400).type("text/html");
      return {
        ok: false,
        html: (0, import_auth_page.renderAuthorizeError)(
          "unsupported_response_type",
          "This authorization server supports `response_type=code` only."
        )
      };
    }
    if (typeof clientId !== "string" || typeof redirectUri !== "string") {
      this.adapter.log.debug(
        `Authorize ${method} rejected: missing client_id or redirect_uri (cid=${typeof clientId}, ru=${typeof redirectUri})`
      );
      reply.status(400).type("text/html");
      return {
        ok: false,
        html: (0, import_auth_page.renderAuthorizeError)("invalid_request", "Missing or invalid `client_id` or `redirect_uri` parameter.")
      };
    }
    if (!(0, import_coerce.isValidRedirectUri)(clientId, redirectUri)) {
      this.adapter.log.debug(
        `Authorize ${method} rejected: redirect_uri "${redirectUri}" not allowed for client_id "${clientId}"`
      );
      reply.status(400).type("text/html");
      return {
        ok: false,
        html: (0, import_auth_page.renderAuthorizeError)(
          "invalid_redirect_uri",
          "The `redirect_uri` parameter is not on the allowlist for this client."
        )
      };
    }
    return { ok: true, clientId, redirectUri };
  }
  /**
   * Issue an auth code, build the redirect target and render the auto-submit redirect page.
   *
   * @param reply       Fastify reply (content-type set to text/html).
   * @param clientId    Identity of the requesting display, or null for headless flows.
   * @param redirectUri Already-validated `redirect_uri` to append the code to.
   * @param state       Optional OAuth2 `state` round-tripped verbatim.
   */
  issueAuthorizeRedirect(reply, clientId, redirectUri, state) {
    const code = this.issueAuthorizationCode(clientId);
    const target = (0, import_auth_page.buildRedirectUrl)(redirectUri, code, state);
    reply.type("text/html");
    return (0, import_auth_page.renderAuthorizeRedirect)(target);
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
  async revokeToken(token) {
    const refresh = typeof token === "string" ? token : "";
    const owner = refresh ? this.registry.getByRefreshToken(refresh) : null;
    if (owner) {
      await this.registry.setRefreshToken(owner.id, null);
      await this.registry.setToken(owner.id, null);
      this.adapter.log.debug(`Token revoked \u2014 client ${owner.id}`);
    } else {
      this.adapter.log.debug("Revoke: unknown/missing token \u2014 returning 200 (HA behavior)");
    }
  }
  setupAuthRoutes() {
    this.app.get("/auth/providers", () => [{ name: "Home Assistant Local", type: "homeassistant", id: null }]);
    this.app.get("/auth/authorize", async (req, reply) => {
      var _a;
      const { response_type, client_id, redirect_uri, state } = (_a = req.query) != null ? _a : {};
      const v = this.validateAuthorizeRequest(reply, "GET", response_type, client_id, redirect_uri);
      if (!v.ok) {
        return v.html;
      }
      const client = await this.identify(req, reply);
      if (!this.config.authRequired) {
        this.adapter.log.debug(`Authorize auto-grant \u2014 client ${client.id}`);
        return this.issueAuthorizeRedirect(reply, client.id, v.redirectUri, state);
      }
      let redirectHost = "?";
      try {
        redirectHost = new URL(v.redirectUri).host || v.redirectUri;
      } catch {
        redirectHost = v.redirectUri;
      }
      this.adapter.log.debug(`Authorize form rendered \u2014 client_id=${v.clientId} redirect_uri-host=${redirectHost}`);
      reply.type("text/html");
      return (0, import_auth_page.renderAuthorizeForm)({ clientId: v.clientId, redirectUri: v.redirectUri, state });
    });
    this.app.post("/auth/authorize", async (req, reply) => {
      var _a;
      const { response_type, client_id, redirect_uri, state, username, password } = (_a = req.body) != null ? _a : {};
      const v = this.validateAuthorizeRequest(reply, "POST", response_type, client_id, redirect_uri);
      if (!v.ok) {
        return v.html;
      }
      const client = await this.identify(req, reply);
      if (!this.config.authRequired) {
        return this.issueAuthorizeRedirect(reply, client.id, v.redirectUri, state);
      }
      const ip = WebServer.getClientIp(req);
      const userOk = typeof username === "string" && (0, import_coerce.safeStringEqual)(username, this.config.username);
      const passOk = typeof password === "string" && (0, import_coerce.safeStringEqual)(password, this.config.password);
      if (!userOk || !passOk) {
        const ipSuffix = ip ? ` (IP ${ip})` : "";
        this.adapter.log.warn(`Invalid credentials${ipSuffix}`);
        reply.status(401).type("text/html");
        return (0, import_auth_page.renderAuthorizeForm)(
          { clientId: v.clientId, redirectUri: v.redirectUri, state },
          "Invalid username or password."
        );
      }
      this.adapter.log.debug(`Authorize grant \u2014 client ${client.id}`);
      return this.issueAuthorizeRedirect(reply, client.id, v.redirectUri, state);
    });
    this.app.post("/auth/login_flow", async (req, reply) => {
      const client = await this.identify(req, reply);
      const flowId = import_node_crypto.default.randomUUID();
      this.storeSession(flowId, { created: Date.now(), clientId: client.id });
      this.adapter.log.debug(`Auth flow created: ${flowId} for client ${client.id}`);
      return {
        type: "form",
        flow_id: flowId,
        handler: ["homeassistant", null],
        step_id: "init",
        data_schema: import_constants.LOGIN_SCHEMA,
        description_placeholders: null,
        errors: null
      };
    });
    this.app.post(
      "/auth/login_flow/:flowId",
      {
        schema: {
          params: {
            type: "object",
            properties: { flowId: { type: "string", minLength: 1 } },
            required: ["flowId"]
          }
        }
      },
      async (req, reply) => {
        var _a;
        const flowId = req.params.flowId;
        const session = this.sessions.get(flowId);
        if (!session) {
          this.adapter.log.debug(`Unknown flow_id: ${flowId}`);
          reply.status(400);
          return { type: "abort", flow_id: flowId, reason: "unknown_flow" };
        }
        if (this.config.authRequired) {
          const ip = WebServer.getClientIp(req);
          const { username, password } = (_a = req.body) != null ? _a : {};
          const userOk = typeof username === "string" && (0, import_coerce.safeStringEqual)(username, this.config.username);
          const passOk = typeof password === "string" && (0, import_coerce.safeStringEqual)(password, this.config.password);
          if (!userOk || !passOk) {
            const ipSuffix = ip ? ` (IP ${ip})` : "";
            this.adapter.log.warn(`Invalid credentials${ipSuffix}`);
            reply.status(400);
            return {
              type: "form",
              flow_id: flowId,
              handler: ["homeassistant", null],
              step_id: "init",
              data_schema: import_constants.LOGIN_SCHEMA,
              errors: { base: "invalid_auth" },
              description_placeholders: null
            };
          }
        }
        this.sessions.delete(flowId);
        const code = import_node_crypto.default.randomUUID();
        this.storeSession(code, { created: Date.now(), clientId: session.clientId });
        this.adapter.log.debug("Auth flow completed \u2014 code issued");
        return {
          version: 1,
          type: "create_entry",
          flow_id: flowId,
          handler: ["homeassistant", null],
          result: code,
          description: null,
          description_placeholders: null
        };
      }
    );
    this.app.post("/auth/revoke", async (req) => {
      var _a;
      await this.revokeToken((_a = req.body) == null ? void 0 : _a.token);
      return {};
    });
    this.app.post("/auth/token", async (req, reply) => {
      var _a, _b, _c;
      const { code, grant_type, refresh_token, action } = (_a = req.body) != null ? _a : {};
      if (action === "revoke") {
        await this.revokeToken((_c = (_b = req.body) == null ? void 0 : _b.token) != null ? _c : refresh_token);
        return {};
      }
      if (grant_type === "authorization_code" && code && this.sessions.has(code)) {
        const session = this.sessions.get(code);
        this.sessions.delete(code);
        const token = import_node_crypto.default.randomUUID();
        const refreshToken = import_node_crypto.default.randomUUID();
        if (session.clientId) {
          await this.registry.setToken(session.clientId, token);
          await this.registry.setRefreshToken(session.clientId, refreshToken);
          this.adapter.log.debug(`Display authenticated \u2014 client ${session.clientId}`);
        }
        return {
          access_token: token,
          token_type: "Bearer",
          refresh_token: refreshToken,
          expires_in: import_constants.OAUTH_ACCESS_TOKEN_TTL_S
        };
      }
      if (grant_type === "refresh_token") {
        const incoming = typeof refresh_token === "string" ? refresh_token : "";
        const ownerRecord = incoming ? this.registry.getByRefreshToken(incoming) : null;
        if (!ownerRecord) {
          this.adapter.log.debug("Refresh token rejected \u2014 unknown or missing");
          reply.status(400);
          return { error: "invalid_grant", error_description: "Invalid refresh token" };
        }
        const newAccess = import_node_crypto.default.randomUUID();
        await this.registry.setToken(ownerRecord.id, newAccess);
        this.adapter.log.debug(`Refresh-token-grant \u2014 client=${ownerRecord.id} new access_token issued`);
        return {
          access_token: newAccess,
          token_type: "Bearer",
          refresh_token: incoming,
          expires_in: import_constants.OAUTH_ACCESS_TOKEN_TTL_S
        };
      }
      this.adapter.log.debug(`Token exchange failed: grant_type=${String(grant_type)}`);
      reply.status(400);
      return { error: "invalid_request", error_description: "Invalid or expired code" };
    });
  }
  /**
   * Minimal read-only HA WebSocket at `/api/websocket`. The HA Companion App's
   * `registerDevice` makes a best-effort `auth/current_user` WS call after the
   * REST registration to store the username (home-assistant/android
   * IntegrationRepositoryImpl.kt at tag 2026.4.4, line 154). Without a WS
   * endpoint that throws and the registration logs "Unable to save device registration".
   *
   * Auth happens in-band: server sends `auth_required`, client replies with an
   * `auth` frame, we validate the access token against the registry. FAIL-FAST:
   * a missing/invalid token or a missing `auth` frame within
   * {@link WS_AUTH_TIMEOUT_MS} closes the socket — so the WS never hangs the
   * App's call (which previously failed fast against a clean 404).
   */
  setupWebSocket() {
    this.app.get("/api/websocket", { websocket: true }, (socket) => {
      let authed = false;
      let authTimer = this.adapter.setTimeout(() => {
        if (!authed) {
          this.adapter.log.debug("WS: no auth frame within timeout \u2014 closing");
          this.wsSend(socket, { type: "auth_invalid", message: "Authentication timed out" });
          socket.close();
        }
      }, import_constants.WS_AUTH_TIMEOUT_MS);
      this.wsSend(socket, { type: "auth_required", ha_version: import_constants.HA_VERSION });
      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8");
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!authed) {
          const token = typeof msg.access_token === "string" ? msg.access_token : "";
          if (msg.type === "auth" && token && this.registry.getByToken(token)) {
            authed = true;
            if (authTimer) {
              this.adapter.clearTimeout(authTimer);
              authTimer = void 0;
            }
            this.wsSend(socket, { type: "auth_ok", ha_version: import_constants.HA_VERSION });
          } else {
            this.adapter.log.debug("WS: auth_invalid \u2014 unknown or missing access token");
            this.wsSend(socket, { type: "auth_invalid", message: "Invalid access token" });
            socket.close();
          }
          return;
        }
        this.handleWsCommand(socket, msg);
      });
      socket.on("error", () => {
      });
      socket.on("close", () => {
        if (authTimer) {
          this.adapter.clearTimeout(authTimer);
          authTimer = void 0;
        }
      });
    });
  }
  /**
   * Safely serialize + send a WS frame; swallows errors from an already-closed socket.
   *
   * @param socket  The client WebSocket to write to.
   * @param payload Plain object serialized to a JSON text frame.
   */
  wsSend(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
    }
  }
  /**
   * Handle one authenticated WS command. hassemu emulates an empty-but-valid HA
   * server with only the components it advertises (http/api/frontend/
   * homeassistant/mobile_app). Responses use only shapes that are either
   * source-verified or trivially correct for an empty server:
   * - data queries → correct empty shape ([] / {}),
   * - subscriptions → ack that never emits (no entities/events on a shim),
   * - everything hassemu does NOT implement (call_service on a service-less
   *   server, conversation, Matter/Thread, assist_pipeline, …) → `unknown_command`,
   *   which is exactly what real HA returns for an unregistered command type.
   *
   * The command SET is verified against home-assistant/android
   * WebSocketRepositoryImpl at tag 2026.4.4; the error code against
   * home-assistant/core websocket_api/const.py at tag 2026.4.0 (ERR_UNKNOWN_COMMAND).
   * No speculative response shapes are emitted.
   *
   * @param socket The authenticated client WebSocket.
   * @param msg    The parsed incoming command frame (`{ id, type, ... }`).
   */
  handleWsCommand(socket, msg) {
    const id = msg.id;
    const type = typeof msg.type === "string" ? msg.type : "";
    const result = (r) => this.wsSend(socket, { id, type: "result", success: true, result: r });
    switch (type) {
      case "ping":
        this.wsSend(socket, { id, type: "pong" });
        return;
      case "auth/current_user":
        result({
          id: this.instanceUuid,
          name: this.config.username || this.serviceName,
          is_owner: true,
          is_admin: true
        });
        return;
      case "get_config":
        result(this.buildHaConfig());
        return;
      case "get_states":
        result([]);
        return;
      case "get_services":
        result({});
        return;
      // Registries on an entity-less emulated server → empty lists.
      case "config/area_registry/list":
      case "config/device_registry/list":
      case "config/entity_registry/list":
        result([]);
        return;
      // Valid subscriptions on an empty server — they ack but never emit.
      // mobile_app/* is an advertised component, so both its WS commands ack
      // consistently (the channel subscribe + the confirm).
      case "subscribe_events":
      case "subscribe_entities":
      case "supported_features":
      case "mobile_app/push_notification_channel":
      case "mobile_app/push_notification_confirm":
        result(null);
        return;
      default:
        this.wsSend(socket, {
          id,
          type: "result",
          success: false,
          error: { code: "unknown_command", message: `Command "${type}" is not supported by this server` }
        });
        return;
    }
  }
  setupMiscRoutes() {
    this.app.get("/health", () => ({
      status: "ok",
      adapter: "hassemu",
      version: import_constants.HA_VERSION
    }));
    this.app.get("/manifest.json", () => ({
      // `name` MUST be "Home Assistant" exactly — the HA Companion App
      // verifies the server identity by parsing this field. Source:
      // home-assistant/android DefaultConnectivityChecker.kt:isHomeAssistant
      // checks `name === "Home Assistant"`. Anything else (e.g. `serviceName`
      // = "ioBroker") fails the onboarding probe with "Server ist nicht
      // Home Assistant". Detail in Ressourcen/hassemu/oauth2-browser-flow-shelly-fw26.md.
      name: "Home Assistant",
      short_name: "Home Assistant",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#03a9f4"
    }));
    this.app.get("/", async (req, reply) => {
      const client = await this.identify(req, reply);
      const { url, chain } = this.globalConfig.resolveUrlForWithChain(client);
      if (!url) {
        this.adapter.log.debug(`GET / client=${client.id} \u2192 landing (chain=${chain})`);
        return reply.status(200).type("text/html; charset=utf-8").send((0, import_landing_page.renderLandingPage)(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
      }
      this.adapter.log.debug(`GET / client=${client.id} \u2192 URL (chain=${chain})`);
      return reply.status(200).type("text/html; charset=utf-8").send((0, import_redirect_wrapper.renderRedirectWrapper)(url, client.id, this.systemLanguage, client.ip));
    });
    this.app.get("/api/redirect_check", async (req, reply) => {
      const client = await this.identify(req, reply);
      const url = this.globalConfig.resolveUrlFor(client);
      const prev = this.lastRedirectTargetByClient.get(client.id);
      const next = url != null ? url : null;
      if (prev !== next) {
        this.adapter.log.debug(
          `redirect_check client=${client.id}: ${prev === void 0 ? "first-poll" : prev != null ? prev : "none"} \u2192 ${next != null ? next : "none"}`
        );
        this.lastRedirectTargetByClient.set(client.id, next);
      }
      return { target: next };
    });
  }
  setupNotFound() {
    this.app.setNotFoundHandler((req, reply) => {
      this.adapter.log.debug(`404: ${req.method} ${req.url}`);
      reply.status(404).send({ error: "Not Found", path: req.url });
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLIENT_COOKIE,
  WebServer
});
//# sourceMappingURL=webserver.js.map
