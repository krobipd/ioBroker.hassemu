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
export function tDesc(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * @param key Translation key from admin/i18n/en.json
 */
export function resolveLabel(key: I18nKey): string {
  return I18n.translate(key);
}
