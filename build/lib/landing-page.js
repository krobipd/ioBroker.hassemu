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
var landing_page_exports = {};
__export(landing_page_exports, {
  renderLandingPage: () => renderLandingPage
});
module.exports = __toCommonJS(landing_page_exports);
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="ioBroker"><circle cx="50" cy="50" r="42" fill="none" stroke="#1F537E" stroke-width="10"/><rect x="44" y="20" width="12" height="60" rx="2" fill="#2B95C6"/><rect x="44" y="26" width="12" height="6" fill="#ffffff"/></svg>';
const STRINGS = {
  en: {
    htmlLang: "en",
    pageTitle: "Connected \xB7 ioBroker",
    heading: "Display connected",
    subhead: "This display is linked to ioBroker. Choose a redirect URL to finish setup.",
    deviceIdLabel: "Device ID",
    ipLabel: "IP address",
    setupTitle: "Finish setup",
    setupIntro: "Set the URL that this display should open on next refresh:",
    step1: "Open the ioBroker admin and switch to the Objects view.",
    step2: "Go to this datapoint:",
    step3: "Enter the URL you want to show here (VIS project, Grafana, dashboard, \u2026).",
    autoRefresh: "This page refreshes automatically every 15 seconds."
  },
  de: {
    htmlLang: "de",
    pageTitle: "Verbunden \xB7 ioBroker",
    heading: "Display verbunden",
    subhead: "Dieses Display ist mit ioBroker verbunden. W\xE4hle noch eine Weiterleitungs-URL aus.",
    deviceIdLabel: "Ger\xE4te-ID",
    ipLabel: "IP-Adresse",
    setupTitle: "Einrichtung abschlie\xDFen",
    setupIntro: "Lege fest, welche URL das Display beim n\xE4chsten Refresh \xF6ffnen soll:",
    step1: '\xD6ffne im ioBroker-Admin die Ansicht \u201EObjekte".',
    step2: "Navigiere zu diesem Datenpunkt:",
    step3: "Trage hier die gew\xFCnschte URL ein (VIS-Projekt, Grafana, Dashboard, \u2026).",
    autoRefresh: "Diese Seite aktualisiert sich automatisch alle 15 Sekunden."
  },
  ru: {
    htmlLang: "ru",
    pageTitle: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E \xB7 ioBroker",
    heading: "\u0414\u0438\u0441\u043F\u043B\u0435\u0439 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D",
    subhead: "\u042D\u0442\u043E\u0442 \u0434\u0438\u0441\u043F\u043B\u0435\u0439 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u043A ioBroker. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 URL \u0434\u043B\u044F \u043F\u0435\u0440\u0435\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F.",
    deviceIdLabel: "ID \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430",
    ipLabel: "IP-\u0430\u0434\u0440\u0435\u0441",
    setupTitle: "\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
    setupIntro: "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 URL, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u0434\u0438\u0441\u043F\u043B\u0435\u0439 \u043E\u0442\u043A\u0440\u043E\u0435\u0442 \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0438:",
    step1: "\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0430\u0434\u043C\u0438\u043D\u043A\u0443 ioBroker \u0438 \u043F\u0435\u0440\u0435\u0439\u0434\u0438\u0442\u0435 \u0432 \u0440\u0430\u0437\u0434\u0435\u043B \xAB\u041E\u0431\u044A\u0435\u043A\u0442\u044B\xBB.",
    step2: "\u041F\u0435\u0440\u0435\u0439\u0434\u0438\u0442\u0435 \u043A \u044D\u0442\u043E\u043C\u0443 \u0434\u0430\u0442\u0430\u043F\u0443\u043D\u043A\u0442\u0443:",
    step3: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u0443\u0436\u043D\u044B\u0439 URL (\u043F\u0440\u043E\u0435\u043A\u0442 VIS, Grafana, \u0434\u0430\u0448\u0431\u043E\u0440\u0434 \u0438 \u0442. \u0434.).",
    autoRefresh: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043E\u0431\u043D\u043E\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u043A\u0430\u0436\u0434\u044B\u0435 15 \u0441\u0435\u043A\u0443\u043D\u0434."
  },
  pt: {
    htmlLang: "pt",
    pageTitle: "Conectado \xB7 ioBroker",
    heading: "Display conectado",
    subhead: "Este display est\xE1 conectado ao ioBroker. Escolha um URL de redirecionamento.",
    deviceIdLabel: "ID do dispositivo",
    ipLabel: "Endere\xE7o IP",
    setupTitle: "Concluir configura\xE7\xE3o",
    setupIntro: "Defina o URL que este display deve abrir na pr\xF3xima atualiza\xE7\xE3o:",
    step1: "Abra o admin do ioBroker e mude para a vis\xE3o de Objetos.",
    step2: "Navegue at\xE9 este datapoint:",
    step3: "Insira o URL desejado (projeto VIS, Grafana, dashboard, \u2026).",
    autoRefresh: "Esta p\xE1gina atualiza automaticamente a cada 15 segundos."
  },
  nl: {
    htmlLang: "nl",
    pageTitle: "Verbonden \xB7 ioBroker",
    heading: "Display verbonden",
    subhead: "Dit display is met ioBroker verbonden. Kies een redirect-URL om de setup af te ronden.",
    deviceIdLabel: "Apparaat-ID",
    ipLabel: "IP-adres",
    setupTitle: "Setup afronden",
    setupIntro: "Stel de URL in die dit display bij de volgende refresh moet openen:",
    step1: "Open de ioBroker-admin en ga naar de Objects-weergave.",
    step2: "Navigeer naar dit datapoint:",
    step3: "Voer hier de gewenste URL in (VIS-project, Grafana, dashboard, \u2026).",
    autoRefresh: "Deze pagina vernieuwt zich automatisch elke 15 seconden."
  },
  fr: {
    htmlLang: "fr",
    pageTitle: "Connect\xE9 \xB7 ioBroker",
    heading: "\xC9cran connect\xE9",
    subhead: "Cet \xE9cran est reli\xE9 \xE0 ioBroker. Choisissez l'URL de redirection pour terminer la configuration.",
    deviceIdLabel: "Identifiant de l'appareil",
    ipLabel: "Adresse IP",
    setupTitle: "Finaliser la configuration",
    setupIntro: "Indiquez l'URL que cet \xE9cran doit ouvrir \xE0 la prochaine actualisation :",
    step1: "Ouvrez l'admin ioBroker et passez \xE0 la vue Objets.",
    step2: "Allez sur ce datapoint :",
    step3: "Saisissez ici l'URL souhait\xE9e (projet VIS, Grafana, tableau de bord, \u2026).",
    autoRefresh: "Cette page se rafra\xEEchit automatiquement toutes les 15 secondes."
  },
  it: {
    htmlLang: "it",
    pageTitle: "Connesso \xB7 ioBroker",
    heading: "Display connesso",
    subhead: "Questo display \xE8 collegato a ioBroker. Scegli un URL di reindirizzamento per completare la configurazione.",
    deviceIdLabel: "ID dispositivo",
    ipLabel: "Indirizzo IP",
    setupTitle: "Completa la configurazione",
    setupIntro: "Imposta l'URL che il display deve aprire al prossimo aggiornamento:",
    step1: "Apri l'admin di ioBroker e passa alla vista Oggetti.",
    step2: "Vai a questo datapoint:",
    step3: "Inserisci qui l'URL desiderato (progetto VIS, Grafana, dashboard, \u2026).",
    autoRefresh: "Questa pagina si aggiorna automaticamente ogni 15 secondi."
  },
  es: {
    htmlLang: "es",
    pageTitle: "Conectado \xB7 ioBroker",
    heading: "Pantalla conectada",
    subhead: "Esta pantalla est\xE1 vinculada a ioBroker. Elige una URL de redirecci\xF3n para terminar la configuraci\xF3n.",
    deviceIdLabel: "ID del dispositivo",
    ipLabel: "Direcci\xF3n IP",
    setupTitle: "Completar configuraci\xF3n",
    setupIntro: "Indica la URL que esta pantalla abrir\xE1 en la pr\xF3xima actualizaci\xF3n:",
    step1: "Abre el admin de ioBroker y cambia a la vista Objetos.",
    step2: "Navega hasta este datapoint:",
    step3: "Introduce aqu\xED la URL deseada (proyecto VIS, Grafana, panel, \u2026).",
    autoRefresh: "Esta p\xE1gina se actualiza autom\xE1ticamente cada 15 segundos."
  },
  pl: {
    htmlLang: "pl",
    pageTitle: "Po\u0142\u0105czono \xB7 ioBroker",
    heading: "Wy\u015Bwietlacz po\u0142\u0105czony",
    subhead: "Ten wy\u015Bwietlacz jest po\u0142\u0105czony z ioBrokerem. Wybierz adres URL przekierowania.",
    deviceIdLabel: "ID urz\u0105dzenia",
    ipLabel: "Adres IP",
    setupTitle: "Zako\u0144cz konfiguracj\u0119",
    setupIntro: "Ustaw URL, kt\xF3ry ma otwiera\u0107 ten wy\u015Bwietlacz przy nast\u0119pnym od\u015Bwie\u017Ceniu:",
    step1: "Otw\xF3rz panel ioBroker i przejd\u017A do widoku Obiekt\xF3w.",
    step2: "Przejd\u017A do tego datapointu:",
    step3: "Wpisz tutaj \u017C\u0105dany URL (projekt VIS, Grafana, dashboard, \u2026).",
    autoRefresh: "Ta strona od\u015Bwie\u017Ca si\u0119 automatycznie co 15 sekund."
  },
  uk: {
    htmlLang: "uk",
    pageTitle: "\u0417'\u0454\u0434\u043D\u0430\u043D\u043E \xB7 ioBroker",
    heading: "\u0414\u0438\u0441\u043F\u043B\u0435\u0439 \u043F\u0456\u0434'\u0454\u0434\u043D\u0430\u043D\u043E",
    subhead: "\u0426\u0435\u0439 \u0434\u0438\u0441\u043F\u043B\u0435\u0439 \u0437'\u0454\u0434\u043D\u0430\u043D\u043E \u0437 ioBroker. \u041E\u0431\u0435\u0440\u0456\u0442\u044C URL \u0434\u043B\u044F \u043F\u0435\u0440\u0435\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044F.",
    deviceIdLabel: "ID \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E",
    ipLabel: "IP-\u0430\u0434\u0440\u0435\u0441\u0430",
    setupTitle: "\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u0438 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F",
    setupIntro: "\u0412\u043A\u0430\u0436\u0456\u0442\u044C URL, \u044F\u043A\u0438\u0439 \u0434\u0438\u0441\u043F\u043B\u0435\u0439 \u0432\u0456\u0434\u043A\u0440\u0438\u0454 \u043F\u0440\u0438 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u043C\u0443 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u0456:",
    step1: "\u0412\u0456\u0434\u043A\u0440\u0438\u0439\u0442\u0435 \u0430\u0434\u043C\u0456\u043D ioBroker \u0456 \u043F\u0435\u0440\u0435\u0439\u0434\u0456\u0442\u044C \u0434\u043E \u043F\u0435\u0440\u0435\u0433\u043B\u044F\u0434\u0443 \xAB\u041E\u0431'\u0454\u043A\u0442\u0438\xBB.",
    step2: "\u041F\u0435\u0440\u0435\u0439\u0434\u0456\u0442\u044C \u0434\u043E \u0446\u044C\u043E\u0433\u043E \u0434\u0430\u0442\u0430\u043F\u043E\u0456\u043D\u0442\u0430:",
    step3: "\u0412\u0432\u0435\u0434\u0456\u0442\u044C \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0438\u0439 URL (\u043F\u0440\u043E\u0454\u043A\u0442 VIS, Grafana, \u0434\u0430\u0448\u0431\u043E\u0440\u0434, \u2026).",
    autoRefresh: "\u0426\u044F \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0430 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u043E\u043D\u043E\u0432\u043B\u044E\u0454\u0442\u044C\u0441\u044F \u043A\u043E\u0436\u043D\u0456 15 \u0441\u0435\u043A\u0443\u043D\u0434."
  },
  "zh-cn": {
    htmlLang: "zh-CN",
    pageTitle: "\u5DF2\u8FDE\u63A5 \xB7 ioBroker",
    heading: "\u663E\u793A\u5668\u5DF2\u8FDE\u63A5",
    subhead: "\u6B64\u663E\u793A\u5668\u5DF2\u8FDE\u63A5\u5230 ioBroker\u3002\u8BF7\u9009\u62E9\u8DF3\u8F6C URL \u4EE5\u5B8C\u6210\u8BBE\u7F6E\u3002",
    deviceIdLabel: "\u8BBE\u5907 ID",
    ipLabel: "IP \u5730\u5740",
    setupTitle: "\u5B8C\u6210\u8BBE\u7F6E",
    setupIntro: "\u8BBE\u7F6E\u6B64\u663E\u793A\u5668\u4E0B\u6B21\u5237\u65B0\u65F6\u8981\u6253\u5F00\u7684 URL\uFF1A",
    step1: "\u6253\u5F00 ioBroker \u7BA1\u7406\u754C\u9762\u5E76\u5207\u6362\u5230\u300C\u5BF9\u8C61\u300D\u89C6\u56FE\u3002",
    step2: "\u5BFC\u822A\u5230\u6B64\u6570\u636E\u70B9\uFF1A",
    step3: "\u5728\u6B64\u5904\u8F93\u5165\u6240\u9700\u7684 URL\uFF08VIS \u9879\u76EE\u3001Grafana\u3001\u4EEA\u8868\u677F\u7B49\uFF09\u3002",
    autoRefresh: "\u6B64\u9875\u9762\u6BCF 15 \u79D2\u81EA\u52A8\u5237\u65B0\u4E00\u6B21\u3002"
  }
};
function renderLandingPage(clientId, namespace, language = "en", ip = null) {
  var _a, _b;
  const s = (_a = STRINGS[language]) != null ? _a : STRINGS.en;
  const id = escapeHtml(clientId);
  const ns = escapeHtml(namespace);
  const datapoint = `${ns}.clients.${id}.mode`;
  const trimmedIp = (_b = ip == null ? void 0 : ip.trim()) != null ? _b : "";
  const isLoopback = trimmedIp === "" || trimmedIp === "127.0.0.1" || trimmedIp === "::1" || trimmedIp === "0.0.0.0" || trimmedIp.startsWith("127.");
  const ipLine = isLoopback ? "" : `<tr><th scope="row">${escapeHtml(s.ipLabel)}</th><td>${escapeHtml(trimmedIp)}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(s.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${escapeHtml(s.pageTitle)}</title>
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
        <div class="check" aria-hidden="true">\u2713</div>
        <div>
            <h1>${escapeHtml(s.heading)}</h1>
            <p>${escapeHtml(s.subhead)}</p>
        </div>
    </div>
    <div class="content">
        <table class="info">
            <tbody>
                <tr>
                    <th scope="row">${escapeHtml(s.deviceIdLabel)}</th>
                    <td><code>${id}</code></td>
                </tr>
                ${ipLine}
            </tbody>
        </table>
        <section class="setup">
            <h2>${escapeHtml(s.setupTitle)}</h2>
            <p>${escapeHtml(s.setupIntro)}</p>
            <ol class="steps">
                <li>${escapeHtml(s.step1)}</li>
                <li>${escapeHtml(s.step2)} <code>${escapeHtml(datapoint)}</code></li>
                <li>${escapeHtml(s.step3)}</li>
            </ol>
        </section>
    </div>
    <footer>
        ${escapeHtml(s.autoRefresh)}
        <span class="brand" aria-hidden="true">${LOGO_SVG} ioBroker</span>
    </footer>
</main>
<script>
(function(){
  // Same connection-status signal as renderRedirectWrapper \u2014 the HA Companion
  // App on Shelly Wall Display FW 2.6.0+ shows "Verbindung zu Home Assistant
  // nicht m\xF6glich" after 10 s if it doesn't see this message. The popup is
  // unrelated to whether a URL is configured, so the landing page must signal
  // "connected" too. Source: home-assistant/android FrontendMessageHandler.kt +
  // FrontendJsBridge.kt + frontend/src/external_app/external_messaging.ts.
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
    } catch (e) { /* silent \u2014 bridge not present, regular browser */ }
  }
  notifyConnected();
  setTimeout(notifyConnected, 500);
  setTimeout(notifyConnected, 2000);
})();
</script>
</body>
</html>`;
}
function escapeHtml(s) {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  renderLandingPage
});
//# sourceMappingURL=landing-page.js.map
