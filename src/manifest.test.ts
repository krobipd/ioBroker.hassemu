// Catalogue completeness — the decisions the object-inventory gate hands back to the
// adapter (fleet template, section "Objekt-Inventar"):
//
// 1. every naming key the adapter uses exists in admin/i18n/en.json,
// 2. every language file carries every key (a missing one silently renders the KEY),
// 3. every datapoint either has a description or is listed as self-explaining, with a
//    reason — `feedback_beschreibung_ist_erklaerung`: an invented sentence is worse than
//    none, but the decision has to be WRITTEN somewhere, not implied by absence,
// 4. the generated inventory covers at least the objects the manifest declares.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_LANGS } from "./lib/html-shared";

const ADMIN_I18N = join(__dirname, "../admin/i18n");
const en = JSON.parse(readFileSync(join(ADMIN_I18N, "en.json"), "utf8")) as Record<string, string>;
const manifest = JSON.parse(readFileSync(join(__dirname, "../io-package.json"), "utf8")) as {
  instanceObjects: { _id: string; type: string; common?: { name?: unknown; desc?: unknown } }[];
};

/**
 * Datapoints that carry NO description, each with the reason it needs none. A datapoint
 * whose name already says everything gets no invented sentence — but the judgement is
 * recorded here, so "no description" is always a decision and never an oversight.
 */
const SELF_EXPLAINING: Record<string, string> = {
  "info.connection": "The name states it: the server is running. There is nothing behind it to explain.",
  "clients.<id>.ip": "The IP the display was last seen at — the name is the whole fact.",
  "clients.<id>.remove": "A button labelled 'Forget this display'. A description could only repeat it.",
};

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

describe("datapoint descriptions", () => {
  it("every manifest datapoint has a description or a recorded reason for having none", () => {
    const undecided: string[] = [];
    for (const obj of manifest.instanceObjects) {
      if (obj.type !== "state") {
        continue; // containers carry a name; a description would have nothing to add
      }
      const hasDesc = obj.common?.desc !== undefined;
      if (!hasDesc && !(obj._id in SELF_EXPLAINING)) {
        undecided.push(obj._id);
      }
    }
    expect(undecided, "datapoints with neither a description nor an entry in SELF_EXPLAINING").to.deep.equal([]);
  });

  it("every self-explaining entry names a datapoint that really has no description", () => {
    // Guards the other direction: an entry left behind after a description WAS added
    // would quietly excuse a datapoint that no longer needs excusing.
    const stale = Object.keys(SELF_EXPLAINING).filter(id => {
      const obj = manifest.instanceObjects.find(o => o._id === id);
      return obj ? obj.common?.desc !== undefined : false;
    });
    expect(stale, "SELF_EXPLAINING entries for datapoints that now have a description").to.deep.equal([]);
  });

  it("each reason is a sentence, not a shrug", () => {
    for (const [id, reason] of Object.entries(SELF_EXPLAINING)) {
      expect(reason.length, `${id}: reason too short to be a reason`).to.be.greaterThan(30);
    }
  });
});
