/**
 * adapter-core `I18n` for the unit-test mocks, answered from the REAL `admin/i18n` files.
 *
 * The object refresh and the pages exist to land the actual user-visible text, so a mock
 * that echoed the key back would let a wrong key pass unnoticed. One copy for every test
 * file: the seven hand copies before were the same rule in seven places (review
 * 2026-11-07, R-15).
 *
 * Use it from a hoisted `vi.mock` factory through a dynamic import:
 * `const { realI18n } = await import("../../test/unit/i18n-stub.js");`
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Mock, vi } from "vitest";

/** The two lookups the adapter code calls, as spies over the real translation files. */
export interface I18nStub {
  /** Every language that carries the key; `{ en: key }` when none does. */
  getTranslatedObject: Mock<(key: string) => Record<string, string>>;
  /** The English text of the key, or the key itself. */
  translate: Mock<(key: string) => string>;
}

/** Reads `admin/i18n/<lang>.json` once and answers both lookups from it. */
export function realI18n(): I18nStub {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
    i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
  }
  return {
    getTranslatedObject: vi.fn((key: string) => {
      const result: Record<string, string> = {};
      for (const [lang, data] of Object.entries(i18nData)) {
        if (data[key]) {
          result[lang] = data[key];
        }
      }
      return Object.keys(result).length > 0 ? result : { en: key };
    }),
    translate: vi.fn((key: string) => i18nData.en?.[key] ?? key),
  };
}
