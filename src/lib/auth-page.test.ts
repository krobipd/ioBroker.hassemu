// The form/error pages now pull their copy from admin/i18n via adapter-core I18n
// (L7) — mock it to serve the real translations from the JSON files (same pattern as
// landing-page.test / webserver.test).
vi.mock("@iobroker/adapter-core", async () => {
  // The factory is hoisted above the imports — the shared translation lookup comes in here.
  const { realI18n } = await import("../../test/unit/i18n-stub.js");
  return { I18n: realI18n() };
});

import {
  AUTHORIZE_ERRORS,
  type AuthorizeErrorReason,
  buildRedirectUrl,
  renderAuthorizeError,
  renderAuthorizeForm,
  renderAuthorizeRedirect,
} from "./auth-page";

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

  describe("renderAuthorizeForm escapes user-controlled fields", () => {
    it("escapes client_id / redirect_uri / state in the hidden inputs", () => {
      const html = renderAuthorizeForm({
        clientId: 'x"><script>1</script>',
        redirectUri: 'y"><script>2</script>',
        state: 'z"><script>3</script>',
      });
      expect(html).to.not.include('"><script>');
      expect(html).to.include("&quot;&gt;&lt;script&gt;");
    });
  });

  describe("localizes the visible copy (L7)", () => {
    it("renders the login form in the requested language but keeps the Home Assistant brand", () => {
      const html = renderAuthorizeForm({ clientId: "c", redirectUri: "https://x/cb" }, undefined, "de");
      expect(html).to.include("Melde dich an, um dieses Display zu autorisieren."); // authSubtitle
      expect(html).to.include(">Anmelden</button>"); // authSignIn
      expect(html).to.include("<h1>Home Assistant</h1>"); // brand stays hardcoded
      expect(html).to.include('lang="de"');
    });

    it("renders a localized error title + user hint but keeps the technical reason", () => {
      const html = renderAuthorizeError("invalid_request", "de");
      expect(html).to.include("Autorisierung fehlgeschlagen"); // authErrorTitle
      expect(html).to.include("Bitte prüfe die Server-Adresse"); // authErrorHint
      expect(html).to.include('<p class="subtitle">invalid_request</p>'); // technical reason retained for support
    });

    it("explains every error code in the system language, English by default (BS-5)", () => {
      const de: Record<AuthorizeErrorReason, string> = {
        unsupported_response_type: "Dieser Server nimmt nur Anmeldeanfragen mit response_type=code an.",
        invalid_request: "Der Anmeldeanfrage fehlt client_id oder redirect_uri, oder einer der beiden ist ungültig.",
        invalid_redirect_uri:
          "Die Adresse, zu der die Anmeldung zurückführen soll (redirect_uri), ist für diese App nicht erlaubt.",
      };
      for (const reason of Object.keys(AUTHORIZE_ERRORS) as AuthorizeErrorReason[]) {
        expect(renderAuthorizeError(reason, "de"), reason).to.include(`<div class="err">${de[reason]}</div>`);
      }
      expect(renderAuthorizeError("invalid_redirect_uri")).to.include(
        '<div class="err">The address the sign-in should return to (redirect_uri) is not allowed for this app.</div>',
      );
    });

    it("shows the sign-in line of the redirect page in the system language, English by default (BS-3)", () => {
      const de = renderAuthorizeRedirect("homeassistant://auth-callback?code=c", "de");
      expect(de).to.include('<p class="loading">Anmeldung läuft…</p>');
      expect(de).to.include('lang="de"');
      expect(de).to.include("<h1>Home Assistant</h1>"); // brand stays hardcoded
      const en = renderAuthorizeRedirect("homeassistant://auth-callback?code=c");
      expect(en).to.include('<p class="loading">Signing in…</p>');
      expect(en).to.include('lang="en"');
    });
  });
});
