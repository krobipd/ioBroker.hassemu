import { htmlLangFor, isLoopbackIp, renderIpRow, SUPPORTED_LANGS } from "./html-shared";

describe("html-shared", () => {
  describe("htmlLangFor", () => {
    it("maps zh-cn to the zh-CN html lang tag, identity for the rest", () => {
      expect(htmlLangFor("zh-cn")).to.equal("zh-CN");
      for (const lang of SUPPORTED_LANGS) {
        if (lang === "zh-cn") {
          continue;
        }
        expect(htmlLangFor(lang), lang).to.equal(lang);
      }
    });

    it("falls back to en for unknown languages", () => {
      expect(htmlLangFor("klingon")).to.equal("en");
      expect(htmlLangFor("")).to.equal("en");
    });

    it("covers all 11 supported languages", () => {
      expect(SUPPORTED_LANGS).to.have.length(11);
    });
  });

  describe("isLoopbackIp", () => {
    it("treats empty, loopback and 0.0.0.0 as loopback (hidden)", () => {
      for (const ip of ["", "127.0.0.1", "127.0.0.5", "127.255.255.255", "::1", "0.0.0.0"]) {
        expect(isLoopbackIp(ip), `ip=${ip || "(empty)"}`).to.be.true;
      }
    });

    it("treats real LAN/WAN addresses as non-loopback (shown)", () => {
      for (const ip of ["10.0.0.50", "192.168.1.42", "172.16.0.1", "8.8.8.8"]) {
        expect(isLoopbackIp(ip), `ip=${ip}`).to.be.false;
      }
    });
  });

  describe("renderIpRow", () => {
    it("renders an escaped <tr> for a non-loopback IP", () => {
      const row = renderIpRow("IP address", "10.0.0.50");
      expect(row).to.equal('<tr><th scope="row">IP address</th><td>10.0.0.50</td></tr>');
    });

    it("trims the IP before rendering", () => {
      expect(renderIpRow("IP", "  10.0.0.50  ")).to.include("<td>10.0.0.50</td>");
    });

    it("returns an empty string for loopback / empty / null", () => {
      for (const ip of [null, "", "127.0.0.1", "::1", "0.0.0.0"]) {
        expect(renderIpRow("IP address", ip), `ip=${ip ?? "null"}`).to.equal("");
      }
    });

    it("escapes both the label and the IP value", () => {
      const row = renderIpRow("<b>L</b>", "1.2.3.4<script>");
      expect(row).to.include("&lt;b&gt;L&lt;/b&gt;");
      expect(row).to.include("1.2.3.4&lt;script&gt;");
      expect(row).to.not.include("<script>");
    });
  });
});
