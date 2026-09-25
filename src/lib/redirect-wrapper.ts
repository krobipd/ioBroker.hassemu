import { CONNECTION_STATUS_SCRIPT } from "./external-bridge";
import { cardTableCss, escapeHtml, htmlLangFor, jsStringLiteral, renderIdRow, renderIpRow } from "./html-shared";
import { makePageTranslator } from "./i18n";

/** Poll interval (ms) for the display's `/api/redirect_check`. v1.37.0 (L16): named so the down-detection time (DOWN_THRESHOLD × this) isn't split between a constant and a magic number. */
const REDIRECT_POLL_INTERVAL_MS = 30_000;

/**
 * v1.32.1: number of consecutive failed polls after which the down page is shown.
 * DOWN_THRESHOLD × REDIRECT_POLL_INTERVAL_MS (3 × 30 s = 1.5 min) without an answer from hassemu —
 * tolerates short hiccups, signals a real outage.
 */
const DOWN_THRESHOLD = 3;

/**
 * v1.39.0: number of consecutive `targetReachable:false` answers after which the
 * target-down card is shown (2 × 30 s ≈ 1 min). Shorter than {@link DOWN_THRESHOLD},
 * because here hassemu itself answers — the verdict comes from the server-side probe,
 * not from a shaky client network.
 */
const TARGET_DOWN_THRESHOLD = 2;

/** What one poll tick decides to do. */
export type PollAction = "reload" | "show-target-down" | "none";

/** Inputs of one poll tick — everything the decision needs, nothing else. */
export interface PollInput {
  /** The target this page was rendered for. */
  current: string;
  /** Parsed JSON body of `/api/redirect_check` (untrusted — any shape). */
  body: unknown;
  /** Consecutive `targetReachable:false` answers so far. */
  targetFails: number;
  /** Threshold at which the target-down card appears. */
  targetThreshold: number;
  /** Whether the target-down card is currently on screen. */
  targetDownVisible: boolean;
}

/**
 * Decide what one `/api/redirect_check` answer means. Pure — no DOM, no timers,
 * no closure over anything — so it can be unit-tested directly AND serialised into
 * the inline `<script>` of the page (see {@link renderRedirectWrapper}).
 *
 * It must not reference ANY binding of this module (a constant, a helper, an import):
 * the page runs a `toString()` copy without the module around it, so such a reference
 * compiles, passes tsc and every module-side test, and throws a ReferenceError on the
 * display — which the poll loop swallows, and the display never reloads again. Every
 * input comes in through `input`; the test table runs the serialised copy for that.
 *
 * Before v1.43.0 this logic lived only as a string inside the page template and was
 * therefore never EXECUTED by a test — only matched against with `expect(html).to.include(…)`.
 * That is how the null-target defect below survived five audits.
 *
 * The target comparison treats "no target any more" as a change. The earlier
 * `typeof j.target === 'string' && j.target && j.target !== current` never fired for
 * `target: null`, which is exactly what the server answers once the user picks `---`
 * or switches the master off (`bulkSetMode("0")` → resolver returns null): the display
 * kept showing the dashboard it had, forever, unless the amber target-down card happened
 * to be up (whose recovery branch reloads by accident). After a reload the display lands
 * on the landing page, whose own `<meta http-equiv="refresh" content="15">` brings it
 * back as soon as a URL is set again — no second mechanism needed.
 *
 * A body without a `target` key at all (a proxy error page, a truncated answer) is NOT
 * treated as "target gone" — otherwise a malformed response would reload the display
 * every poll interval forever.
 *
 * @param input The tick's inputs.
 * @returns The action to run and the new consecutive-failure count.
 */
export function decidePollAction(input: PollInput): { action: PollAction; targetFails: number } {
  const body = input.body as { target?: unknown; targetReachable?: unknown } | null;
  const isObject = !!body && typeof body === "object";
  if (isObject && "target" in body) {
    const raw = body.target;
    const next = typeof raw === "string" && raw ? raw : null;
    if (next !== input.current) {
      return { action: "reload", targetFails: input.targetFails };
    }
  }
  if (isObject && body.targetReachable === false) {
    const fails = input.targetFails + 1;
    return { action: fails >= input.targetThreshold ? "show-target-down" : "none", targetFails: fails };
  }
  if (input.targetDownVisible) {
    return { action: "reload", targetFails: 0 };
  }
  return { action: "none", targetFails: 0 };
}

/**
 * v1.39.0: shared color tokens for BOTH overlay cards (hassemu-down + target-down).
 * One source — the cards must not drift apart visually; only the banner color
 * differs (red vs. amber) and stays at the respective `.banner` rule.
 */
const OVERLAY_CARD_THEME = {
  cardBg: "#1e293b",
  shadow: "0 4px 18px rgba(0,0,0,.35)",
  border: "#334155",
  thColor: "#94a3b8",
  codeBg: "#0f172a",
} as const;

