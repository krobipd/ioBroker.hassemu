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
var import_fastify = __toESM(require("fastify"));
var import_constants = require("./constants");
var import_coerce = require("./coerce");
var import_setup_page = require("./setup-page");
const CLIENT_COOKIE = "hassemu_client";
const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60;
class WebServer {
  adapter;
  config;
  registry;
  globalConfig;
  app;
  sessions = /* @__PURE__ */ new Map();
  cleanupTimer = null;
  instanceUuid;
  /** ioBroker system language for the setup page — resolved on startup. */
  systemLanguage;
  /** Set of IPs whose reverse DNS lookup is already in-flight — prevents duplicate work. */
  dnsInFlight = /* @__PURE__ */ new Set();
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
    this.app = (0, import_fastify.default)({ logger: false, trustProxy: false });
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
    await this.app.register(import_cookie.default);
    this.setupErrorHandler();
    this.setupRoutes();
    const bindAddress = this.config.bindAddress || "0.0.0.0";
    try {
      await this.app.listen({ port: this.config.port, host: bindAddress });
    } catch (err) {
      const e = err;
      const msg = e.code === "EADDRINUSE" ? `Port ${this.config.port} is already in use!` : `Server error: ${e.message}`;
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
      this.adapter.log.error(`Web server stop error: ${String(err)}`);
    }
  }
  /** Exposed for testing — fires injected requests without a real socket. */
  get inject() {
    return this.app.inject.bind(this.app);
  }
  /** Periodic cleanup of expired in-flight auth sessions. */
  cleanupSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.created > import_constants.SESSION_TTL_MS) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.adapter.log.debug(`Session cleanup: removed ${cleaned} expired sessions`);
    }
  }
  // --- client identification ---
  async identify(req, reply) {
    var _a;
    const cookie = (0, import_coerce.coerceUuid)((_a = req.cookies) == null ? void 0 : _a[CLIENT_COOKIE]);
    const ip = (0, import_coerce.coerceString)(req.ip);
    const record = await this.registry.identifyOrCreate(cookie, ip, null);
    if (cookie !== record.cookie) {
      reply.setCookie(CLIENT_COOKIE, record.cookie, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: COOKIE_MAX_AGE_S
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
    import_promises.default.reverse(ip).then((names) => {
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
      this.adapter.log.warn(`Request error: ${error.message}`);
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
      components: ["http", "api", "frontend", "homeassistant"],
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
    this.app.get("/api/discovery_info", (req) => {
      const host = req.hostname || this.config.bindAddress || "0.0.0.0";
      const baseUrl = `http://${host}:${this.config.port}`;
      return {
        base_url: baseUrl,
        external_url: null,
        internal_url: baseUrl,
        location_name: this.serviceName,
        requires_api_password: true,
        uuid: this.instanceUuid,
        version: import_constants.HA_VERSION
      };
    });
    for (const path of ["/api/states", "/api/services", "/api/events"]) {
      this.app.get(path, () => []);
    }
    this.app.get("/api/error_log", () => "");
  }
  setupAuthRoutes() {
    this.app.get("/auth/providers", () => [{ name: "Home Assistant Local", type: "homeassistant", id: null }]);
    this.app.post("/auth/login_flow", async (req, reply) => {
      const client = await this.identify(req, reply);
      const flowId = import_node_crypto.default.randomUUID();
      this.sessions.set(flowId, { created: Date.now(), clientId: client.id });
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
          this.adapter.log.warn(`Unknown flow_id: ${flowId}`);
          reply.status(400);
          return { type: "abort", flow_id: flowId, reason: "unknown_flow" };
        }
        if (this.config.authRequired) {
          const { username, password } = (_a = req.body) != null ? _a : {};
          if (username !== this.config.username || password !== this.config.password) {
            this.adapter.log.warn("Invalid credentials");
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
        this.sessions.set(code, { created: Date.now(), clientId: session.clientId });
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
        const { code, grant_type } = (_a = req.body) != null ? _a : {};
        if (grant_type === "authorization_code" && code && this.sessions.has(code)) {
          const session = this.sessions.get(code);
          this.sessions.delete(code);
          const token = import_node_crypto.default.randomUUID();
          if (session.clientId) {
            await this.registry.setToken(session.clientId, token);
            this.adapter.log.debug(`Display authenticated \u2014 client ${session.clientId}`);
          }
          return {
            access_token: token,
            token_type: "Bearer",
            refresh_token: import_node_crypto.default.randomUUID(),
            expires_in: 1800
          };
        }
        if (grant_type === "refresh_token") {
          return {
            access_token: import_node_crypto.default.randomUUID(),
            token_type: "Bearer",
            expires_in: 1800
          };
        }
        this.adapter.log.warn(`Token exchange failed: grant_type=${String(grant_type)}`);
        reply.status(400);
        return { error: "invalid_request", error_description: "Invalid or expired code" };
      }
    );
  }
  setupMiscRoutes() {
    this.app.get("/health", () => ({
      status: "ok",
      adapter: "hassemu",
      version: import_constants.HA_VERSION,
      config: {
        mdns: this.config.mdnsEnabled,
        auth: this.config.authRequired,
        globalRedirect: this.globalConfig.isEnabled() ? this.globalConfig.getGlobalUrl() : null
      }
    }));
    this.app.get("/manifest.json", () => ({
      name: this.serviceName,
      short_name: this.serviceName,
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#03a9f4"
    }));
    this.app.get("/", async (req, reply) => {
      const client = await this.identify(req, reply);
      const url = this.globalConfig.resolveUrlFor(client);
      if (!url) {
        this.adapter.log.debug(`No redirect URL for client ${client.id} \u2014 serving setup page`);
        return reply.status(200).type("text/html; charset=utf-8").send((0, import_setup_page.renderSetupPage)(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
      }
      this.adapter.log.debug(`Redirecting client ${client.id} \u2192 ${url}`);
      return reply.redirect(url, 302);
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
