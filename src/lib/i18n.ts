import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

type I18nKey = keyof typeof translations;

/**
 * @param key Translation key from admin/i18n/en.json
 */
export function tName(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * @param key Translation key from admin/i18n/en.json
 */
export function resolveLabel(key: I18nKey): string {
  return I18n.translate(key);
}

/**
 * Resolve a translation key to a plain string in a SPECIFIC language with an
 * English fallback. Used by the server-rendered display pages (landing page /
 * down page), which render in the ioBroker system language passed to them — not
 * in the admin UI's currently-active language, so `I18n.translate` (current
 * language) is not what we want here.
 *
 * @param key      Translation key from admin/i18n/en.json.
 * @param language Target language (`en`, `de`, …); unknown → English.
 */
export function tPage(key: I18nKey, language: string): string {
  const obj = I18n.getTranslatedObject(key);
  if (typeof obj === "string") {
    return obj;
  }
  const rec = obj as Record<string, string>;
  return rec[language] ?? rec.en ?? key;
}

/**
 * Returns a {@link tPage} translator bound to one language — convenience so the
 * server-rendered pages share the closure instead of each redeclaring it.
 *
 * @param language Target language (`en`, `de`, …); unknown → English.
 */
export function makePageTranslator(language: string): (key: I18nKey) => string {
  return key => tPage(key, language);
}
