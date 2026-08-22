import { vi } from "vitest";

/** os.networkInterfaces is swappable so the interface-priority rules are testable. */
const osMock = vi.hoisted(() => ({ interfaces: null as NodeJS.Dict<os.NetworkInterfaceInfo[]> | null }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> =>
    osMock.interfaces ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});

import type * as os from "node:os";
import { generateClientId, getLocalIp, isWildcardBind, resolveAdvertisedHost } from "./network";

/** Build one interface entry with only the fields getLocalIp reads. */
function iface(address: string, family: "IPv4" | "IPv6", internal = false): os.NetworkInterfaceInfo {
  return { address, family, internal, netmask: "", mac: "", cidr: null } as os.NetworkInterfaceInfo;
}

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

  describe("getLocalIp — interface priority (mutation audit)", () => {
    afterEach(() => {
      osMock.interfaces = null;
    });

    it("never advertises a loopback address when a real one exists", () => {
      // Order matters: the loopback comes first, so a missing internal-check
      // would hand out 127.0.0.1 and no display on the LAN could reach us.
      osMock.interfaces = {
        lo: [iface("127.0.0.1", "IPv4", true)],
        eth0: [iface("192.168.1.5", "IPv4")],
      };
      expect(getLocalIp()).to.equal("192.168.1.5");
    });

    it("prefers a LAN address over the Docker bridge, but falls back to it", () => {
      // docker0 first — advertising it via mDNS gives every display an address
      // that is unreachable from the LAN.
      osMock.interfaces = {
        docker0: [iface("172.17.0.1", "IPv4")],
        br1: [iface("172.18.0.1", "IPv4")],
        eth0: [iface("192.168.1.5", "IPv4")],
      };
      expect(getLocalIp()).to.equal("192.168.1.5");

      // Docker-only host: the bridge is better than nothing.
      osMock.interfaces = { docker0: [iface("172.17.0.1", "IPv4")] };
      expect(getLocalIp()).to.equal("172.17.0.1");

      // 172.16.x is a normal LAN range, NOT a Docker default bridge.
      osMock.interfaces = { eth0: [iface("172.16.4.7", "IPv4")] };
      expect(getLocalIp()).to.equal("172.16.4.7");
    });

    it("falls back to IPv6, then to loopback", () => {
      osMock.interfaces = { eth0: [iface("fe80::1", "IPv6")] };
      expect(getLocalIp()).to.equal("fe80::1");
      osMock.interfaces = { lo: [iface("127.0.0.1", "IPv4", true)] };
      expect(getLocalIp()).to.equal("127.0.0.1");
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
