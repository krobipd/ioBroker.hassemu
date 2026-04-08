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
  WebServer: () => WebServer
});
module.exports = __toCommonJS(webserver_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_express = __toESM(require("express"));
var import_constants = require("./constants");
class WebServer {
  adapter;
  config;
  app;
  server = null;
  sessions = /* @__PURE__ */ new Map();
  cleanupTimer = null;
  instanceUuid;
  /**
   * Creates a new WebServer instance
   *
   * @param adapter - Adapter interface for logging and state management
   * @param config - Adapter configuration
   * @param instanceUuid - Shared UUID for consistent identity across WebServer and mDNS
   */
  constructor(adapter, config, instanceUuid) {
    this.adapter = adapter;
    this.config = config;
    this.app = (0, import_express.default)();
    this.instanceUuid = instanceUuid;
  }
  /** Configured service name */
  get serviceName() {
    return this.config.serviceName || "ioBroker";
  }
  /** Returns the actual address the server is bound to, or null if not running */
  get boundAddress() {
    if (!this.server) {
      return null;
    }
    const addr = this.server.address();
    if (typeof addr === "string" || !addr) {
      return null;
    }
    return { address: addr.address, port: addr.port };
  }
  // --- Helpers ---
  json(res, data, status = 200) {
    res.status(status).json(data);
  }
  /**
   * Create a session entry with automatic expiration
   *
   * @param key - Unique session identifier
   */
  createSession(key) {
    this.sessions.set(key, { created: Date.now() });
  }
  /** Periodic cleanup of expired sessions */
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
  // --- Middleware ---
  setupMiddleware() {
    this.app.use(import_express.default.json());
    this.app.use(import_express.default.urlencoded({ extended: true }));
    this.app.use((err, _req, res, next) => {
      if (err instanceof SyntaxError && "body" in err) {
        this.adapter.log.debug(`Malformed JSON in request: ${err.message}`);
        res.status(400).json({ error: "Invalid JSON in request body" });
        return;
      }
      next(err);
    });
    this.app.use((req, _res, next) => {
      this.adapter.log.debug(`${req.method} ${req.path}`);
      next();
    });
  }
  // --- Routes ---
  setupRoutes() {
    this.setupApiRoutes();
    this.setupAuthRoutes();
    this.setupMiscRoutes();
    this.setupCatchAll();
  }
  setupApiRoutes() {
    this.app.get("/api/", (_req, res) => {
      this.json(res, { message: "API running." });
    });
    this.app.get("/api/config", (_req, res) => {
      this.json(res, {
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
      });
    });
    this.app.get("/api/discovery_info", (req, res) => {
      const baseUrl = `http://${req.hostname}:${this.config.port}`;
      this.json(res, {
        base_url: baseUrl,
        external_url: null,
        internal_url: baseUrl,
        location_name: this.serviceName,
        requires_api_password: true,
        uuid: this.instanceUuid,
        version: import_constants.HA_VERSION
      });
    });
    for (const path of ["/api/states", "/api/services", "/api/events"]) {
      this.app.get(path, (_req, res) => this.json(res, []));
    }
    this.app.get("/api/error_log", (_req, res) => this.json(res, ""));
  }
  setupAuthRoutes() {
    this.app.get("/auth/providers", (_req, res) => {
      this.json(res, [
        {
          name: "Home Assistant Local",
          type: "homeassistant",
          id: null
        }
      ]);
    });
    this.app.post("/auth/login_flow", (_req, res) => {
      const flowId = import_node_crypto.default.randomUUID();
      this.createSession(flowId);
      this.adapter.log.debug(`Auth flow created: ${flowId}`);
      this.json(res, {
        type: "form",
        flow_id: flowId,
        handler: ["homeassistant", null],
        step_id: "init",
        data_schema: import_constants.LOGIN_SCHEMA,
        description_placeholders: null,
        errors: null
      });
    });
    this.app.post("/auth/login_flow/:flowId", (req, res) => {
      const flowId = req.params.flowId;
      if (!this.sessions.has(flowId)) {
        this.adapter.log.warn(`Unknown flow_id: ${flowId}`);
        this.json(
          res,
          {
            type: "abort",
            flow_id: flowId,
            reason: "unknown_flow"
          },
          400
        );
        return;
      }
      if (this.config.authRequired) {
        const { username, password } = req.body;
        if (username !== this.config.username || password !== this.config.password) {
          this.adapter.log.warn("Invalid credentials");
          this.json(
            res,
            {
              type: "form",
              flow_id: flowId,
              handler: ["homeassistant", null],
              step_id: "init",
              data_schema: import_constants.LOGIN_SCHEMA,
              errors: { base: "invalid_auth" },
              description_placeholders: null
            },
            400
          );
          return;
        }
      }
      this.sessions.delete(flowId);
      const code = import_node_crypto.default.randomUUID();
      this.createSession(code);
      this.adapter.log.debug("Auth flow completed \u2014 code issued");
      this.json(res, {
        version: 1,
        type: "create_entry",
        flow_id: flowId,
        handler: ["homeassistant", null],
        result: code,
        description: null,
        description_placeholders: null
      });
    });
    this.app.post("/auth/token", (req, res) => {
      const { code, grant_type } = req.body;
      if (grant_type === "authorization_code" && code && this.sessions.has(code)) {
        this.sessions.delete(code);
        this.adapter.log.debug("Display authenticated successfully");
        this.json(res, {
          access_token: import_node_crypto.default.randomUUID(),
          token_type: "Bearer",
          refresh_token: import_node_crypto.default.randomUUID(),
          expires_in: 1800
        });
        return;
      }
      if (grant_type === "refresh_token") {
        this.json(res, {
          access_token: import_node_crypto.default.randomUUID(),
          token_type: "Bearer",
          expires_in: 1800
        });
        return;
      }
      this.adapter.log.warn(`Token exchange failed: grant_type=${grant_type}`);
      this.json(
        res,
        {
          error: "invalid_request",
          error_description: "Invalid or expired code"
        },
        400
      );
    });
  }
  setupMiscRoutes() {
    this.app.get("/health", (_req, res) => {
      this.json(res, {
        status: "ok",
        adapter: "hassemu",
        version: import_constants.HA_VERSION,
        config: {
          mdns: this.config.mdnsEnabled,
          auth: this.config.authRequired,
          redirectTo: this.config.visUrl
        }
      });
    });
    this.app.get("/manifest.json", (_req, res) => {
      this.json(res, {
        name: this.serviceName,
        short_name: this.serviceName,
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#03a9f4"
      });
    });
    this.app.get("/", (_req, res) => {
      if (!this.config.visUrl) {
        this.adapter.log.error("No redirect URL configured!");
        this.json(
          res,
          {
            error: "No redirect URL configured",
            message: "Please configure a redirect URL in the adapter settings."
          },
          500
        );
        return;
      }
      this.adapter.log.debug(`Redirecting to: ${this.config.visUrl}`);
      res.redirect(this.config.visUrl);
    });
  }
  setupCatchAll() {
    this.app.use((req, res) => {
      this.adapter.log.debug(`404: ${req.method} ${req.path}`);
      this.json(res, { error: "Not Found", path: req.path }, 404);
    });
  }
  // --- Lifecycle ---
  /** Start the web server and session cleanup timer */
  async start() {
    return new Promise((resolve, reject) => {
      this.setupMiddleware();
      this.setupRoutes();
      const bindAddress = this.config.bindAddress || "0.0.0.0";
      this.server = this.app.listen(this.config.port, bindAddress, () => {
        this.adapter.log.debug(`Web server listening on ${bindAddress}:${this.config.port}`);
        resolve();
      });
      this.server.on("error", (error) => {
        const msg = error.code === "EADDRINUSE" ? `Port ${this.config.port} is already in use!` : `Server error: ${error.message}`;
        this.adapter.log.error(msg);
        reject(error);
      });
      this.cleanupTimer = this.adapter.setInterval(() => this.cleanupSessions(), import_constants.CLEANUP_INTERVAL_MS);
    });
  }
  /** Stop the web server and cleanup timer */
  async stop() {
    if (this.cleanupTimer) {
      this.adapter.clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.adapter.log.debug("Web server stopped");
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WebServer
});
//# sourceMappingURL=webserver.js.map
