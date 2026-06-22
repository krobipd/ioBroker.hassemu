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
var redirect_wrapper_exports = {};
__export(redirect_wrapper_exports, {
  renderRedirectWrapper: () => renderRedirectWrapper
});
module.exports = __toCommonJS(redirect_wrapper_exports);
var import_coerce = require("./coerce");
var import_external_bridge = require("./external-bridge");
var import_html_shared = require("./html-shared");
var import_i18n = require("./i18n");
const DOWN_THRESHOLD = 3;
function renderRedirectWrapper(target, clientId, language = "en", ip = null) {
  const escTarget = (0, import_coerce.escapeHtml)(target);
  const escJs = JSON.stringify(target).replace(/</g, "\\u003C");
  const t = (0, import_i18n.makePageTranslator)(language);
  const id = (0, import_coerce.escapeHtml)(clientId);
  const ipRow = (0, import_html_shared.renderIpRow)(t("pageIpAddress"), ip);
  return `<!DOCTYPE html>
<html lang="${(0, import_coerce.escapeHtml)((0, import_html_shared.htmlLangFor)(language))}">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${(0, import_coerce.escapeHtml)(t("pageOfflineTitle"))}</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:1;}
#hassemu-down{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0f172a;color:#f1f5f9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;z-index:10;}
#hassemu-down[hidden]{display:none;}
#hassemu-down.visible{display:flex;}
#hassemu-down .card{width:100%;max-width:44rem;background:#1e293b;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.35);}
#hassemu-down .banner{background:#dc2626;color:#fff;padding:1.4rem 1.8rem;}
#hassemu-down .banner h1{margin:0;font-size:1.4rem;font-weight:600;}
#hassemu-down .banner p{margin:.4rem 0 0;font-size:.95rem;opacity:.95;}
#hassemu-down .content{padding:1.6rem 1.8rem 1.3rem;}
#hassemu-down table{width:100%;border-collapse:collapse;font-size:.95rem;margin-bottom:1.4rem;}
#hassemu-down th,#hassemu-down td{padding:.55rem .7rem;text-align:left;border-bottom:1px solid #334155;}
#hassemu-down tr:last-child th,#hassemu-down tr:last-child td{border-bottom:none;}
#hassemu-down th{font-weight:500;color:#94a3b8;width:9rem;white-space:nowrap;}
#hassemu-down code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f172a;padding:.15rem .45rem;border-radius:4px;font-size:.9em;}
#hassemu-down button{display:block;width:100%;padding:.9rem 1.2rem;background:#38bdf8;color:#0f172a;border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer;}
#hassemu-down button:hover{background:#0ea5e9;}
@media (max-width:30rem){#hassemu-down{padding:0;}#hassemu-down .card{border-radius:0;}#hassemu-down th{width:auto;}}
</style>
</head>
<body>
<iframe id="hassemu-iframe" src="${escTarget}" allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
<div id="hassemu-down" role="status" aria-live="polite">
  <div class="card">
    <div class="banner">
      <h1>${(0, import_coerce.escapeHtml)(t("pageOfflineHeading"))}</h1>
      <p>${(0, import_coerce.escapeHtml)(t("pageOfflineSubhead"))}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          <tr><th scope="row">${(0, import_coerce.escapeHtml)(t("pageDeviceId"))}</th><td><code>${id}</code></td></tr>
          ${ipRow}
        </tbody>
      </table>
      <button type="button" onclick="location.reload()">${(0, import_coerce.escapeHtml)(t("pageReload"))}</button>
    </div>
  </div>
</div>
${import_external_bridge.CONNECTION_STATUS_SCRIPT}
<script>
(function(){
  var current=${escJs};
  var fails=0;
  var THRESHOLD=${DOWN_THRESHOLD};
  var iframeEl=document.getElementById('hassemu-iframe');
  var downEl=document.getElementById('hassemu-down');
  function showDown(){
    if(downEl && !downEl.classList.contains('visible')){
      downEl.classList.add('visible');
      if(iframeEl){iframeEl.style.display='none';}
    }
  }
  function hideDown(){
    if(downEl && downEl.classList.contains('visible')){
      downEl.classList.remove('visible');
      if(iframeEl){iframeEl.style.display='block';}
    }
  }
  window.setInterval(function(){
    fetch('/api/redirect_check',{cache:'no-store',credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){
        fails=0;
        hideDown();
        if(j&&typeof j.target==='string'&&j.target&&j.target!==current){
          location.reload();
        }
      })
      .catch(function(){
        fails++;
        if(fails>=THRESHOLD){
          showDown();
        }
      });
  },30000);
})();
</script>
</body>
</html>`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  renderRedirectWrapper
});
//# sourceMappingURL=redirect-wrapper.js.map
