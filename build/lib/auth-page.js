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
var auth_page_exports = {};
__export(auth_page_exports, {
  buildRedirectUrl: () => buildRedirectUrl,
  renderAuthorizeError: () => renderAuthorizeError,
  renderAuthorizeForm: () => renderAuthorizeForm,
  renderAuthorizeRedirect: () => renderAuthorizeRedirect
});
module.exports = __toCommonJS(auth_page_exports);
var import_html_shared = require("./html-shared");
var import_i18n = require("./i18n");
function buildRedirectUrl(redirectUri, code, state) {
  let url = redirectUri;
  if (!url.includes("?")) {
    url += "?";
  } else if (!url.endsWith("&") && !url.endsWith("?")) {
    url += "&";
  }
  url += `code=${encodeURIComponent(code)}`;
  if (state) {
    url += `&state=${encodeURIComponent(state)}`;
  }
  return url;
}
const STYLE = `
html,body{margin:0;padding:0;height:100%;background:#111;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.card{max-width:380px;margin:64px auto;padding:32px;background:#1c1c1c;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.5);}
h1{margin:0 0 24px;font-size:24px;font-weight:500;text-align:center;color:#03a9f4;}
.subtitle{color:#888;font-size:14px;text-align:center;margin:-16px 0 24px;}
.err{background:#3a1a1a;color:#ff8a80;padding:12px;border-radius:4px;margin-bottom:16px;font-size:14px;}
input{display:block;width:100%;padding:12px;margin:8px 0 16px;background:#2a2a2a;border:1px solid #444;color:#fff;border-radius:4px;font-size:16px;box-sizing:border-box;}
input:focus{outline:none;border-color:#03a9f4;}
button{display:block;width:100%;padding:14px;background:#03a9f4;color:#fff;border:none;border-radius:4px;font-size:16px;cursor:pointer;}
button:hover{background:#039be5;}
.loading{text-align:center;color:#888;padding:16px;}
`.trim();
function htmlShell(opts) {
  return `<!DOCTYPE html>
<html lang="${(0, import_html_shared.escapeHtml)((0, import_html_shared.htmlLangFor)(opts.lang))}">
<head>
<meta charset="utf-8">
${opts.headExtra}
<title>${opts.title}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card">
${opts.cardInner}
</div>${opts.bodyExtra ? `
${opts.bodyExtra}` : ""}
</body>
</html>`;
}
function renderAuthorizeRedirect(target) {
  const a = (0, import_html_shared.escapeHtml)(target);
  const j = (0, import_html_shared.jsStringLiteral)(target);
  return htmlShell({
    // Momentary auto-redirect page (sub-second) — kept in English on purpose; only the
    // login form + error page (which a user actually reads) are localized. L7.
    lang: "en",
    title: "Home Assistant",
    headExtra: `<meta http-equiv="refresh" content="0; URL=${a}">`,
    cardInner: `<h1>Home Assistant</h1>
<p class="loading">Signing in\u2026</p>`,
    bodyExtra: `<script>(function(){document.location.assign(${j});})();</script>`
  });
}
function renderAuthorizeForm(params, errorMessage, language = "en") {
  const t = (0, import_i18n.makePageTranslator)(language);
  const cid = (0, import_html_shared.escapeHtml)(params.clientId);
  const ru = (0, import_html_shared.escapeHtml)(params.redirectUri);
  const st = params.state ? (0, import_html_shared.escapeHtml)(params.state) : "";
  const errBlock = errorMessage ? `<div class="err">${(0, import_html_shared.escapeHtml)(errorMessage)}</div>` : "";
  return htmlShell({
    lang: language,
    // `<h1>Home Assistant</h1>` + the brand title stay hardcoded — the HA Companion app
    // verifies the server identity by the "Home Assistant" name; only the human-readable
    // copy below is localized. L7 (v1.38.0).
    title: "Home Assistant \u2014 Sign In",
    headExtra: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    cardInner: `<h1>Home Assistant</h1>
<p class="subtitle">${(0, import_html_shared.escapeHtml)(t("authSubtitle"))}</p>
${errBlock}
<form method="POST" action="/auth/authorize" autocomplete="off">
<input type="hidden" name="response_type" value="code">
<input type="hidden" name="client_id" value="${cid}">
<input type="hidden" name="redirect_uri" value="${ru}">
<input type="hidden" name="state" value="${st}">
<input type="text" name="username" placeholder="${(0, import_html_shared.escapeHtml)(t("username"))}" autofocus required>
<input type="password" name="password" placeholder="${(0, import_html_shared.escapeHtml)(t("password"))}" required>
<button type="submit">${(0, import_html_shared.escapeHtml)(t("authSignIn"))}</button>
</form>`
  });
}
function renderAuthorizeError(reason, detail, language = "en") {
  const t = (0, import_i18n.makePageTranslator)(language);
  return htmlShell({
    lang: language,
    title: `Home Assistant \u2014 ${(0, import_html_shared.escapeHtml)(reason)}`,
    headExtra: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    // Localized title + a user-readable hint; the technical `detail`/`reason` stay for
    // support diagnostics. L7 (v1.38.0).
    cardInner: `<h1>${(0, import_html_shared.escapeHtml)(t("authErrorTitle"))}</h1>
<p class="subtitle">${(0, import_html_shared.escapeHtml)(t("authErrorHint"))}</p>
<div class="err">${(0, import_html_shared.escapeHtml)(detail)}</div>
<p class="subtitle">${(0, import_html_shared.escapeHtml)(reason)}</p>`
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildRedirectUrl,
  renderAuthorizeError,
  renderAuthorizeForm,
  renderAuthorizeRedirect
});
//# sourceMappingURL=auth-page.js.map
