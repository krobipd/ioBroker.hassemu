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
function renderRedirectWrapper(target) {
  const escAttr = (0, import_coerce.escapeHtml)(target);
  const escJs = JSON.stringify(target);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>ioBroker HASS Emulator</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
/* display:block kills the inline-baseline gap below the iframe; position:fixed +
   100vw/100vh nimmt das Display sicher voll aus, auch wenn ein WebView die
   100%-Berechnung subpixel-falsch macht (Shelly Wall Display zeigte sonst
   einen schwarzen Streifen rechts/unten). */
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;}
</style>
</head>
<body>
<iframe src="${escAttr}" allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
${import_external_bridge.CONNECTION_STATUS_SCRIPT}
<script>
(function(){
  var current=${escJs};
  setInterval(function(){
    fetch('/api/redirect_check',{cache:'no-store',credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&typeof j.target==='string'&&j.target&&j.target!==current){
          location.reload();
        }
      })
      .catch(function(){/* silent \u2014 broker hiccup, retry next tick */});
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
