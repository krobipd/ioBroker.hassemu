import { generateClientId, getLocalIp, isWildcardBind, resolveAdvertisedHost } from "./network";

describe("network", () => {
  describe("getLocalIp", () => {
    // The previous test for this lived as MDNSService.getLocalIP() — a
    // thin wrapper that was deleted in v1.30.0 (R8). Coverage migrated
    // here so getLocalIp() stays exercised directly without the wrapper.
    it("returns either a non-loopback IPv4, an IPv6, or the 127.0.0.1 fallback", () => {
      const ip = getLocalIp();
      expect(ip).to.be.a("string");
      // Accept IPv4 (most common), IPv6 (pure-v6 hosts), or loopback fallback
      const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
      const isIPv6 = ip.includes(":");
      expect(isIPv4 || isIPv6).to.be.true;
    });
  });

  describe("isWildcardBind", () => {
    it("treats falsy / 0.0.0.0 / :: as wildcard", () => {
      expect(isWildcardBind("")).to.be.true;
      expect(isWildcardBind(undefined)).to.be.true;
      expect(isWildcardBind(null)).to.be.true;
      expect(isWildcardBind("0.0.0.0")).to.be.true;
      expect(isWildcardBind("::")).to.be.true;
    });

    it("treats a specific bind address as non-wildcard", () => {
      expect(isWildcardBind("192.168.1.10")).to.be.false;
      expect(isWildcardBind("127.0.0.1")).to.be.false;
      expect(isWildcardBind("::1")).to.be.false;
    });
  });

  describe("resolveAdvertisedHost", () => {
    it("advertises a concrete bind address verbatim", () => {
      expect(resolveAdvertisedHost("192.168.1.10")).to.equal("192.168.1.10");
      expect(resolveAdvertisedHost("127.0.0.1")).to.equal("127.0.0.1");
      expect(resolveAdvertisedHost("::1")).to.equal("::1");
    });

    it("falls back to getLocalIp() for wildcard / empty binds — identical to before", () => {
      // Regression surface: almost every install runs a wildcard bind, so the
      // resolved host MUST stay exactly getLocalIp() for these — no behaviour
      // change vs. the previous unconditional getLocalIp() in mdns.ts.
      const local = getLocalIp();
      expect(resolveAdvertisedHost("")).to.equal(local);
      expect(resolveAdvertisedHost(undefined)).to.equal(local);
      expect(resolveAdvertisedHost(null)).to.equal(local);
      expect(resolveAdvertisedHost("0.0.0.0")).to.equal(local);
      expect(resolveAdvertisedHost("::")).to.equal(local);
    });
  });

  describe("generateClientId", () => {
    it("produces a 6-character lowercase hex string", () => {
      const id = generateClientId();
      expect(id).to.match(/^[0-9a-f]{6}$/);
    });

    it("produces different IDs on subsequent calls (crypto-random)", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateClientId());
      }
      // 100 random 6-hex IDs from a 16.7M-key space — collisions
      // statistically negligible. If this ever fails, RNG is broken.
      expect(ids.size).to.equal(100);
    });
  });
});
