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
var import_external_bridge = require("./external-bridge");
var import_html_shared = require("./html-shared");
var import_i18n = require("./i18n");
const REDIRECT_POLL_INTERVAL_MS = 3e4;
const DOWN_THRESHOLD = 3;
const TARGET_DOWN_THRESHOLD = 2;
function renderRedirectWrapper(target, clientId, language = "en", ip = null, targetReachable = true) {
  const escTarget = (0, import_html_shared.escapeHtml)(target);
  const escJs = (0, import_html_shared.jsStringLiteral)(target);
  const t = (0, import_i18n.makePageTranslator)(language);
  const ipRow = (0, import_html_shared.renderIpRow)(t("pageIpAddress"), ip);
  return `<!DOCTYPE html>
<html lang="${(0, import_html_shared.escapeHtml)((0, import_html_shared.htmlLangFor)(language))}">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${(0, import_html_shared.escapeHtml)(t("pageConnectedTitle"))}</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:1;}
#hassemu-down{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0f172a;color:#f1f5f9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;z-index:10;}
#hassemu-down.visible{display:flex;}
#hassemu-target-down{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0f172a;color:#f1f5f9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;z-index:9;}
#hassemu-target-down.visible{display:flex;}
${(0, import_html_shared.cardTableCss)(
    {
      card: "#hassemu-down .card",
      content: "#hassemu-down .content",
      table: "#hassemu-down table",
      cell: "#hassemu-down"
    },
    { cardBg: "#1e293b", shadow: "0 4px 18px rgba(0,0,0,.35)", border: "#334155", thColor: "#94a3b8", codeBg: "#0f172a" }
  )}
${(0, import_html_shared.cardTableCss)(
    {
      card: "#hassemu-target-down .card",
      content: "#hassemu-target-down .content",
      table: "#hassemu-target-down table",
      cell: "#hassemu-target-down"
    },
    { cardBg: "#1e293b", shadow: "0 4px 18px rgba(0,0,0,.35)", border: "#334155", thColor: "#94a3b8", codeBg: "#0f172a" }
  )}
#hassemu-down .banner{background:#dc2626;color:#fff;padding:1.4rem 1.8rem;}
#hassemu-target-down .banner{background:#d97706;color:#fff;padding:1.4rem 1.8rem;}
#hassemu-down .banner h1,#hassemu-target-down .banner h1{margin:0;font-size:1.4rem;font-weight:600;}
#hassemu-down .banner p,#hassemu-target-down .banner p{margin:.4rem 0 0;font-size:.95rem;opacity:.95;}
#hassemu-down button,#hassemu-target-down button{display:block;width:100%;padding:.9rem 1.2rem;background:#38bdf8;color:#0f172a;border:none;border-radius:6px;font-size:1rem;font-weight:600;cursor:pointer;}
#hassemu-down button:hover,#hassemu-target-down button:hover{background:#0ea5e9;}
#hassemu-target-down td.target-url{word-break:break-all;}
@media (max-width:30rem){#hassemu-down,#hassemu-target-down{padding:0;}#hassemu-down .card,#hassemu-target-down .card{border-radius:0;}#hassemu-down th,#hassemu-target-down th{width:auto;}}
</style>
</head>
<body>
<iframe id="hassemu-iframe" src="${escTarget}"${targetReachable ? "" : ' style="display:none"'} allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
<div id="hassemu-down" role="status" aria-live="polite">
  <div class="card">
    <div class="banner">
      <h1>${(0, import_html_shared.escapeHtml)(t("pageOfflineHeading"))}</h1>
      <p>${(0, import_html_shared.escapeHtml)(t("pageOfflineSubhead"))}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          ${(0, import_html_shared.renderIdRow)(t("pageDeviceId"), clientId)}
          ${ipRow}
        </tbody>
      </table>
      <button type="button" onclick="location.reload()">${(0, import_html_shared.escapeHtml)(t("pageReload"))}</button>
    </div>
  </div>
</div>
<div id="hassemu-target-down"${targetReachable ? "" : ' class="visible"'} role="status" aria-live="polite">
  <div class="card">
    <div class="banner">
      <h1>${(0, import_html_shared.escapeHtml)(t("pageTargetOfflineHeading"))}</h1>
      <p>${(0, import_html_shared.escapeHtml)(t("pageTargetOfflineSubhead"))}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          <tr><th scope="row">${(0, import_html_shared.escapeHtml)(t("pageTargetUrl"))}</th><td class="target-url"><code>${escTarget}</code></td></tr>
          ${(0, import_html_shared.renderIdRow)(t("pageDeviceId"), clientId)}
          ${ipRow}
        </tbody>
      </table>
      <button type="button" onclick="location.reload()">${(0, import_html_shared.escapeHtml)(t("pageReload"))}</button>
    </div>
  </div>
</div>
${import_external_bridge.CONNECTION_STATUS_SCRIPT}
<script>
(function(){
  var current=${escJs};
  var fails=0;
  var THRESHOLD=${DOWN_THRESHOLD};
  var targetFails=${targetReachable ? 0 : TARGET_DOWN_THRESHOLD};
  var TARGET_THRESHOLD=${TARGET_DOWN_THRESHOLD};
  var iframeEl=document.getElementById('hassemu-iframe');
  var downEl=document.getElementById('hassemu-down');
  var targetDownEl=document.getElementById('hassemu-target-down');
  function targetDownVisible(){
    return !!(targetDownEl && targetDownEl.classList.contains('visible'));
  }
  function showDown(){
    if(downEl && !downEl.classList.contains('visible')){
      downEl.classList.add('visible');
      if(iframeEl){iframeEl.style.display='none';}
    }
  }
  function hideDown(){
    if(downEl && downEl.classList.contains('visible')){
      downEl.classList.remove('visible');
      if(iframeEl && !targetDownVisible()){iframeEl.style.display='block';}
    }
  }
  function showTargetDown(){
    if(targetDownEl && !targetDownEl.classList.contains('visible')){
      targetDownEl.classList.add('visible');
      if(iframeEl){iframeEl.style.display='none';}
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
          return;
        }
        if(j&&j.targetReachable===false){
          targetFails++;
          if(targetFails>=TARGET_THRESHOLD){
            showTargetDown();
          }
        }else{
          if(targetDownVisible()){
            location.reload();
            return;
          }
          targetFails=0;
        }
      })
      .catch(function(){
        fails++;
        if(fails>=THRESHOLD){
          showDown();
        }
      });
  },${REDIRECT_POLL_INTERVAL_MS});
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
