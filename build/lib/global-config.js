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
var global_config_exports = {};
__export(global_config_exports, {
  GlobalConfig: () => GlobalConfig,
  parseGlobalStateId: () => parseGlobalStateId
});
module.exports = __toCommonJS(global_config_exports);
var import_coerce = require("./coerce");
class GlobalConfig {
  adapter;
  visUrl = null;
  enabled = false;
  /** @param adapter Adapter instance used for state and object I/O. */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /** Loads the current global.* values from the broker. Call once on adapter start. */
  async restore() {
    const urlState = await this.safeGetState("global.visUrl");
    const enabledState = await this.safeGetState("global.enabled");
    this.visUrl = (0, import_coerce.coerceSafeUrl)(urlState == null ? void 0 : urlState.val);
    this.enabled = (0, import_coerce.coerceBoolean)(enabledState == null ? void 0 : enabledState.val) === true;
  }
  /**
   * Resolves the redirect URL for `record`.
   * Returns the global URL if the override is enabled and set, otherwise the
   * client's own URL, or `null` when nothing is configured.
   *
   * @param record Client to resolve the URL for.
   */
  resolveUrlFor(record) {
    if (this.enabled && this.visUrl) {
      return this.visUrl;
    }
    return record.visUrl;
  }
  /** Returns the stored global URL regardless of the enabled flag. */
  getGlobalUrl() {
    return this.visUrl;
  }
  /** Returns whether the global override is currently active. */
  isEnabled() {
    return this.enabled;
  }
  /**
   * Accept an external write on `global.visUrl`. Unsafe URLs are rejected,
   * empty string / null clears the override.
   *
   * @param rawValue Value written to the state.
   */
  async handleVisUrlWrite(rawValue) {
    var _a;
    const empty = rawValue === "" || rawValue === null || rawValue === void 0;
    const safe = empty ? null : (0, import_coerce.coerceSafeUrl)(rawValue);
    if (!empty && !safe) {
      this.adapter.log.warn("global-config: rejected unsafe global.visUrl");
      await this.adapter.setStateAsync("global.visUrl", { val: (_a = this.visUrl) != null ? _a : "", ack: true });
      return;
    }
    this.visUrl = safe;
    await this.adapter.setStateAsync("global.visUrl", { val: safe != null ? safe : "", ack: true });
  }
  /**
   * Accept an external write on `global.enabled`.
   *
   * @param rawValue Value written to the state.
   */
  async handleEnabledWrite(rawValue) {
    const enabled = (0, import_coerce.coerceBoolean)(rawValue) === true;
    this.enabled = enabled;
    await this.adapter.setStateAsync("global.enabled", { val: enabled, ack: true });
  }
  /**
   * Updates the dropdown states (common.states) on `global.visUrl`.
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states) {
    await this.adapter.extendObjectAsync("global.visUrl", {
      common: { states: { ...states } }
    });
  }
  async safeGetState(id) {
    var _a;
    try {
      return (_a = await this.adapter.getStateAsync(id)) != null ? _a : null;
    } catch {
      return null;
    }
  }
}
function parseGlobalStateId(fullId, namespace) {
  const prefix = `${namespace}.global.`;
  if (!fullId.startsWith(prefix)) {
    return null;
  }
  const tail = fullId.substring(prefix.length);
  if (tail === "visUrl" || tail === "enabled") {
    return tail;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GlobalConfig,
  parseGlobalStateId
});
//# sourceMappingURL=global-config.js.map
