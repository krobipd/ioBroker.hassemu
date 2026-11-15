import type { LocalNet } from "./network-address";
import { addressForPeer, advertisedBaseUrl, hostForUrl, hostNets, listAddress, targetForPeer } from "./network";

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

  describe("hostNets — the networks nobody asked about", () => {
    it("without a chosen address every network of the host, no link-local one, none twice", () => {
      expect(hostNets("0.0.0.0", [...NETS, net("192.168.1.5", 24, "eth0:1")]).map(n => n.address)).to.deep.equal([
        "fd00::5",
        "192.168.1.5",
        "172.17.0.1",
      ]);
    });

    it("with a chosen address only its network", () => {
      expect(hostNets("172.17.0.1", NETS).map(n => n.address)).to.deep.equal(["172.17.0.1"]);
    });
  });

  describe("listAddress — the one entry of a list built before any display asks (werkbank D17, 2026-11-15)", () => {
    it("the chosen address", () => {
      expect(listAddress("172.17.0.1", NETS)).to.equal("172.17.0.1");
    });

    it("without one the first IPv4 address in the system's order — a Docker bridge is not put back", () => {
      expect(listAddress("", [NETS[3], NETS[2]])).to.equal("172.17.0.1");
      expect(listAddress(undefined, NETS)).to.equal("192.168.1.5");
    });

    it("an IPv6 address only on a host without IPv4, the loopback address on a host without a network", () => {
      expect(listAddress("::", [NETS[0], NETS[1]])).to.equal("fd00::5");
      expect(listAddress("0.0.0.0", [])).to.equal("127.0.0.1");
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

    it("a text that is no URL with a host stays as it is", () => {
      for (const target of ["not a url", "/relative/path", "mailto:x@192.168.1.5"]) {
        expect(targetForPeer(target, "172.17.0.9", "0.0.0.0", NETS), target).to.equal(target);
      }
    });
  });
});
