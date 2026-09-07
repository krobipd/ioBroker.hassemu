// Naming catalogue — the i18n side of the fleet template's "Objekt-Inventar" section:
//
// 1. every naming key the adapter uses exists in admin/i18n/en.json,
// 2. every language file carries every key (a missing one silently renders the KEY),
// 3. no key survives that nothing reads any more.
//
// The description decision — every datapoint EXPLAINED or declared self-explaining WITH a
// reason — belongs to the fleet gate since 2026-09-07: check-object-inventory.py reads
// test/self-explaining.json and judges the generated INVENTORY. That is the wider surface:
// the block that stood here walked io-package.json, so the per-display datapoints the
// adapter creates at runtime were listed but never actually decided. A second copy here
// could only drift away from the one the gate reads.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_LANGS } from "./lib/html-shared";

const ADMIN_I18N = join(__dirname, "../admin/i18n");
const en = JSON.parse(readFileSync(join(ADMIN_I18N, "en.json"), "utf8")) as Record<string, string>;

describe("naming catalogue", () => {
  it("every language file carries exactly the keys en.json has", () => {
    const expected = Object.keys(en).sort();
    for (const lang of SUPPORTED_LANGS) {
      const data = JSON.parse(readFileSync(join(ADMIN_I18N, `${lang}.json`), "utf8")) as Record<string, string>;
      const actual = Object.keys(data).sort();
      const missing = expected.filter(k => !actual.includes(k));
      const extra = actual.filter(k => !expected.includes(k));
      expect(missing, `${lang}.json is missing keys`).to.deep.equal([]);
      expect(extra, `${lang}.json has keys en.json does not`).to.deep.equal([]);
    }
  });

  it("no language file leaves a key empty", () => {
    for (const lang of SUPPORTED_LANGS) {
      const data = JSON.parse(readFileSync(join(ADMIN_I18N, `${lang}.json`), "utf8")) as Record<string, string>;
      const blank = Object.entries(data)
        .filter(([, v]) => typeof v !== "string" || v.trim() === "")
        .map(([k]) => k);
      expect(blank, `${lang}.json has blank values`).to.deep.equal([]);
    }
  });

  it("carries no key nothing reads any more", () => {
    // A dead key is pure maintenance load: eleven files to keep in step for a text no
    // code asks for. `pageOfflineTitle` was one for five releases, orphaned when the
    // wrapper's <title> moved to pageConnectedTitle (L36, v1.38.0).
    const libDir = join(__dirname, "lib");
    const sources = [readFileSync(join(__dirname, "main.ts"), "utf8")];
    for (const f of readdirSync(libDir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      sources.push(readFileSync(join(libDir, f), "utf8"));
    }
    // The manifest is the second consumer: sync-iopackage-from-i18n.py fills
    // instanceObjects names/descs from these keys, so a key used only there is USED.
    sources.push(readFileSync(join(__dirname, "../io-package.json"), "utf8"));
    sources.push(readFileSync(join(__dirname, "../admin/jsonConfig.json"), "utf8"));
    const haystack = sources.join("\n");
    const dead = Object.keys(en).filter(k => !haystack.includes(`"${k}"`) && !haystack.includes(`'${k}'`));
    expect(dead, "i18n keys no source or manifest reads").to.deep.equal([]);
  });
});
