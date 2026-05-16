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
const DOWN_STRINGS = {
  en: {
    htmlLang: "en",
    pageTitle: "hassemu offline \xB7 ioBroker",
    heading: "hassemu offline",
    subhead: "The page above is the last view this display received. As soon as hassemu is reachable again, the display updates by itself.",
    deviceIdLabel: "Device ID",
    ipLabel: "IP address",
    reloadButton: "Reload now"
  },
  de: {
    htmlLang: "de",
    pageTitle: "hassemu offline \xB7 ioBroker",
    heading: "hassemu offline",
    subhead: "Die Seite oben ist die letzte Ansicht, die das Display erhalten hat. Sobald hassemu wieder erreichbar ist, aktualisiert sich die Anzeige automatisch.",
    deviceIdLabel: "Ger\xE4te-ID",
    ipLabel: "IP-Adresse",
    reloadButton: "Jetzt neu laden"
  },
  ru: {
    htmlLang: "ru",
    pageTitle: "hassemu \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \xB7 ioBroker",
    heading: "hassemu \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D",
    subhead: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0432\u044B\u0448\u0435 \u2014 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u0432\u0438\u0434, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u043F\u043E\u043B\u0443\u0447\u0438\u043B \u0434\u0438\u0441\u043F\u043B\u0435\u0439. \u041A\u0430\u043A \u0442\u043E\u043B\u044C\u043A\u043E hassemu \u0441\u043D\u043E\u0432\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u044D\u043A\u0440\u0430\u043D \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.",
    deviceIdLabel: "ID \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430",
    ipLabel: "IP-\u0430\u0434\u0440\u0435\u0441",
    reloadButton: "\u041F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C"
  },
  pt: {
    htmlLang: "pt",
    pageTitle: "hassemu offline \xB7 ioBroker",
    heading: "hassemu offline",
    subhead: "A p\xE1gina acima \xE9 a \xFAltima visualiza\xE7\xE3o que este ecr\xE3 recebeu. Assim que o hassemu voltar a estar dispon\xEDvel, o ecr\xE3 atualiza-se automaticamente.",
    deviceIdLabel: "ID do dispositivo",
    ipLabel: "Endere\xE7o IP",
    reloadButton: "Recarregar"
  },
  nl: {
    htmlLang: "nl",
    pageTitle: "hassemu offline \xB7 ioBroker",
    heading: "hassemu offline",
    subhead: "De pagina hierboven is de laatste weergave die dit display heeft ontvangen. Zodra hassemu weer bereikbaar is, wordt het scherm automatisch bijgewerkt.",
    deviceIdLabel: "Apparaat-ID",
    ipLabel: "IP-adres",
    reloadButton: "Opnieuw laden"
  },
  fr: {
    htmlLang: "fr",
    pageTitle: "hassemu hors ligne \xB7 ioBroker",
    heading: "hassemu hors ligne",
    subhead: "La page ci-dessus est la derni\xE8re vue re\xE7ue par cet \xE9cran. D\xE8s que hassemu est de nouveau accessible, l'\xE9cran se met \xE0 jour automatiquement.",
    deviceIdLabel: "Identifiant de l'appareil",
    ipLabel: "Adresse IP",
    reloadButton: "Recharger"
  },
  it: {
    htmlLang: "it",
    pageTitle: "hassemu offline \xB7 ioBroker",
    heading: "hassemu offline",
    subhead: "La pagina sopra \xE8 l\u2019ultima vista ricevuta dal display. Appena hassemu sar\xE0 nuovamente raggiungibile, la schermata si aggiorner\xE0 automaticamente.",
    deviceIdLabel: "ID dispositivo",
    ipLabel: "Indirizzo IP",
    reloadButton: "Ricarica"
  },
  es: {
    htmlLang: "es",
    pageTitle: "hassemu sin conexi\xF3n \xB7 ioBroker",
    heading: "hassemu sin conexi\xF3n",
    subhead: "La p\xE1gina de arriba es la \xFAltima vista que recibi\xF3 esta pantalla. En cuanto hassemu vuelva a estar disponible, la pantalla se actualizar\xE1 autom\xE1ticamente.",
    deviceIdLabel: "ID del dispositivo",
    ipLabel: "Direcci\xF3n IP",
    reloadButton: "Recargar"
  },
  pl: {
    htmlLang: "pl",
    pageTitle: "hassemu offline \xB7 ioBroker",
    heading: "hassemu offline",
    subhead: "Strona powy\u017Cej to ostatni widok otrzymany przez ten wy\u015Bwietlacz. Gdy hassemu zn\xF3w b\u0119dzie dost\u0119pny, ekran od\u015Bwie\u017Cy si\u0119 sam.",
    deviceIdLabel: "ID urz\u0105dzenia",
    ipLabel: "Adres IP",
    reloadButton: "Za\u0142aduj ponownie"
  },
  uk: {
    htmlLang: "uk",
    pageTitle: "hassemu \u043E\u0444\u043B\u0430\u0439\u043D \xB7 ioBroker",
    heading: "hassemu \u043E\u0444\u043B\u0430\u0439\u043D",
    subhead: "\u0421\u0442\u043E\u0440\u0456\u043D\u043A\u0430 \u0432\u0438\u0449\u0435 \u2014 \u043E\u0441\u0442\u0430\u043D\u043D\u0456\u0439 \u0432\u0438\u0433\u043B\u044F\u0434, \u044F\u043A\u0438\u0439 \u043E\u0442\u0440\u0438\u043C\u0430\u0432 \u0446\u0435\u0439 \u0434\u0438\u0441\u043F\u043B\u0435\u0439. \u0429\u043E\u0439\u043D\u043E hassemu \u0437\u043D\u043E\u0432\u0443 \u0431\u0443\u0434\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u043C, \u0435\u043A\u0440\u0430\u043D \u043E\u043D\u043E\u0432\u0438\u0442\u044C\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E.",
    deviceIdLabel: "ID \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E",
    ipLabel: "IP-\u0430\u0434\u0440\u0435\u0441\u0430",
    reloadButton: "\u041F\u0435\u0440\u0435\u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0438\u0442\u0438"
  },
  "zh-cn": {
    htmlLang: "zh-CN",
    pageTitle: "hassemu \u79BB\u7EBF \xB7 ioBroker",
    heading: "hassemu \u79BB\u7EBF",
    subhead: "\u4E0A\u65B9\u9875\u9762\u662F\u6B64\u663E\u793A\u5668\u6536\u5230\u7684\u6700\u540E\u4E00\u6B21\u89C6\u56FE\u3002hassemu \u91CD\u65B0\u53EF\u7528\u540E\uFF0C\u5C4F\u5E55\u4F1A\u81EA\u52A8\u5237\u65B0\u3002",
    deviceIdLabel: "\u8BBE\u5907 ID",
    ipLabel: "IP \u5730\u5740",
    reloadButton: "\u7ACB\u5373\u91CD\u65B0\u52A0\u8F7D"
  }
};
const DOWN_THRESHOLD = 3;
function renderRedirectWrapper(target, clientId, namespace, language = "en", ip = null) {
  var _a, _b;
  const escAttr = (0, import_coerce.escapeHtml)(target);
  const escJs = JSON.stringify(target);
  const s = (_a = DOWN_STRINGS[language]) != null ? _a : DOWN_STRINGS.en;
  const id = (0, import_coerce.escapeHtml)(clientId);
  const ns = (0, import_coerce.escapeHtml)(namespace);
  const trimmedIp = (_b = ip == null ? void 0 : ip.trim()) != null ? _b : "";
  const isLoopback = trimmedIp === "" || trimmedIp === "127.0.0.1" || trimmedIp === "::1" || trimmedIp === "0.0.0.0" || trimmedIp.startsWith("127.");
  const ipRow = isLoopback ? "" : `<tr><th scope="row">${(0, import_coerce.escapeHtml)(s.ipLabel)}</th><td>${(0, import_coerce.escapeHtml)(trimmedIp)}</td></tr>`;
  void ns;
  return `<!DOCTYPE html>
<html lang="${(0, import_coerce.escapeHtml)(s.htmlLang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${(0, import_coerce.escapeHtml)(s.pageTitle)}</title>
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
<iframe id="hassemu-iframe" src="${escAttr}" allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
<div id="hassemu-down" role="status" aria-live="polite">
  <div class="card">
    <div class="banner">
      <h1>${(0, import_coerce.escapeHtml)(s.heading)}</h1>
      <p>${(0, import_coerce.escapeHtml)(s.subhead)}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          <tr><th scope="row">${(0, import_coerce.escapeHtml)(s.deviceIdLabel)}</th><td><code>${id}</code></td></tr>
          ${ipRow}
        </tbody>
      </table>
      <button type="button" onclick="location.reload()">${(0, import_coerce.escapeHtml)(s.reloadButton)}</button>
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
  setInterval(function(){
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
