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
var external_bridge_exports = {};
__export(external_bridge_exports, {
  CONNECTION_STATUS_SCRIPT: () => CONNECTION_STATUS_SCRIPT
});
module.exports = __toCommonJS(external_bridge_exports);
const CONNECTION_STATUS_SCRIPT = `<script>
(function(){
  function notifyConnected(){
    try {
      var v1Payload = JSON.stringify({id:1,type:"connection-status",payload:{event:"connected"}});
      if (window.externalApp && typeof window.externalApp.externalBus === "function") {
        window.externalApp.externalBus(v1Payload);
        return;
      }
      if (window.externalAppV2 && typeof window.externalAppV2.postMessage === "function") {
        window.externalAppV2.postMessage(JSON.stringify({
          type:"externalBus",
          payload:{id:1,type:"connection-status",payload:{event:"connected"}}
        }));
      }
    } catch (e) { /* silent \u2014 bridge not present, this is a regular browser */ }
  }
  notifyConnected();
  setTimeout(notifyConnected, 500);
  setTimeout(notifyConnected, 2000);
})();
</script>`;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CONNECTION_STATUS_SCRIPT
});
//# sourceMappingURL=external-bridge.js.map
