// The resolver's I/O runs against a mocked `dns.reverse` (audit 2026-09-15, F5): the
// class — lookup, sink, negative cache, deadline, prune, cap — had no test at all.
const { dnsReverse } = vi.hoisted(() => ({
  dnsReverse: vi.fn((_ip: string): Promise<string[]> => Promise.resolve([])),
}));
vi.mock("node:dns/promises", () => ({ default: { reverse: (ip: string) => dnsReverse(ip) } }));

import { HostnameResolver, shouldAttemptReverseDns } from "./hostname-resolver";
import { DNS_NEGATIVE_CACHE_CAP, DNS_NEGATIVE_CACHE_MS, DNS_REVERSE_TIMEOUT_MS } from "./constants";

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

  describe("resolve — the I/O behind the predicate", () => {
    type Timer = { cb: () => void; ms: number };
    /** A minimal adapter surface: logs collected, timers held so a test can fire the deadline. */
    function mockAdapter(): { adapter: never; timers: Timer[]; logs: string[] } {
      const timers: Timer[] = [];
      const logs: string[] = [];
      const adapter = {
        log: {
          silly: (m: string) => logs.push(`[silly] ${m}`),
          debug: (m: string) => logs.push(`[debug] ${m}`),
          info: (m: string) => logs.push(`[info] ${m}`),
          warn: (m: string) => logs.push(`[warn] ${m}`),
          error: (m: string) => logs.push(`[error] ${m}`),
        },
        setTimeout: (cb: () => void, ms: number) => {
          const timer = { cb, ms };
          timers.push(timer);
          return timer;
        },
        clearTimeout: (h: unknown) => {
          const i = timers.indexOf(h as Timer);
          if (i >= 0) {
            timers.splice(i, 1);
          }
        },
        setInterval: () => undefined,
        clearInterval: () => undefined,
      };
      return { adapter: adapter as never, timers, logs };
    }
    const target = (id = "abc123"): { id: string; cookie: string; hasHostname: boolean } => ({
      id,
      cookie: "11111111-1111-4111-8111-111111111111",
      hasHostname: false,
    });
    const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    beforeEach(() => {
      dnsReverse.mockReset();
      dnsReverse.mockImplementation(() => Promise.resolve([]));
    });

    it("hands a resolved name to the sink and clears the in-flight mark", async () => {
      const { adapter, timers } = mockAdapter();
      const sunk: Array<[string, string]> = [];
      const r = new HostnameResolver(adapter, (cookie, name) => {
        sunk.push([cookie, name]);
        return Promise.resolve();
      });
      dnsReverse.mockImplementation(() => Promise.resolve(["display.lan"]));

      r.resolve(target(), "10.0.0.5");
      expect(r.inFlightCount).to.equal(1);
      await settle();

      expect(sunk).to.deep.equal([[target().cookie, "display.lan"]]);
      expect(r.inFlightCount).to.equal(0);
      expect(timers, "the deadline timer is cleared once the lookup answered").to.have.lengthOf(0);
    });

    it("an empty answer (no PTR record) goes to the negative cache and is not retried inside the window", async () => {
      const { adapter } = mockAdapter();
      const sunk: string[] = [];
      const r = new HostnameResolver(adapter, (_c, name) => {
        sunk.push(name);
        return Promise.resolve();
      });

      r.resolve(target(), "10.0.0.6");
      await settle();
      r.resolve(target(), "10.0.0.6");
      await settle();

      expect(sunk).to.deep.equal([]);
      expect(dnsReverse).toHaveBeenCalledTimes(1);
    });

    it("a rejected lookup is cached like a miss, logged on debug, and the sink stays untouched", async () => {
      const { adapter, logs } = mockAdapter();
      const sunk: string[] = [];
      const r = new HostnameResolver(adapter, (_c, name) => {
        sunk.push(name);
        return Promise.resolve();
      });
      dnsReverse.mockImplementation(() => Promise.reject(new Error("ENOTFOUND")));

      r.resolve(target(), "10.0.0.7");
      await settle();
      r.resolve(target(), "10.0.0.7");
      await settle();

      expect(sunk).to.deep.equal([]);
      expect(dnsReverse).toHaveBeenCalledTimes(1);
      expect(logs.some(l => l.startsWith("[debug]") && l.includes("ENOTFOUND"))).to.be.true;
      expect(logs.some(l => l.startsWith("[warn]"))).to.be.false;
    });

    it("the deadline runs on the adapter timer: a resolver that never answers is given up on and cached", async () => {
      const { adapter, timers } = mockAdapter();
      const r = new HostnameResolver(adapter, () => Promise.resolve());
      dnsReverse.mockImplementation(() => new Promise<string[]>(() => {}));

      r.resolve(target(), "10.0.0.8");
      expect(timers).to.have.lengthOf(1);
      expect(timers[0].ms).to.equal(DNS_REVERSE_TIMEOUT_MS);
      timers[0].cb();
      await settle();

      expect(r.inFlightCount).to.equal(0);
      r.resolve(target(), "10.0.0.8");
      expect(dnsReverse, "cached as a miss after the deadline").toHaveBeenCalledTimes(1);
    });

    it("prune() drops only expired negative entries", async () => {
      const { adapter } = mockAdapter();
      const r = new HostnameResolver(adapter, () => Promise.resolve());
      const now = Date.now();
      const clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(now - DNS_NEGATIVE_CACHE_MS - 1);
      r.resolve(target(), "10.0.0.9");
      await settle();
      clock.mockReturnValue(now);
      r.resolve(target(), "10.0.0.10");
      await settle();
      clock.mockRestore();

      expect(r.prune(now)).to.equal(1);
      expect(r.prune(now)).to.equal(0);
    });

    it("a rejecting sink is swallowed on debug — a lookup must never throw into the request path", async () => {
      const { adapter, logs } = mockAdapter();
      const r = new HostnameResolver(adapter, () => Promise.reject(new Error("store gone")));
      dnsReverse.mockImplementation(() => Promise.resolve(["display.lan"]));

      r.resolve(target(), "10.0.0.11");
      await settle();
      await settle();

      expect(logs.some(l => l.startsWith("[debug]") && l.includes("store gone"))).to.be.true;
      expect(r.inFlightCount).to.equal(0);
    });

    it("the negative cache is capped — oldest entry out (D3)", async () => {
      // A device rotating its apparent IP per request (trustProxy without a sanitising
      // proxy) used to add one entry per request for an hour; this was the one map of
      // the adapter without a cap.
      const { adapter } = mockAdapter();
      const r = new HostnameResolver(adapter, () => Promise.resolve());
      for (let i = 0; i < DNS_NEGATIVE_CACHE_CAP + 50; i++) {
        r.resolve(target(), `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      }
      await settle();

      const cache = (r as unknown as { negativeCache: Map<string, number> }).negativeCache;
      expect(cache.size).to.equal(DNS_NEGATIVE_CACHE_CAP);
      expect(cache.has("10.0.0.0"), "the oldest entries were evicted").to.be.false;
      expect(cache.has(`10.0.${((DNS_NEGATIVE_CACHE_CAP + 49) >> 8) & 255}.${(DNS_NEGATIVE_CACHE_CAP + 49) & 255}`)).to
        .be.true;
    });
  });
});
