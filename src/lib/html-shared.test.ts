import {
  cardTableCss,
  escapeHtml,
  htmlLangFor,
  isLoopbackIp,
  jsStringLiteral,
  renderIdRow,
  renderIpRow,
  SUPPORTED_LANGS,
} from "./html-shared";

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

  describe("renderIdRow", () => {
    it("renders an escaped <tr> with the id in a <code> cell", () => {
      expect(renderIdRow("Device ID", "a4b9c2")).to.equal(
        '<tr><th scope="row">Device ID</th><td><code>a4b9c2</code></td></tr>',
      );
    });

    it("escapes both the label and the id value", () => {
      const row = renderIdRow("<b>ID</b>", "x<script>");
      expect(row).to.include("&lt;b&gt;ID&lt;/b&gt;");
      expect(row).to.include("x&lt;script&gt;");
      expect(row).to.not.include("<script>");
    });
  });

  describe("escapeHtml", () => {
    it("escapes the 5 HTML-special characters", () => {
      expect(escapeHtml('<script>alert("x\'y")</script>&')).to.equal(
        "&lt;script&gt;alert(&quot;x&#39;y&quot;)&lt;/script&gt;&amp;",
      );
    });

    it("returns input unchanged when no special chars", () => {
      expect(escapeHtml("plain text 123")).to.equal("plain text 123");
    });

    it("escapes apostrophe (defense-in-depth for href='...' attributes)", () => {
      expect(escapeHtml("a'b")).to.equal("a&#39;b");
    });
  });

  describe("jsStringLiteral", () => {
    it("produces a valid JS string literal", () => {
      expect(jsStringLiteral("http://x/")).to.equal('"http://x/"');
    });

    it("neutralises a </script> breakout so it cannot close the inline script", () => {
      const lit = jsStringLiteral("http://x/</script><script>alert(1)");
      expect(lit).to.not.include("</script>");
      expect(lit).to.include("\\u003C/script>");
    });

    it("escapes every < to its unicode escape", () => {
      expect(jsStringLiteral("<a<b<c")).to.equal('"\\u003Ca\\u003Cb\\u003Cc"');
    });
  });

  describe("cardTableCss (L21)", () => {
    const landing = cardTableCss(
      { card: "main", content: ".content", table: ".info", cell: ".info" },
      {
        cardBg: "var(--card-bg)",
        shadow: "var(--shadow)",
        border: "var(--border)",
        thColor: "var(--muted)",
        codeBg: "var(--code-bg)",
      },
    );
    const down = cardTableCss(
      {
        card: "#hassemu-down .card",
        content: "#hassemu-down .content",
        table: "#hassemu-down table",
        cell: "#hassemu-down",
      },
      {
        cardBg: "#1e293b",
        shadow: "0 4px 18px rgba(0,0,0,.35)",
        border: "#334155",
        thColor: "#94a3b8",
        codeBg: "#0f172a",
      },
    );

    it("emits the card shell with the given selector + tokens (landing)", () => {
      expect(landing).to.include("main {");
      expect(landing).to.include("max-width: 44rem;");
      expect(landing).to.include("background: var(--card-bg);");
      expect(landing).to.include("box-shadow: var(--shadow);");
      expect(landing).to.include("border-radius: 12px;");
    });

    it("scopes the table + code chip to the cell selector (landing uses .info)", () => {
      expect(landing).to.include(".info th, .info td {");
      expect(landing).to.include("border-bottom: 1px solid var(--border);");
      expect(landing).to.include(".info code {");
      expect(landing).to.include("background: var(--code-bg);");
      expect(landing).to.include("font-family: ui-monospace, SFMono-Regular, Menlo, monospace;");
    });

    it("re-scopes cleanly for the down page with literal error-theme colors", () => {
      expect(down).to.include("#hassemu-down .card {");
      expect(down).to.include("#hassemu-down th, #hassemu-down td {");
      expect(down).to.include("border-bottom: 1px solid #334155;");
      expect(down).to.include("#hassemu-down code {");
      expect(down).to.include("background: #0f172a;");
      // identical structure across both pages — only selectors + colors differ
      expect(down).to.include("max-width: 44rem;");
      expect(down).to.include("border-radius: 12px;");
    });

    it("emits no landing var(--…) token in the down page and vice versa", () => {
      expect(down).to.not.include("var(--");
      expect(landing).to.not.include("#hassemu-down");
    });
  });
});
