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
var import_fastify = __toESM(require("fastify"));
var import_constants = require("./constants");
var import_coerce = require("./coerce");
var import_auth_page = require("./auth-page");
var import_external_bridge = require("./external-bridge");
var import_landing_page = require("./landing-page");
var import_network = require("./network");
function renderRedirectWrapper(target) {
  const escAttr = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const escJs = JSON.stringify(target);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>ioBroker HASS Emulator</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
/* display:block kills the inline-baseline gap below the iframe; position:fixed +
   100vw/100vh nimmt das Display sicher voll aus, auch wenn ein WebView die
   100%-Berechnung subpixel-falsch macht (Shelly Wall Display zeigte sonst
   einen schwarzen Streifen rechts/unten). */
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;}
</style>
</head>
<body>
<iframe src="${escAttr}" allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
${import_external_bridge.CONNECTION_STATUS_SCRIPT}
<script>
(function(){
  var current=${escJs};
  setInterval(function(){
    fetch('/api/redirect_check',{cache:'no-store',credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&typeof j.target==='string'&&j.target&&j.target!==current){
          location.reload();
        }
      })
      .catch(function(){/* silent \u2014 broker hiccup, retry next tick */});
  },30000);
})();
</script>
</body>
</html>`;
}
const CLIENT_COOKIE = "hassemu_client";
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
   * map. FIFO-capped at {@link WEBHOOK_REGISTRATIONS_CAP}.
   *
   * Reused for Shelly Wall Display FW 2.6.0+ onboarding — the on-device HA
   * Companion App requires this endpoint to complete device registration
   * after the OAuth2 sign-in. Without it the App refuses to proceed with a
   * "Mobile-App-Integration nicht verfügbar" error.
   *
   * **Design — in-memory only, by intent.** The map is NOT persisted across
   * adapter restarts. Restart-recovery relies on the
   * `POST /api/webhook/<unknown-id>` branch returning HTTP 200 with an
   * empty body — the HA Companion App reads that as a stale webhook and
   * re-runs `update_registration`, which on hassemu issues a fresh
   * webhookId. (Source: home-assistant/android
   * IntegrationRepositoryImpl.kt:170 — `200 with empty body triggers
   * maybeReregisterDeviceOnFailedUpdate`.)
   *
   * If a future refactor changes the unknown-webhookId response from
   * `200 empty` to `404`, displays will silently break across adapter
   * restarts. Keep that response shape OR add real persistence here.
   */
  webhookRegistrations = /* @__PURE__ */ new Map();
  cleanupTimer = null;
  /**
   * v1.14.0 (H8): bind once im Constructor statt bei jedem Property-Access
   * via getter — vorher allokierte jeder `s.inject({...})`-Call eine neue
   * gebundene Funktion. Tests rufen das in Loops auf — unnötiger GC-Druck.
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
  /** Periodic cleanup of expired in-flight auth sessions and stale lockouts. */
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
  }
  /**
   * Drops the oldest entry of a Map if it would exceed `cap` after the next insert.
   * Map iteration order in JS is insertion order, so `keys().next()` is the oldest.
   *
   * @param map Map to evict from.
   * @param cap Hard cap; when `map.size >= cap`, the oldest entry is removed.
   */
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
      WebServer.evictOldest(this.errorLogCooldown, import_constants.REQUEST_ERROR_COOLDOWN_CAP);
    }
    this.errorLogCooldown.set(key, now);
    return true;
  }
  static evictOldest(map, cap) {
    while (map.size >= cap) {
      const oldest = map.keys().next().value;
      if (oldest === void 0) {
        return;
      }
      map.delete(oldest);
    }
  }
  /**
   * Inserts a session, dropping the oldest entry if {@link SESSIONS_CAP} is exceeded.
   *
   * @param key  Session key (flow id or auth code).
   * @param data Session payload.
   */
  storeSession(key, data) {
    WebServer.evictOldest(this.sessions, import_constants.SESSIONS_CAP);
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
    if (cookie !== record.cookie) {
      const useSecure = req.protocol === "https";
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
    const timeout = new Promise(
      (_, reject) => setTimeout(() => reject(new Error("dns reverse-lookup timeout")), 5e3)
    );
    Promise.race([import_promises.default.reverse(ip), timeout]).then((names) => {
      const name = names[0];
      if (name) {
        this.registry.identifyOrCreate(record.cookie, ip, name).catch(() => {
        });
      }
    }).catch(() => {
    }).finally(() => {
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
      if (path === "/" || path === "/api/" || path === "/api/discovery_info" || path === "/manifest.json" || path === "/health" || path.startsWith("/auth/") || // v1.29.1: Mobile-App webhooks carry the secret in the URL
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
    this.setupMiscRoutes();
    this.setupNotFound();
  }
  setupApiRoutes() {
    this.app.get("/api/", () => ({ message: "API running." }));
    this.app.get("/api/config", () => ({
      // `mobile_app` advertises the integration the HA Companion App
      // probes for during onboarding (v1.29.1, Shelly FW 2.6.0+).
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
    }));
    this.app.get("/api/discovery_info", () => {
      const isWildcard = !this.config.bindAddress || (0, import_network.isWildcardBind)(this.config.bindAddress);
      const host = isWildcard ? (0, import_network.getLocalIp)() : this.config.bindAddress;
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
      WebServer.evictOldest(this.webhookRegistrations, import_constants.WEBHOOK_REGISTRATIONS_CAP);
      this.webhookRegistrations.set(webhookId, ownerId);
      this.adapter.log.debug(
        `Mobile-App registration \u2014 client=${ownerId} app_id=${(_d = body.app_id) != null ? _d : "?"} device_name=${(_e = body.device_name) != null ? _e : "?"} \u2192 webhook=${webhookId}`
      );
      reply.status(201);
      return {
        webhook_id: webhookId,
        cloudhook_url: null,
        remote_ui_url: null,
        secret: null
      };
    });
    this.app.put(
      "/api/mobile_app/registrations/:webhookId",
      async (req, reply) => {
        const id = req.params.webhookId;
        if (!this.webhookRegistrations.has(id)) {
          reply.status(404);
          return { error: "unknown_registration" };
        }
        return { webhook_id: id, cloudhook_url: null, remote_ui_url: null, secret: null };
      }
    );
    this.app.delete(
      "/api/mobile_app/registrations/:webhookId",
      async (req, reply) => {
        this.webhookRegistrations.delete(req.params.webhookId);
        reply.status(204);
        return null;
      }
    );
    this.app.post("/api/webhook/:webhookId", async (req, reply) => {
      var _a;
      const id = req.params.webhookId;
      if (!this.webhookRegistrations.has(id)) {
        reply.status(200);
        return null;
      }
      const body = (_a = req.body) != null ? _a : {};
      const type = typeof body.type === "string" ? body.type : "";
      this.adapter.log.debug(`Webhook ${id.substring(0, 8)}\u2026 type=${type || "(no type)"}`);
      switch (type) {
        case "get_config":
          return {
            components: ["http", "api", "frontend", "homeassistant", "mobile_app"],
            latitude: 0,
            longitude: 0,
            elevation: 0,
            unit_system: { length: "km", mass: "g", temperature: "\xB0C", volume: "L" },
            location_name: this.serviceName,
            time_zone: "UTC",
            version: import_constants.HA_VERSION
          };
        case "get_zones":
          return [];
        case "render_template":
          return {};
        case "update_registration":
          return { webhook_id: id, cloudhook_url: null, remote_ui_url: null, secret: null };
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
  setupAuthRoutes() {
    this.app.get("/auth/providers", () => [{ name: "Home Assistant Local", type: "homeassistant", id: null }]);
    this.app.get("/auth/authorize", async (req, reply) => {
      var _a;
      const { response_type, client_id, redirect_uri, state } = (_a = req.query) != null ? _a : {};
      if (response_type !== "code") {
        reply.status(400).type("text/html");
        return (0, import_auth_page.renderAuthorizeError)(
          "unsupported_response_type",
          "This authorization server supports `response_type=code` only."
        );
      }
      if (typeof client_id !== "string" || typeof redirect_uri !== "string") {
        reply.status(400).type("text/html");
        return (0, import_auth_page.renderAuthorizeError)(
          "invalid_request",
          "Missing or invalid `client_id` or `redirect_uri` parameter."
        );
      }
      if (!(0, import_coerce.isValidRedirectUri)(client_id, redirect_uri)) {
        this.adapter.log.debug(
          `Authorize rejected: redirect_uri "${redirect_uri}" not allowed for client_id "${client_id}"`
        );
        reply.status(400).type("text/html");
        return (0, import_auth_page.renderAuthorizeError)(
          "invalid_redirect_uri",
          "The `redirect_uri` parameter is not on the allowlist for this client."
        );
      }
      const client = await this.identify(req, reply);
      if (!this.config.authRequired) {
        const code = this.issueAuthorizationCode(client.id);
        const target = (0, import_auth_page.buildRedirectUrl)(redirect_uri, code, state);
        this.adapter.log.debug(`Authorize auto-grant \u2014 client ${client.id}`);
        reply.type("text/html");
        return (0, import_auth_page.renderAuthorizeRedirect)(target);
      }
      reply.type("text/html");
      return (0, import_auth_page.renderAuthorizeForm)({ clientId: client_id, redirectUri: redirect_uri, state });
    });
    this.app.post("/auth/authorize", async (req, reply) => {
      var _a;
      const { response_type, client_id, redirect_uri, state, username, password } = (_a = req.body) != null ? _a : {};
      if (response_type !== "code") {
        reply.status(400).type("text/html");
        return (0, import_auth_page.renderAuthorizeError)("unsupported_response_type", "Only `response_type=code` is supported.");
      }
      if (typeof client_id !== "string" || typeof redirect_uri !== "string") {
        reply.status(400).type("text/html");
        return (0, import_auth_page.renderAuthorizeError)(
          "invalid_request",
          "Missing or invalid `client_id` or `redirect_uri` parameter."
        );
      }
      if (!(0, import_coerce.isValidRedirectUri)(client_id, redirect_uri)) {
        reply.status(400).type("text/html");
        return (0, import_auth_page.renderAuthorizeError)(
          "invalid_redirect_uri",
          "The `redirect_uri` parameter is not on the allowlist for this client."
        );
      }
      const client = await this.identify(req, reply);
      if (!this.config.authRequired) {
        const code2 = this.issueAuthorizationCode(client.id);
        const target2 = (0, import_auth_page.buildRedirectUrl)(redirect_uri, code2, state);
        reply.type("text/html");
        return (0, import_auth_page.renderAuthorizeRedirect)(target2);
      }
      const ip = WebServer.getClientIp(req);
      const userOk = typeof username === "string" && (0, import_coerce.safeStringEqual)(username, this.config.username);
      const passOk = typeof password === "string" && (0, import_coerce.safeStringEqual)(password, this.config.password);
      if (!userOk || !passOk) {
        const ipSuffix = ip ? ` (IP ${ip})` : "";
        this.adapter.log.warn(`Invalid credentials${ipSuffix}`);
        reply.status(401).type("text/html");
        return (0, import_auth_page.renderAuthorizeForm)(
          { clientId: client_id, redirectUri: redirect_uri, state },
          "Invalid username or password."
        );
      }
      const code = this.issueAuthorizationCode(client.id);
      const target = (0, import_auth_page.buildRedirectUrl)(redirect_uri, code, state);
      this.adapter.log.debug(`Authorize grant \u2014 client ${client.id}`);
      reply.type("text/html");
      return (0, import_auth_page.renderAuthorizeRedirect)(target);
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
    this.app.post(
      "/auth/token",
      async (req, reply) => {
        var _a;
        const { code, grant_type, refresh_token } = (_a = req.body) != null ? _a : {};
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
      }
    );
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
      const url = this.globalConfig.resolveUrlFor(client);
      if (!url) {
        this.adapter.log.debug(`No redirect URL for client ${client.id} \u2014 serving landing page`);
        return reply.status(200).type("text/html; charset=utf-8").send((0, import_landing_page.renderLandingPage)(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
      }
      this.adapter.log.debug(`Serving wrapper for client ${client.id} \u2192 ${url}`);
      return reply.status(200).type("text/html; charset=utf-8").send(renderRedirectWrapper(url));
    });
    this.app.get("/api/redirect_check", async (req, reply) => {
      const client = await this.identify(req, reply);
      const url = this.globalConfig.resolveUrlFor(client);
      return { target: url != null ? url : null };
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
