import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";
import { SUPPORTED_LANGS } from "./html-shared";

type I18nKey = keyof typeof translations;

/**
 * Wrap a text that does not come from `admin/i18n` — the hostname a display
 * announced itself with, for example — as a translation object.
 *
 * There is nothing to translate (the display sends one string, identical in every
 * language), but `common.name` must be a translation object for every object type,
 * never a bare string (core team, nut2 #15). Offering the same text under every
 * language key makes the object browser show it whatever the system language is,
 * instead of falling back on an untranslated name.
 *
 * Uses the same eleven languages as the rendered pages ({@link SUPPORTED_LANGS}) so
 * the adapter carries ONE language list, not two that can drift apart.
 *
 * @param text The display-supplied text, passed through unchanged.
 * @returns The same text under every supported language key.
 */
export function tRaw(text: string): ioBroker.StringOrTranslated {
  return Object.fromEntries(SUPPORTED_LANGS.map(lang => [lang, text])) as ioBroker.StringOrTranslated;
}

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
