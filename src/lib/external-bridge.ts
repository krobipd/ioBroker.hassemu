/**
 * HA Companion App bridge — emits a `connection-status: connected` message the way the HA
 * frontend's `fireExternalBusMessage` does (home-assistant/frontend
 * src/external_app/external_messaging.ts:528-540 at tag 20260826.7): V2
 * (`window.externalAppV2.postMessage`, JSON string in an `externalBus` envelope), else V1
 * (`window.externalApp.externalBus`, JSON string), else iOS
 * (`window.webkit.messageHandlers.externalBus.postMessage` with the OBJECT, not a string).
 *
 * The apps show a loader over every page until they see this message: Android shows the
 * "Unable to connect to Home Assistant." popup after 10 s; the iOS app (release/2026.9.2,
 * HomeAssistantViewModel.swift:22 and 356-367) lifts its full-screen loader only on it or
 * after a 10-s watchdog, and iOS 2026.8.0 had no watchdog at all — without the iOS branch an
 * iPad panel stayed behind the HA logo (audit 2026-09-25, U1). Real HA's frontend fires the
 * message after its WebSocket opens — but the display loads hassemu's iframe wrapper (not the
 * HA frontend SPA), so we send it directly from the loaded HTML. (hassemu's own minimal
 * `/api/websocket` only serves the Companion App's registration, not this runtime WebView.)
 *
 * Three call sites at 0 / 500 / 2000 ms cover a slow bridge attach; the `sent` latch makes it
 * ONE message per page (before, it went out up to three times). In a regular browser tab no
 * bridge exists and nothing happens.
 *
 * NOTE — onboarding WebView vs. runtime WebView. The Onboarding flow uses
 * `HAWebViewClient` (error mapping) but **not** `FrontendJsBridge` — so
 * `window.externalApp` / `window.externalAppV2` are NOT injected on
 * `/auth/authorize`. We therefore don't emit this script from auth-page.ts;
 * the bridge call there would be inert. Sources verified:
 *   - home-assistant/android FrontendMessageHandler.kt (parses message)
 *   - home-assistant/android FrontendJsBridge.kt (V1+V2 registration)
 *   - home-assistant/frontend src/external_app/external_messaging.ts
 *     (fires on the `connection-status` DOM event)
 *
 * The constant is intentionally a `<script>` block that can be inlined into
 * any HTML response — caller pastes it verbatim before `</body>`.
 */
export const CONNECTION_STATUS_SCRIPT = `<script>
(function(){
  var sent = false;
  function notifyConnected(){
    if (sent) { return; }
    var msg = {id:1,type:"connection-status",payload:{event:"connected"}};
    try {
      if (window.externalAppV2 && typeof window.externalAppV2.postMessage === "function") {
        window.externalAppV2.postMessage(JSON.stringify({type:"externalBus",payload:msg}));
        sent = true;
      } else if (window.externalApp && typeof window.externalApp.externalBus === "function") {
        window.externalApp.externalBus(JSON.stringify(msg));
        sent = true;
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.externalBus
                 && typeof window.webkit.messageHandlers.externalBus.postMessage === "function") {
        window.webkit.messageHandlers.externalBus.postMessage(msg);
        sent = true;
      }
    } catch (e) { /* silent — no bridge, this is a regular browser */ }
  }
  notifyConnected();
  window.setTimeout(notifyConnected, 500);
  window.setTimeout(notifyConnected, 2000);
})();
</script>`;
