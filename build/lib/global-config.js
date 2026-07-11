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
var import_constants = require("./constants");
var import_i18n = require("./i18n");
var import_object_repair = require("./object-repair");
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
    const modeState = await (0, import_coerce.safeGetState)(this.adapter, "global.mode");
    const manualState = await (0, import_coerce.safeGetState)(this.adapter, "global.manualUrl");
    const enabledState = await (0, import_coerce.safeGetState)(this.adapter, "global.enabled");
    this.mode = typeof (modeState == null ? void 0 : modeState.val) === "string" ? modeState.val : "";
    this.manualUrl = (0, import_coerce.coerceSafeUrl)(manualState == null ? void 0 : manualState.val);
    this.enabled = (0, import_coerce.coerceBoolean)(enabledState == null ? void 0 : enabledState.val) === true;
    const v = modeState == null ? void 0 : modeState.val;
    if (v === "" || v === null || v === void 0 || v === 0) {
      await this.adapter.setState("global.mode", { val: "0", ack: true });
    }
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
    return this.resolveUrlForWithChain(record).url;
  }
  /**
   * v1.32.0 B1: Resolves the redirect URL AND returns the resolution chain
   * for debug-tracing. Chain examples:
   *   `direct→{url}`           — client.mode is a URL itself
   *   `manual→{url}`           — client.mode='manual' + client.manualUrl
   *   `global→direct→{url}`    — client.mode='global' + global.mode=URL
   *   `global→manual→{url}`    — client.mode='global' + global.mode='manual' + global.manualUrl
   *   `global→landing`         — client.mode='global' + global has no resolvable URL
   *   `landing`                — client.mode is empty/no-choice
   *
   * @param record Client to resolve for.
   */
  resolveUrlForWithChain(record) {
    if (record.mode === import_constants.MODE_GLOBAL) {
      const inner = this.resolveGlobalModeWithChain();
      return { url: inner.url, chain: `global\u2192${inner.chain}` };
    }
    return this.resolveOne(record.mode, record.manualUrl);
  }
  resolveGlobalModeWithChain() {
    return this.resolveOne(this.mode, this.manualUrl);
  }
  /**
   * I16 (v1.37.0): resolve a single (mode, manualUrl) pair to a URL + debug chain.
   * The shared tail of {@link resolveUrlForWithChain} (client level) and
   * {@link resolveGlobalModeWithChain} (global level) — they differ only in whether
   * `global` is a legal mode (client-only), which the client caller handles before
   * delegating here. `ClientRecord.manualUrl` is already `string | null` (L45).
   *
   * @param mode      A `mode` value (`'manual'`, a URL, or a no-choice sentinel).
   * @param manualUrl The `manualUrl` paired with `mode === 'manual'`.
   */
  resolveOne(mode, manualUrl) {
    if ((0, import_coerce.isNoChoice)(mode)) {
      return { url: null, chain: "landing" };
    }
    if (mode === import_constants.MODE_MANUAL) {
      return { url: manualUrl, chain: manualUrl ? `manual\u2192${manualUrl}` : "manual\u2192landing" };
    }
    const safe = (0, import_coerce.coerceSafeUrl)(mode);
    return { url: safe, chain: safe ? `direct\u2192${safe}` : "landing" };
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
    const result = (0, import_coerce.parseModeWrite)(rawValue, [import_constants.MODE_MANUAL]);
    switch (result.kind) {
      case "no-choice":
        this.mode = "";
        await this.adapter.setState("global.mode", { val: "0", ack: true });
        this.adapter.log.debug(`global.mode \u2192 cleared (no-choice)`);
        return;
      case "rejected-non-string":
        this.adapter.log.warn(`global.mode rejected \u2014 non-string value`);
        await this.adapter.setState("global.mode", { val: this.mode || "0", ack: true });
        return;
      case "rejected-disallowed-sentinel":
        this.adapter.log.warn(`global.mode rejected \u2014 "global" is not allowed at the global level (self-referential)`);
        await this.adapter.setState("global.mode", { val: this.mode || "0", ack: true });
        return;
      case "sentinel":
        if (result.value === import_constants.MODE_MANUAL && !this.manualUrl) {
          this.adapter.log.warn(
            `global.mode is "manual" but global.manualUrl is empty \u2014 fill global.manualUrl to redirect`
          );
        }
        this.mode = result.value;
        await this.adapter.setState("global.mode", { val: result.value, ack: true });
        this.adapter.log.debug(`global.mode \u2192 '${result.value}' (sentinel)`);
        return;
      case "rejected-unsafe-url":
        this.adapter.log.warn(`global.mode rejected \u2014 unsafe URL value "${(0, import_coerce.oneLine)(result.raw).substring(0, 120)}"`);
        await this.adapter.setState("global.mode", { val: this.mode || "0", ack: true });
        return;
      case "url":
        this.mode = result.value;
        await this.adapter.setState("global.mode", { val: result.value, ack: true });
        this.adapter.log.debug(`global.mode \u2192 ${result.value} (direct URL)`);
        return;
    }
  }
  /**
   * Accept a write on `global.manualUrl`. Free-text — must pass
   * {@link coerceSafeUrl} (or be empty to clear).
   *
   * @param rawValue Value written to the state.
   */
  async handleManualUrlWrite(rawValue) {
    var _a, _b, _c;
    const result = (0, import_coerce.parseManualUrlWrite)(rawValue);
    if (!result.ok) {
      this.adapter.log.warn(`global.manualUrl rejected \u2014 unsafe URL`);
      await this.adapter.setState("global.manualUrl", { val: (_a = this.manualUrl) != null ? _a : "", ack: true });
      return;
    }
    this.manualUrl = result.safe;
    await this.adapter.setState("global.manualUrl", { val: (_b = result.safe) != null ? _b : "", ack: true });
    this.adapter.log.debug(`global.manualUrl \u2192 ${(_c = result.safe) != null ? _c : "cleared"}`);
    if (this.mode === import_constants.MODE_MANUAL && !result.safe) {
      this.adapter.log.warn(
        `global.manualUrl cleared while global.mode is "manual" \u2014 clients delegating to global will see the setup page`
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
    const coerced = (0, import_coerce.coerceBoolean)(rawValue);
    if (coerced === null) {
      this.adapter.log.warn(`global.enabled rejected \u2014 non-boolean value`);
      await this.adapter.setState("global.enabled", { val: this.enabled, ack: true });
      return;
    }
    this.enabled = coerced;
    await this.adapter.setState("global.enabled", { val: coerced, ack: true });
    this.adapter.log.debug(`global.enabled \u2192 ${coerced} (master switch)`);
  }
  /**
   * Updates the dropdown states (`common.states`) on `global.mode`.
   * The `'manual'` sentinel is added; `'global'` is NOT (would be self-referential).
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states) {
    const merged = (0, import_coerce.buildDropdownStates)({ [import_constants.MODE_MANUAL]: (0, import_i18n.resolveLabel)("manualUrl") }, states);
    const existing = await this.adapter.getObjectAsync("global.mode");
    if (!existing) {
      return;
    }
    if ((0, import_coerce.shallowStatesEqual)(existing.common.states, merged)) {
      return;
    }
    existing.common.states = merged;
    await (0, import_object_repair.replaceObjectPreservingValue)(this.adapter, "global.mode", existing);
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
    const safeMode = mode === import_constants.MODE_MANUAL || (0, import_coerce.coerceSafeUrl)(mode) ? mode : import_constants.MODE_MANUAL;
    const safeManual = manualUrl !== null ? (0, import_coerce.coerceSafeUrl)(manualUrl) : null;
    this.mode = safeMode;
    this.manualUrl = safeManual;
    await this.adapter.setState("global.mode", { val: safeMode, ack: true });
    await this.adapter.setState("global.manualUrl", { val: safeManual != null ? safeManual : "", ack: true });
  }
  // v1.20.0 (F10): private safeGetState war duplicate zu coerce.ts:safeGetState —
  // jetzt direkt importiert.
}
function parseGlobalStateId(fullId, namespace) {
  const parts = (0, import_coerce.parseAdapterStateId)(fullId, namespace, "global.", 1);
  if (!parts) {
    return null;
  }
  const [tail] = parts;
  if (tail === "mode" || tail === "manualUrl" || tail === "enabled") {
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
