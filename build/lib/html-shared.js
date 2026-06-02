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
var html_shared_exports = {};
__export(html_shared_exports, {
  SUPPORTED_LANGS: () => SUPPORTED_LANGS,
  htmlLangFor: () => htmlLangFor,
  isLoopbackIp: () => isLoopbackIp,
  renderIpRow: () => renderIpRow
});
module.exports = __toCommonJS(html_shared_exports);
var import_coerce = require("./coerce");
const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
function htmlLangFor(language) {
  if (!SUPPORTED_LANGS.includes(language)) {
    return "en";
  }
  return language === "zh-cn" ? "zh-CN" : language;
}
function isLoopbackIp(ip) {
  return ip === "" || ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0" || ip.startsWith("127.");
}
function renderIpRow(ipLabel, ip) {
  var _a;
  const trimmedIp = (_a = ip == null ? void 0 : ip.trim()) != null ? _a : "";
  if (isLoopbackIp(trimmedIp)) {
    return "";
  }
  return `<tr><th scope="row">${(0, import_coerce.escapeHtml)(ipLabel)}</th><td>${(0, import_coerce.escapeHtml)(trimmedIp)}</td></tr>`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SUPPORTED_LANGS,
  htmlLangFor,
  isLoopbackIp,
  renderIpRow
});
//# sourceMappingURL=html-shared.js.map
