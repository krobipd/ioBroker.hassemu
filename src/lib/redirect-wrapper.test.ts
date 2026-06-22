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
  });
});
