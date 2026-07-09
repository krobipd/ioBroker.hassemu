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
  cardTableCss: () => cardTableCss,
  escapeHtml: () => escapeHtml,
  htmlLangFor: () => htmlLangFor,
  isLoopbackIp: () => isLoopbackIp,
  jsStringLiteral: () => jsStringLiteral,
  renderIdRow: () => renderIdRow,
  renderIpRow: () => renderIpRow
});
module.exports = __toCommonJS(html_shared_exports);
function escapeHtml(s) {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
function jsStringLiteral(value) {
  return JSON.stringify(value).replace(/</g, "\\u003C");
}
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
  return `<tr><th scope="row">${escapeHtml(ipLabel)}</th><td>${escapeHtml(trimmedIp)}</td></tr>`;
}
function renderIdRow(idLabel, id) {
  return `<tr><th scope="row">${escapeHtml(idLabel)}</th><td><code>${escapeHtml(id)}</code></td></tr>`;
}
function cardTableCss(sel, theme) {
  return `${sel.card} {
    width: 100%;
    max-width: 44rem;
    background: ${theme.cardBg};
    border-radius: 12px;
    box-shadow: ${theme.shadow};
    overflow: hidden;
}
${sel.content} {
    padding: 1.6rem 1.8rem 1.3rem;
}
${sel.table} {
    margin: 0 0 1.4rem;
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95rem;
}
${sel.cell} th, ${sel.cell} td {
    padding: 0.55rem 0.7rem;
    text-align: left;
    border-bottom: 1px solid ${theme.border};
}
${sel.cell} tr:last-child th, ${sel.cell} tr:last-child td {
    border-bottom: none;
}
${sel.cell} th {
    font-weight: 500;
    color: ${theme.thColor};
    white-space: nowrap;
    width: 9rem;
}
${sel.cell} code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: ${theme.codeBg};
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    font-size: 0.9em;
}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SUPPORTED_LANGS,
  cardTableCss,
  escapeHtml,
  htmlLangFor,
  isLoopbackIp,
  jsStringLiteral,
  renderIdRow,
  renderIpRow
});
//# sourceMappingURL=html-shared.js.map
