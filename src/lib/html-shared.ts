/**
 * Shared helpers for the HTML pages served to displays (landing page + redirect
 * wrapper / down page). Keeps the loopback-IP rule and the optional IP table row
 * in exactly one place — both pages rendered identical markup before.
 */

/**
 * Escapes the 5 HTML-special characters `<`, `>`, `&`, `"`, `'` for safe
 * interpolation in HTML element bodies AND in attribute values. Defensive
 * default — the apostrophe escape covers `href='...'` attribute uses even if the
 * calling site uses `"..."` attributes today.
 *
 * v1.32.0: consolidated from `landing-page.ts:escapeHtml` (5-char) and
 * `auth-page.ts:escAttr` (4-char). v1.37.0 (L34): moved here from coerce.ts — an
 * HTML escaper belongs with the HTML helpers, not the boundary-coercion module.
 *
 * @param s Untrusted string to interpolate into HTML.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, c => {
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

/**
 * The 11 supported UI languages — matches admin/i18n + the io-package translations.
 * Exported so the i18n-completeness test can assert against the same canonical list.
 */
export const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;

/**
 * Escape a string for safe embedding as a JavaScript string literal inside an
 * inline `<script>` block. `JSON.stringify` yields a valid JS literal, but does
 * NOT neutralise `<`, so an embedded `</script>` would close the script at the
 * HTML-tokenizer level before JS ever parses it — hence the extra `<` → `<`
 * escape. Shared by the auth redirect page and the display redirect wrapper.
 *
 * @param value Untrusted string to embed as a JS string literal.
 */
export function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003C");
}

/**
 * `<html lang>` tag for a UI language. Identity for every supported language
 * except `zh-cn` → `zh-CN`; an unknown language falls back to `en` (matching the
 * English content fallback the pages use).
 *
 * @param language ioBroker system language (`en`, `de`, …).
 */
export function htmlLangFor(language: string): string {
  if (!(SUPPORTED_LANGS as readonly string[]).includes(language)) {
    return "en";
  }
  return language === "zh-cn" ? "zh-CN" : language;
}

/**
 * Loopback / unusable display IPs that must not be shown to the end-user.
 *
 * v1.16.0 (E3): a reverse-proxy setup makes the display look like `127.0.0.1` /
 * `::1` to the adapter, which is confusing on screen. An empty string (no IP
 * known) is treated the same way so the IP row is simply omitted.
 *
 * @param ip Already-trimmed IP string (see {@link renderIpRow}).
 */
export function isLoopbackIp(ip: string): boolean {
  return ip === "" || ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0" || ip.startsWith("127.");
}

/**
 * Render the optional IP table row for the info table. Returns an empty string
 * for loopback / unknown IPs so the row drops out cleanly.
 *
 * @param ipLabel Localized "IP address" label.
 * @param ip      Raw remote IP of the display (trimmed internally), or null.
 */
export function renderIpRow(ipLabel: string, ip: string | null): string {
  const trimmedIp = ip?.trim() ?? "";
  if (isLoopbackIp(trimmedIp)) {
    return "";
  }
  return `<tr><th scope="row">${escapeHtml(ipLabel)}</th><td>${escapeHtml(trimmedIp)}</td></tr>`;
}

/**
 * Render the device-id table row shared by the landing page and the down page.
 * Escapes both the label and the id (callers pass raw values). Companion to
 * {@link renderIpRow} so both info rows live in one place.
 *
 * @param idLabel Localized "Device ID" label.
 * @param id      Raw short client id.
 */
export function renderIdRow(idLabel: string, id: string): string {
  return `<tr><th scope="row">${escapeHtml(idLabel)}</th><td><code>${escapeHtml(id)}</code></td></tr>`;
}

/** Color tokens for {@link cardTableCss}. Values may be literal colors or `var(--x)` refs. */
export interface CardTheme {
  /** Card background. */
  cardBg: string;
  /** Card drop shadow. */
  shadow: string;
  /** Table row divider color. */
  border: string;
  /** Table header (`th`) text color. */
  thColor: string;
  /** Inline `<code>` chip background. */
  codeBg: string;
}

/** Selectors for {@link cardTableCss} — lets each page keep its own scoping. */
export interface CardSelectors {
  /** Card container, e.g. `main` or `#hassemu-down .card`. */
  card: string;
  /** Content wrapper, e.g. `.content` or `#hassemu-down .content`. */
  content: string;
  /** The `<table>` element, e.g. `.info` (class on the table) or `#hassemu-down table`. */
  table: string;
  /** Scope prefix for `th`/`td`/`code`, e.g. `.info` or `#hassemu-down`. */
  cell: string;
}

/**
 * Emit the card + info-table + code-chip CSS shared by the landing page and the
 * connection-down page. Both render the same card/table structure and differ only
 * in colors (green landing banner vs. red down banner) and scope — so the rule
 * bodies live here once, parametrized by {@link CardSelectors} + {@link CardTheme}.
 * Page-specific rules (landing banner/logo/setup/steps, down button, each page's
 * `@media` block) stay in their own file. v1.37.0 (L21).
 *
 * @param sel   Selectors for the card, content, table element and cell scope.
 * @param theme Color tokens (literal colors or `var(--x)` refs).
 */
export function cardTableCss(sel: CardSelectors, theme: CardTheme): string {
  return `${sel.card} {
    width: 100%;
    max-width: 44rem;
    background: ${theme.cardBg};
    border-radius: 12px;
    box-shadow: ${theme.shadow};
    overflow: hidden;
}
${sel.content} {
    padding: 1.6rem 1.8rem 1.3rem;
}
${sel.table} {
    margin: 0 0 1.4rem;
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95rem;
}
${sel.cell} th, ${sel.cell} td {
    padding: 0.55rem 0.7rem;
    text-align: left;
    border-bottom: 1px solid ${theme.border};
}
${sel.cell} tr:last-child th, ${sel.cell} tr:last-child td {
    border-bottom: none;
}
${sel.cell} th {
    font-weight: 500;
    color: ${theme.thColor};
    white-space: nowrap;
    width: 9rem;
}
${sel.cell} code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: ${theme.codeBg};
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    font-size: 0.9em;
}`;
}
