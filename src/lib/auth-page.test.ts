import { buildRedirectUrl, renderAuthorizeError, renderAuthorizeForm, renderAuthorizeRedirect } from "./auth-page";

describe("auth-page", () => {
  describe("buildRedirectUrl", () => {
    it("appends code (and state) with the correct separator and URL-encoding", () => {
      expect(buildRedirectUrl("https://x/cb", "the code", undefined)).to.equal("https://x/cb?code=the%20code");
      expect(buildRedirectUrl("https://x/cb?foo=1", "c", "s")).to.equal("https://x/cb?foo=1&code=c&state=s");
      expect(buildRedirectUrl("homeassistant://auth-callback", "c", "s")).to.equal(
        "homeassistant://auth-callback?code=c&state=s",
      );
    });
  });

  describe("renderAuthorizeRedirect (C3 inline-script sink)", () => {
    it("neutralizes </script> in the target so it cannot break out of the inline <script> (v1.36.0 C3)", () => {
      const target = "https://10.0.0.1:8123/a</script><script>alert(1)</script>?code=abc";
      const html = renderAuthorizeRedirect(target);
      const line = html.split("\n").find(l => l.includes("document.location.assign"))!;
      // The inline `document.location.assign(...)` argument must not contain a raw
      // `</script>` — at the HTML-tokenizer level that closes the <script> regardless
      // of JS string nesting. Only the legit trailing </script> of the block may
      // remain on the (single-line) script; the target's two </script> must be
      // escaped to </script. JSON.stringify does NOT escape `<`; the replace does.
      expect((line.match(/<\/script>/g) || []).length).to.equal(1);
      expect(line).to.include("\\u003C/script");
      // The <meta http-equiv="refresh"> fallback is HTML-attribute-escaped (escapeHtml).
      expect(html).to.include("&lt;/script&gt;");
    });
  });

  describe("renderAuthorizeForm / renderAuthorizeError escape user-controlled fields", () => {
    it("escapes client_id / redirect_uri / state in the hidden inputs", () => {
      const html = renderAuthorizeForm({
        clientId: 'x"><script>1</script>',
        redirectUri: 'y"><script>2</script>',
        state: 'z"><script>3</script>',
      });
      expect(html).to.not.include('"><script>');
      expect(html).to.include("&quot;&gt;&lt;script&gt;");
    });

    it("escapes reason / detail on the error page", () => {
      const html = renderAuthorizeError("inv<script>", "bad <b>thing</b>");
      expect(html).to.not.include("<script>");
      expect(html).to.include("&lt;script&gt;");
    });
  });
});
