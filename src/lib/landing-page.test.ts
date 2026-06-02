import { expect } from "chai";

// The page now pulls its copy from admin/i18n via adapter-core I18n — mock it to
// serve the real translations from the JSON files (same pattern as webserver.test).
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

import { renderLandingPage } from "./landing-page";

describe("landing-page", () => {
  describe("renderLandingPage()", () => {
    it("returns HTML5 document with utf-8 charset and viewport", () => {
      const html = renderLandingPage("abc123", "hassemu.0");
      expect(html).to.include("<!DOCTYPE html>");
      expect(html).to.include('<meta charset="utf-8">');
      expect(html).to.include("viewport");
    });

    it("embeds the resolved datapoint path", () => {
      const html = renderLandingPage("abc123", "hassemu.0");
      expect(html).to.include("hassemu.0.clients.abc123.mode");
    });

    it("includes 15-second meta-refresh tag", () => {
      const html = renderLandingPage("abc123", "hassemu.0");
      expect(html).to.include('<meta http-equiv="refresh" content="15">');
    });

    it("omits IP row when ip is null", () => {
      const html = renderLandingPage("abc123", "hassemu.0", "en", null);
      // ipLabel shouldn't be rendered without IP
      expect(html).to.not.include("IP address");
    });

    it("renders IP row when ip is provided", () => {
      const html = renderLandingPage("abc123", "hassemu.0", "en", "192.168.1.42");
      expect(html).to.include("192.168.1.42");
    });

    it("omits IP row when ip is empty string", () => {
      const html = renderLandingPage("abc123", "hassemu.0", "en", "");
      expect(html).to.not.include("IP address");
    });

    it("omits IP row when ip is whitespace only", () => {
      const html = renderLandingPage("abc123", "hassemu.0", "en", "   ");
      expect(html).to.not.include("IP address");
    });

    it("skips loopback IPs in landing page (E3 v1.16.0)", () => {
      for (const loopback of ["127.0.0.1", "::1", "0.0.0.0", "127.0.0.5", "   "]) {
        const html = renderLandingPage("abc", "hassemu.0", "en", loopback);
        expect(html, `loopback ${loopback}`).to.not.include("IP address");
        expect(html, `loopback ${loopback} value`).to.not.include(`<td>${loopback}`);
      }
    });

    it("shows non-loopback IPs (E3 v1.16.0)", () => {
      const html = renderLandingPage("abc", "hassemu.0", "en", "192.168.1.42");
      expect(html).to.include("IP address");
      expect(html).to.include("192.168.1.42");
    });

    it("falls back to English on unknown language", () => {
      const enHtml = renderLandingPage("abc", "hassemu.0", "en");
      const unknownHtml = renderLandingPage("abc", "hassemu.0", "klingon");
      expect(unknownHtml).to.equal(enHtml);
    });

    it("renders German strings when language is de", () => {
      const html = renderLandingPage("abc", "hassemu.0", "de");
      // German page-title
      expect(html).to.include('lang="de"');
    });

    it("renders all 11 supported languages without crashing", () => {
      const langs = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
      for (const lang of langs) {
        const html = renderLandingPage("abc", "hassemu.0", lang);
        expect(html).to.be.a("string").and.have.length.greaterThan(500);
        expect(html).to.include("<!DOCTYPE html>");
      }
    });

    describe("XSS protection", () => {
      it("escapes < > & \" ' in clientId", () => {
        const html = renderLandingPage("<script>alert(1)</script>", "hassemu.0");
        expect(html).to.not.include("<script>alert(1)</script>");
        expect(html).to.include("&lt;script&gt;alert(1)&lt;/script&gt;");
      });

      it("escapes namespace injection attempts", () => {
        const html = renderLandingPage("abc", 'hassemu.0"><script>x</script>');
        // Raw injected payload must never appear unescaped — that's the XSS guarantee.
        // The page legitimately contains one </script> (the notifyConnected
        // block at the bottom); the injected one would be a second.
        expect(html).to.not.include('"><script>');
        // Count `</script>` occurrences — only our legitimate one is allowed.
        const scriptCloseCount = (html.match(/<\/script>/g) ?? []).length;
        expect(scriptCloseCount).to.equal(1);
        // The injected `<script>x` raw payload must not appear
        expect(html).to.not.include("<script>x</script>");
      });

      it("escapes IP injection attempts", () => {
        const html = renderLandingPage("abc", "hassemu.0", "en", "<img src=x onerror=alert(1)>");
        expect(html).to.not.include("<img src=x onerror=alert(1)>");
        expect(html).to.include("&lt;img src=x onerror=alert(1)&gt;");
      });

      it("escapes ampersands in user input", () => {
        const html = renderLandingPage("a&b", "hassemu.0");
        expect(html).to.include("a&amp;b");
      });

      it("escapes single quotes", () => {
        const html = renderLandingPage("a'b", "hassemu.0");
        expect(html).to.include("a&#39;b");
        expect(html).to.not.match(/[^&]a'b/);
      });

      it("does not double-escape already-escaped sequences", () => {
        // The escaper runs once over user-supplied id; passing &amp; through
        // should produce &amp;amp; (treat input as raw text).
        const html = renderLandingPage("a&amp;b", "hassemu.0");
        expect(html).to.include("a&amp;amp;b");
      });

      it("escapes the datapoint path exactly once (v1.34.0 double-escape fix)", () => {
        // Regression: the datapoint used to be built from the ALREADY-escaped
        // id/ns and then escaped a second time → `a&amp;amp;b`. It must now be
        // built from the raw values and escaped exactly once.
        const html = renderLandingPage("a&b", "hassemu.0");
        expect(html).to.include("hassemu.0.clients.a&amp;b.mode");
        expect(html).to.not.include("a&amp;amp;b.mode");
      });
    });

    describe("ioBroker logo (v1.29.3)", () => {
      it('embeds the real ioBroker brand SVG inline (power-button "i" in a ring)', () => {
        const html = renderLandingPage("abc123", "hassemu.0");
        // 100x100 viewBox per the official mark
        expect(html).to.include('viewBox="0 0 100 100"');
        // Two-tone brand colors — dark navy ring + mid-blue "i"
        expect(html).to.include("#1F537E"); // ring
        expect(html).to.include("#2B95C6"); // i
        expect(html.match(/role="img"/g)?.length ?? 0).to.be.at.least(1);
      });

      it('renders the brand wordmark "ioBroker" in the footer', () => {
        const html = renderLandingPage("abc123", "hassemu.0");
        expect(html).to.include('class="brand"');
        expect(html).to.match(/<span class="brand"[^>]*>.*ioBroker.*<\/span>/s);
      });
    });

    describe("Companion-App bridge signal (v1.29.3)", () => {
      it("emits connection-status:connected to V1 and V2 bridges from the landing page too", () => {
        // Without this, FW 2.6.0+ Companion App shows the
        // "Verbindung zu Home Assistant nicht möglich" popup even when
        // the landing page is the displayed content (no URL configured).
        const html = renderLandingPage("abc123", "hassemu.0");
        expect(html).to.include("window.externalApp");
        expect(html).to.include("externalBus");
        expect(html).to.include("window.externalAppV2");
        expect(html).to.include("postMessage");
        expect(html).to.include('type:"connection-status"');
        expect(html).to.include('event:"connected"');
        // Retry pattern (slow-bridge-attach)
        expect(html).to.match(/setTimeout\(notifyConnected,\s*\d+\)/);
      });
    });
  });
});
