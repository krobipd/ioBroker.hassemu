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
var url_discovery_exports = {};
__export(url_discovery_exports, {
  DEFAULT_REFRESH_DEBOUNCE_MS: () => DEFAULT_REFRESH_DEBOUNCE_MS,
  UrlDiscovery: () => UrlDiscovery,
  buildCrossRefs: () => buildCrossRefs,
  collectFromInstance: () => collectFromInstance,
  resolvePlaceholders: () => resolvePlaceholders
});
module.exports = __toCommonJS(url_discovery_exports);
var import_coerce = require("./coerce");
var import_network = require("./network");
const DEFAULT_REFRESH_DEBOUNCE_MS = 2e3;
class UrlDiscovery {
  adapter;
  onChange;
  cached = {};
  debounceTimer = null;
  /**
   * @param adapter  Adapter instance used to read broker state.
   * @param onChange Optional callback fired after every successful refresh.
   */
  constructor(adapter, onChange) {
    this.adapter = adapter;
    this.onChange = onChange;
  }
  /** Returns a copy of the last collected URL states. Does not trigger collection. */
  getCached() {
    return { ...this.cached };
  }
  /**
   * Returns the first discovered URL (insertion order), or null if the cache
   * is empty. Used by the global-config bulk-sync when the master switch is
   * flipped off — clients fall back to a sensible default URL.
   */
  getFirstDiscoveredUrl() {
    for (const url of Object.keys(this.cached)) {
      return url;
    }
    return null;
  }
  /**
   * Schedules a refresh after `debounceMs`. Multiple calls within the window coalesce into one.
   *
   * @param debounceMs Debounce window in milliseconds.
   */
  scheduleRefresh(debounceMs = DEFAULT_REFRESH_DEBOUNCE_MS) {
    var _a;
    if (this.debounceTimer !== null) {
      this.adapter.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = (_a = this.adapter.setTimeout(() => {
      this.debounceTimer = null;
      this.collect().catch((err) => {
        this.adapter.log.debug(`url-discovery: refresh failed: ${String(err)}`);
      });
    }, debounceMs)) != null ? _a : null;
  }
  /** Cancels any pending scheduled refresh. */
  cancelRefresh() {
    if (this.debounceTimer !== null) {
      this.adapter.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
  /** Collects all discoverable URLs from the broker. Updates cache, returns states map. */
  async collect() {
    var _a;
    const result = {};
    const hostIp = (0, import_network.getLocalIp)();
    let instances = {};
    let instancesOk = false;
    try {
      instances = (_a = await this.adapter.getForeignObjectsAsync("system.adapter.*", "instance")) != null ? _a : {};
      instancesOk = true;
    } catch (err) {
      this.adapter.log.debug(`url-discovery: getForeignObjectsAsync failed: ${String(err)}`);
    }
    if (!instancesOk) {
      return { ...this.cached };
    }
    const crossRefs = buildCrossRefs(instances);
    for (const [id, obj] of Object.entries(instances)) {
      collectFromInstance(id, obj, crossRefs, hostIp, result);
    }
    await this.addVisProjects(result, crossRefs.get("web.0"), hostIp, "vis-2.0", "vis-2", "VIS-2");
    await this.addVisProjects(result, crossRefs.get("web.0"), hostIp, "vis.0", "vis", "VIS");
    this.cached = result;
    if (this.onChange) {
      try {
        await this.onChange(result);
      } catch (err) {
        this.adapter.log.debug(`url-discovery: onChange listener failed: ${String(err)}`);
      }
    }
    return result;
  }
  async addVisProjects(result, webInstance, hostIp, adapterName, urlPath, label) {
    var _a;
    if (!webInstance) {
      return;
    }
    const native = (0, import_coerce.isPlainObject)(webInstance.native) ? webInstance.native : null;
    if (!native) {
      return;
    }
    const port = (0, import_coerce.coerceFiniteNumber)(native.port);
    if (port === null) {
      return;
    }
    const bindRaw = (0, import_coerce.coerceString)(native.bind);
    const ip = (0, import_network.isWildcardBind)(bindRaw) ? hostIp : bindRaw;
    const protocol = native.secure === true ? "https" : "http";
    let entries = [];
    try {
      entries = (_a = await this.adapter.readDirAsync(adapterName, "/")) != null ? _a : [];
    } catch {
      return;
    }
    if (!Array.isArray(entries)) {
      return;
    }
    for (const e of entries) {
      if (!(0, import_coerce.isPlainObject)(e)) {
        continue;
      }
      if (e.isDir !== true) {
        continue;
      }
      const name = (0, import_coerce.coerceString)(e.file);
      if (!name || name.startsWith("_")) {
        continue;
      }
      const url = `${protocol}://${ip}:${port}/${urlPath}/index.html?${name}`;
      const safe = (0, import_coerce.coerceSafeUrl)(url);
      if (!safe) {
        continue;
      }
      result[safe] = `${label}: ${name}`;
      if (adapterName === "vis-2.0") {
        await this.addVisViews(result, adapterName, name, url, label);
      }
    }
  }
  /**
   * Lese `<project>/vis-views.json` und füge pro View einen Dropdown-Eintrag
   * `?<project>/<viewName>` ein. Defensive — alle Fehler silently caught.
   *
   * @param result Output-Map (mutated)
   * @param adapterName VIS-Adapter (z.B. `vis-2.0`)
   * @param projectName Top-level-Projekt-Folder
   * @param projectUrl Bereits berechneter Projekt-URL (`...?projectName`)
   * @param label Sprach-Label für Dropdown (`VIS-2`)
   */
  async addVisViews(result, adapterName, projectName, projectUrl, label) {
    let raw;
    try {
      raw = await this.adapter.readFileAsync(adapterName, `${projectName}/vis-views.json`);
    } catch {
      return;
    }
    let text;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else if ((0, import_coerce.isPlainObject)(raw) && raw.file !== void 0) {
      const f = raw.file;
      text = typeof f === "string" ? f : Buffer.isBuffer(f) ? f.toString("utf8") : "";
    } else {
      return;
    }
    if (!text) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!(0, import_coerce.isPlainObject)(parsed)) {
      return;
    }
    const viewsContainer = (0, import_coerce.isPlainObject)(parsed.views) ? parsed.views : parsed;
    for (const viewName of Object.keys(viewsContainer)) {
      if (viewName.startsWith("_") || viewName === "settings" || viewName === "activeView") {
        continue;
      }
      const v = viewsContainer[viewName];
      if (!(0, import_coerce.isPlainObject)(v)) {
        continue;
      }
      const viewUrl = `${projectUrl}/${encodeURIComponent(viewName)}`;
      const safe = (0, import_coerce.coerceSafeUrl)(viewUrl);
      if (!safe) {
        continue;
      }
      result[safe] = `${label}: ${projectName} / ${viewName}`;
    }
  }
}
function buildCrossRefs(instances) {
  const map = /* @__PURE__ */ new Map();
  for (const [id, obj] of Object.entries(instances)) {
    if (!(0, import_coerce.isPlainObject)(obj)) {
      continue;
    }
    const short = id.startsWith("system.adapter.") ? id.substring("system.adapter.".length) : id;
    map.set(short, obj);
  }
  return map;
}
function collectFromInstance(id, obj, crossRefs, hostIp, result) {
  if (!(0, import_coerce.isPlainObject)(obj)) {
    return;
  }
  const common = (0, import_coerce.isPlainObject)(obj.common) ? obj.common : null;
  if (!common) {
    return;
  }
  if (common.enabled !== true) {
    return;
  }
  const instanceId = id.startsWith("system.adapter.") ? id.substring("system.adapter.".length) : id;
  const native = (0, import_coerce.isPlainObject)(obj.native) ? obj.native : {};
  const ctx = { instanceId, native, crossRefs, hostIp };
  if ((0, import_coerce.isPlainObject)(common.localLinks)) {
    for (const entry of Object.values(common.localLinks)) {
      addFromEntry(entry, ctx, instanceId, result);
    }
  }
  if (typeof common.localLink === "string" && !(0, import_coerce.isPlainObject)(common.localLinks)) {
    const resolved = resolvePlaceholders(common.localLink, ctx);
    if (resolved) {
      const safe = (0, import_coerce.coerceSafeUrl)(resolved);
      if (safe) {
        result[safe] = instanceId;
      }
    }
  }
  for (const key of ["welcomeScreen", "welcomeScreenPro"]) {
    const ws = common[key];
    const entries = Array.isArray(ws) ? ws : (0, import_coerce.isPlainObject)(ws) ? [ws] : [];
    for (const entry of entries) {
      addFromEntry(entry, ctx, instanceId, result);
    }
  }
}
function addFromEntry(entry, ctx, instanceId, result) {
  if (!(0, import_coerce.isPlainObject)(entry)) {
    return;
  }
  const linkTpl = (0, import_coerce.coerceString)(entry.link);
  if (!linkTpl) {
    return;
  }
  const resolved = resolvePlaceholders(linkTpl, ctx);
  if (!resolved) {
    return;
  }
  const safe = (0, import_coerce.coerceSafeUrl)(resolved);
  if (!safe) {
    return;
  }
  const name = (0, import_coerce.coerceString)(entry.name);
  result[safe] = name ? `${instanceId}: ${name}` : instanceId;
}
function resolvePlaceholders(template, ctx) {
  let failed = false;
  const out = template.replace(/%([^%]+)%/g, (match, token) => {
    const v = resolveOne(token, ctx);
    if (v === null) {
      failed = true;
      return match;
    }
    return v;
  });
  return failed ? null : out;
}
function resolveOne(token, ctx) {
  var _a;
  switch (token) {
    case "ip":
      return ctx.hostIp;
    case "bind": {
      const b = (0, import_coerce.coerceString)(ctx.native.bind);
      return (0, import_network.isWildcardBind)(b) ? ctx.hostIp : b;
    }
    case "port": {
      const p = (0, import_coerce.coerceFiniteNumber)(ctx.native.port);
      return p !== null ? String(p) : null;
    }
    case "protocol":
      return ctx.native.secure === true ? "https" : "http";
    case "secure":
      return ctx.native.secure === true ? "true" : "false";
    case "instance":
      return (_a = ctx.instanceId.split(".").pop()) != null ? _a : null;
    case "instanceNumeric": {
      const last = ctx.instanceId.split(".").pop();
      return last && /^\d+$/.test(last) ? last : null;
    }
  }
  if (token.startsWith("native_")) {
    const field = token.substring("native_".length);
    return primitiveToString(ctx.native[field]);
  }
  const crossMatch = token.match(/^([a-zA-Z0-9-]+\.\d+)_(.+)$/);
  if (crossMatch) {
    const [, refKey, field] = crossMatch;
    const refInstance = ctx.crossRefs.get(refKey);
    if (!refInstance) {
      return null;
    }
    const refNative = (0, import_coerce.isPlainObject)(refInstance.native) ? refInstance.native : null;
    if (!refNative) {
      return null;
    }
    if (field === "bind") {
      const b = (0, import_coerce.coerceString)(refNative.bind);
      return (0, import_network.isWildcardBind)(b) ? ctx.hostIp : b;
    }
    if (field === "port") {
      const p = (0, import_coerce.coerceFiniteNumber)(refNative.port);
      return p !== null ? String(p) : null;
    }
    if (field === "protocol") {
      return refNative.secure === true ? "https" : "http";
    }
    return primitiveToString(refNative[field]);
  }
  return null;
}
function primitiveToString(v) {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_REFRESH_DEBOUNCE_MS,
  UrlDiscovery,
  buildCrossRefs,
  collectFromInstance,
  resolvePlaceholders
});
//# sourceMappingURL=url-discovery.js.map
