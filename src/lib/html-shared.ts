/**
 * Shared helpers for the HTML pages served to displays (landing page + redirect
 * wrapper / down page). Keeps the loopback-IP rule and the optional IP table row
 * in exactly one place — both pages rendered identical markup before.
 */

import { escapeHtml } from "./coerce";

/** The 11 supported UI languages — matches admin/i18n + the io-package translations. */
export const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;

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
