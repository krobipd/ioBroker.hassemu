// The down page now pulls its copy from admin/i18n via adapter-core I18n — mock
// it to serve the real translations from the JSON files (same as webserver.test).
vi.mock("@iobroker/adapter-core", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const i18nDir = join(__dirname, "../../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
    i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
  }
  return {
    I18n: {
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
    },
  };
});

import { renderRedirectWrapper } from "./redirect-wrapper";

describe("redirect-wrapper", () => {
  describe("renderRedirectWrapper", () => {
    it("renders an iframe with the validated target URL", () => {
      const html = renderRedirectWrapper(
        "https://vis.example.test/vis-2/index.html?main",
        "a1b2c3",
        "en",
        "192.168.1.42",
      );
      expect(html).to.include('<iframe id="hassemu-iframe" src="https://vis.example.test/vis-2/index.html?main"');
      expect(html).to.include('id="hassemu-down"');
      // Down page is hidden by default (display:none from inline-CSS).
      expect(html).to.match(/#hassemu-down\{display:none;/);
    });

    it("renders the shared card/table CSS with the down (error-theme) colors (L21)", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      expect(html).to.include("#hassemu-down .card {");
      expect(html).to.include("max-width: 44rem;");
      expect(html).to.include("#hassemu-down th, #hassemu-down td {");
      expect(html).to.include("border-bottom: 1px solid #334155;");
      expect(html).to.not.include("var(--"); // down page uses literal colors, no landing tokens
    });

    it("includes 30s polling JS with consecutive-fail threshold", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      // window.-prefixed timer keeps the repochecker W5004 regex from matching
      // this client-side <script> string (it is not an adapter timer).
      expect(html).to.match(/window\.setInterval\(/);
      expect(html).to.include("fetch('/api/redirect_check'");
      expect(html).to.include("THRESHOLD=3");
      expect(html).to.include("fails++");
      expect(html).to.include("hideDown");
      expect(html).to.include("showDown");
    });

    it("neutralizes </script> in the target so it cannot break out of the inline <script> (v1.36.0 C3)", () => {
      const html = renderRedirectWrapper("https://attacker.test/a</script><script>alert(1)</script>", "a1b2c3", "en");
      // iframe src attribute escape kills `<`/`>`/`"` — the entity-escaped copy is safe.
      expect(html).to.include("&lt;/script&gt;");
      // The inline `var current=` JS sink must NOT contain a raw `</script>`: at the
      // HTML-tokenizer level that closes the <script> regardless of JS string nesting.
      // JSON.stringify does NOT escape `<`; the `.replace(/</g, "\\u003C")` does.
      const line = html.split("\n").find(l => l.includes("var current="))!;
      expect(line).to.not.include("</script>");
      expect(line).to.include("\\u003C/script"); // `<` escaped to its JS unicode escape
    });

    it('renders the German down-page strings when language is "de"', () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "de", "10.0.0.50");
      expect(html).to.include("hassemu offline");
      expect(html).to.include("Geräte-ID");
      expect(html).to.include("IP-Adresse");
      expect(html).to.include("Jetzt neu laden");
      expect(html).to.match(/lang="de"/);
    });

    it('renders the Polish strings when language is "pl"', () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "pl", "10.0.0.50");
      expect(html).to.include("Załaduj ponownie");
      expect(html).to.include("Adres IP");
    });

    it("falls back to English when language is unknown", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "xx-XX");
      expect(html).to.include("Reload now");
      expect(html).to.include("Device ID");
      expect(html).to.match(/lang="en"/);
    });

    it("shows the IP row when ip is a non-loopback address", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en", "10.0.0.50");
      expect(html).to.include("10.0.0.50");
      expect(html).to.match(/<th scope="row">IP address<\/th><td>10\.0\.0\.50<\/td>/);
    });

    it("omits the IP row when ip is loopback / empty / null", () => {
      for (const ip of [null, "", "127.0.0.1", "127.0.0.5", "::1", "0.0.0.0"]) {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en", ip);
        expect(html, `ip=${ip ?? "null"}`).not.to.match(/<th scope="row">IP address<\/th>/);
      }
    });

    it("includes the reload button with location.reload onclick", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      expect(html).to.match(/<button type="button" onclick="location\.reload\(\)">/);
    });

    it("escapes the clientId to prevent injection into the down-page table", () => {
      const html = renderRedirectWrapper("https://x.test/", "<script>alert(1)</script>", "en");
      expect(html).not.to.include("<script>alert(1)</script>");
      expect(html).to.include("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    // v1.39.0: target-down card ("hassemu läuft, Ziel antwortet nicht").
    describe("target-down card", () => {
      it("renders the card hidden by default when the target is reachable", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include('id="hassemu-target-down"');
        expect(html).to.match(/#hassemu-target-down\{display:none;/);
        expect(html).not.to.include('<div id="hassemu-target-down" class="visible"');
        // iframe stays visible.
        expect(html).not.to.include('<iframe id="hassemu-iframe" src="https://x.test/" style="display:none"');
        // Counter starts clean.
        expect(html).to.include("var targetFails=0");
      });

      it("renders the card VISIBLE and the iframe hidden when the target is down at render time (cold boot)", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en", null, false);
        expect(html).to.include('<div id="hassemu-target-down" class="visible"');
        expect(html).to.include('<iframe id="hassemu-iframe" src="https://x.test/" style="display:none"');
        // Counter starts AT the threshold so the card stays until recovery.
        expect(html).to.include("var targetFails=2");
      });

      it("shows the target URL, device id and localized copy on the card", () => {
        const html = renderRedirectWrapper("https://vis.example.test/dash", "a1b2c3", "de", "10.0.0.50", false);
        expect(html).to.include("Weiterleitungsziel nicht erreichbar");
        expect(html).to.include("Ziel-URL");
        expect(html).to.match(/<td class="target-url"><code>https:\/\/vis\.example\.test\/dash<\/code><\/td>/);
        expect(html).to.include("Geräte-ID");
      });

      it("polling JS reacts to targetReachable: threshold 2 to show, reload on recovery", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include("var TARGET_THRESHOLD=2");
        expect(html).to.include("j.targetReachable===false");
        expect(html).to.include("targetFails++");
        expect(html).to.include("showTargetDown");
        // Recovery path is a FULL reload (a dead-loaded iframe never retries itself).
        expect(html).to.include("if(targetDownVisible()){");
      });

      it("hassemu-down recovery does NOT unhide the iframe while the target card is visible", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include("if(iframeEl && !targetDownVisible()){iframeEl.style.display='block';}");
      });

      it("card uses the shared card CSS scoped to its own id (design consistency)", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include("#hassemu-target-down .card {");
        expect(html).to.include("#hassemu-target-down th, #hassemu-target-down td {");
        // Amber banner — distinct from the red hassemu-down banner.
        expect(html).to.include("#hassemu-target-down .banner{background:#d97706;");
        expect(html).to.include("#hassemu-down .banner{background:#dc2626;");
      });

      it("escapes a hostile target URL in the card's URL row", () => {
        const html = renderRedirectWrapper(
          'https://x.test/"><img src=x onerror=alert(1)>',
          "a1b2c3",
          "en",
          null,
          false,
        );
        expect(html).not.to.include('"><img src=x');
        expect(html).to.include("&quot;&gt;&lt;img");
      });
    });
  });
});
