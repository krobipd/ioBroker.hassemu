import { vi } from "vitest";

/** os.networkInterfaces is swappable so the interface-priority rules are testable. */
const osMock = vi.hoisted(() => ({ interfaces: null as NodeJS.Dict<os.NetworkInterfaceInfo[]> | null }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof os>();
  const networkInterfaces = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> =>
    osMock.interfaces ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});

import type * as os from "node:os";
import {
  advertisedBaseUrl,
  generateClientId,
  getLocalIp,
  hostForUrl,
  isWildcardBind,
  resolveAdvertisedHost,
} from "./network";

/**
 * Build one interface entry with only the fields getLocalIp reads.
 *
 * @param address IP address of the interface
 * @param family Address family as os.networkInterfaces reports it
 * @param internal Whether it is a loopback/internal interface
 */
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

    it("falls back to a global IPv6, never to a link-local one, then to loopback (H10)", () => {
      // fe80:: is valid only with a zone id — useless in a URL a display is given.
      osMock.interfaces = { eth0: [iface("fe80::1", "IPv6")] };
      expect(getLocalIp()).to.equal("127.0.0.1");
      osMock.interfaces = { eth0: [iface("fe80::1", "IPv6"), iface("2001:db8::5", "IPv6")] };
      expect(getLocalIp()).to.equal("2001:db8::5");
      osMock.interfaces = { eth0: [iface("169.254.3.4", "IPv4")], eth1: [iface("192.168.1.5", "IPv4")] };
      expect(getLocalIp()).to.equal("192.168.1.5");
      osMock.interfaces = { lo: [iface("127.0.0.1", "IPv4", true)] };
      expect(getLocalIp()).to.equal("127.0.0.1");
    });

    it("ranks VPN and container interfaces by NAME behind the LAN, whatever their address (H10)", () => {
      osMock.interfaces = {
        tailscale0: [iface("100.101.102.103", "IPv4")],
        "br-3f2a": [iface("172.20.0.1", "IPv4")],
        eth0: [iface("192.168.1.10", "IPv4")],
      };
      expect(getLocalIp()).to.equal("192.168.1.10");
      // A physical IPv6 beats a virtual IPv4 — the virtual one is not reachable from the LAN.
      osMock.interfaces = { wg0: [iface("10.8.0.2", "IPv4")], eth0: [iface("2001:db8::7", "IPv6")] };
      expect(getLocalIp()).to.equal("2001:db8::7");
      // Only virtual interfaces: better than nothing.
      osMock.interfaces = { tailscale0: [iface("100.64.0.1", "IPv4")] };
      expect(getLocalIp()).to.equal("100.64.0.1");
    });
  });

  describe("hostForUrl / advertisedBaseUrl (H10)", () => {
    it("puts an IPv6 address in brackets, leaves IPv4 and names alone", () => {
      expect(hostForUrl("2001:db8::5")).to.equal("[2001:db8::5]");
      expect(hostForUrl("192.168.1.5")).to.equal("192.168.1.5");
      expect(hostForUrl("hassemu.local")).to.equal("hassemu.local");
    });

    it("builds a URL that parses for an IPv6 bind", () => {
      const url = advertisedBaseUrl("::1", 8123);
      expect(url).to.equal("http://[::1]:8123");
      expect(new URL(url).port).to.equal("8123");
      expect(advertisedBaseUrl("192.168.1.5", 8123)).to.equal("http://192.168.1.5:8123");
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
