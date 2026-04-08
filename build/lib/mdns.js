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
var mdns_exports = {};
__export(mdns_exports, {
  MDNSService: () => MDNSService
});
module.exports = __toCommonJS(mdns_exports);
var import_node_os = __toESM(require("node:os"));
var import_bonjour_service = __toESM(require("bonjour-service"));
var import_constants = require("./constants");
class MDNSService {
  adapter;
  config;
  uuid;
  active = false;
  bonjour = null;
  published = null;
  /**
   * Creates a new MDNSService instance
   *
   * @param adapter - Adapter interface for logging
   * @param config - Adapter configuration
   * @param uuid - Shared UUID for consistent identity across WebServer and mDNS
   */
  constructor(adapter, config, uuid) {
    this.adapter = adapter;
    this.config = config;
    this.uuid = uuid;
  }
  /** First non-internal IPv4 address */
  getLocalIP() {
    const interfaces = import_node_os.default.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
      if (!ifaces) {
        continue;
      }
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return "127.0.0.1";
  }
  /** Start mDNS broadcasting via bonjour-service */
  start() {
    const localIP = this.getLocalIP();
    const baseUrl = `http://${localIP}:${this.config.port}`;
    const serviceName = this.config.serviceName || "ioBroker";
    try {
      this.bonjour = new import_bonjour_service.default();
      this.published = this.bonjour.publish({
        name: serviceName,
        type: "home-assistant",
        protocol: "tcp",
        port: this.config.port,
        txt: {
          base_url: baseUrl,
          internal_url: baseUrl,
          external_url: "",
          version: import_constants.HA_VERSION,
          uuid: this.uuid,
          location_name: serviceName,
          requires_api_password: "True"
        }
      });
      this.active = true;
      this.adapter.log.debug(
        `mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local on ${localIP}:${this.config.port}`
      );
      this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
    } catch (error) {
      const err = error;
      this.adapter.log.warn(`mDNS: Failed to start: ${err.message}`);
    }
  }
  /** Stop mDNS broadcasting */
  stop() {
    var _a, _b;
    if (!this.active) {
      return;
    }
    try {
      if (this.published) {
        (_b = (_a = this.published).stop) == null ? void 0 : _b.call(_a);
        this.published = null;
      }
      if (this.bonjour) {
        this.bonjour.destroy();
        this.bonjour = null;
      }
      this.adapter.log.debug("mDNS: Service stopped");
    } catch (error) {
      const err = error;
      this.adapter.log.warn(`mDNS: Could not stop cleanly: ${err.message}`);
    }
    this.active = false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MDNSService
});
//# sourceMappingURL=mdns.js.map
