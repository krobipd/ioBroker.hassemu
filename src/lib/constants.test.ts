import {
  HA_VERSION,
  SESSION_TTL_MS,
  CLEANUP_INTERVAL_MS,
  LOGIN_SCHEMA,
  OAUTH_ACCESS_TOKEN_TTL_S,
  NEW_CLIENT_WINDOW_MS,
  NEW_CLIENT_BURST_WARN_THRESHOLD,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  DNS_REVERSE_TIMEOUT_MS,
  DNS_NEGATIVE_CACHE_MS,
  LASTSEEN_FLUSH_INTERVAL_MS,
  STALE_CLIENT_TTL_MS,
} from "./constants";

describe("constants", () => {
  describe("HA_VERSION", () => {
    it("should be a valid HA-style version string (year.month.patch)", () => {
      expect(HA_VERSION).to.be.a("string");
      expect(HA_VERSION).to.match(/^\d{4}\.\d+\.\d+$/);
    });
  });

  describe("SESSION_TTL_MS", () => {
    it("is a millisecond-scale login window (guards against a seconds/ms unit mixup)", () => {
      expect(SESSION_TTL_MS).to.be.a("number");
      // A login flow must stay open long enough for a human (≥ 1 min) but not
      // leak sessions for hours. The band catches both a too-short value and a
      // seconds-as-ms fat-finger (e.g. 600 instead of 600_000) — the exact
      // tuning (currently 10 min) is free to change without breaking the test.
      expect(SESSION_TTL_MS).to.be.within(60 * 1000, 60 * 60 * 1000);
    });
  });

  describe("CLEANUP_INTERVAL_MS", () => {
    it("runs more often than the session lifetime, so expired sessions are reaped within one TTL", () => {
      // The real invariant: if cleanup ran less often than the TTL, an expired
      // session could linger for up to a full extra TTL before being swept.
      expect(CLEANUP_INTERVAL_MS).to.be.lessThan(SESSION_TTL_MS);
    });
  });

  describe("LOGIN_SCHEMA", () => {
    it("should have username and password fields", () => {
      expect(LOGIN_SCHEMA).to.have.lengthOf(2);

      const usernameField = LOGIN_SCHEMA.find(f => f.name === "username");
      const passwordField = LOGIN_SCHEMA.find(f => f.name === "password");

      expect(usernameField).to.exist;
      expect(passwordField).to.exist;
    });

    it("should have required fields", () => {
      for (const field of LOGIN_SCHEMA) {
        expect(field.required).to.be.true;
        expect(field.type).to.equal("string");
      }
    });
  });

  describe("OAUTH_ACCESS_TOKEN_TTL_S", () => {
    it("is a second-scale token lifetime (guards against an ms/seconds unit mixup)", () => {
      expect(OAUTH_ACCESS_TOKEN_TTL_S).to.be.a("number");
      // Expressed in SECONDS (the _S suffix) — the HA Android Companion refreshes
      // its access token on this cadence (AuthenticationRepositoryImpl). A value
      // from a minute up to a day is sane; an ms-scale value (e.g. 1_800_000) is the bug.
      expect(OAUTH_ACCESS_TOKEN_TTL_S).to.be.within(60, 24 * 60 * 60);
    });
  });

  describe("new-client throttle ladder", () => {
    it("warns before it throttles (burst-warn threshold below the throttle)", () => {
      // The two thresholds form one escalation ladder: warn at >BURST_WARN,
      // stop minting persistent clients at THROTTLE. If the warn rung were at or
      // above the throttle it could never fire before the throttle kicks in.
      expect(NEW_CLIENT_BURST_WARN_THRESHOLD).to.be.lessThan(NEW_CLIENT_THROTTLE_PER_HOUR);
      expect(NEW_CLIENT_BURST_WARN_THRESHOLD).to.be.greaterThan(0);
    });

    it("uses a millisecond-scale rolling window (guards a seconds/ms mixup)", () => {
      expect(NEW_CLIENT_WINDOW_MS).to.be.within(60 * 1000, 24 * 60 * 60 * 1000);
    });
  });

  describe("DNS timing windows", () => {
    it("reverse-lookup timeout is a short millisecond-scale deadline", () => {
      expect(DNS_REVERSE_TIMEOUT_MS).to.be.within(1000, 30 * 1000);
    });

    it("negative-cache window is far longer than the lookup timeout", () => {
      // A negative cache only helps if it outlasts the lookup by orders of
      // magnitude — otherwise it re-queries almost as often as before.
      expect(DNS_NEGATIVE_CACHE_MS).to.be.greaterThan(DNS_REVERSE_TIMEOUT_MS * 10);
    });
  });

  describe("LASTSEEN_FLUSH_INTERVAL_MS", () => {
    it("is a millisecond-scale throttle window shorter than the stale-client TTL", () => {
      expect(LASTSEEN_FLUSH_INTERVAL_MS).to.be.within(60 * 1000, 24 * 60 * 60 * 1000);
      // The real invariant: a display seen within the window must never look stale —
      // otherwise the GC could forget a display the throttle is still holding a write for.
      expect(LASTSEEN_FLUSH_INTERVAL_MS).to.be.lessThan(STALE_CLIENT_TTL_MS);
    });
  });

  it("HA_VERSION stays below 2026.8.0 — from there both Companion apps wait for `frontend/loaded`, which the wrapper never sends (U3)", () => {
    const [major, minor, patch] = HA_VERSION.split(".").map(Number);
    const cmp = major - 2026 || minor - 8 || patch - 0;
    expect(cmp).to.be.lessThan(0);
  });
});
