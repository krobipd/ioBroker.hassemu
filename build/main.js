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
var import_global_config = require("./lib/global-config");
var import_mdns = require("./lib/mdns");
var import_url_discovery = require("./lib/url-discovery");
var import_webserver = require("./lib/webserver");
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
    this.on("objectChange", () => {
      var _a;
      (_a = this.urlDiscovery) == null ? void 0 : _a.scheduleRefresh();
    });
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    await this.setState("info.connection", { val: false, ack: true });
    this.globalConfig = new import_global_config.GlobalConfig(this);
    await this.globalConfig.restore();
    await this.migrateLegacyDefaultVisUrl();
    const instanceUuid = import_node_crypto.default.randomUUID();
    this.log.debug(
      `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`
    );
    this.registry = new import_client_registry.ClientRegistry(this);
    await this.registry.restore();
    this.urlDiscovery = new import_url_discovery.UrlDiscovery(this, async (states) => {
      var _a, _b;
      await ((_a = this.globalConfig) == null ? void 0 : _a.syncUrlDropdown(states));
      await ((_b = this.registry) == null ? void 0 : _b.syncUrlDropdown(states));
    });
    await this.urlDiscovery.collect();
    await this.subscribeForeignObjectsAsync("system.adapter.*");
    await this.subscribeStatesAsync("clients.*");
    await this.subscribeStatesAsync("global.*");
    try {
      this.webServer = new import_webserver.WebServer(this, this.config, this.registry, this.globalConfig, instanceUuid);
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
   * 1.0.x / 1.1.0 → 1.1.1 migration — move the legacy `defaultVisUrl` from
   * instance native into `global.visUrl` + `global.enabled=true` and drop it
   * from native. Runs once; subsequent starts see empty/missing legacy fields.
   */
  async migrateLegacyDefaultVisUrl() {
    const legacy = this.config;
    const url = legacy.defaultVisUrl || legacy.visUrl;
    if (!url || !this.globalConfig) {
      return;
    }
    this.log.info("Migrating defaultVisUrl \u2192 global.visUrl + global.enabled");
    await this.globalConfig.handleVisUrlWrite(url);
    if (this.globalConfig.getGlobalUrl()) {
      await this.globalConfig.handleEnabledWrite(true);
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
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const clientParsed = this.registry ? (0, import_client_registry.parseClientStateId)(id, this.namespace) : null;
    if (clientParsed) {
      if (clientParsed.kind === "visUrl") {
        await this.registry.handleVisUrlWrite(clientParsed.id, state.val);
      } else if (clientParsed.kind === "remove" && state.val === true) {
        await this.registry.remove(clientParsed.id);
      }
      return;
    }
    const globalParsed = this.globalConfig ? (0, import_global_config.parseGlobalStateId)(id, this.namespace) : null;
    if (globalParsed === "visUrl") {
      await this.globalConfig.handleVisUrlWrite(state.val);
    } else if (globalParsed === "enabled") {
      await this.globalConfig.handleEnabledWrite(state.val);
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
