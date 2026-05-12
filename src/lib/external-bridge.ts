/**
 * HA Companion App bridge — emits a `connection-status: connected` message
 * via either V1 (`window.externalApp.externalBus`) or V2
 * (`window.externalAppV2.postMessage`).
 *
 * The HA Companion App's runtime WebView (FrontendViewModel) starts a 10 s
 * timer when a page begins loading and shows the "Verbindung zu Home
 * Assistant nicht möglich" popup if it doesn't see this message. Real HA's
 * frontend fires the message after the WebSocket opens — hassemu doesn't
 * implement WebSocket, so we send the message directly from the loaded HTML.
 *
 * Three call sites at 0 / 500 / 2000 ms cover slow bridge attach in some
 * Companion App builds. After the first successful V1 invocation we early-
 * exit. If neither bridge is present (regular browser tab), the try/catch
 * swallows the no-op.
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
    } catch (e) { /* silent — bridge not present, this is a regular browser */ }
  }
  notifyConnected();
  setTimeout(notifyConnected, 500);
  setTimeout(notifyConnected, 2000);
})();
</script>`;
