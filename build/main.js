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
var import_mdns = require("./lib/mdns");
var import_webserver = require("./lib/webserver");
class HassEmu extends utils.Adapter {
  mdnsService = null;
  webServer = null;
  constructor(options = {}) {
    super({
      ...options,
      name: "hassemu"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    try {
      await this.setStateAsync("info.connection", false, true);
      if (!this.config.visUrl) {
        this.log.error("No redirect URL configured! Please configure a URL in the adapter settings.");
      }
      const config = {
        port: this.config.port || 8123,
        bindAddress: this.config.bindAddress || "0.0.0.0",
        visUrl: this.config.visUrl || "",
        authRequired: this.config.authRequired === true,
        username: this.config.username || "admin",
        password: this.config.password || "",
        mdnsEnabled: this.config.mdnsEnabled !== false,
        serviceName: this.config.serviceName || "ioBroker"
      };
      const instanceUuid = import_node_crypto.default.randomUUID();
      this.log.debug(`Config: port=${config.port}, auth=${config.authRequired}, mdns=${config.mdnsEnabled}`);
      if (config.visUrl) {
        this.log.debug(`Target URL: ${config.visUrl}`);
        if (/\blocalhost\b|127\.0\.0\.1/.test(config.visUrl)) {
          this.log.warn(
            "visUrl contains localhost \u2014 the display cannot reach this! Use the real IP address."
          );
        }
      }
      this.webServer = new import_webserver.WebServer(this, config, instanceUuid);
      await this.webServer.start();
      if (config.mdnsEnabled) {
        this.mdnsService = new import_mdns.MDNSService(this, config, instanceUuid);
        this.mdnsService.start();
      } else {
        this.log.debug("mDNS disabled \u2014 enter URL manually on the display");
      }
      await this.setStateAsync("info.connection", true, true);
      const bindAddr = config.bindAddress || "0.0.0.0";
      this.log.info(
        `HA emulation running on ${bindAddr}:${config.port}${config.mdnsEnabled ? ", mDNS active" : ""}`
      );
    } catch (error) {
      const err = error;
      this.log.error(`Failed to start: ${err.message}`);
      if (err.stack) {
        this.log.debug(err.stack);
      }
    }
  }
  onUnload(callback) {
    try {
      if (this.mdnsService) {
        this.mdnsService.stop();
        this.mdnsService = null;
      }
      if (this.webServer) {
        this.webServer.stop().catch((err) => this.log.error(`Server stop error: ${err.message}`));
        this.webServer = null;
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
