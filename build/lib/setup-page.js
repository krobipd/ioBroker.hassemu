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
var setup_page_exports = {};
__export(setup_page_exports, {
  renderSetupPage: () => renderSetupPage
});
module.exports = __toCommonJS(setup_page_exports);
function renderSetupPage(clientId, namespace) {
  const id = escapeHtml(clientId);
  const ns = escapeHtml(namespace);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ioBroker HASS Emulator</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<style>
body{font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#222;background:#f5f5f5;margin:0}
main{max-width:34em;margin:8vh auto;padding:1.6em 1.8em;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{margin:0 0 .7em;font-size:1.15em;font-weight:600}
code{background:#eee;padding:.15em .45em;border-radius:3px;font-size:.95em;white-space:nowrap}
p{margin:.6em 0}
</style>
</head>
<body>
<main>
<h1>Connected</h1>
<p>Device ID: <code>${id}</code></p>
<p>Set a redirect URL under <code>${ns}.clients.${id}.visUrl</code> in the ioBroker admin.</p>
</main>
</body>
</html>`;
}
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  renderSetupPage
});
//# sourceMappingURL=setup-page.js.map
