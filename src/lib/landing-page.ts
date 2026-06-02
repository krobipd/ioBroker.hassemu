/**
 * Landing page served to a display whose redirect URL is not yet configured.
 *
 * Goal: give the end-user a strong visual "everything is connected, now just
 * pick a URL" signal — big green check, three clear steps, adapter-local copy
 * in the ioBroker system language. Auto-refreshes every 15 s so the display
 * jumps to the real URL the moment the state is written.
 */

import { escapeHtml } from "./coerce";
import { CONNECTION_STATUS_SCRIPT } from "./external-bridge";
import { htmlLangFor, renderIpRow } from "./html-shared";
import { makePageTranslator } from "./i18n";

/**
 * Inline ioBroker brand logo — the power-button "i" inside a ring.
 * Source: github.com/ioBroker organization avatar (the canonical mark used
 * across the project). Two-tone: dark navy outer ring (#1F537E), mid-blue
 * vertical "i" (#2B95C6), white power-button gap at the top.
 *
 * Inlined so the landing page works behind a strict CSP and needs no extra
 * HTTP request.
 */
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="ioBroker">' +
  '<circle cx="50" cy="50" r="42" fill="none" stroke="#1F537E" stroke-width="10"/>' +
  '<rect x="44" y="20" width="12" height="60" rx="2" fill="#2B95C6"/>' +
  '<rect x="44" y="26" width="12" height="6" fill="#ffffff"/>' +
  "</svg>";

/**
 * Render the landing page.
 *
 * @param clientId  Short client id of this display.
 * @param namespace Adapter namespace (e.g. `hassemu.0`).
 * @param language  Desired UI language, resolved from `system.config.language`.
 * @param ip        Optional remote IP of the display, shown next to the ID.
 */
export function renderLandingPage(
  clientId: string,
  namespace: string,
  language: string = "en",
  ip: string | null = null,
): string {
  // All page copy comes from admin/i18n via adapter-core I18n, resolved for the
  // passed `language` (English fallback) — single i18n source, shared with the
  // admin UI + state names. No private translation table here anymore.
  const t = makePageTranslator(language);
  const id = escapeHtml(clientId);
  // Build the datapoint path from the RAW values and escape exactly once below —
  // building it from the already-escaped id/ns would double-escape any special char.
  const datapoint = `${namespace}.clients.${clientId}.mode`;
  // v1.16.0 (E3): Loopback-IPs nicht anzeigen — der End-User sieht sonst
  // „localhost" / „127.0.0.1" / „::1" als sein Display-IP, was bei Proxy-
  // Setups verwirrt (Display sitzt am Reverse-Proxy, nicht am Adapter).
  // Ohne IP-Zeile fällt die Tabellen-Zeile einfach weg, alles andere bleibt.
  const ipLine = renderIpRow(t("pageIpAddress"), ip);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(htmlLangFor(language))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${escapeHtml(t("pageConnectedTitle"))}</title>
<style>
:root {
    --bg: #f5f7fa;
    --card-bg: #ffffff;
    --text: #1f2933;
    --muted: #52606d;
    --ok-bg: #16a34a;
    --ok-bg-soft: #dcfce7;
    --ok-text: #14532d;
    --accent: #0369a1;
    --border: #e4e7eb;
    --code-bg: #eef2f7;
    --shadow: 0 4px 18px rgba(15, 23, 42, 0.08);
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #0f172a;
        --card-bg: #1e293b;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --ok-bg-soft: #052e16;
        --ok-text: #bbf7d0;
        --accent: #38bdf8;
        --border: #334155;
        --code-bg: #0f172a;
        --shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
    }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
}
main {
    width: 100%;
    max-width: 44rem;
    background: var(--card-bg);
    border-radius: 12px;
    box-shadow: var(--shadow);
    overflow: hidden;
}
.banner {
    background: var(--ok-bg);
    color: #ffffff;
    padding: 1.4rem 1.8rem;
    display: flex;
    align-items: center;
    gap: 1rem;
}
.banner .logo {
    width: 3.2rem;
    height: 3.2rem;
    flex-shrink: 0;
    background: #ffffff;
    border-radius: 50%;
    padding: 0.25rem;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}
