/**
 * Landing page served to a display whose redirect URL is not yet configured.
 *
 * Goal: give the end-user a strong visual "everything is connected, now just
 * pick a URL" signal — big green check, three clear steps, adapter-local copy
 * in the ioBroker system language. Auto-refreshes every 15 s so the display
 * jumps to the real URL the moment the state is written.
 */

/**
 * Inline ioBroker / hassemu logo SVG. Mirrors admin/hassemu.svg so the landing
 * page is self-contained (no extra HTTP request, works behind a strict CSP).
 * Background circle is the ioBroker brand blue (#41BDF5); inner glyph is a
 * Home-Assistant-style house with a connection arc — a deliberate nod to what
 * this adapter does.
 */
const LOGO_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="ioBroker">' +
    '<circle cx="32" cy="32" r="30" fill="#41BDF5"/>' +
    '<path d="M32 12 L12 28 L12 52 L24 52 L24 38 L40 38 L40 52 L52 52 L52 28 Z" fill="#ffffff" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M20 44 Q32 36 44 44" fill="none" stroke="#41BDF5" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="20" cy="44" r="3" fill="#41BDF5"/>' +
    '<circle cx="44" cy="44" r="3" fill="#41BDF5"/>' +
    '</svg>';

/** Supported languages — matches the 11 io-package.json translations. */
export type LandingLanguage = 'en' | 'de' | 'ru' | 'pt' | 'nl' | 'fr' | 'it' | 'es' | 'pl' | 'uk' | 'zh-cn';

/** One translation bundle for the landing page. */
interface LandingStrings {
    htmlLang: string;
    pageTitle: string;
    heading: string;
    subhead: string;
    deviceIdLabel: string;
    ipLabel: string;
    setupTitle: string;
    setupIntro: string;
    step1: string;
    step2: string;
    step3: string;
    autoRefresh: string;
}

