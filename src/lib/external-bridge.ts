/**
 * HA Companion App bridge — sends the two messages the HA frontend sends to the apps, the way
 * its `fireExternalBusMessage` does (home-assistant/frontend
 * src/external_app/external_messaging.ts:623-636 at tag 20261028.5; `fireMessage` numbers each
 * message, 546-558): V2
 * (`window.externalAppV2.postMessage`, JSON string in an `externalBus` envelope), else V1
 * (`window.externalApp.externalBus`, JSON string), else iOS
 * (`window.webkit.messageHandlers.externalBus.postMessage` with the OBJECT, not a string).
 *
 * 1. `connection-status: connected` (id 1) — the frontend sends it once its WebSocket is open.
 *    The apps show a loader over every page until they see it: Android shows "Unable to connect
 *    to Home Assistant." after 10 s (FrontendViewModel.kt:91 and 838-848 at android tag
 *    2026.11.1); iOS lifts its full-screen loader only on it or after a 10-s watchdog
 *    (HomeAssistantViewModel.swift:23 and 405-445 at release/2026.10.3/2026.3322).
 * 2. `frontend/loaded` (id 2) — the frontend sends it once its launch screen is gone
 *    (partial-panel-resolver.ts:292-299 at 20261028.5). For a server of 2026.8.0 or newer both
 *    apps keep their own loader up until it arrives (Android FrontendViewModel.kt:1273-1290 —
 *    after 10 s it shows the page anyway; iOS HomeAssistantViewModel.swift:189-196 and
 *    WebViewExternalMessageHandler.swift:100-101). Since hassemu reports 2026.8.0 (constants.ts
 *    `HA_VERSION`), every page has to send it: the landing page and the cards at once, the
 *    dashboard wrapper when its iframe has loaded or after `FRONTEND_LOADED_CAP_MS`.
 *
 * The display loads hassemu's own pages, not the HA frontend, so hassemu sends both messages
 * from the page itself. A page asks for `loaded` through `window.hassemuFrontendLoaded()`;
 * `connected` always goes first, in the same attempt — the frontend's order. Each message goes
 * out at most once per page (iOS latches `loaded` until the next navigation,
 * HomeAssistantViewModel.swift:298-301 and 332-335). Attempts run at 0 / 500 / 2000 ms (a bridge
 * that attaches late) and on every `hassemuFrontendLoaded()` call. In a regular browser tab no
 * bridge exists and nothing happens.
 *
 * The dashboard's iframe can fire its `load` before this script has run (the iframe comes first
 * in the page). Its `onload` therefore sets `window.hassemuIframeLoaded`; this script reads the
 * flag when it starts.
 *
 * NOTE — onboarding WebView vs. runtime WebView. The onboarding flow uses `HAWebViewClient`
 * (error mapping) but **not** `FrontendJsBridge` — so `window.externalApp` /
 * `window.externalAppV2` are NOT injected on `/auth/authorize`. auth-page.ts therefore carries no
 * bridge script; the call there would be inert.
 *
 * The constant is a `<script>` block inlined verbatim before `</body>`.
 */
export const APP_BRIDGE_SCRIPT = `<script>
(function(){
  var connectedSent = false;
  var loadedWanted = false;
  var loadedSent = false;
  function post(msg){
    try {
      if (window.externalAppV2 && typeof window.externalAppV2.postMessage === "function") {
        window.externalAppV2.postMessage(JSON.stringify({type:"externalBus",payload:msg}));
        return true;
      }
      if (window.externalApp && typeof window.externalApp.externalBus === "function") {
        window.externalApp.externalBus(JSON.stringify(msg));
        return true;
      }
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.externalBus
          && typeof window.webkit.messageHandlers.externalBus.postMessage === "function") {
        window.webkit.messageHandlers.externalBus.postMessage(msg);
        return true;
      }
    } catch (e) { /* silent — no bridge, this is a regular browser */ }
    return false;
  }
  function flush(){
    if (!connectedSent) {
      connectedSent = post({id:1,type:"connection-status",payload:{event:"connected"}});
    }
    if (connectedSent && loadedWanted && !loadedSent) {
      loadedSent = post({id:2,type:"frontend/loaded"});
    }
  }
  window.hassemuFrontendLoaded = function(){
    loadedWanted = true;
    flush();
  };
  if (window.hassemuIframeLoaded) {
    loadedWanted = true;
  }
  flush();
  window.setTimeout(flush, 500);
  window.setTimeout(flush, 2000);
})();
</script>`;

/**
 * Inline call for a page that is complete as soon as it is parsed (landing page): asks the bridge
 * for `frontend/loaded` right away.
 */
export const FRONTEND_LOADED_NOW_SCRIPT = `<script>window.hassemuFrontendLoaded();</script>`;
