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
var coerce_exports = {};
__export(coerce_exports, {
  coerceBoolean: () => coerceBoolean,
  coerceFiniteNumber: () => coerceFiniteNumber,
  coerceSafeUrl: () => coerceSafeUrl,
  coerceString: () => coerceString,
  coerceUuid: () => coerceUuid,
  isPlainObject: () => isPlainObject
});
module.exports = __toCommonJS(coerce_exports);
function coerceFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
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
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function coerceUuid(value, strictV4 = false) {
  if (typeof value !== "string") {
    return null;
  }
  const regex = strictV4 ? UUID_V4_REGEX : UUID_ANY_REGEX;
  return regex.test(value) ? value.toLowerCase() : null;
}
function coerceSafeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return null;
  }
  return value;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  coerceBoolean,
  coerceFiniteNumber,
  coerceSafeUrl,
  coerceString,
  coerceUuid,
  isPlainObject
});
//# sourceMappingURL=coerce.js.map
