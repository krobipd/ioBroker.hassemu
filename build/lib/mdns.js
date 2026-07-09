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
var import_bonjour_service = __toESM(require("bonjour-service"));
var import_constants = require("./constants");
var import_network = require("./network");
class MDNSService {
  adapter;
  config;
  /** Shared server UUID (constructor input). Exposed read-only for the unit tests only — no production reader (main.ts already holds the uuid). v1.37.0 (L25). */
  uuid;
  active = false;
  bonjour = null;
  published = null;
  /** Read-only flag — true between successful `start()` and `stop()`. */
  isActive() {
    return this.active;
  }
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
  /** Start mDNS broadcasting via bonjour-service */
  start() {
    var _a, _b, _c;
    const host = (0, import_network.resolveAdvertisedHost)(this.config.bindAddress);
    const baseUrl = `http://${host}:${this.config.port}`;
    const serviceName = this.config.serviceName || import_constants.DEFAULT_SERVICE_NAME;
    try {
      this.bonjour = new import_bonjour_service.default();
      const txt = {
        base_url: baseUrl,
        internal_url: baseUrl,
        version: import_constants.HA_VERSION,
        uuid: this.uuid,
        location_name: serviceName,
        // mDNS-TXT ist string-only — boolean explizit zu „True"/„False" mappen.
        // Vorher hardcoded 'True' unabhängig von authRequired → Spec-Drift (HA-Clients
        // mit strict-mode triggerten Auth-Flow auch bei authRequired=false).
        requires_api_password: this.config.authRequired ? "True" : "False"
      };
      this.published = this.bonjour.publish({
        name: serviceName,
        type: "home-assistant",
        protocol: "tcp",
        port: this.config.port,
        txt
      });
      (_b = (_a = this.published).on) == null ? void 0 : _b.call(_a, "error", (err) => {
        var _a2;
        this.adapter.log.warn(`mDNS async publish error: ${err.message}`);
        this.active = false;
        try {
          (_a2 = this.bonjour) == null ? void 0 : _a2.destroy();
        } catch {
        }
        this.bonjour = null;
        this.published = null;
      });
      this.active = true;
      this.adapter.log.debug(
        `mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local on ${host}:${this.config.port}`
      );
      this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
    } catch (error) {
      const err = error;
      this.adapter.log.warn(`mDNS failed to start: ${err.message}`);
      try {
        (_c = this.bonjour) == null ? void 0 : _c.destroy();
      } catch {
      }
      this.bonjour = null;
      this.published = null;
    }
  }
  /**
   * Stop mDNS broadcasting.
   *
   * @param synchronous pass `true` from the synchronous onUnload path — there the
   *   process is tearing down, so we skip the managed fallback timer (adapter-core
   *   warns when a managed timer is armed during shutdown, and process exit
   *   releases the sockets regardless). Defaults to `false` for the runtime
   *   re-init path, where the adapter keeps running and the fallback matters.
   */
  stop(synchronous = false) {
    if (!this.active) {
      return;
    }
    this.active = false;
    const published = this.published;
    const bonjour = this.bonjour;
    this.published = null;
    this.bonjour = null;
    let destroyed = false;
    const destroy = () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      try {
        bonjour == null ? void 0 : bonjour.destroy();
      } catch {
      }
    };
    try {
      if (published == null ? void 0 : published.stop) {
        published.stop(destroy);
        if (!synchronous) {
          this.adapter.setTimeout(destroy, 300);
        }
      } else {
        destroy();
      }
      this.adapter.log.debug("mDNS: Service stopped");
    } catch (error) {
      const err = error;
      this.adapter.log.warn(`mDNS could not stop cleanly: ${err.message}`);
      destroy();
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MDNSService
});
//# sourceMappingURL=mdns.js.map
