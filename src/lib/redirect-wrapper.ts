import { escapeHtml } from "./coerce";
import { CONNECTION_STATUS_SCRIPT } from "./external-bridge";
import { htmlLangFor, renderIpRow } from "./html-shared";
import { makePageTranslator } from "./i18n";

/**
 * v1.32.1: Threshold der konsekutiven Poll-Fails ab dem die Down-Seite eingeblendet wird.
 * 3 × 30 s = 1.5 min ohne Antwort von hassemu — toleriert kurze Hiccups, signalisiert echte Outage.
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
  // A `</script>` in `target` would close the inline <script> at the HTML
  // tokenizer level, so JSON.stringify alone is not enough — also escape `<`
  // to its JS unicode escape `<`.
  const escJs = JSON.stringify(target).replace(/</g, "\\u003C");

  // Page copy from admin/i18n via adapter-core I18n, resolved for the passed
  // `language` (English fallback) — single i18n source, no private table here.
  const t = makePageTranslator(language);
  const id = escapeHtml(clientId);
  const ipRow = renderIpRow(t("pageIpAddress"), ip);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(htmlLangFor(language))}">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${escapeHtml(t("pageOfflineTitle"))}</title>
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
      <h1>${escapeHtml(t("pageOfflineHeading"))}</h1>
      <p>${escapeHtml(t("pageOfflineSubhead"))}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          <tr><th scope="row">${escapeHtml(t("pageDeviceId"))}</th><td><code>${id}</code></td></tr>
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
  },30000);
})();
</script>
</body>
</html>`;
}
