"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var import_node_crypto = __toESM(require("node:crypto"));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_client_registry = require("./lib/client-registry");
var import_coerce = require("./lib/coerce");
var import_global_config = require("./lib/global-config");
var import_mdns = require("./lib/mdns");
var import_url_discovery = require("./lib/url-discovery");
var import_webserver = require("./lib/webserver");
const STALE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
class HassEmu extends utils.Adapter {
  mdnsService = null;
  webServer = null;
  registry = null;
  globalConfig = null;
  urlDiscovery = null;
  unhandledRejectionHandler = null;
  uncaughtExceptionHandler = null;
  constructor(options = {}) {
    super({ ...options, name: "hassemu" });
    this.on("ready", () => {
      this.onReady().catch((err) => this.log.error(`onReady unhandled: ${String(err)}`));
    });
    this.on("stateChange", (id, state) => {
      this.onStateChange(id, state).catch((err) => this.log.error(`stateChange unhandled: ${String(err)}`));
    });
    this.on("objectChange", () => {
      var _a;
      (_a = this.urlDiscovery) == null ? void 0 : _a.scheduleRefresh();
    });
    this.on("unload", this.onUnload.bind(this));
    this.unhandledRejectionHandler = (reason) => {
      this.log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    };
    this.uncaughtExceptionHandler = (err) => {
      this.log.error(`Uncaught exception: ${err.message}`);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }
  async onReady() {
    await this.setState("info.connection", { val: false, ack: true });
    this.globalConfig = new import_global_config.GlobalConfig(this);
    await this.globalConfig.restore();
    this.registry = new import_client_registry.ClientRegistry(this);
    await this.registry.restore();
    await this.migrateLegacyDefaultVisUrl();
    await this.migrateVisUrlToMode();
    await this.repairGlobalSchemas();
    await this.gcStaleClients();
    const instanceUuid = import_node_crypto.default.randomUUID();
    this.log.debug(
      `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`
    );
    this.urlDiscovery = new import_url_discovery.UrlDiscovery(this, async (states) => {
      var _a, _b;
      await ((_a = this.globalConfig) == null ? void 0 : _a.syncUrlDropdown(states));
      await ((_b = this.registry) == null ? void 0 : _b.syncUrlDropdown(states));
    });
    await this.urlDiscovery.collect();
    this.registry.setNewClientModeProvider(() => this.computeNewClientMode());
    await this.subscribeForeignObjectsAsync("system.adapter.*");
    await this.subscribeStatesAsync("clients.*");
    await this.subscribeStatesAsync("global.*");
    const systemLanguage = await this.readSystemLanguage();
    try {
      this.webServer = new import_webserver.WebServer(
        this,
        this.config,
        this.registry,
        this.globalConfig,
        instanceUuid,
        systemLanguage
      );
      await this.webServer.start();
    } catch (err) {
      this.log.error(`Web server failed to start: ${String(err)}`);
      return;
    }
    if (this.config.mdnsEnabled) {
      this.mdnsService = new import_mdns.MDNSService(this, this.config, instanceUuid);
      this.mdnsService.start();
    } else {
      this.log.debug("mDNS disabled \u2014 clients must enter the URL manually.");
    }
    await this.setState("info.connection", { val: true, ack: true });
    const bindAddr = this.config.bindAddress || "0.0.0.0";
    this.log.info(
      `HA emulation running on ${bindAddr}:${this.config.port}${this.config.mdnsEnabled ? ", mDNS active" : ""}`
    );
  }
  /**
   * Default mode for newly registered clients. Respects the master switch:
   * - `global.enabled=true`  → `'global'` (follow master)
   * - `global.enabled=false` → first discovered URL, fallback `'manual'`
   */
  computeNewClientMode() {
    var _a, _b;
    if ((_a = this.globalConfig) == null ? void 0 : _a.isEnabled()) {
      return import_global_config.MODE_GLOBAL;
    }
    const first = (_b = this.urlDiscovery) == null ? void 0 : _b.getFirstDiscoveredUrl();
    return first != null ? first : import_global_config.MODE_MANUAL;
  }
  /**
   * Read the ioBroker system language (set in Admin → Main Settings).
   * Used for the landing page so the end-user sees the same language as
   * their admin UI. Falls back to `en` when `system.config` can't be read
   * or holds a language we don't translate. Read once on startup — a
   * language switch at runtime only takes effect after an adapter restart,
   * which is fine for a setup-hint page that most users see once.
   */
  async readSystemLanguage() {
    var _a;
    try {
      const cfg = await this.getForeignObjectAsync("system.config");
      const lang = (_a = cfg == null ? void 0 : cfg.common) == null ? void 0 : _a.language;
      return typeof lang === "string" && lang.length > 0 ? lang : "en";
    } catch {
      return "en";
    }
  }
  /**
   * 1.0.x / 1.1.0 → 1.1.1 migration — move the legacy `defaultVisUrl` from
   * instance native into `global.visUrl` + `global.enabled=true` and drop it
   * from native. Subsequent migrations (`migrateVisUrlToMode`) then move
   * `global.visUrl` into the mode/manualUrl model.
   */
  async migrateLegacyDefaultVisUrl() {
    const legacy = this.config;
    const url = legacy.defaultVisUrl || legacy.visUrl;
    if (!url) {
      return;
    }
    this.log.info("Migrating legacy native.defaultVisUrl/visUrl \u2192 global.visUrl");
    await this.setStateAsync("global.visUrl", { val: url, ack: true }).catch(() => {
    });
    try {
      const id = `system.adapter.${this.namespace}`;
      const obj = await this.getForeignObjectAsync(id);
      if (obj == null ? void 0 : obj.native) {
        delete obj.native.defaultVisUrl;
        delete obj.native.visUrl;
        await this.setForeignObjectAsync(id, obj);
      }
    } catch (err) {
      this.log.warn(`Legacy config cleanup failed: ${String(err)}`);
    }
  }
  /**
   * 1.x → 1.2.0 migration — move legacy per-client `visUrl`-states to the
   * `mode`/`manualUrl` model, plus the global `visUrl` to `global.mode` +
   * `global.manualUrl`. Old datapoints are removed, type of mode-states
   * upgraded to 'mixed'. Idempotent — does nothing on subsequent starts.
   */
  async migrateVisUrlToMode() {
    var _a, _b;
    try {
      const legacyGlobal = await this.getStateAsync("global.visUrl");
      if (legacyGlobal && legacyGlobal.val !== void 0 && legacyGlobal.val !== null && legacyGlobal.val !== "") {
        const safe = (0, import_coerce.coerceSafeUrl)(legacyGlobal.val);
        if (safe) {
          await this.globalConfig.migrationSet(import_global_config.MODE_MANUAL, safe);
          this.log.info(`Migration: global.visUrl \u2192 mode='manual', manualUrl='${safe}'`);
        } else {
          await this.globalConfig.migrationSet(import_global_config.MODE_MANUAL, null);
          this.log.warn(`Migration: legacy global.visUrl rejected as unsafe \u2014 set global.manualUrl manually`);
        }
      }
    } catch {
    }
    try {
      await this.delObjectAsync("global.visUrl");
    } catch {
    }
    const records = (_b = (_a = this.registry) == null ? void 0 : _a.listAll()) != null ? _b : [];
    for (const record of records) {
      try {
        const legacy = await this.getStateAsync(`clients.${record.id}.visUrl`);
        if (legacy && legacy.val !== void 0 && legacy.val !== null && legacy.val !== "") {
          const safe = (0, import_coerce.coerceSafeUrl)(legacy.val);
          if (safe) {
            record.mode = import_global_config.MODE_MANUAL;
            record.manualUrl = safe;
            await this.setStateAsync(`clients.${record.id}.mode`, { val: import_global_config.MODE_MANUAL, ack: true });
            await this.setStateAsync(`clients.${record.id}.manualUrl`, { val: safe, ack: true });
            this.log.info(
              `Migration: client ${record.id} visUrl='${safe}' \u2192 mode='manual', manualUrl='${safe}'`
            );
          } else {
            this.log.warn(
              `Migration: client ${record.id} legacy visUrl rejected as unsafe \u2014 set clients.${record.id}.manualUrl manually`
            );
          }
        }
      } catch {
      }
      try {
        await this.delObjectAsync(`clients.${record.id}.visUrl`);
      } catch {
      }
    }
  }
  /**
   * Repairs partial-formed `global.mode` / `global.manualUrl` objects from
   * the v1.2.0 migration bug (extendObjectAsync was called with only
   * `common.type:'mixed'` — leaving the object without top-level `type`,
   * name, role, read, write, def). `extendObjectAsync` here merges the full
   * instanceObjects schema onto the existing partial object so js-controller
   * stops warning "obj.type has to exist" and the dropdown renders correctly.
   *
   * Idempotent — extending an already-complete object is a no-op write.
   */
  async repairGlobalSchemas() {
    try {
      await this.extendObjectAsync("global.mode", {
        type: "state",
        common: {
          name: "Global redirect mode",
          type: "mixed",
          role: "value",
          read: true,
          write: true,
          def: 0
        },
        native: {}
      });
    } catch (err) {
      this.log.debug(`repair global.mode failed: ${String(err)}`);
    }
    try {
      await this.extendObjectAsync("global.manualUrl", {
        type: "state",
        common: {
          name: "Global manual URL (used when mode='manual')",
          type: "string",
          role: "url",
          read: true,
          write: true,
          def: ""
        },
        native: {}
      });
    } catch (err) {
      this.log.debug(`repair global.manualUrl failed: ${String(err)}`);
    }
  }
  /**
   * Removes clients that are clearly stale: no auth token (= never authenticated
   * or revoked) AND `native.lastSeen` older than {@link STALE_CLIENT_TTL_MS}.
   * Clients without `lastSeen` (pre-1.2.0) get the timestamp seeded on this run
   * — GC kicks in only on subsequent restarts.
   */
  async gcStaleClients() {
    var _a, _b, _c;
    const now = Date.now();
    const records = (_b = (_a = this.registry) == null ? void 0 : _a.listAll()) != null ? _b : [];
    let removed = 0;
    for (const record of records) {
      if (record.token) {
        continue;
      }
      try {
        const obj = await this.getObjectAsync(`clients.${record.id}`);
        const native = (_c = obj == null ? void 0 : obj.native) != null ? _c : {};
        const lastSeen = typeof native.lastSeen === "number" ? native.lastSeen : 0;
        if (lastSeen === 0) {
          await this.extendObjectAsync(`clients.${record.id}`, { native: { lastSeen: now } });
          continue;
        }
        if (now - lastSeen > STALE_CLIENT_TTL_MS) {
          await this.registry.remove(record.id);
          removed++;
        }
      } catch (err) {
        this.log.debug(`Stale-GC: failed for ${record.id}: ${String(err)}`);
      }
    }
    if (removed > 0) {
      this.log.info(`Stale-Client-GC: removed ${removed} client(s) (no token + idle >30 days)`);
    }
  }
  /**
   * Master-switch action: when `global.enabled` flips, propagate to every
   * client's `mode`. true → all clients follow `'global'`. false → fall back
   * to the first discovered URL, or `'manual'` if discovery is empty.
   *
   * @param enabled New value of `global.enabled`.
   */
  async applyMasterSwitch(enabled) {
    var _a;
    if (!this.registry) {
      return;
    }
    if (enabled) {
      await this.registry.bulkSetMode(import_global_config.MODE_GLOBAL);
      return;
    }
    const first = (_a = this.urlDiscovery) == null ? void 0 : _a.getFirstDiscoveredUrl();
    if (first) {
      await this.registry.bulkSetMode(first);
    } else {
      await this.registry.bulkSetMode(import_global_config.MODE_MANUAL);
      this.log.warn(
        "global.enabled=false but no discovered VIS URL \u2014 clients set to 'manual'; fill clients.<id>.manualUrl per client"
      );
    }
  }
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const clientParsed = this.registry ? (0, import_client_registry.parseClientStateId)(id, this.namespace) : null;
    if (clientParsed) {
      if (clientParsed.kind === "mode") {
        await this.registry.handleModeWrite(clientParsed.id, state.val);
        const record = this.registry.getById(clientParsed.id);
        if ((record == null ? void 0 : record.mode) === import_global_config.MODE_GLOBAL && this.globalConfig.resolveUrlFor(record) === null) {
          this.log.warn(
            `Client ${record.id}: mode='global' but global has no resolvable URL \u2014 fill global.mode/manualUrl, or pick a different client mode`
          );
        }
      } else if (clientParsed.kind === "manualUrl") {
        await this.registry.handleManualUrlWrite(clientParsed.id, state.val);
      } else if (clientParsed.kind === "remove" && state.val === true) {
        await this.registry.remove(clientParsed.id);
      }
      return;
    }
    const globalParsed = this.globalConfig ? (0, import_global_config.parseGlobalStateId)(id, this.namespace) : null;
    if (globalParsed === "mode") {
      await this.globalConfig.handleModeWrite(state.val);
    } else if (globalParsed === "manualUrl") {
      await this.globalConfig.handleManualUrlWrite(state.val);
    } else if (globalParsed === "enabled") {
      await this.globalConfig.handleEnabledWrite(state.val);
      await this.applyMasterSwitch(this.globalConfig.isEnabled());
    }
  }
  onUnload(callback) {
    var _a;
    try {
      (_a = this.urlDiscovery) == null ? void 0 : _a.cancelRefresh();
      this.urlDiscovery = null;
      if (this.mdnsService) {
        this.mdnsService.stop();
        this.mdnsService = null;
      }
      if (this.webServer) {
        this.webServer.stop().catch((err) => this.log.error(`Server stop error: ${err.message}`));
        this.webServer = null;
      }
      this.registry = null;
      this.globalConfig = null;
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
      void this.setState("info.connection", { val: false, ack: true });
    } catch (error) {
      const err = error;
      this.log.error(`Shutdown error: ${err.message}`);
    } finally {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new HassEmu(options);
} else {
  (() => new HassEmu())();
}
//# sourceMappingURL=main.js.map
