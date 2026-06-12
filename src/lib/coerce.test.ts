import {
  coerceFiniteNumber,
  coerceString,
  coerceBoolean,
  coerceUuid,
  coerceSafeUrl,
  decideGcAction,
  decideLegacyVisMigration,
  escapeHtml,
  evictOldest,
  isPlainObject,
  isValidRedirectUri,
  safeStringEqual,
} from "./coerce";

describe("coerce", () => {
  describe("coerceFiniteNumber", () => {
    it("accepts finite numbers", () => {
      expect(coerceFiniteNumber(0)).to.equal(0);
      expect(coerceFiniteNumber(42)).to.equal(42);
      expect(coerceFiniteNumber(-3.14)).to.equal(-3.14);
    });

    it("parses numeric strings", () => {
      expect(coerceFiniteNumber("42")).to.equal(42);
      expect(coerceFiniteNumber("-3.14")).to.equal(-3.14);
    });

    it("rejects NaN and Infinity", () => {
      expect(coerceFiniteNumber(NaN)).to.be.null;
      expect(coerceFiniteNumber(Infinity)).to.be.null;
      expect(coerceFiniteNumber(-Infinity)).to.be.null;
    });

    it("rejects empty string", () => {
      expect(coerceFiniteNumber("")).to.be.null;
    });

    it("rejects non-numeric strings", () => {
      expect(coerceFiniteNumber("abc")).to.be.null;
      expect(coerceFiniteNumber("12abc")).to.be.null;
    });

    it("rejects null / undefined / objects / arrays / booleans", () => {
      expect(coerceFiniteNumber(null)).to.be.null;
      expect(coerceFiniteNumber(undefined)).to.be.null;
      expect(coerceFiniteNumber({})).to.be.null;
      expect(coerceFiniteNumber([1])).to.be.null;
      expect(coerceFiniteNumber(true)).to.be.null;
    });
  });

  describe("coerceString", () => {
    it("accepts non-empty strings", () => {
      expect(coerceString("hello")).to.equal("hello");
      expect(coerceString(" ")).to.equal(" ");
    });

    it("rejects empty string", () => {
      expect(coerceString("")).to.be.null;
    });

    it("rejects non-strings", () => {
      expect(coerceString(42)).to.be.null;
      expect(coerceString(null)).to.be.null;
      expect(coerceString(undefined)).to.be.null;
      expect(coerceString({})).to.be.null;
      expect(coerceString([])).to.be.null;
      expect(coerceString(true)).to.be.null;
    });
  });

  describe("coerceBoolean", () => {
    it("accepts true and false", () => {
      expect(coerceBoolean(true)).to.equal(true);
      expect(coerceBoolean(false)).to.equal(false);
    });

    it("rejects truthy / falsy non-booleans", () => {
      expect(coerceBoolean(1)).to.be.null;
      expect(coerceBoolean(0)).to.be.null;
      expect(coerceBoolean("true")).to.be.null;
      expect(coerceBoolean("false")).to.be.null;
      expect(coerceBoolean("")).to.be.null;
      expect(coerceBoolean(null)).to.be.null;
      expect(coerceBoolean(undefined)).to.be.null;
      expect(coerceBoolean({})).to.be.null;
    });
  });

  describe("isPlainObject", () => {
    it("accepts plain objects", () => {
      expect(isPlainObject({})).to.be.true;
      expect(isPlainObject({ a: 1 })).to.be.true;
      expect(isPlainObject(Object.create(null))).to.be.true;
    });

    it("rejects arrays", () => {
      expect(isPlainObject([])).to.be.false;
      expect(isPlainObject([1, 2])).to.be.false;
    });

    it("rejects null / undefined / primitives", () => {
      expect(isPlainObject(null)).to.be.false;
      expect(isPlainObject(undefined)).to.be.false;
      expect(isPlainObject(42)).to.be.false;
      expect(isPlainObject("str")).to.be.false;
      expect(isPlainObject(true)).to.be.false;
    });
  });

  describe("coerceUuid", () => {
    it("accepts valid UUIDs (any version)", () => {
      expect(coerceUuid("12345678-1234-1234-1234-123456789abc")).to.equal("12345678-1234-1234-1234-123456789abc");
      expect(coerceUuid("abcdef12-3456-4789-abcd-ef1234567890")).to.equal("abcdef12-3456-4789-abcd-ef1234567890");
    });

    it("lowercases the output", () => {
      expect(coerceUuid("ABCDEF12-3456-4789-ABCD-EF1234567890")).to.equal("abcdef12-3456-4789-abcd-ef1234567890");
    });

    it("rejects malformed strings", () => {
      expect(coerceUuid("not-a-uuid")).to.be.null;
      expect(coerceUuid("")).to.be.null;
      expect(coerceUuid("12345678-1234-1234-1234")).to.be.null;
      expect(coerceUuid("12345678-1234-1234-1234-123456789abcZ")).to.be.null;
    });

    it("rejects non-strings", () => {
      expect(coerceUuid(null)).to.be.null;
      expect(coerceUuid(42)).to.be.null;
      expect(coerceUuid({})).to.be.null;
      expect(coerceUuid([])).to.be.null;
    });
  });

  describe("coerceSafeUrl", () => {
    it("accepts http and https URLs", () => {
      expect(coerceSafeUrl("http://example.com")).to.equal("http://example.com");
      expect(coerceSafeUrl("https://example.com/path")).to.equal("https://example.com/path");
      expect(coerceSafeUrl("http://192.168.1.10:8082/vis/")).to.equal("http://192.168.1.10:8082/vis/");
    });

    it("rejects dangerous schemes", () => {
      expect(coerceSafeUrl("javascript:alert(1)")).to.be.null;
      expect(coerceSafeUrl("data:text/html,<script>")).to.be.null;
      expect(coerceSafeUrl("file:///etc/passwd")).to.be.null;
      expect(coerceSafeUrl("ftp://example.com")).to.be.null;
    });

    it("rejects URLs with embedded credentials", () => {
      expect(coerceSafeUrl("http://user:pass@example.com")).to.be.null;
      expect(coerceSafeUrl("https://admin@example.com")).to.be.null;
    });

    it("rejects unparseable strings", () => {
      expect(coerceSafeUrl("not a url")).to.be.null;
      expect(coerceSafeUrl("http://")).to.be.null;
      expect(coerceSafeUrl("://example.com")).to.be.null;
    });

    it("rejects empty and overlong strings", () => {
      expect(coerceSafeUrl("")).to.be.null;
      const longUrl = `http://example.com/${"a".repeat(2048)}`;
      expect(coerceSafeUrl(longUrl)).to.be.null;
    });

    it("rejects non-strings", () => {
      expect(coerceSafeUrl(null)).to.be.null;
      expect(coerceSafeUrl(42)).to.be.null;
      expect(coerceSafeUrl({})).to.be.null;
    });
  });

  describe("coerceSafeUrl (rejection branches)", () => {
    // Every rejection branch (bad scheme, credentials, unparseable, length)
    // is exercised through the public coerceSafeUrl boundary validator.
    it("returns the URL for OK URLs", () => {
      expect(coerceSafeUrl("http://example.com/")).to.equal("http://example.com/");
    });

    it("rejects javascript: scheme", () => {
      expect(coerceSafeUrl("javascript:alert(1)")).to.be.null;
    });

    it("rejects data: scheme", () => {
      expect(coerceSafeUrl("data:text/html,<script>x</script>")).to.be.null;
    });

    it("rejects credentials-in-url (user:pass)", () => {
      expect(coerceSafeUrl("https://user:pass@example.com/")).to.be.null;
    });

    it("rejects unparseable strings", () => {
      expect(coerceSafeUrl("not a url")).to.be.null;
    });

    it("rejects empty string", () => {
      expect(coerceSafeUrl("")).to.be.null;
    });

    it("rejects >2048 chars", () => {
      expect(coerceSafeUrl("http://x.com/" + "a".repeat(2050))).to.be.null;
    });

    it("rejects non-strings", () => {
      expect(coerceSafeUrl(42)).to.be.null;
    });
  });

  describe("decideGcAction (J1 v1.25.0)", () => {
    const TTL = 30 * 24 * 60 * 60 * 1000;
    it("returns seed for missing/undefined lastSeen", () => {
      expect(decideGcAction(undefined, 1_000_000, TTL)).to.equal("seed");
      expect(decideGcAction(null, 1_000_000, TTL)).to.equal("seed");
      expect(decideGcAction(0, 1_000_000, TTL)).to.equal("seed");
    });

    it("returns seed for non-number values (string, object)", () => {
      expect(decideGcAction("1234567", 1_000_000, TTL)).to.equal("seed");
      expect(decideGcAction({}, 1_000_000, TTL)).to.equal("seed");
      expect(decideGcAction(NaN, 1_000_000, TTL)).to.equal("seed");
    });

    it("returns stale when now-lastSeen > ttl", () => {
      const now = Date.now();
      const oldLastSeen = now - TTL - 1; // just past the TTL
      expect(decideGcAction(oldLastSeen, now, TTL)).to.equal("stale");
    });

    it("returns keep when within window", () => {
      const now = Date.now();
      expect(decideGcAction(now - 1000, now, TTL)).to.equal("keep");
      expect(decideGcAction(now - TTL + 1, now, TTL)).to.equal("keep");
    });
  });

  describe("decideLegacyVisMigration (J2 v1.25.0)", () => {
    it("returns empty for undefined/null/empty-string", () => {
      expect(decideLegacyVisMigration(undefined).kind).to.equal("empty");
      expect(decideLegacyVisMigration(null).kind).to.equal("empty");
      expect(decideLegacyVisMigration("").kind).to.equal("empty");
    });

    it("returns safe-url for http/https URLs", () => {
      const r = decideLegacyVisMigration("https://example.com/");
      expect(r.kind).to.equal("safe-url");
      if (r.kind === "safe-url") {
        expect(r.safe).to.equal("https://example.com/");
      }
    });

    it("returns unsafe-rejected for javascript: scheme", () => {
      expect(decideLegacyVisMigration("javascript:alert(1)").kind).to.equal("unsafe-rejected");
    });

    it("returns unsafe-rejected for data: URLs", () => {
      expect(decideLegacyVisMigration("data:text/html,<script>x</script>").kind).to.equal("unsafe-rejected");
    });

    it("returns unsafe-rejected for credentials in URL", () => {
      expect(decideLegacyVisMigration("https://user:pass@example.com/").kind).to.equal("unsafe-rejected");
    });

    it("returns unsafe-rejected for non-string types", () => {
      expect(decideLegacyVisMigration(42).kind).to.equal("unsafe-rejected");
      expect(decideLegacyVisMigration({}).kind).to.equal("unsafe-rejected");
    });
  });

  describe("safeStringEqual (F5 v1.22.0)", () => {
    it("returns true for identical strings", () => {
      expect(safeStringEqual("admin", "admin")).to.be.true;
    });

    it("returns false for different strings of same length", () => {
      expect(safeStringEqual("admin", "admit")).to.be.false;
    });

    it("returns false for different lengths (no length-leak via early-return)", () => {
      expect(safeStringEqual("admin", "administrator")).to.be.false;
      expect(safeStringEqual("a", "aaaaaaaaaa")).to.be.false;
    });

    it("returns true for empty strings", () => {
      expect(safeStringEqual("", "")).to.be.true;
    });

    it("handles UTF-8 correctly", () => {
      expect(safeStringEqual("Häuser", "Häuser")).to.be.true;
      expect(safeStringEqual("Häuser", "Hauser")).to.be.false;
    });
  });

  describe("isValidRedirectUri (OAuth2, v1.29.0)", () => {
    // Source: home-assistant/core indieauth.py:verify_redirect_uri.
    // Detail in Ressourcen/hassemu/oauth2-browser-flow-shelly-fw26.md.

    it("accepts HA Companion iOS callback", () => {
      expect(isValidRedirectUri("https://home-assistant.io/iOS", "homeassistant://auth-callback")).to.be.true;
    });

    it("accepts HA Companion Android callback", () => {
      expect(isValidRedirectUri("https://home-assistant.io/android", "homeassistant://auth-callback")).to.be.true;
    });

    it("accepts Wear OS callbacks for Android client", () => {
      expect(
        isValidRedirectUri(
          "https://home-assistant.io/android",
          "https://wear.googleapis.com/3p_auth/io.homeassistant.companion.android",
        ),
      ).to.be.true;
      expect(
        isValidRedirectUri(
          "https://home-assistant.io/android",
          "https://wear.googleapis-cn.com/3p_auth/io.homeassistant.companion.android",
        ),
      ).to.be.true;
    });

    it("rejects swapping iOS callback into android client and vice versa", () => {
      // Same callback URL but wrong client_id — still rejected.
      expect(
        isValidRedirectUri(
          "https://home-assistant.io/iOS",
          "https://wear.googleapis.com/3p_auth/io.homeassistant.companion.android",
        ),
      ).to.be.false;
    });

    it("accepts same scheme + netloc per default IndieAuth rule", () => {
      expect(isValidRedirectUri("http://10.0.0.1:8123/", "http://10.0.0.1:8123/cb")).to.be.true;
      expect(isValidRedirectUri("http://10.0.0.1:8123/foo", "http://10.0.0.1:8123/bar")).to.be.true;
    });

    it("rejects different host on http(s) (open-redirect guard)", () => {
      expect(isValidRedirectUri("http://10.0.0.1:8123/", "http://attacker.example.com/cb")).to.be.false;
    });

    it("rejects different port on http(s)", () => {
      expect(isValidRedirectUri("http://10.0.0.1:8123/", "http://10.0.0.1:9999/cb")).to.be.false;
    });

    it("rejects javascript: scheme regardless of whitelist match", () => {
      expect(isValidRedirectUri("https://home-assistant.io/android", "javascript:alert(1)")).to.be.false;
    });

    it("rejects data: scheme", () => {
      expect(isValidRedirectUri("https://home-assistant.io/android", "data:text/html,<script>x</script>")).to.be.false;
    });

    it("rejects vbscript: and file: schemes", () => {
      expect(isValidRedirectUri("https://home-assistant.io/android", "vbscript:Msgbox")).to.be.false;
      expect(isValidRedirectUri("http://10.0.0.1:8123/", "file:///etc/passwd")).to.be.false;
    });

    it("rejects mixed-case dangerous schemes", () => {
      // Case-insensitive scheme check — `JavaScript:` is just as dangerous.
      expect(isValidRedirectUri("https://home-assistant.io/android", "JavaScript:alert(1)")).to.be.false;
      expect(isValidRedirectUri("https://home-assistant.io/android", "DATA:text/html,x")).to.be.false;
    });

    it("rejects empty / non-string / oversized inputs", () => {
      expect(isValidRedirectUri("", "homeassistant://auth-callback")).to.be.false;
      expect(isValidRedirectUri("https://home-assistant.io/android", "")).to.be.false;
      expect(isValidRedirectUri(null as unknown as string, "x")).to.be.false;
      expect(isValidRedirectUri("x", undefined as unknown as string)).to.be.false;
      expect(isValidRedirectUri("https://home-assistant.io/android", "homeassistant://" + "a".repeat(3000))).to.be
        .false;
    });

    it("rejects custom-scheme redirects for non-whitelisted clients", () => {
      // A self-hosted client with `client_id=http://10.0.0.1:8123/` cannot
      // request `homeassistant://auth-callback` — that's reserved for the
      // Companion App. Defense against client-spoofing.
      expect(isValidRedirectUri("http://10.0.0.1:8123/", "homeassistant://auth-callback")).to.be.false;
    });
  });

  describe("evictOldest", () => {
    it("does nothing on empty map", () => {
      const m = new Map<string, number>();
      evictOldest(m, 5);
      expect(m.size).to.equal(0);
    });

    it("evicts single oldest entry when at cap", () => {
      // Insertion order: a, b, c — at cap=3, next insert would push past;
      // pre-evict drops 'a' (oldest by insertion order).
      const m = new Map<string, number>([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);
      evictOldest(m, 3);
      expect([...m.keys()]).to.deep.equal(["b", "c"]);
    });

    it("while-loop evicts multiple when over cap", () => {
      // Defensive against bulk-insert past cap or lowered cap.
      // Loop runs while size >= cap, i.e. evicts until size < cap.
      // size=5, cap=3 → evicts a/b/c, leaves d/e.
      const m = new Map<string, number>([
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
        ["e", 5],
      ]);
      evictOldest(m, 3);
      expect([...m.keys()]).to.deep.equal(["d", "e"]);
    });

    it("handles cap=0 by emptying the map", () => {
      const m = new Map<string, number>([
        ["a", 1],
        ["b", 2],
      ]);
      evictOldest(m, 0);
      expect(m.size).to.equal(0);
    });

    it("is safe on map smaller than cap", () => {
      const m = new Map<string, number>([["a", 1]]);
      evictOldest(m, 5);
      expect([...m.keys()]).to.deep.equal(["a"]);
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
});
