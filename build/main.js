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
var main_exports = {};
__export(main_exports, {
  HassEmu: () => HassEmu
});
module.exports = __toCommonJS(main_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_path = require("node:path");
var import_adapter_core = require("@iobroker/adapter-core");
var utils = __toESM(require("@iobroker/adapter-core"));
var import_client_registry = require("./lib/client-registry");
var import_coerce = require("./lib/coerce");
var import_constants = require("./lib/constants");
var import_global_config = require("./lib/global-config");
var import_legacy_migration = require("./lib/legacy-migration");
var import_mdns = require("./lib/mdns");
var import_schema_repair = require("./lib/schema-repair");
var import_url_discovery = require("./lib/url-discovery");
var import_webserver = require("./lib/webserver");
var import_io_package = __toESM(require("../io-package.json"));
var _a;
const instanceObjectsList = (_a = import_io_package.default.instanceObjects) != null ? _a : [];
class HassEmu extends utils.Adapter {
  /**
   * ioBroker system language used to render the user-facing landing page (HTML)
   * in the user's language. Adapter logs themselves stay English by ioBroker
   * convention. Read in `onReady` from `system.config.language` (EN fallback) and
   * passed to WebServer as a constructor argument — not part of AdapterInterface.
   */
  systemLanguage = "en";
  mdnsService = null;
  webServer = null;
  registry = null;
  globalConfig = null;
  urlDiscovery = null;
  // Factory seams — production builds the real collaborators; the orchestration
  // unit tests (src/main.test.ts) override these fields with fakes so onReady &
  // friends can run without sockets, mDNS or a js-controller.
  makeGlobalConfig = () => new import_global_config.GlobalConfig(this);
  makeRegistry = () => new import_client_registry.ClientRegistry(this);
  makeUrlDiscovery = (onChange) => new import_url_discovery.UrlDiscovery(this, onChange);
  makeWebServer = (instanceUuid) => new import_webserver.WebServer(this, this.config, this.registry, this.globalConfig, instanceUuid, this.systemLanguage);
  makeMdnsService = (instanceUuid) => new import_mdns.MDNSService(this, this.config, instanceUuid);
  /** @param options Adapter options forwarded to the ioBroker base class. */
  constructor(options = {}) {
    super({ ...options, name: "hassemu" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a2, _b;
    try {
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
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      await this.setState("info.connection", { val: false, ack: true });
      this.systemLanguage = await this.readSystemLanguage();
      this.globalConfig = this.makeGlobalConfig();
      await this.globalConfig.restore();
      this.registry = this.makeRegistry();
      await this.registry.restore();
      await (0, import_legacy_migration.migrateLegacyDefaultVisUrl)(this, this.config, this.globalConfig);
      await (0, import_legacy_migration.migrateVisUrlToMode)(this, this.globalConfig, this.registry);
      await (0, import_schema_repair.repairGlobalSchemas)(this, instanceObjectsList);
      if (await this.getObjectAsync("info.refresh_urls")) {
        await this.delObjectAsync("info.refresh_urls").catch(() => {
        });
      }
      await this.gcStaleClients();
      const instanceUuid = await this.getOrCreateServerUuid();
      this.log.debug(
        `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`
      );
      this.urlDiscovery = this.makeUrlDiscovery(async (states) => {
        var _a3, _b2;
        await ((_a3 = this.globalConfig) == null ? void 0 : _a3.syncUrlDropdown(states));
        await ((_b2 = this.registry) == null ? void 0 : _b2.syncUrlDropdown(states));
      });
      this.registry.setNewClientModeProvider(() => this.computeNewClientMode());
      await this.urlDiscovery.collect();
      try {
        this.webServer = this.makeWebServer(instanceUuid);
        await this.webServer.start();
      } catch (err) {
        this.log.debug(`Web server failed to start: ${String(err)}`);
        this.terminate(11);
        return;
      }
      await this.subscribeForeignObjectsAsync("system.adapter.*");
      await this.subscribeStatesAsync("clients.*");
      await this.subscribeStatesAsync("global.*");
      await this.subscribeStatesAsync("info.refreshUrls");
      let mdnsActive = false;
      if (this.config.mdnsEnabled) {
        this.mdnsService = this.makeMdnsService(instanceUuid);
        this.mdnsService.start();
        mdnsActive = this.mdnsService.isActive();
        if (!mdnsActive) {
          this.log.warn("mDNS failed to start \u2014 see preceding mDNS warning");
        }
      } else {
        this.log.debug("mDNS disabled \u2014 clients must enter the URL manually.");
      }
      await this.setState("info.connection", { val: true, ack: true });
      const bindAddr = this.config.bindAddress || "0.0.0.0";
      const mdnsSuffix = this.config.mdnsEnabled ? mdnsActive ? ", mDNS started" : ", mDNS FAILED" : "";
      this.log.info(`HA emulation running on ${bindAddr}:${this.config.port}${mdnsSuffix}`);
    } catch (err) {
      this.log.error(`onReady failed: ${String(err)}`);
      await ((_b = this.webServer) == null ? void 0 : _b.stop().catch(() => {
      }));
      this.terminate(11);
    }
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
      const reused = (0, import_coerce.coerceUuid)(existing == null ? void 0 : existing.val);
      if (reused) {
        this.log.debug(`Server UUID reused from info.serverUuid: ${reused}`);
        return reused;
      }
    } catch {
    }
    const fresh = import_node_crypto.default.randomUUID();
    await this.setState("info.serverUuid", { val: fresh, ack: true }).catch((err) => {
      this.log.warn(`Could not save server UUID: ${String(err)}`);
    });
    this.log.info(`Server UUID generated and saved: ${fresh}`);
    return fresh;
  }
  /**
   * Default mode for newly registered clients. Respects the master switch:
   * - `global.enabled=true`  → `'global'` (follow master)
   * - sonst                  → `'0'` (no-choice) → Resolver returnt null →
   *   Landing-Page bis der User im Mode-Dropdown explizit eine URL wählt.
   *   Pre-v1.26.0 fiel der Default auf die erste discovered URL — das hat
   *   die Landing-Page für neue Displays praktisch unsichtbar gemacht und
   *   den User mit einer ungewollten Auto-Wahl überrascht.
   */
  computeNewClientMode() {
    var _a2;
    if ((_a2 = this.globalConfig) == null ? void 0 : _a2.isEnabled()) {
      return import_constants.MODE_GLOBAL;
    }
    return "0";
  }
  /**
   * Read the ioBroker system language (set in Admin → Main Settings). Used for the
   * landing page so the end-user sees the same language as their admin UI. Any
   * non-empty language is passed through as-is; an unknown one falls back to
   * English only at render time (htmlLangFor / tPage). An unreadable system.config
   * falls back to `en` here. Read once on startup — a runtime language switch takes
   * effect after an adapter restart, fine for a setup-hint page seen once.
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
    var _a2, _b;
    const now = Date.now();
    const records = (_b = (_a2 = this.registry) == null ? void 0 : _a2.listAll()) != null ? _b : [];
    if (records.length > 0) {
      const ttlDays = Math.round(import_constants.STALE_CLIENT_TTL_MS / (24 * 60 * 60 * 1e3));
      this.log.debug(`gcStaleClients: scanning ${records.length} client(s) for staleness (TTL=${ttlDays}d)`);
    }
    const results = await Promise.all(
      records.map(async (record) => {
        var _a3;
        try {
          const obj = await this.getObjectAsync(`clients.${record.id}`);
          const native = (_a3 = obj == null ? void 0 : obj.native) != null ? _a3 : {};
          const action = (0, import_coerce.decideGcAction)(native.lastSeen, now, import_constants.STALE_CLIENT_TTL_MS);
          if (action === "seed") {
            await this.registry.seedLastSeen(record.id, now);
            return 0;
          }
          if (action === "stale") {
            await this.registry.remove(record.id);
            return 1;
          }
          return 0;
        } catch (err) {
          this.log.debug(`Stale-GC: failed for ${record.id}: ${String(err)}`);
          return 0;
        }
      })
    );
    const removed = results.reduce((acc, n) => acc + n, 0);
    if (removed > 0) {
      this.log.info(`Removed ${removed} inactive client(s) (idle longer than 30 days)`);
    }
  }
  /**
   * Master-switch action: when `global.enabled` flips, propagate to every
   * client's `mode`. `true` → all clients follow `'global'`. `false` → all
   * clients drop to `'0'` (no-choice) so the next display load shows the
   * landing page until the user picks a URL again (since v1.26 — earlier
   * versions auto-selected the first discovered URL which surprised users).
   *
   * @param enabled New value of `global.enabled`.
   */
  async applyMasterSwitch(enabled) {
    if (!this.registry) {
      return;
    }
    if (enabled) {
      this.log.debug(`applyMasterSwitch: enabled=true \u2192 propagating mode='global' to all clients`);
      await this.registry.bulkSetMode(import_constants.MODE_GLOBAL);
      return;
    }
    this.log.debug(`applyMasterSwitch: enabled=false \u2192 propagating mode='0' (no-choice) to all clients`);
    await this.registry.bulkSetMode("0");
  }
  async onStateChange(id, state) {
    try {
      if (!state || state.ack) {
        return;
      }
      const registry = this.registry;
      const globalConfig = this.globalConfig;
      const clientParsed = registry ? (0, import_client_registry.parseClientStateId)(id, this.namespace) : null;
      if (clientParsed && registry) {
        if (clientParsed.kind === "mode") {
          await registry.handleModeWrite(clientParsed.id, state.val);
          const record = registry.getById(clientParsed.id);
          if ((record == null ? void 0 : record.mode) === import_constants.MODE_GLOBAL && (globalConfig == null ? void 0 : globalConfig.resolveUrlFor(record)) === null) {
            this.log.warn(
              `Client ${record.id}: mode is "global" but global has no resolvable URL \u2014 fill global.mode/manualUrl, or pick a different mode`
            );
          }
        } else if (clientParsed.kind === "manualUrl") {
          await registry.handleManualUrlWrite(clientParsed.id, state.val);
        } else if (clientParsed.kind === "remove" && state.val === true) {
          await registry.remove(clientParsed.id);
        }
        return;
      }
      const globalParsed = globalConfig ? (0, import_global_config.parseGlobalStateId)(id, this.namespace) : null;
      if (globalParsed && globalConfig) {
        if (globalParsed === "mode") {
          await globalConfig.handleModeWrite(state.val);
        } else if (globalParsed === "manualUrl") {
          await globalConfig.handleManualUrlWrite(state.val);
        } else if (globalParsed === "enabled") {
          await globalConfig.handleEnabledWrite(state.val);
          await this.applyMasterSwitch(globalConfig.isEnabled());
        }
        return;
      }
      if (id === `${this.namespace}.info.refreshUrls` && state.val === true) {
        await this.handleRefreshUrlsWrite();
      }
    } catch (err) {
      this.log.error(`stateChange failed: ${String(err)}`);
    }
  }
  /**
   * Handler for the `info.refreshUrls` button.
   * Triggert eine sofortige `urlDiscovery.collect()` (statt Debounce-Schedule),
   * damit der User nicht 2s warten muss. Schreibt anschließend `false ack` damit
   * der Button in der Admin-UI wieder „klickbar" wird.
   */
  async handleRefreshUrlsWrite() {
    if (!this.urlDiscovery) {
      return;
    }
    this.urlDiscovery.cancelRefresh();
    try {
      await this.urlDiscovery.collect();
      this.log.debug(`URL list refreshed on user request`);
    } catch (err) {
      this.log.warn(`URL refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.setState("info.refreshUrls", { val: false, ack: true }).catch(
        (err) => this.log.debug(`refreshUrls re-arm failed: ${String(err)}`)
      );
    }
  }
  onObjectChange(id, obj) {
    var _a2, _b;
    try {
      if (!(id == null ? void 0 : id.startsWith("system.adapter."))) {
        return;
      }
      const isUrlSourceAdapter = (0, import_url_discovery.isUrlSourceAdapterEvent)(id);
      const isAddOrRemove = !obj || obj.type === "instance" && !((_a2 = obj.common) == null ? void 0 : _a2.host);
      if (isUrlSourceAdapter || isAddOrRemove) {
        (_b = this.urlDiscovery) == null ? void 0 : _b.scheduleRefresh();
      }
    } catch (err) {
      this.log.error(`objectChange failed: ${String(err)}`);
    }
  }
  onUnload(callback) {
    var _a2;
    try {
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {
      });
      void this.unsubscribeStatesAsync("clients.*").catch(() => {
      });
      void this.unsubscribeStatesAsync("global.*").catch(() => {
      });
      void this.unsubscribeStatesAsync("info.refreshUrls").catch(() => {
      });
      void this.unsubscribeForeignObjectsAsync("system.adapter.*").catch(() => {
      });
      (_a2 = this.urlDiscovery) == null ? void 0 : _a2.cancelRefresh();
      this.urlDiscovery = null;
      if (this.mdnsService) {
        this.mdnsService.stop(true);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HassEmu
});
//# sourceMappingURL=main.js.map
