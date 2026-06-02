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
var i18n_exports = {};
__export(i18n_exports, {
  makePageTranslator: () => makePageTranslator,
  resolveLabel: () => resolveLabel,
  tName: () => tName,
  tPage: () => tPage
});
module.exports = __toCommonJS(i18n_exports);
var import_adapter_core = require("@iobroker/adapter-core");
function tName(key) {
  return import_adapter_core.I18n.getTranslatedObject(key);
}
function resolveLabel(key) {
  return import_adapter_core.I18n.translate(key);
}
function tPage(key, language) {
  var _a, _b;
  const obj = import_adapter_core.I18n.getTranslatedObject(key);
  if (typeof obj === "string") {
    return obj;
  }
  const rec = obj;
  return (_b = (_a = rec[language]) != null ? _a : rec.en) != null ? _b : key;
}
function makePageTranslator(language) {
  return (key) => tPage(key, language);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  makePageTranslator,
  resolveLabel,
  tName,
  tPage
});
//# sourceMappingURL=i18n.js.map
