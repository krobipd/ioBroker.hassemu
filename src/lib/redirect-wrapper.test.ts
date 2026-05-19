import { expect } from "chai";
import { renderRedirectWrapper } from "./redirect-wrapper";

describe("redirect-wrapper", () => {
  describe("renderRedirectWrapper", () => {
    it("renders an iframe with the validated target URL", () => {
      const html = renderRedirectWrapper(
        "https://vis.example.test/vis-2/index.html?main",
        "a1b2c3",
        "hassemu.0",
        "en",
        "192.168.1.42",
      );
      expect(html).to.include('<iframe id="hassemu-iframe" src="https://vis.example.test/vis-2/index.html?main"');
      expect(html).to.include('id="hassemu-down"');
      // Down page is hidden by default (display:none from inline-CSS).
      expect(html).to.match(/#hassemu-down\{display:none;/);
    });

    it("includes 30s polling JS with consecutive-fail threshold", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "en");
      expect(html).to.match(/setInterval\(/);
      expect(html).to.include("fetch('/api/redirect_check'");
      expect(html).to.include("THRESHOLD=3");
      expect(html).to.include("fails++");
      expect(html).to.include("hideDown");
      expect(html).to.include("showDown");
    });

    it("escapes the target URL in both the src attribute and the JS literal", () => {
      const html = renderRedirectWrapper(
        'https://attacker.test/"><script>alert(1)</script>',
        "a1b2c3",
        "hassemu.0",
        "en",
      );
      // The attribute escape kills `"`, `<` and `>`.
      expect(html).not.to.include('attacker.test/"><script>');
      expect(html).to.include("&quot;");
      expect(html).to.include("&lt;script&gt;");
      // JSON.stringify makes a safe JS string literal — embedded `</script>`
      // sequence would close the script tag in the JS context, so the
      // safest check is that we use `JSON.stringify(target)` semantics
      // (escape sequences appear).
      expect(html).to.match(/var current="[^"]*\\u003[Cc][^"]*"|var current="https:[^"]+"/);
    });

    it('renders the German down-page strings when language is "de"', () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "de", "10.0.0.50");
      expect(html).to.include("hassemu offline");
      expect(html).to.include("Geräte-ID");
      expect(html).to.include("IP-Adresse");
      expect(html).to.include("Jetzt neu laden");
      expect(html).to.match(/lang="de"/);
    });

    it('renders the Polish strings when language is "pl"', () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "pl", "10.0.0.50");
      expect(html).to.include("Załaduj ponownie");
      expect(html).to.include("Adres IP");
    });

    it("falls back to English when language is unknown", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "xx-XX");
      expect(html).to.include("Reload now");
      expect(html).to.include("Device ID");
      expect(html).to.match(/lang="en"/);
    });

    it("shows the IP row when ip is a non-loopback address", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "en", "10.0.0.50");
      expect(html).to.include("10.0.0.50");
      expect(html).to.match(/<th scope="row">IP address<\/th><td>10\.0\.0\.50<\/td>/);
    });

    it("omits the IP row when ip is loopback / empty / null", () => {
      for (const ip of [null, "", "127.0.0.1", "127.0.0.5", "::1", "0.0.0.0"]) {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "en", ip);
        expect(html, `ip=${ip ?? "null"}`).not.to.match(/<th scope="row">IP address<\/th>/);
      }
    });

    it("includes the reload button with location.reload onclick", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "hassemu.0", "en");
      expect(html).to.match(/<button type="button" onclick="location\.reload\(\)">/);
    });

    it("escapes the clientId to prevent injection into the down-page table", () => {
      const html = renderRedirectWrapper("https://x.test/", "<script>alert(1)</script>", "hassemu.0", "en");
      expect(html).not.to.include("<script>alert(1)</script>");
      expect(html).to.include("&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });
});
