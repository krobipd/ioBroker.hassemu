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
var constants_exports = {};
__export(constants_exports, {
  CLEANUP_INTERVAL_MS: () => CLEANUP_INTERVAL_MS,
  HA_VERSION: () => HA_VERSION,
  LOGIN_SCHEMA: () => LOGIN_SCHEMA,
  SESSION_TTL_MS: () => SESSION_TTL_MS
});
module.exports = __toCommonJS(constants_exports);
const HA_VERSION = "2026.3.1";
const SESSION_TTL_MS = 10 * 60 * 1e3;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1e3;
const LOGIN_SCHEMA = [
  { name: "username", required: true, type: "string" },
  { name: "password", required: true, type: "string" }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLEANUP_INTERVAL_MS,
  HA_VERSION,
  LOGIN_SCHEMA,
  SESSION_TTL_MS
});
//# sourceMappingURL=constants.js.map
