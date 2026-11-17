import type { LocalNet } from "./network-address";
import { addressForPeer, advertisedBaseUrl, hostForUrl, listAddress, targetForPeer } from "./network";

/**
 * One network of the host, as the fleet master `localNets` reports it.
 *
 * @param address      The host's address in it.
 * @param prefixLength The network's prefix length.
 * @param iface        The interface name.
 */
function net(address: string, prefixLength: number, iface = "eth0"): LocalNet {
  return { iface, family: address.includes(":") ? "IPv6" : "IPv4", address, prefixLength };
}

/** The loopback network as the fleet master lists it since round 182 — `internal`, no device sits in it. */
const LOOPBACK: LocalNet = { iface: "lo0", family: "IPv4", address: "127.0.0.1", prefixLength: 8, internal: true };

/** A host in a LAN, a Docker bridge and a ULA, with a link-local address — the case 1.46.1 picked one address for. */
const NETS: LocalNet[] = [
  net("fe80::1", 64),
  net("fd00::5", 64),
  net("192.168.1.5", 24),
  net("172.17.0.1", 16, "docker0"),
];

describe("network", () => {
  describe("hostForUrl / advertisedBaseUrl (H10, K4)", () => {
    it("puts an IPv6 address in brackets, leaves IPv4 and names alone", () => {
      expect(hostForUrl("2001:db8::5")).to.equal("[2001:db8::5]");
      expect(hostForUrl("192.168.1.5")).to.equal("192.168.1.5");
      expect(hostForUrl("hassemu.local")).to.equal("hassemu.local");
    });

    it("builds a URL that parses for an IPv6 address", () => {
      const url = advertisedBaseUrl("::1", 8123);
      expect(url).to.equal("http://[::1]:8123");
      expect(new URL(url).port).to.equal("8123");
      expect(advertisedBaseUrl("192.168.1.5", 8123)).to.equal("http://192.168.1.5:8123");
    });

    it("with HTTPS names the certificate's name, and the address only for a certificate without one", () => {
      expect(advertisedBaseUrl("192.168.1.5", 8123, { name: "hassemu.example" })).to.equal(
        "https://hassemu.example:8123",
      );
      expect(advertisedBaseUrl("192.168.1.5", 8443, { name: undefined })).to.equal("https://192.168.1.5:8443");
    });
  });

  describe("addressForPeer — the address in the display's own network (fleet rule 2026-11-11 19:34)", () => {
    it("without a chosen address the host's address in the network the display sits in", () => {
      expect(addressForPeer("172.17.0.9", "0.0.0.0", NETS)).to.equal("172.17.0.1");
      expect(addressForPeer("fd00::77", "", NETS)).to.equal("fd00::5");
    });

    it("a chosen address is the one every display in its network gets", () => {
      expect(addressForPeer("192.168.1.40", "192.168.1.5", NETS)).to.equal("192.168.1.5");
    });

    it("a display outside the chosen address's network gets none", () => {
      expect(addressForPeer("203.0.113.9", "192.168.1.5", NETS)).to.equal(undefined);
    });
  });

  describe("listAddress — the one entry of a list built before any display asks (werkbank D17, 2026-11-15)", () => {
    it("the chosen address, link-local included (round 182: a chosen address the host carries is the only one)", () => {
      expect(listAddress("172.17.0.1", NETS)).to.equal("172.17.0.1");
      expect(listAddress("169.254.3.4", [net("169.254.3.4", 16), net("192.168.1.5", 24)])).to.equal("169.254.3.4");
    });

    it("without one the first IPv4 address in the system's order — a Docker bridge is not put back", () => {
      expect(listAddress("", [NETS[3], NETS[2]])).to.equal("172.17.0.1");
      expect(listAddress(undefined, NETS)).to.equal("192.168.1.5");
    });

    it("what the fleet master leaves out is never the entry — IPv4 link-local beside another IPv4 of its interface", () => {
      expect(listAddress("", [net("169.254.3.4", 16), net("192.168.1.5", 24)])).to.equal("192.168.1.5");
      // the only address of its interface stays (RFC 3927 §1.9 rule 3, master `blockedAddress`)
      expect(listAddress("", [net("169.254.3.4", 16, "eth1")])).to.equal("169.254.3.4");
    });

    it("an IPv6 address only on a host without IPv4, never a form the master leaves out (6to4)", () => {
      expect(listAddress("::", [net("2002:c000:204::1", 48), NETS[1]])).to.equal("fd00::5");
    });

    it("the loopback address on a host without a network, and for a chosen address the host does not carry", () => {
      expect(listAddress("0.0.0.0", [])).to.equal("127.0.0.1");
      expect(listAddress("0.0.0.0", [LOOPBACK])).to.equal("127.0.0.1");
      expect(listAddress("10.0.0.9", NETS)).to.equal("127.0.0.1");
    });
  });

  describe("targetForPeer — the target as one display gets it (werkbank D17, 2026-11-15)", () => {
    it("an address of this host becomes the host's address in the display's own network", () => {
      const target = "http://192.168.1.5:8082/vis-2/index.html?main#Kitchen";
      expect(targetForPeer(target, "172.17.0.9", "0.0.0.0", NETS)).to.equal(
        "http://172.17.0.1:8082/vis-2/index.html?main#Kitchen",
      );
      expect(targetForPeer(target, "192.168.1.40", "0.0.0.0", NETS)).to.equal(target);
    });

    it("the display's address family decides — an IPv6 display gets the bracketed address", () => {
      expect(targetForPeer("http://192.168.1.5:8081", "fd00::77", undefined, NETS)).to.equal("http://[fd00::5]:8081");
      expect(targetForPeer("https://[fd00::5]:8082/x", "172.17.3.4", undefined, NETS)).to.equal(
        "https://172.17.0.1:8082/x",
      );
    });

    it("only the host part changes — a bare origin keeps its form", () => {
      expect(targetForPeer("http://192.168.1.5:8081", "172.17.0.9", "", NETS)).to.equal("http://172.17.0.1:8081");
      expect(targetForPeer("http://192.168.1.5", "172.17.0.9", "", NETS)).to.equal("http://172.17.0.1");
    });

    it("a target on another host stays as it is", () => {
      for (const target of ["http://192.168.1.77:8082/", "https://grafana.example/d/x", "http://192.168.1.50/"]) {
        expect(targetForPeer(target, "172.17.0.9", "0.0.0.0", NETS), target).to.equal(target);
      }
    });

    it("a display no own network holds keeps the target", () => {
      expect(targetForPeer("http://192.168.1.5:8082/", "203.0.113.9", "0.0.0.0", NETS)).to.equal(
        "http://192.168.1.5:8082/",
      );
      expect(targetForPeer("http://192.168.1.5:8082/", undefined, "0.0.0.0", NETS)).to.equal(
        "http://192.168.1.5:8082/",
      );
    });

    it("with a chosen address a display in its network gets that address", () => {
      expect(targetForPeer("http://172.17.0.1:8082/", "192.168.1.40", "192.168.1.5", NETS)).to.equal(
        "http://192.168.1.5:8082/",
      );
    });

    it("a loopback target reaches the host only — it stays as it is, the master lists loopback since round 182", () => {
      const nets = [LOOPBACK, ...NETS];
      expect(targetForPeer("http://127.0.0.1:8082/", "172.17.0.9", "0.0.0.0", nets)).to.equal("http://127.0.0.1:8082/");
      expect(targetForPeer("http://192.168.1.5:8082/", "172.17.0.9", "0.0.0.0", nets)).to.equal(
        "http://172.17.0.1:8082/",
      );
    });

    it("a text that is no URL with a host stays as it is", () => {
      for (const target of ["not a url", "/relative/path", "mailto:x@192.168.1.5"]) {
        expect(targetForPeer(target, "172.17.0.9", "0.0.0.0", NETS), target).to.equal(target);
      }
    });
  });
});