/**
 * HTML wrapper instead of a 302 redirect (A3 / v1.7.0). The display loads the HTML once,
 * shows the target in an iframe and polls `/api/redirect_check` every 30 s. When the
 * target changes (a user edit) it calls `location.reload()`.
 *
 * v1.32.1: an extra down page (`#hassemu-down` div, hidden by default) is shown when the
 * poll endpoint fails `DOWN_THRESHOLD = 3` times in a row (~1.5 min). The inline JS
 * reaches the browser with the wrapper before hassemu goes down and lives on there — so
 * the down page can be rendered while hassemu no longer answers. On recovery (the first
 * successful answer) the down page is hidden again, no reload. Plus an explicit
 * "Reload now" button as a touch-friendly fallback (Shelly Wall Display + HA Companion
 * WebView).
 *
 * Limitation: a display that boots COLD while hassemu is down cannot load this HTML from
 * hassemu — the browser shows a connection error. A service-worker cache would solve
 * that and is deliberately not implemented (the Wall Display WebView's cache behaviour
 * is unclear, cache invalidation is a problem of its own). In practice this covers the
 * usual case of a display that has been running before.
 *
 * v1.39.0: a second card `#hassemu-target-down` for "hassemu runs, but the redirect
 * target does not answer". The verdict comes from the server: the `/api/redirect_check`
 * response also carries `targetReachable` (a probe with a cache in `target-health.ts` —
 * cross-origin, the browser itself may not know whether the iframe loaded). Two `false`
 * in a row → the card instead of a black area; the first `true` afterwards does a full
 * `location.reload()` so the iframe loads fresh (an iframe that once ran into nothing
 * never tries again by itself). The probe state is handed over at render time (the
 * `targetReachable` parameter): a display that starts COLD while the target is down sees
 * the card at once — not black for two poll rounds first.
 *
 * @param target          Target URL from the resolver.
 * @param clientId        Short id of this display (shown on the down page).
 * @param language        ioBroker system language for the down page (English fallback).
 * @param ip              Optional address of the display (shown on the down page).
 * @param targetReachable Probe state of the target at render time (false → card visible at once).
 */
export function renderRedirectWrapper(
  target: string,
  clientId: string,
  language: string = "en",
  ip: string | null = null,
  targetReachable: boolean = true,
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
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;top:var(--app-safe-area-inset-top,0px);left:var(--app-safe-area-inset-left,0px);width:calc(100vw - var(--app-safe-area-inset-left,0px) - var(--app-safe-area-inset-right,0px));height:calc(100vh - var(--app-safe-area-inset-top,0px) - var(--app-safe-area-inset-bottom,0px));background:#000;z-index:1;}
#hassemu-down{display:none;position:fixed;top:0;left:0;right:0;bottom:0;top:var(--app-safe-area-inset-top,0px);left:var(--app-safe-area-inset-left,0px);right:var(--app-safe-area-inset-right,0px);bottom:var(--app-safe-area-inset-bottom,0px);background:#0f172a;color:#f1f5f9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;z-index:10;}
#hassemu-down.visible{display:flex;}
#hassemu-target-down{display:none;position:fixed;top:0;left:0;right:0;bottom:0;top:var(--app-safe-area-inset-top,0px);left:var(--app-safe-area-inset-left,0px);right:var(--app-safe-area-inset-right,0px);bottom:var(--app-safe-area-inset-bottom,0px);background:#0f172a;color:#f1f5f9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;align-items:center;justify-content:center;padding:1.5rem;box-sizing:border-box;z-index:9;}
#hassemu-target-down.visible{display:flex;}
${cardTableCss(
  {
    card: "#hassemu-down .card",
    content: "#hassemu-down .content",
    table: "#hassemu-down table",
    cell: "#hassemu-down",
  },
  OVERLAY_CARD_THEME,
)}
${cardTableCss(
  {
    card: "#hassemu-target-down .card",
    content: "#hassemu-target-down .content",
    table: "#hassemu-target-down table",
    cell: "#hassemu-target-down",
  },
  OVERLAY_CARD_THEME,
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
<div id="hassemu-target-down"${targetReachable ? "" : ' class="visible"'} role="status" aria-live="polite">
  <div class="card">
    <div class="banner">
      <h1>${escapeHtml(t("pageTargetOfflineHeading"))}</h1>
      <p>${escapeHtml(t("pageTargetOfflineSubhead"))}</p>
    </div>
    <div class="content">
      <table>
        <tbody>
          <tr><th scope="row">${escapeHtml(t("pageTargetUrl"))}</th><td class="target-url"><code>${escTarget}</code></td></tr>
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
  // The decision itself is the SAME function the unit tests run — serialised here
  // instead of rewritten as a string, so the page can never drift from what is tested.
  var decide=${decidePollAction.toString()};
  window.setInterval(function(){
    fetch('/api/redirect_check',{cache:'no-store',credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){
        fails=0;
        hideDown();
        var d=decide({current:current,body:j,targetFails:targetFails,targetThreshold:TARGET_THRESHOLD,targetDownVisible:targetDownVisible()});
        targetFails=d.targetFails;
        if(d.action==='reload'){
          location.reload();
          return;
        }
        if(d.action==='show-target-down'){
          showTargetDown();
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
