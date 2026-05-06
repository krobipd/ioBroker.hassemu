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
var coerce_exports = {};
__export(coerce_exports, {
  buildDropdownStates: () => buildDropdownStates,
  coerceBoolean: () => coerceBoolean,
  coerceFiniteNumber: () => coerceFiniteNumber,
  coerceSafeUrl: () => coerceSafeUrl,
  coerceSafeUrlReason: () => coerceSafeUrlReason,
  coerceString: () => coerceString,
  coerceUuid: () => coerceUuid,
  decideGcAction: () => decideGcAction,
  decideLegacyVisMigration: () => decideLegacyVisMigration,
  isNoChoice: () => isNoChoice,
  isPlainObject: () => isPlainObject,
  parseAdapterStateId: () => parseAdapterStateId,
  parseManualUrlWrite: () => parseManualUrlWrite,
  parseModeWrite: () => parseModeWrite,
  safeGetState: () => safeGetState,
  safeStringEqual: () => safeStringEqual
});
module.exports = __toCommonJS(coerce_exports);
var import_node_crypto = __toESM(require("node:crypto"));
function safeStringEqual(a, b) {
  const ah = import_node_crypto.default.createHash("sha256").update(a, "utf8").digest();
  const bh = import_node_crypto.default.createHash("sha256").update(b, "utf8").digest();
  return import_node_crypto.default.timingSafeEqual(ah, bh);
}
function isNoChoice(value) {
  return value === 0 || value === "0" || value === "";
}
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;
function coerceFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && DECIMAL_NUMBER_RE.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function coerceString(value) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}
function coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function coerceUuid(value) {
  if (typeof value !== "string") {
    return null;
  }
  return UUID_REGEX.test(value) ? value.toLowerCase() : null;
}
function parseManualUrlWrite(rawValue) {
  const empty = rawValue === "" || rawValue === null || rawValue === void 0;
  if (empty) {
    return { ok: true, safe: null };
  }
  const safe = coerceSafeUrl(rawValue);
  if (!safe) {
    return { ok: false };
  }
  return { ok: true, safe };
}
function parseModeWrite(rawValue, allowedSentinels) {
  if (isNoChoice(rawValue)) {
    return { kind: "no-choice" };
  }
  if (typeof rawValue !== "string") {
    return { kind: "rejected-non-string" };
  }
  if (allowedSentinels.includes(rawValue)) {
    return { kind: "sentinel", value: rawValue };
  }
  if (rawValue === "global" || rawValue === "manual") {
    return { kind: "rejected-disallowed-sentinel", value: rawValue };
  }
  const safe = coerceSafeUrl(rawValue);
  if (!safe) {
    return { kind: "rejected-unsafe-url", raw: rawValue };
  }
  return { kind: "url", value: safe };
}
function coerceSafeUrl(value) {
  return coerceSafeUrlReason(value).safe;
}
function coerceSafeUrlReason(value) {
  if (typeof value !== "string") {
    return { safe: null, reason: "not-a-string" };
  }
  if (value.length === 0) {
    return { safe: null, reason: "empty" };
  }
  if (value.length > 2048) {
    return { safe: null, reason: "too-long" };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { safe: null, reason: "unparseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: null, reason: `bad-scheme:${url.protocol}` };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { safe: null, reason: "credentials-in-url" };
  }
  return { safe: value, reason: null };
}
async function safeGetState(adapter, id) {
  var _a;
  try {
    return (_a = await adapter.getStateAsync(id)) != null ? _a : null;
  } catch {
    return null;
  }
}
function parseAdapterStateId(fullId, namespace, prefix, expectedParts) {
  const fullPrefix = `${namespace}.${prefix}`;
  if (!fullId.startsWith(fullPrefix)) {
    return null;
  }
  const tail = fullId.substring(fullPrefix.length);
  const parts = tail.split(".");
  if (parts.length !== expectedParts) {
    return null;
  }
  return parts;
}
function decideGcAction(lastSeen, now, ttlMs) {
  const ls = typeof lastSeen === "number" && Number.isFinite(lastSeen) ? lastSeen : 0;
  if (ls === 0) {
    return "seed";
  }
  if (now - ls > ttlMs) {
    return "stale";
  }
  return "keep";
}
function decideLegacyVisMigration(rawValue) {
  if (rawValue === void 0 || rawValue === null || rawValue === "") {
    return { kind: "empty" };
  }
  const safe = coerceSafeUrl(rawValue);
  if (safe) {
    return { kind: "safe-url", safe };
  }
  return { kind: "unsafe-rejected" };
}
function buildDropdownStates(sentinels, urlStates) {
  return { 0: "---", ...sentinels, ...urlStates };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildDropdownStates,
  coerceBoolean,
  coerceFiniteNumber,
  coerceSafeUrl,
  coerceSafeUrlReason,
  coerceString,
  coerceUuid,
  decideGcAction,
  decideLegacyVisMigration,
  isNoChoice,
  isPlainObject,
  parseAdapterStateId,
  parseManualUrlWrite,
  parseModeWrite,
  safeGetState,
  safeStringEqual
});
//# sourceMappingURL=coerce.js.map
