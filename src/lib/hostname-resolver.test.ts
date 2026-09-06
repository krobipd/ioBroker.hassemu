import { shouldAttemptReverseDns } from "./hostname-resolver";

// The reverse-DNS skip decision. Pure, so the negative-cache window is testable without
// driving real DNS or timers (I8 v1.38.0). It moved here with the resolver in v1.43.0 —
// it was never boundary coercion, it is this module's own rule.
describe("hostname-resolver", () => {
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
});
