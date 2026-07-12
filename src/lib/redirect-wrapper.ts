import { CONNECTION_STATUS_SCRIPT } from "./external-bridge";
import { cardTableCss, escapeHtml, htmlLangFor, jsStringLiteral, renderIdRow, renderIpRow } from "./html-shared";
import { makePageTranslator } from "./i18n";

/** Poll interval (ms) for the display's `/api/redirect_check`. v1.37.0 (L16): named so the down-detection time (DOWN_THRESHOLD × this) isn't split between a constant and a magic number. */
const REDIRECT_POLL_INTERVAL_MS = 30_000;

/**
 * v1.32.1: Threshold der konsekutiven Poll-Fails ab dem die Down-Seite eingeblendet wird.
 * DOWN_THRESHOLD × REDIRECT_POLL_INTERVAL_MS (3 × 30 s = 1.5 min) ohne Antwort von hassemu —
 * toleriert kurze Hiccups, signalisiert echte Outage.
 */
const DOWN_THRESHOLD = 3;

/**
 * HTML-Wrapper statt 302-Redirect (A3 / v1.7.0). Display lädt das HTML einmal,
 * sieht den Target im iframe, polled `/api/redirect_check` alle 30s. Bei
 * Target-Wechsel (User edit) macht es `location.reload()`.
 *
 * v1.32.1: zusätzliche Down-Seite (`#hassemu-down`-Div, hidden by default) wird
 * eingeblendet wenn der Polling-Endpoint `DOWN_THRESHOLD = 3` mal hintereinander
 * fehlschlägt (~1.5 min). Inline-JS kommt vor dem Adapter-Down vom hassemu-
 * Wrapper im Browser an und lebt dort weiter — die Down-Seite kann also auch
 * gerendert werden wenn hassemu nicht mehr antwortet. Bei Recovery (erste
 * erfolgreiche Antwort) wird die Down-Seite wieder ausgeblendet, kein reload.
 * Plus expliziter „Reload now"-Button als Touch-fähiger Fallback (Shelly Wall
 * Display + HA Companion WebView).
 *
 * Limitierung: ein Display der KALT bootet während hassemu down ist, kann
 * dieses HTML nicht von hassemu laden — Browser zeigt Connection-Error.
 * Service-Worker-Cache wäre die Lösung, ist hier bewusst nicht implementiert
 * (Wall-Display-WebView-Cache-Verhalten unklar, Cache-Invalidation eigenes
 * Problem). Praxis: 95% der Realität (Display lief vorher mal) deckt diese
 * Mechanik ab.
 *
 * @param target    Vom Resolver gelieferte Ziel-URL.
 * @param clientId  Short id of this display (für Anzeige auf der Down-Seite).
 * @param language  ioBroker-Systemsprache für die Down-Seite (EN-Fallback).
 * @param ip        Optional IP-Adresse des Displays (für Anzeige auf der Down-Seite).
 */
export function renderRedirectWrapper(
  target: string,
  clientId: string,
  language: string = "en",
  ip: string | null = null,
): string {
  const escTarget = escapeHtml(target);
  // M8: shared jsStringLiteral escapes a `</script>` breakout (JSON.stringify
  // alone would let it close the inline <script> at the HTML tokenizer level).
  const escJs = jsStringLiteral(target);

  // Page copy from admin/i18n via adapter-core I18n, resolved for the passed
  // `language` (English fallback) — single i18n source, no private table here.
  const t = makePageTranslator(language);
  // L36: the page <title> uses the neutral "Connected" string for the normal
  // (dashboard-in-iframe) state; the down card that can replace the iframe carries
  // its own visible "hassemu offline" banner, so a permanent "offline" tab title
  // was misleading during normal operation.
  const ipRow = renderIpRow(t("pageIpAddress"), ip);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(htmlLangFor(language))}">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(t("pageConnectedTitle"))}</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:1;}
#hassemu-down{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0f172a;color:#f1f5f9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;z-index:10;}
#hassemu-down.visible{display:flex;}
${cardTableCss(
  {
    card: "#hassemu-down .card",
    content: "#hassemu-down .content",
    table: "#hassemu-down table",
    cell: "#hassemu-down",
  },
  { cardBg: "#1e293b", shadow: "0 4px 18px rgba(0,0,0,.35)", border: "#334155", thColor: "#94a3b8", codeBg: "#0f172a" },
)}
#hassemu-down .banner{background:#dc2626;color:#fff;padding:1.4rem 1.8rem;}
#hassemu-down .banner h1{margin:0;font-size:1.4rem;font-weight:600;}
#hassemu-down .banner p{margin:.4rem 0 0;font-size:.95rem;opacity:.95;}
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
      <h1>${escapeHtml(t("pageOfflineHeading"))}</h1>
      <p>${escapeHtml(t("pageOfflineSubhead"))}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          ${renderIdRow(t("pageDeviceId"), clientId)}
          ${ipRow}
        </tbody>
      </table>
      <button type="button" onclick="location.reload()">${escapeHtml(t("pageReload"))}</button>
    </div>
  </div>
</div>
${CONNECTION_STATUS_SCRIPT}
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
  },${REDIRECT_POLL_INTERVAL_MS});
})();
</script>
</body>
</html>`;
}
