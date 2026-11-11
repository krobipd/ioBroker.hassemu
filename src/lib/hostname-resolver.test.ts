// The resolver's I/O runs against a mocked `dns.reverse` (audit 2026-09-15, F5): the
// class — lookup, sink, negative cache, deadline, prune, cap — had no test at all.
const { dnsReverse, resolverLocal, resolverReverse } = vi.hoisted(() => ({
  dnsReverse: vi.fn((_ip: string): Promise<string[]> => Promise.resolve([])),
  resolverLocal: [] as string[],
  resolverReverse: vi.fn((_ip: string): Promise<string[]> => Promise.resolve([])),
}));
vi.mock("node:dns/promises", () => ({
  default: {
    reverse: (ip: string) => dnsReverse(ip),
    Resolver: class {
      setLocalAddress(address: string): void {
        resolverLocal.push(address);
      }
      reverse(ip: string): Promise<string[]> {
        return resolverReverse(ip);
      }
    },
  },
}));

import { HostnameResolver, shouldAttemptReverseDns } from "./hostname-resolver";
import { DNS_NEGATIVE_CACHE_CAP, DNS_NEGATIVE_CACHE_MS, DNS_REVERSE_TIMEOUT_MS } from "./constants";

// The reverse-DNS skip decision. Pure, so the negative-cache window is testable without
// driving real DNS or timers (I8 v1.38.0). It moved here with the resolver in v1.43.0 —
// it was never boundary coercion, it is this module's own rule.
describe("hostname-resolver", () => {
  describe("shouldAttemptReverseDns (I8 v1.38.0)", () => {
    const TTL = 30_000;
    const base = { answered: false, inFlight: false, lastNegative: undefined, now: 100_000, negativeCacheMs: TTL };
    it("attempts when nothing blocks it", () => {
      expect(shouldAttemptReverseDns(base)).to.be.true;
    });
    it("skips when a lookup already named the client at this IP during this run (K7)", () => {
      expect(shouldAttemptReverseDns({ ...base, answered: true })).to.be.false;
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
    const target = (
      id = "abc123",
      cookie = "11111111-1111-4111-8111-111111111111",
    ): { id: string; cookie: string } => ({
      id,
      cookie,
    });
    const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    beforeEach(() => {
      dnsReverse.mockReset();
      dnsReverse.mockImplementation(() => Promise.resolve([]));
    });

    it("an answer that arrives after dispose() writes nothing and caches nothing (H12)", async () => {
      const { adapter, logs } = mockAdapter();
      const sunk: string[] = [];
      const r = new HostnameResolver(adapter, (_c, name) => {
        sunk.push(name);
        return Promise.resolve();
      });
      let answer = (_names: string[]): void => undefined;
      dnsReverse.mockImplementation(() => new Promise<string[]>(resolve => (answer = resolve)));

      r.resolve(target(), "10.0.0.6");
      r.dispose();
      answer(["display-kitchen.lan"]);
      await settle();

      expect(sunk).to.deep.equal([]);
      expect(r.negativeCacheSize).to.equal(0);
      expect(logs.some(l => l.includes("display-kitchen.lan"))).to.be.false;
      // And nothing new starts after the stop.
      r.resolve(target("other1"), "10.0.0.7");
      expect(r.inFlightCount).to.equal(0);
    });

    it("a lookup that fails after dispose() caches nothing and logs nothing (H12)", async () => {
      const { adapter, logs } = mockAdapter();
      const r = new HostnameResolver(adapter, () => Promise.resolve());
      let fail = (_err: Error): void => undefined;
      dnsReverse.mockImplementation(() => new Promise<string[]>((_resolve, reject) => (fail = reject)));

      r.resolve(target(), "10.0.0.8");
      r.dispose();
      fail(new Error("getHostByAddr ENOTFOUND 10.0.0.8"));
      await settle();

      expect(r.negativeCacheSize).to.equal(0);
      expect(logs.some(l => l.includes("10.0.0.8"))).to.be.false;
    });

    // The chosen address is the only one the adapter sends on (review 2026-11-07, R-20).
    it("with a chosen address the lookups go through a resolver bound to it", async () => {
      const { adapter } = mockAdapter();
      const sunk: string[] = [];
      resolverLocal.length = 0;
      resolverReverse.mockReset();
      resolverReverse.mockImplementation(() => Promise.resolve(["display.lan"]));
      dnsReverse.mockClear();
      const r = new HostnameResolver(
        adapter,
        (_cookie, name) => {
          sunk.push(name);
          return Promise.resolve();
        },
        "192.0.2.10",
      );

      r.resolve(target(), "10.0.0.6");
      await settle();

      expect(resolverLocal).to.deep.equal(["192.0.2.10"]);
      expect(resolverReverse).toHaveBeenCalledWith("10.0.0.6");
      expect(dnsReverse).not.toHaveBeenCalled();
      expect(sunk).to.deep.equal(["display.lan"]);
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

    // K7: the host name is stored and names the display from the start on, so a display that has one is looked up
    // again once per run — a name changed in the network arrives — but not on every poll; a new address asks anew.
    it("a display is looked up once per run and address, and again at a new address (K7)", async () => {
      const { adapter } = mockAdapter();
      const sunk: Array<[string, string]> = [];
      const r = new HostnameResolver(adapter, (cookie, name) => {
        sunk.push([cookie, name]);
        return Promise.resolve();
      });
      dnsReverse.mockImplementation(ip => Promise.resolve([ip === "10.0.0.5" ? "display.lan" : "display-new.lan"]));

      r.resolve(target(), "10.0.0.5");
      await settle();
      r.resolve(target(), "10.0.0.5");
      await settle();
      expect(dnsReverse, "the same display at the same address is not asked again").toHaveBeenCalledTimes(1);

      r.resolve(target("other1", "22222222-2222-4222-8222-222222222222"), "10.0.0.5");
      await settle();
      expect(dnsReverse, "another display at that address is asked for itself").toHaveBeenCalledTimes(2);

      r.resolve(target(), "10.0.0.6");
      await settle();
      expect(dnsReverse, "a new address is asked anew").toHaveBeenCalledTimes(3);
      expect(sunk.map(([, name]) => name)).to.deep.equal(["display.lan", "display.lan", "display-new.lan"]);
    });

    it("a new resolver (the next run) asks again for a display it named before (K7)", async () => {
      const { adapter } = mockAdapter();
      const sunk: string[] = [];
      const sink = (_c: string, name: string): Promise<void> => {
        sunk.push(name);
        return Promise.resolve();
      };
      dnsReverse.mockImplementation(() => Promise.resolve(["display.lan"]));
      const first = new HostnameResolver(adapter, sink);
      first.resolve(target(), "10.0.0.5");
      await settle();
      first.dispose();

      new HostnameResolver(adapter, sink).resolve(target(), "10.0.0.5");
      await settle();

      expect(dnsReverse).toHaveBeenCalledTimes(2);
      expect(sunk).to.deep.equal(["display.lan", "display.lan"]);
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

      expect(sunk, "a failure never reaches the sink, so a stored host name stays (K7)").to.deep.equal([]);
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

    it("the run memory of named displays is capped — oldest entry out (K7)", async () => {
      const { adapter } = mockAdapter();
      const r = new HostnameResolver(adapter, () => Promise.resolve());
      dnsReverse.mockImplementation(() => Promise.resolve(["display.lan"]));
      const cookie = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      const ip = (i: number): string => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      for (let i = 0; i < DNS_NEGATIVE_CACHE_CAP + 50; i++) {
        r.resolve(target(`d${i}`, cookie(i)), ip(i));
      }
      await settle();

      const answered = (r as unknown as { answered: Map<string, string> }).answered;
      expect(answered.size).to.equal(DNS_NEGATIVE_CACHE_CAP);
      expect(answered.has(cookie(0)), "the oldest entries were evicted").to.be.false;
      expect(answered.get(cookie(DNS_NEGATIVE_CACHE_CAP + 49))).to.equal(ip(DNS_NEGATIVE_CACHE_CAP + 49));
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
