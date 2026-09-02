import { vi } from "vitest";
import type * as CryptoModule from "node:crypto";

/**
 * node:crypto passes through unchanged except for a timingSafeEqual counter —
 * the constant-time credential comparison is a security guarantee that is
 * invisible in the return value, so the test has to see the call itself.
 */
const cryptoCounters = vi.hoisted(() => ({ timingSafe: 0 }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof CryptoModule>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
    cryptoCounters.timingSafe++;
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

import {
  coerceFiniteNumber,
  coerceString,
  coerceBoolean,
  coerceUuid,
  coerceSafeUrl,
  decideGcAction,
  decideLegacyVisMigration,
  evictOldest,
  isEmptyValue,
  isPlainObject,
  isValidRedirectUri,
  oneLine,
  parseAdapterStateId,
  safeStringEqual,
  shallowStatesEqual,
  shouldAttemptReverseDns,
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
      expect(isValidRedirectUri("https://home-assistant.io/android", `homeassistant://${"a".repeat(3000)}`)).to.be
        .false;
    });

    it("rejects custom-scheme redirects for non-whitelisted clients", () => {
      // A self-hosted client with `client_id=http://10.0.0.1:8123/` cannot
      // request `homeassistant://auth-callback` — that's reserved for the
      // Companion App. Defense against client-spoofing.
      expect(isValidRedirectUri("http://10.0.0.1:8123/", "homeassistant://auth-callback")).to.be.false;
    });

    it("rejects control-char-obfuscated dangerous schemes (v1.36.0 C2 — parser differential)", () => {
      // `new URL()` strips tab/newline/CR anywhere, so a raw-string
      // `startsWith("javascript:")` blacklist was bypassable: a leading tab made
      // the prefix-check miss while the parsed protocol normalized to javascript:.
      // The parsed-protocol allowlist closes it (attacker controls client_id too).
      expect(isValidRedirectUri("javascript:x", "\tjavascript:alert(1)")).to.be.false;
      expect(isValidRedirectUri("javascript:x", "java\tscript:alert(1)")).to.be.false;
      expect(isValidRedirectUri("javascript:x", "\njavascript:alert(1)")).to.be.false;
      expect(isValidRedirectUri("data:x", "\rdata:text/html,x")).to.be.false;
    });

    it("rejects any non-http(s) scheme even when client_id matches it (v1.36.0 C2)", () => {
      expect(isValidRedirectUri("ftp://10.0.0.1/", "ftp://10.0.0.1/cb")).to.be.false;
      expect(isValidRedirectUri("ws://10.0.0.1:8123/", "ws://10.0.0.1:8123/cb")).to.be.false;
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

  describe("oneLine (S4 v1.36.0)", () => {
    it("collapses CR / LF / TAB runs to single spaces (log-injection guard)", () => {
      expect(oneLine("a\r\nb")).to.equal("a b");
      expect(oneLine("evil\nINFO 2026 forged log line")).to.equal("evil INFO 2026 forged log line");
      expect(oneLine("a\t\tb")).to.equal("a b");
    });

    it("collapses NUL, VT, FF and the Unicode line separators (v1.37.0 parcelapp parity)", () => {
      expect(oneLine("a\0b")).to.equal("a b");
      expect(oneLine("a\u2028b\u2029c")).to.equal("a b c");
      expect(oneLine("a b c")).to.equal("a b c");
    });

    it("leaves single-line input unchanged", () => {
      expect(oneLine("plain text 123")).to.equal("plain text 123");
      expect(oneLine("")).to.equal("");
    });
  });

  describe("isEmptyValue", () => {
    it("is true for empty string, null and undefined", () => {
      for (const v of ["", null, undefined]) {
        expect(isEmptyValue(v), `v=${String(v)}`).to.be.true;
      }
    });

    it("is false for any other value including 0 and whitespace", () => {
      for (const v of [0, "0", " ", "x", false, {}]) {
        expect(isEmptyValue(v), `v=${JSON.stringify(v)}`).to.be.false;
      }
    });
  });

  describe("shouldAttemptReverseDns (I8 v1.38.0)", () => {
    const TTL = 30_000;
    const base = { hasHostname: false, inFlight: false, lastNegative: undefined, now: 100_000, negativeCacheMs: TTL };
    it("attempts when nothing blocks it", () => {
      expect(shouldAttemptReverseDns(base)).to.be.true;
    });
    it("skips when the client already has a hostname", () => {
      expect(shouldAttemptReverseDns({ ...base, hasHostname: true })).to.be.false;
    });
    it("skips when a lookup is already in flight", () => {
      expect(shouldAttemptReverseDns({ ...base, inFlight: true })).to.be.false;
    });
    it("skips within the negative-cache window (recent no-PTR result)", () => {
      expect(shouldAttemptReverseDns({ ...base, lastNegative: base.now - (TTL - 1) })).to.be.false;
    });
    it("attempts again once the negative-cache window has lapsed", () => {
      expect(shouldAttemptReverseDns({ ...base, lastNegative: base.now - TTL })).to.be.true;
    });
  });
  describe("length caps + shapes without a test (mutation audit)", () => {
    it("rejects an over-long client_id / redirect_uri (2048-char cap)", () => {
      const long = `https://example.com/${"a".repeat(2100)}`;
      // Same host and scheme, so the IndieAuth rule itself would say yes —
      // only the cap stands between the log/state layer and a 2 kB payload.
      expect(isValidRedirectUri("https://example.com/app", long)).to.be.false;
      expect(isValidRedirectUri(long, "https://example.com/cb")).to.be.false;
      // Just under the cap is still accepted.
      const ok = `https://example.com/${"a".repeat(2000)}`;
      expect(isValidRedirectUri("https://example.com/app", ok)).to.be.true;
    });

    it("compares credentials in constant time, not with ===", () => {
      const before = cryptoCounters.timingSafe;
      expect(safeStringEqual("admin", "admin")).to.be.true;
      expect(safeStringEqual("admin", "wrong")).to.be.false;
      // A plain === would answer the same but leak the answer through timing —
      // the guarantee only exists if the comparison really goes through
      // crypto.timingSafeEqual.
      expect(cryptoCounters.timingSafe).to.equal(before + 2);
    });
  });

  describe("parseAdapterStateId", () => {
    const NS = "hassemu.0";

    it("splits a well-formed id into its parts", () => {
      expect(parseAdapterStateId(`${NS}.clients.abc.mode`, NS, "clients.", 2)).to.deep.equal(["abc", "mode"]);
    });

    it("rejects an id from a different namespace or prefix", () => {
      // Without this guard a write to another adapter's state would be parsed
      // and acted on as if it were ours.
      expect(parseAdapterStateId("other.0.clients.abc.mode", NS, "clients.", 2)).to.equal(null);
      expect(parseAdapterStateId(`${NS}.global.mode`, NS, "clients.", 2)).to.equal(null);
    });

    it("rejects an id with the wrong number of segments", () => {
      // Too few and too many both mean "not the state we think it is" — the
      // caller indexes the parts positionally.
      expect(parseAdapterStateId(`${NS}.clients.abc`, NS, "clients.", 2)).to.equal(null);
      expect(parseAdapterStateId(`${NS}.clients.abc.mode.extra`, NS, "clients.", 2)).to.equal(null);
    });
  });

  describe("shallowStatesEqual", () => {
    it("treats an equal map as unchanged regardless of key order", () => {
      expect(shallowStatesEqual({ b: "2", a: "1" }, { a: "1", b: "2" })).to.be.true;
    });

    it("reports a difference in value, key set or size", () => {
      expect(shallowStatesEqual({ a: "1" }, { a: "2" })).to.be.false;
      expect(shallowStatesEqual({ a: "1" }, { b: "1" })).to.be.false;
      // Fewer AND more keys — a size-blind comparison would call the first pair
      // equal and skip the dropdown rewrite, leaving a stale entry in the UI.
      expect(shallowStatesEqual({ a: "1" }, { a: "1", b: "2" })).to.be.false;
      expect(shallowStatesEqual({ a: "1", b: "2" }, { a: "1" })).to.be.false;
    });

    it("counts a malformed existing value as unequal so it gets repaired", () => {
      for (const broken of [null, undefined, "states", 42, ["a"]]) {
        expect(shallowStatesEqual(broken, { a: "1" }), String(broken)).to.be.false;
      }
    });
  });
});