/** Translation table — EN is the fallback for any missing language. */
const STRINGS = {
    en: {
        htmlLang: 'en',
        pageTitle: 'Connected · ioBroker',
        heading: 'Display connected',
        subhead: 'This display is linked to ioBroker. Choose a redirect URL to finish setup.',
        deviceIdLabel: 'Device ID',
        ipLabel: 'IP address',
        setupTitle: 'Finish setup',
        setupIntro: 'Set the URL that this display should open on next refresh:',
        step1: 'Open the ioBroker admin and switch to the Objects view.',
        step2: 'Go to this datapoint:',
        step3: 'Enter the URL you want to show here (VIS project, Grafana, dashboard, …).',
        autoRefresh: 'This page refreshes automatically every 15 seconds.',
    },
    de: {
        htmlLang: 'de',
        pageTitle: 'Verbunden · ioBroker',
        heading: 'Display verbunden',
        subhead: 'Dieses Display ist mit ioBroker verbunden. Wähle noch eine Weiterleitungs-URL aus.',
        deviceIdLabel: 'Geräte-ID',
        ipLabel: 'IP-Adresse',
        setupTitle: 'Einrichtung abschließen',
        setupIntro: 'Lege fest, welche URL das Display beim nächsten Refresh öffnen soll:',
        step1: 'Öffne im ioBroker-Admin die Ansicht „Objekte".',
        step2: 'Navigiere zu diesem Datenpunkt:',
        step3: 'Trage hier die gewünschte URL ein (VIS-Projekt, Grafana, Dashboard, …).',
        autoRefresh: 'Diese Seite aktualisiert sich automatisch alle 15 Sekunden.',
    },
    ru: {
        htmlLang: 'ru',
        pageTitle: 'Подключено · ioBroker',
        heading: 'Дисплей подключён',
        subhead: 'Этот дисплей подключён к ioBroker. Выберите URL для перенаправления.',
        deviceIdLabel: 'ID устройства',
        ipLabel: 'IP-адрес',
        setupTitle: 'Завершение настройки',
        setupIntro: 'Укажите URL, который дисплей откроет при следующем обновлении:',
        step1: 'Откройте админку ioBroker и перейдите в раздел «Объекты».',
        step2: 'Перейдите к этому датапункту:',
        step3: 'Введите нужный URL (проект VIS, Grafana, дашборд и т. д.).',
        autoRefresh: 'Страница автоматически обновляется каждые 15 секунд.',
    },
    pt: {
        htmlLang: 'pt',
        pageTitle: 'Conectado · ioBroker',
        heading: 'Display conectado',
        subhead: 'Este display está conectado ao ioBroker. Escolha um URL de redirecionamento.',
        deviceIdLabel: 'ID do dispositivo',
        ipLabel: 'Endereço IP',
        setupTitle: 'Concluir configuração',
        setupIntro: 'Defina o URL que este display deve abrir na próxima atualização:',
        step1: 'Abra o admin do ioBroker e mude para a visão de Objetos.',
        step2: 'Navegue até este datapoint:',
        step3: 'Insira o URL desejado (projeto VIS, Grafana, dashboard, …).',
        autoRefresh: 'Esta página atualiza automaticamente a cada 15 segundos.',
    },
    nl: {
        htmlLang: 'nl',
        pageTitle: 'Verbonden · ioBroker',
        heading: 'Display verbonden',
        subhead: 'Dit display is met ioBroker verbonden. Kies een redirect-URL om de setup af te ronden.',
        deviceIdLabel: 'Apparaat-ID',
        ipLabel: 'IP-adres',
        setupTitle: 'Setup afronden',
        setupIntro: 'Stel de URL in die dit display bij de volgende refresh moet openen:',
        step1: 'Open de ioBroker-admin en ga naar de Objects-weergave.',
        step2: 'Navigeer naar dit datapoint:',
        step3: 'Voer hier de gewenste URL in (VIS-project, Grafana, dashboard, …).',
        autoRefresh: 'Deze pagina vernieuwt zich automatisch elke 15 seconden.',
    },
    fr: {
        htmlLang: 'fr',
        pageTitle: 'Connecté · ioBroker',
        heading: 'Écran connecté',
        subhead: "Cet écran est relié à ioBroker. Choisissez l'URL de redirection pour terminer la configuration.",
        deviceIdLabel: "Identifiant de l'appareil",
        ipLabel: 'Adresse IP',
        setupTitle: 'Finaliser la configuration',
        setupIntro: "Indiquez l'URL que cet écran doit ouvrir à la prochaine actualisation :",
        step1: "Ouvrez l'admin ioBroker et passez à la vue Objets.",
        step2: 'Allez sur ce datapoint :',
        step3: "Saisissez ici l'URL souhaitée (projet VIS, Grafana, tableau de bord, …).",
        autoRefresh: 'Cette page se rafraîchit automatiquement toutes les 15 secondes.',
    },
    it: {
        htmlLang: 'it',
        pageTitle: 'Connesso · ioBroker',
        heading: 'Display connesso',
        subhead:
            'Questo display è collegato a ioBroker. Scegli un URL di reindirizzamento per completare la configurazione.',
        deviceIdLabel: 'ID dispositivo',
        ipLabel: 'Indirizzo IP',
        setupTitle: 'Completa la configurazione',
        setupIntro: "Imposta l'URL che il display deve aprire al prossimo aggiornamento:",
        step1: "Apri l'admin di ioBroker e passa alla vista Oggetti.",
        step2: 'Vai a questo datapoint:',
        step3: "Inserisci qui l'URL desiderato (progetto VIS, Grafana, dashboard, …).",
        autoRefresh: 'Questa pagina si aggiorna automaticamente ogni 15 secondi.',
    },
    es: {
        htmlLang: 'es',
        pageTitle: 'Conectado · ioBroker',
        heading: 'Pantalla conectada',
        subhead:
            'Esta pantalla está vinculada a ioBroker. Elige una URL de redirección para terminar la configuración.',
        deviceIdLabel: 'ID del dispositivo',
        ipLabel: 'Dirección IP',
        setupTitle: 'Completar configuración',
        setupIntro: 'Indica la URL que esta pantalla abrirá en la próxima actualización:',
        step1: 'Abre el admin de ioBroker y cambia a la vista Objetos.',
        step2: 'Navega hasta este datapoint:',
        step3: 'Introduce aquí la URL deseada (proyecto VIS, Grafana, panel, …).',
        autoRefresh: 'Esta página se actualiza automáticamente cada 15 segundos.',
    },
    pl: {
        htmlLang: 'pl',
        pageTitle: 'Połączono · ioBroker',
        heading: 'Wyświetlacz połączony',
        subhead: 'Ten wyświetlacz jest połączony z ioBrokerem. Wybierz adres URL przekierowania.',
        deviceIdLabel: 'ID urządzenia',
        ipLabel: 'Adres IP',
        setupTitle: 'Zakończ konfigurację',
        setupIntro: 'Ustaw URL, który ma otwierać ten wyświetlacz przy następnym odświeżeniu:',
        step1: 'Otwórz panel ioBroker i przejdź do widoku Obiektów.',
        step2: 'Przejdź do tego datapointu:',
        step3: 'Wpisz tutaj żądany URL (projekt VIS, Grafana, dashboard, …).',
        autoRefresh: 'Ta strona odświeża się automatycznie co 15 sekund.',
    },
    uk: {
        htmlLang: 'uk',
        pageTitle: "З'єднано · ioBroker",
        heading: "Дисплей під'єднано",
        subhead: "Цей дисплей з'єднано з ioBroker. Оберіть URL для перенаправлення.",
        deviceIdLabel: 'ID пристрою',
        ipLabel: 'IP-адреса',
        setupTitle: 'Завершити налаштування',
        setupIntro: 'Вкажіть URL, який дисплей відкриє при наступному оновленні:',
        step1: "Відкрийте адмін ioBroker і перейдіть до перегляду «Об'єкти».",
        step2: 'Перейдіть до цього датапоінта:',
        step3: 'Введіть потрібний URL (проєкт VIS, Grafana, дашборд, …).',
        autoRefresh: 'Ця сторінка автоматично оновлюється кожні 15 секунд.',
    },
    'zh-cn': {
        htmlLang: 'zh-CN',
        pageTitle: '已连接 · ioBroker',
        heading: '显示器已连接',
        subhead: '此显示器已连接到 ioBroker。请选择跳转 URL 以完成设置。',
        deviceIdLabel: '设备 ID',
        ipLabel: 'IP 地址',
        setupTitle: '完成设置',
        setupIntro: '设置此显示器下次刷新时要打开的 URL：',
        step1: '打开 ioBroker 管理界面并切换到「对象」视图。',
        step2: '导航到此数据点：',
        step3: '在此处输入所需的 URL（VIS 项目、Grafana、仪表板等）。',
        autoRefresh: '此页面每 15 秒自动刷新一次。',
    },
} as const satisfies Record<LandingLanguage, LandingStrings>;

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
    language: string = 'en',
    ip: string | null = null,
): string {
    const s = STRINGS[language as LandingLanguage] ?? STRINGS.en;
    const id = escapeHtml(clientId);
    const ns = escapeHtml(namespace);
    const datapoint = `${ns}.clients.${id}.mode`;
    // v1.16.0 (E3): Loopback-IPs nicht anzeigen — der End-User sieht sonst
    // „localhost" / „127.0.0.1" / „::1" als sein Display-IP, was bei Proxy-
    // Setups verwirrt (Display sitzt am Reverse-Proxy, nicht am Adapter).
    // Ohne IP-Zeile fällt die Tabellen-Zeile einfach weg, alles andere bleibt.
    const trimmedIp = ip?.trim() ?? '';
    const isLoopback =
        trimmedIp === '' ||
        trimmedIp === '127.0.0.1' ||
        trimmedIp === '::1' ||
        trimmedIp === '0.0.0.0' ||
        trimmedIp.startsWith('127.');
    const ipLine = isLoopback
        ? ''
        : `<tr><th scope="row">${escapeHtml(s.ipLabel)}</th><td>${escapeHtml(trimmedIp)}</td></tr>`;

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
        <div class="check" aria-hidden="true">✓</div>
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
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[<>&"']/g, c => {
        switch (c) {
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '&':
                return '&amp;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}
