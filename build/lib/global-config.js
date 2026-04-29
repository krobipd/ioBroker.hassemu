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
  MODE_GLOBAL: () => MODE_GLOBAL,
  MODE_MANUAL: () => MODE_MANUAL,
  parseGlobalStateId: () => parseGlobalStateId
});
module.exports = __toCommonJS(global_config_exports);
var import_coerce = require("./coerce");
const MODE_GLOBAL = "global";
const MODE_MANUAL = "manual";
class GlobalConfig {
  adapter;
  mode = "";
  manualUrl = null;
  enabled = false;
  /** @param adapter Adapter instance used for state and object I/O. */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /** Loads the current global.* values from the broker. Call once on adapter start. */
  async restore() {
    const modeState = await this.safeGetState("global.mode");
    const manualState = await this.safeGetState("global.manualUrl");
    const enabledState = await this.safeGetState("global.enabled");
    this.mode = typeof (modeState == null ? void 0 : modeState.val) === "string" ? modeState.val : "";
    this.manualUrl = (0, import_coerce.coerceSafeUrl)(manualState == null ? void 0 : manualState.val);
    this.enabled = (0, import_coerce.coerceBoolean)(enabledState == null ? void 0 : enabledState.val) === true;
  }
  /**
   * Resolves the redirect URL for `record`.
   *
   * Delegates via the client's `mode`:
   * - `'global'` → resolve global mode/manualUrl
   * - `'manual'` → client's manualUrl
   * - URL string → that URL
   * - empty / unknown → null (setup page)
   *
   * @param record Client to resolve for.
   */
  resolveUrlFor(record) {
    return this.resolveClientMode(record);
  }
  resolveClientMode(record) {
    var _a;
    const m = record.mode;
    if (m === MODE_GLOBAL) {
      return this.resolveGlobalMode();
    }
    if (m === MODE_MANUAL) {
      return (_a = record.manualUrl) != null ? _a : null;
    }
    return (0, import_coerce.coerceSafeUrl)(m);
  }
  resolveGlobalMode() {
    if (this.mode === MODE_MANUAL) {
      return this.manualUrl;
    }
    return (0, import_coerce.coerceSafeUrl)(this.mode);
  }
  /** Returns the stored global mode (raw string — sentinel or URL). */
  getMode() {
    return this.mode;
  }
  /** Returns the stored global manualUrl. */
  getManualUrl() {
    return this.manualUrl;
  }
  /** Returns whether the master switch is currently active. */
  isEnabled() {
    return this.enabled;
  }
  /**
   * Accept a write on `global.mode`. Allowed values: `'manual'` or a URL that
   * passes {@link coerceSafeUrl}. `'global'` is rejected (would be
   * self-referential). Empty string clears the choice.
   *
   * @param rawValue Value written to the state.
   */
  async handleModeWrite(rawValue) {
    if (typeof rawValue !== "string") {
      this.adapter.log.warn("global-config: rejected non-string global.mode");
      await this.adapter.setStateAsync("global.mode", { val: this.mode, ack: true });
      return;
    }
    if (rawValue === "") {
      this.mode = "";
      await this.adapter.setStateAsync("global.mode", { val: "", ack: true });
      return;
    }
    if (rawValue === MODE_GLOBAL) {
      this.adapter.log.warn("global-config: 'global' is not allowed as global.mode (self-referential)");
      await this.adapter.setStateAsync("global.mode", { val: this.mode, ack: true });
      return;
    }
    if (rawValue === MODE_MANUAL) {
      if (!this.manualUrl) {
        this.adapter.log.warn(
          "global-config: global.mode set to 'manual' but global.manualUrl is empty \u2014 fill it to redirect"
        );
      }
      this.mode = MODE_MANUAL;
      await this.adapter.setStateAsync("global.mode", { val: MODE_MANUAL, ack: true });
      return;
    }
    const safe = (0, import_coerce.coerceSafeUrl)(rawValue);
    if (!safe) {
      this.adapter.log.warn(`global-config: rejected unsafe global.mode value '${rawValue}'`);
      await this.adapter.setStateAsync("global.mode", { val: this.mode, ack: true });
      return;
    }
    this.mode = safe;
    await this.adapter.setStateAsync("global.mode", { val: safe, ack: true });
  }
  /**
   * Accept a write on `global.manualUrl`. Free-text — must pass
   * {@link coerceSafeUrl} (or be empty to clear).
   *
   * @param rawValue Value written to the state.
   */
  async handleManualUrlWrite(rawValue) {
    var _a;
    const empty = rawValue === "" || rawValue === null || rawValue === void 0;
    const safe = empty ? null : (0, import_coerce.coerceSafeUrl)(rawValue);
    if (!empty && !safe) {
      this.adapter.log.warn("global-config: rejected unsafe global.manualUrl");
      await this.adapter.setStateAsync("global.manualUrl", { val: (_a = this.manualUrl) != null ? _a : "", ack: true });
      return;
    }
    this.manualUrl = safe;
    await this.adapter.setStateAsync("global.manualUrl", { val: safe != null ? safe : "", ack: true });
    if (this.mode === MODE_MANUAL && !safe) {
      this.adapter.log.warn(
        "global-config: global.manualUrl cleared while global.mode='manual' \u2014 clients delegating to global will hit the setup page"
      );
    }
  }
  /**
   * Accept a write on `global.enabled`. Persists the value but does NOT trigger
   * the bulk-sync of client modes — the caller (main.ts) does that, because it
   * holds the registry + url-discovery references needed for the sync.
   *
   * @param rawValue Value written to the state.
   */
  async handleEnabledWrite(rawValue) {
    const enabled = (0, import_coerce.coerceBoolean)(rawValue) === true;
    this.enabled = enabled;
    await this.adapter.setStateAsync("global.enabled", { val: enabled, ack: true });
  }
  /**
   * Updates the dropdown states (`common.states`) on `global.mode`.
   * The `'manual'` sentinel is added; `'global'` is NOT (would be self-referential).
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states) {
    const merged = { ...states, [MODE_MANUAL]: "Manual URL" };
    await this.adapter.extendObjectAsync("global.mode", {
      common: { states: merged }
    });
  }
  /**
   * Convenience for migration: set mode + manualUrl together. Skips the
   * write-side validation that {@link handleModeWrite} / {@link handleManualUrlWrite}
   * apply, because migration trusts the legacy values it carries forward.
   *
   * @param mode      New mode value.
   * @param manualUrl New manualUrl, or null to clear.
   */
  async migrationSet(mode, manualUrl) {
    this.mode = mode;
    this.manualUrl = manualUrl;
    await this.adapter.setStateAsync("global.mode", { val: mode, ack: true });
    await this.adapter.setStateAsync("global.manualUrl", { val: manualUrl != null ? manualUrl : "", ack: true });
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
  if (tail === "mode" || tail === "manualUrl" || tail === "enabled") {
    return tail;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GlobalConfig,
  MODE_GLOBAL,
  MODE_MANUAL,
  parseGlobalStateId
});
//# sourceMappingURL=global-config.js.map
