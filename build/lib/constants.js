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
  COOKIE_MAX_AGE_S: () => COOKIE_MAX_AGE_S,
  DEFAULT_SERVICE_NAME: () => DEFAULT_SERVICE_NAME,
  DNS_NEGATIVE_CACHE_MS: () => DNS_NEGATIVE_CACHE_MS,
  DNS_REVERSE_TIMEOUT_MS: () => DNS_REVERSE_TIMEOUT_MS,
  HA_VERSION: () => HA_VERSION,
  LASTSEEN_FLUSH_INTERVAL_MS: () => LASTSEEN_FLUSH_INTERVAL_MS,
  LOGIN_SCHEMA: () => LOGIN_SCHEMA,
  MODE_GLOBAL: () => MODE_GLOBAL,
  MODE_MANUAL: () => MODE_MANUAL,
  NEW_CLIENT_BURST_CAP: () => NEW_CLIENT_BURST_CAP,
  NEW_CLIENT_BURST_WARN_THRESHOLD: () => NEW_CLIENT_BURST_WARN_THRESHOLD,
  NEW_CLIENT_THROTTLE_PER_HOUR: () => NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS: () => NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S: () => OAUTH_ACCESS_TOKEN_TTL_S,
  REQUEST_ERROR_COOLDOWN_CAP: () => REQUEST_ERROR_COOLDOWN_CAP,
  REQUEST_ERROR_COOLDOWN_MS: () => REQUEST_ERROR_COOLDOWN_MS,
  SESSIONS_CAP: () => SESSIONS_CAP,
  SESSION_TTL_MS: () => SESSION_TTL_MS,
  STALE_CLIENT_TTL_MS: () => STALE_CLIENT_TTL_MS,
  TARGET_HEALTH_CACHE_CAP: () => TARGET_HEALTH_CACHE_CAP,
  TARGET_PROBE_CACHE_MS: () => TARGET_PROBE_CACHE_MS,
  TARGET_PROBE_TIMEOUT_MS: () => TARGET_PROBE_TIMEOUT_MS,
  WEBHOOK_REGISTRATIONS_CAP: () => WEBHOOK_REGISTRATIONS_CAP,
  WS_AUTH_TIMEOUT_MS: () => WS_AUTH_TIMEOUT_MS,
  WS_HEARTBEAT_INTERVAL_MS: () => WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_PAYLOAD_BYTES: () => WS_MAX_PAYLOAD_BYTES
});
module.exports = __toCommonJS(constants_exports);
const HA_VERSION = "2026.4.0";
const DEFAULT_SERVICE_NAME = "ioBroker";
const SESSION_TTL_MS = 10 * 60 * 1e3;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1e3;
const OAUTH_ACCESS_TOKEN_TTL_S = 30 * 60;
const WS_AUTH_TIMEOUT_MS = 5 * 1e3;
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1e3;
const DNS_REVERSE_TIMEOUT_MS = 5 * 1e3;
const DNS_NEGATIVE_CACHE_MS = 60 * 60 * 1e3;
const STALE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
const LASTSEEN_FLUSH_INTERVAL_MS = 60 * 60 * 1e3;
const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60;
const SESSIONS_CAP = 100;
const WEBHOOK_REGISTRATIONS_CAP = 200;
const REQUEST_ERROR_COOLDOWN_MS = 60 * 1e3;
const REQUEST_ERROR_COOLDOWN_CAP = 200;
const NEW_CLIENT_BURST_CAP = 200;
const NEW_CLIENT_THROTTLE_PER_HOUR = 30;
const NEW_CLIENT_WINDOW_MS = 60 * 60 * 1e3;
const NEW_CLIENT_BURST_WARN_THRESHOLD = 3;
const MODE_GLOBAL = "global";
const MODE_MANUAL = "manual";
const TARGET_PROBE_TIMEOUT_MS = 4e3;
const TARGET_PROBE_CACHE_MS = 25e3;
const TARGET_HEALTH_CACHE_CAP = 50;
const LOGIN_SCHEMA = [
  { name: "username", required: true, type: "string" },
  { name: "password", required: true, type: "string" }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLEANUP_INTERVAL_MS,
  COOKIE_MAX_AGE_S,
  DEFAULT_SERVICE_NAME,
  DNS_NEGATIVE_CACHE_MS,
  DNS_REVERSE_TIMEOUT_MS,
  HA_VERSION,
  LASTSEEN_FLUSH_INTERVAL_MS,
  LOGIN_SCHEMA,
  MODE_GLOBAL,
  MODE_MANUAL,
  NEW_CLIENT_BURST_CAP,
  NEW_CLIENT_BURST_WARN_THRESHOLD,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S,
  REQUEST_ERROR_COOLDOWN_CAP,
  REQUEST_ERROR_COOLDOWN_MS,
  SESSIONS_CAP,
  SESSION_TTL_MS,
  STALE_CLIENT_TTL_MS,
  TARGET_HEALTH_CACHE_CAP,
  TARGET_PROBE_CACHE_MS,
  TARGET_PROBE_TIMEOUT_MS,
  WEBHOOK_REGISTRATIONS_CAP,
  WS_AUTH_TIMEOUT_MS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_PAYLOAD_BYTES
});
//# sourceMappingURL=constants.js.map
