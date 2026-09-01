"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var target_health_exports = {};
__export(target_health_exports, {
  TargetHealth: () => TargetHealth,
  probeTarget: () => probeTarget
});
module.exports = __toCommonJS(target_health_exports);
var import_node_http = require("node:http");
var import_node_https = require("node:https");
var import_coerce = require("./coerce");
var import_constants = require("./constants");
function probeTarget(url, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(true);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (alive) => {
      if (!settled) {
        settled = true;
        resolve(alive);
      }
    };
    const isHttps = parsed.protocol === "https:";
    const options = isHttps ? { method: "GET", timeout: timeoutMs, rejectUnauthorized: false } : { method: "GET", timeout: timeoutMs };
    const req = (isHttps ? import_node_https.request : import_node_http.request)(parsed, options, (res) => {
      res.destroy();
      settle(true);
    });
    req.on("timeout", () => {
      req.destroy();
      settle(false);
    });
    req.on("error", () => settle(false));
    req.end();
  });
}
class TargetHealth {
  adapter;
  probe;
  cacheMs;
  cache = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  /**
   * Terminal flag set by {@link dispose} (webserver stop). A probe that settles
   * AFTERWARDS must neither repopulate the cache nor log — the adapter is
   * shutting down and a late "target not reachable" line would land after the
   * teardown messages.
   */
  disposed = false;
  /**
   * @param adapter Adapter surface (logging).
   * @param probe   Probe implementation ({@link probeTarget} in production).
   * @param cacheMs Result validity window (test seam; default {@link TARGET_PROBE_CACHE_MS}).
   */
  constructor(adapter, probe = probeTarget, cacheMs = import_constants.TARGET_PROBE_CACHE_MS) {
    this.adapter = adapter;
    this.probe = probe;
    this.cacheMs = cacheMs;
  }
  /**
   * Whether `url` currently answers, from cache or via one shared probe.
   *
   * @param url Target URL as resolved for the display.
   */
  async isReachable(url) {
    const entry = this.cache.get(url);
    if (entry && Date.now() - entry.checkedAt < this.cacheMs) {
      return entry.alive;
    }
    const pending = this.inflight.get(url);
    if (pending) {
      return pending;
    }
    const run = this.probe(url, import_constants.TARGET_PROBE_TIMEOUT_MS).catch(() => true).then((alive) => {
      var _a;
      this.inflight.delete(url);
      if (this.disposed) {
        return alive;
      }
      const prev = (_a = this.cache.get(url)) == null ? void 0 : _a.alive;
      if (prev === void 0) {
        (0, import_coerce.evictOldest)(this.cache, import_constants.TARGET_HEALTH_CACHE_CAP);
      }
      this.cache.set(url, { alive, checkedAt: Date.now() });
      if (!alive && prev !== false) {
        this.adapter.log.info(`Redirect target not reachable: ${url}`);
      } else if (alive && prev === false) {
        this.adapter.log.info(`Redirect target reachable again: ${url}`);
      }
      return alive;
    });
    this.inflight.set(url, run);
    return run;
  }
  /** Drops cache and in-flight bookkeeping (webserver stop). Terminal — the instance is not reused. */
  dispose() {
    this.disposed = true;
    this.cache.clear();
    this.inflight.clear();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TargetHealth,
  probeTarget
});
//# sourceMappingURL=target-health.js.map
