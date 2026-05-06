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
var import_constants = require("./lib/constants");
var import_global_config = require("./lib/global-config");
var import_mdns = require("./lib/mdns");
var import_url_discovery = require("./lib/url-discovery");
var import_webserver = require("./lib/webserver");
var import_io_package = __toESM(require("../io-package.json"));
var _a;
const instanceObjectsList = (_a = import_io_package.default.instanceObjects) != null ? _a : [];
let processHandlersInstalled = false;
let installedUnhandledHandler = null;
let installedUncaughtHandler = null;
class HassEmu extends utils.Adapter {
  mdnsService = null;
  webServer = null;
  registry = null;
  globalConfig = null;
  urlDiscovery = null;
  constructor(options = {}) {
    super({ ...options, name: "hassemu" });
    this.on("ready", () => {
      this.onReady().catch((err) => this.log.error(`onReady unhandled: ${String(err)}`));
    });
    this.on("stateChange", (id, state) => {
      this.onStateChange(id, state).catch((err) => this.log.error(`stateChange unhandled: ${String(err)}`));
    });
    this.on("objectChange", (id, obj) => {
      var _a2, _b;
      if (!(id == null ? void 0 : id.startsWith("system.adapter."))) {
        return;
      }
      const isUrlSourceAdapter = id.startsWith("system.adapter.admin.") || id.startsWith("system.adapter.web.") || id.startsWith("system.adapter.vis.") || id.startsWith("system.adapter.vis-2.");
      const isAddOrRemove = !obj || obj.type === "instance" && !((_a2 = obj.common) == null ? void 0 : _a2.host);
      if (isUrlSourceAdapter || isAddOrRemove) {
        (_b = this.urlDiscovery) == null ? void 0 : _b.scheduleRefresh();
      }
    });
    this.on("unload", this.onUnload.bind(this));
    if (!processHandlersInstalled) {
      installedUnhandledHandler = (reason) => {
        console.error(
          `[hassemu] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`
        );
      };
      installedUncaughtHandler = (err) => {
        console.error(`[hassemu] Uncaught exception: ${err.message}`);
      };
      process.on("unhandledRejection", installedUnhandledHandler);
      process.on("uncaughtException", installedUncaughtHandler);
      processHandlersInstalled = true;
    }
  }
  async onReady() {
    var _a2, _b, _c;
    if (this.webServer) {
      await this.webServer.stop().catch(() => {
      });
      this.webServer = null;
    }
    if (this.mdnsService) {
      this.mdnsService.stop();
      this.mdnsService = null;
    }
    (_a2 = this.urlDiscovery) == null ? void 0 : _a2.cancelRefresh();
    this.urlDiscovery = null;
    await this.setState("info.connection", { val: false, ack: true });
    this.globalConfig = new import_global_config.GlobalConfig(this);
    await this.globalConfig.restore();
    this.registry = new import_client_registry.ClientRegistry(this);
    await this.registry.restore();
    await this.migrateLegacyDefaultVisUrl();
    await this.migrateVisUrlToMode();
    await this.repairGlobalSchemas();
    await this.gcStaleClients();
    const instanceUuid = await this.getOrCreateServerUuid();
    this.log.debug(
      `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`
    );
    this.urlDiscovery = new import_url_discovery.UrlDiscovery(this, async (states) => {
      var _a3, _b2;
      await ((_a3 = this.globalConfig) == null ? void 0 : _a3.syncUrlDropdown(states));
      await ((_b2 = this.registry) == null ? void 0 : _b2.syncUrlDropdown(states));
    });
    this.registry.setNewClientModeProvider(() => this.computeNewClientMode());
    await this.urlDiscovery.collect();
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
      (_c = (_b = this.terminate) == null ? void 0 : _b.call(this, 11)) != null ? _c : process.exit(11);
      return;
    }
    await this.subscribeForeignObjectsAsync("system.adapter.*");
    await this.subscribeStatesAsync("clients.*");
    await this.subscribeStatesAsync("global.*");
    await this.subscribeStatesAsync("info.refresh_urls");
    let mdnsActive = false;
    if (this.config.mdnsEnabled) {
      this.mdnsService = new import_mdns.MDNSService(this, this.config, instanceUuid);
      this.mdnsService.start();
      mdnsActive = this.mdnsService.isActive();
      if (!mdnsActive) {
        this.log.warn(
          "mDNS broadcast failed \u2014 clients must enter the URL manually. Auth/connection still works."
        );
      }
    } else {
      this.log.debug("mDNS disabled \u2014 clients must enter the URL manually.");
    }
    await this.setState("info.connection", { val: true, ack: true });
    const bindAddr = this.config.bindAddress || "0.0.0.0";
    const mdnsSuffix = this.config.mdnsEnabled ? mdnsActive ? ", mDNS active" : ", mDNS FAILED" : "";
    this.log.info(`HA emulation running on ${bindAddr}:${this.config.port}${mdnsSuffix}`);
  }
  /**
   * Liefert die persistente Server-UUID. Beim ersten Start wird sie generiert und in
   * `info.serverUuid` geschrieben; bei späteren Starts kommt der gleiche Wert raus.
   *
   * Warum nicht `extendForeignObjectAsync(system.adapter.X, native: { serverUuid })`?
   * Schreibt man auf den eigenen `system.adapter.X`-Objekt, triggert js-controller
   * einen Adapter-Restart — bei jedem Start ein Restart-Loop. govee-smart hatte das
   * in v2.1.3 (`extendForeignObjectAsync` für `mqttCredentials`-native) und musste
   * auf state-based persistence migrieren.
   */
  async getOrCreateServerUuid() {
    try {
      const existing = await this.getStateAsync("info.serverUuid");
      const val = existing == null ? void 0 : existing.val;
      if (typeof val === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
        return val;
      }
    } catch {
    }
    const fresh = import_node_crypto.default.randomUUID();
    await this.setStateAsync("info.serverUuid", { val: fresh, ack: true }).catch((err) => {
      this.log.warn(`Could not persist info.serverUuid: ${String(err)}`);
    });
    this.log.info(`Generated and persisted server UUID: ${fresh}`);
    return fresh;
  }
  /**
   * Default mode for newly registered clients. Respects the master switch:
   * - `global.enabled=true`  → `'global'` (follow master)
   * - `global.enabled=false` → first discovered URL, fallback `'manual'`
   */
  computeNewClientMode() {
    var _a2, _b;
    if ((_a2 = this.globalConfig) == null ? void 0 : _a2.isEnabled()) {
      return import_constants.MODE_GLOBAL;
    }
    const first = (_b = this.urlDiscovery) == null ? void 0 : _b.getFirstDiscoveredUrl();
    return first != null ? first : import_constants.MODE_MANUAL;
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
    var _a2;
    try {
      const cfg = await this.getForeignObjectAsync("system.config");
      const lang = (_a2 = cfg == null ? void 0 : cfg.common) == null ? void 0 : _a2.language;
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
    const safe = (0, import_coerce.coerceSafeUrl)(url);
    if (!safe) {
      this.log.warn(
        `Legacy URL rejected as unsafe \u2014 dropping native.defaultVisUrl/visUrl without migration: ${String(url)}`
      );
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
      return;
    }
    this.log.info("Migrating legacy native.defaultVisUrl/visUrl \u2192 global.visUrl");
    let stateWritten = false;
    try {
      await this.setStateAsync("global.visUrl", { val: safe, ack: true });
      stateWritten = true;
    } catch {
      try {
        if (this.globalConfig) {
          await this.globalConfig.migrationSet(import_constants.MODE_MANUAL, safe);
          this.log.info(
            `Migration shortcut: global.visUrl-state missing \u2192 wrote directly to global.mode='manual', manualUrl='${safe}'`
          );
          stateWritten = true;
        }
      } catch (err) {
        this.log.warn(`Legacy URL migration failed at fallback: ${String(err)}`);
      }
    }
    if (!stateWritten) {
      this.log.warn("Legacy URL preserved in native \u2014 neither global.visUrl nor global.mode write succeeded");
      return;
    }
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
    var _a2, _b;
    try {
      const legacyGlobal = await this.getStateAsync("global.visUrl");
      const decision = (0, import_coerce.decideLegacyVisMigration)(legacyGlobal == null ? void 0 : legacyGlobal.val);
      if (decision.kind === "safe-url") {
        await this.globalConfig.migrationSet(import_constants.MODE_MANUAL, decision.safe);
        this.log.info(`Migration: global.visUrl \u2192 mode='manual', manualUrl='${decision.safe}'`);
      } else if (decision.kind === "unsafe-rejected") {
        await this.globalConfig.migrationSet(import_constants.MODE_MANUAL, null);
        this.log.warn(`Migration: legacy global.visUrl rejected as unsafe \u2014 set global.manualUrl manually`);
      }
    } catch {
    }
    try {
      await this.delObjectAsync("global.visUrl");
    } catch {
    }
    const records = (_b = (_a2 = this.registry) == null ? void 0 : _a2.listAll()) != null ? _b : [];
    for (const record of records) {
      try {
        const legacy = await this.getStateAsync(`clients.${record.id}.visUrl`);
        const decision = (0, import_coerce.decideLegacyVisMigration)(legacy == null ? void 0 : legacy.val);
        if (decision.kind === "safe-url") {
          record.mode = import_constants.MODE_MANUAL;
          record.manualUrl = decision.safe;
          await this.setStateAsync(`clients.${record.id}.mode`, { val: import_constants.MODE_MANUAL, ack: true });
          await this.setStateAsync(`clients.${record.id}.manualUrl`, { val: decision.safe, ack: true });
          this.log.info(
            `Migration: client ${record.id} visUrl='${decision.safe}' \u2192 mode='manual', manualUrl='${decision.safe}'`
          );
        } else if (decision.kind === "unsafe-rejected") {
          this.log.warn(
            `Migration: client ${record.id} legacy visUrl rejected as unsafe \u2014 set clients.${record.id}.manualUrl manually`
          );
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
    const repair = async (id, expectedCommonType) => {
      var _a2, _b;
      try {
        const obj = await this.getObjectAsync(id);
        if (obj && obj.type === "state" && ((_a2 = obj.common) == null ? void 0 : _a2.type) === expectedCommonType) {
          return;
        }
      } catch {
      }
      const fullId = `${this.namespace}.${id}`;
      const schema = instanceObjectsList.find((o) => o._id === id || o._id === fullId);
      if (!schema) {
        this.log.debug(`repair ${id}: no instanceObjects-schema found, skipping`);
        return;
      }
      try {
        await this.extendObjectAsync(id, {
          type: schema.type,
          common: schema.common,
          native: (_b = schema.native) != null ? _b : {}
        });
      } catch (err) {
        this.log.debug(`repair ${id} failed: ${String(err)}`);
      }
    };
    await repair("global.mode", "mixed");
    await repair("global.manualUrl", "string");
  }
  /**
   * Removes clients that are clearly stale: `native.lastSeen` older than
   * {@link STALE_CLIENT_TTL_MS}.
   *
   * Clients without `lastSeen` (pre-1.2.0) get the timestamp seeded on this run
   * — GC kicks in only on subsequent restarts.
   *
   * v1.11.0 (C9): vorher übersprang GC alle token-haltenden Clients (`if record.token`).
   * Effekt: über Jahre wuchs die Liste mit „authenticated, but never seen again"-
   * Clients (Display weg/refurbished/Bridge-Reset etc.). Jetzt: lastSeen-basiert
   * unabhängig vom Token. Access-Token sind ohnehin nur 30min gültig — wenn
   * lastSeen 30 Tage zurückliegt, ist der Token längst abgelaufen.
   */
  async gcStaleClients() {
    var _a2, _b, _c;
    const now = Date.now();
    const records = (_b = (_a2 = this.registry) == null ? void 0 : _a2.listAll()) != null ? _b : [];
    let removed = 0;
    for (const record of records) {
      try {
        const obj = await this.getObjectAsync(`clients.${record.id}`);
        const native = (_c = obj == null ? void 0 : obj.native) != null ? _c : {};
        const action = (0, import_coerce.decideGcAction)(native.lastSeen, now, import_constants.STALE_CLIENT_TTL_MS);
        if (action === "seed") {
          await this.registry.seedLastSeen(record.id, now);
        } else if (action === "stale") {
          await this.registry.remove(record.id);
          removed++;
        }
      } catch (err) {
        this.log.debug(`Stale-GC: failed for ${record.id}: ${String(err)}`);
      }
    }
    if (removed > 0) {
      this.log.info(`Stale-Client-GC: removed ${removed} client(s) (idle >30 days)`);
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
    var _a2;
    if (!this.registry) {
      return;
    }
    if (enabled) {
      await this.registry.bulkSetMode(import_constants.MODE_GLOBAL);
      return;
    }
    const first = (_a2 = this.urlDiscovery) == null ? void 0 : _a2.getFirstDiscoveredUrl();
    if (first) {
      await this.registry.bulkSetMode(first);
    } else {
      await this.registry.bulkSetMode(import_constants.MODE_MANUAL);
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
        if ((record == null ? void 0 : record.mode) === import_constants.MODE_GLOBAL && this.globalConfig.resolveUrlFor(record) === null) {
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
      return;
    }
    if (id === `${this.namespace}.info.refresh_urls` && state.val === true) {
      await this.handleRefreshUrlsWrite();
    }
  }
  /**
   * Handler for the `info.refresh_urls` button.
   * Triggert eine sofortige `urlDiscovery.collect()` (statt Debounce-Schedule),
   * damit der User nicht 2s warten muss. Schreibt anschließend `false ack` damit
   * der Button in der Admin-UI wieder „klickbar" wird.
   */
  async handleRefreshUrlsWrite() {
    if (!this.urlDiscovery) {
      return;
    }
    try {
      await this.urlDiscovery.collect();
      this.log.info("URL discovery refreshed on user request");
    } catch (err) {
      this.log.warn(`URL refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.setStateAsync("info.refresh_urls", { val: false, ack: true }).catch(() => {
      });
    }
  }
  onUnload(callback) {
    var _a2;
    try {
      void this.setState("info.connection", { val: false, ack: true });
      void this.unsubscribeStatesAsync("clients.*");
      void this.unsubscribeStatesAsync("global.*");
      void this.unsubscribeStatesAsync("info.refresh_urls");
      void this.unsubscribeForeignObjectsAsync("system.adapter.*");
      (_a2 = this.urlDiscovery) == null ? void 0 : _a2.cancelRefresh();
      this.urlDiscovery = null;
      if (this.mdnsService) {
        this.mdnsService.stop();
        this.mdnsService = null;
      }
      if (this.webServer) {
        this.webServer.stop().catch(() => {
        });
        this.webServer = null;
      }
      this.registry = null;
      this.globalConfig = null;
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