.banner .logo svg { display: block; width: 100%; height: 100%; }
.banner .check {
    width: 1.8rem;
    height: 1.8rem;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.22);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 1.1rem;
    line-height: 1;
    font-weight: 700;
}
.banner h1 {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 600;
    letter-spacing: 0.01em;
}
.banner p {
    margin: 0.15rem 0 0;
    font-size: 0.95rem;
    opacity: 0.95;
}
.content {
    padding: 1.6rem 1.8rem 1.3rem;
}
.info {
    margin: 0 0 1.4rem;
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95rem;
}
.info th, .info td {
    padding: 0.55rem 0.7rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
}
.info th {
    font-weight: 500;
    color: var(--muted);
    white-space: nowrap;
    width: 9rem;
}
.info tr:last-child th, .info tr:last-child td {
    border-bottom: none;
}
.info code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--code-bg);
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    font-size: 0.9em;
}
.setup h2 {
    margin: 0 0 0.6rem;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--accent);
}
.setup > p {
    margin: 0 0 0.9rem;
    color: var(--muted);
}
.steps {
    margin: 0;
    padding-left: 1.4rem;
    color: var(--text);
}
.steps li {
    margin: 0.5rem 0;
}
.steps code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--code-bg);
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    font-size: 0.88em;
    word-break: break-all;
}
footer {
    padding: 0.9rem 1.8rem;
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
    color: var(--muted);
    text-align: center;
}
footer .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-left: 0.6rem;
    color: var(--accent);
    font-weight: 500;
}
footer .brand svg { width: 0.95rem; height: 0.95rem; display: block; }
@media (max-width: 30rem) {
    body { padding: 0; }
    main { border-radius: 0; box-shadow: none; height: 100%; }
    .banner { padding: 1.1rem 1.2rem; }
    .banner h1 { font-size: 1.2rem; }
    .content { padding: 1.2rem 1.2rem 1rem; }
    .info th { width: auto; }
    footer { padding: 0.9rem 1.2rem; }
}
</style>
</head>
<body>
<main>
    <div class="banner" role="status" aria-live="polite">
        <div class="logo" aria-hidden="true">${LOGO_SVG}</div>
        <div class="check" aria-hidden="true">✓</div>
        <div>
            <h1>${escapeHtml(t("pageConnectedHeading"))}</h1>
            <p>${escapeHtml(t("pageConnectedSubhead"))}</p>
        </div>
    </div>
    <div class="content">
        <table class="info">
            <tbody>
                <tr>
                    <th scope="row">${escapeHtml(t("pageDeviceId"))}</th>
                    <td><code>${id}</code></td>
                </tr>
                ${ipLine}
            </tbody>
        </table>
        <section class="setup">
            <h2>${escapeHtml(t("pageSetupTitle"))}</h2>
            <p>${escapeHtml(t("pageSetupIntro"))}</p>
            <ol class="steps">
                <li>${escapeHtml(t("pageStep1"))}</li>
                <li>${escapeHtml(t("pageStep2"))} <code>${escapeHtml(datapoint)}</code></li>
                <li>${escapeHtml(t("pageStep3"))}</li>
            </ol>
        </section>
    </div>
    <footer>
        ${escapeHtml(t("pageAutoRefresh"))}
        <span class="brand" aria-hidden="true">${LOGO_SVG} ioBroker</span>
    </footer>
</main>
${CONNECTION_STATUS_SCRIPT}
</body>
</html>`;
}

// v1.32.0: `escapeHtml` ist nach `coerce.ts` ausgelagert (shared helper für
// landing-page, auth-page, redirect-wrapper).
