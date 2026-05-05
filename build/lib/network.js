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
var network_exports = {};
__export(network_exports, {
  generateClientId: () => generateClientId,
  getLocalIp: () => getLocalIp,
  isWildcardBind: () => isWildcardBind
});
module.exports = __toCommonJS(network_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_os = __toESM(require("node:os"));
function getLocalIp() {
  const interfaces = import_node_os.default.networkInterfaces();
  let ipv6Fallback = null;
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) {
      continue;
    }
    for (const iface of ifaces) {
      if (iface.internal) {
        continue;
      }
      if (iface.family === "IPv4") {
        return iface.address;
      }
      if (iface.family === "IPv6" && !ipv6Fallback) {
        ipv6Fallback = iface.address;
      }
    }
  }
  return ipv6Fallback != null ? ipv6Fallback : "127.0.0.1";
}
function isWildcardBind(bindAddress) {
  if (!bindAddress) {
    return true;
  }
  return bindAddress === "0.0.0.0" || bindAddress === "::";
}
function generateClientId() {
  return import_node_crypto.default.randomBytes(3).toString("hex");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  generateClientId,
  getLocalIp,
  isWildcardBind
});
//# sourceMappingURL=network.js.map
