// Fleet master (.consistency-master/src/lib/network-address.test.ts) — never edit the copy in an adapter.
import type * as Os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  announceAddresses,
  announceableNets,
  blockedAddress,
  carriesAddress,
  chosenAddress,
  interfaceAddresses,
  isOwnPeer,
  localNets,
  ownAddressFor,
  ownNets,
  type InterfaceMap,
  type LocalNet,
} from "./network-address";

// Round 157 (master audit M21/M22): the defaults read `os.networkInterfaces()` — the tests read the machine's own
// interfaces before (counted with the code's own filter, or expected only `false`), so they measured the machine. The
// module is replaced: the default must hand over exactly these interfaces.
const { IFACES } = vi.hoisted((): { IFACES: InterfaceMap } => ({
  IFACES: {
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
    eth0: [
      {
        address: "192.168.1.5",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "aa:aa:aa:aa:aa:aa",
        internal: false,
        cidr: "192.168.1.5/24",
      },
      {
        address: "2001:db8::5",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "aa:aa:aa:aa:aa:aa",
        internal: false,
        cidr: "2001:db8::5/64",
        scopeid: 0,
      },
    ],
    iot: [
      {
        address: "192.0.2.2",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "bb:bb:bb:bb:bb:bb",
        internal: false,
        cidr: null,
      },
      {
        address: "FE80::1%iot",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "bb:bb:bb:bb:bb:bb",
        internal: false,
        cidr: null,
        scopeid: 3,
      },
    ],
    odd: [{ address: "x", netmask: "x", family: "IPX" as "IPv4", mac: "", internal: false, cidr: null }],
    none: undefined,
  },
}));
vi.mock("node:os", async importOriginal => ({
  ...(await importOriginal<typeof Os>()),
  networkInterfaces: () => IFACES,
}));

describe("chosenAddress", () => {
  it("reads every wildcard and the empty value as every address", () => {
    for (const value of ["", "  ", "0.0.0.0", " :: ", undefined, null, 42]) {
      expect(chosenAddress(value)).toBeUndefined();
    }
  });

  it("keeps a chosen address, trimmed", () => {
    expect(chosenAddress(" 192.168.1.5 ")).toBe("192.168.1.5");
  });
});

describe("localNets", () => {
  it("lists every address, loopback marked internal, with the prefix from cidr or the address alone", () => {
    expect(localNets(IFACES)).toEqual([
      { iface: "lo0", family: "IPv4", address: "127.0.0.1", prefixLength: 8, internal: true },
      { iface: "eth0", family: "IPv4", address: "192.168.1.5", prefixLength: 24 },
      { iface: "eth0", family: "IPv6", address: "2001:db8::5", prefixLength: 64 },
      { iface: "iot", family: "IPv4", address: "192.0.2.2", prefixLength: 32 },
      { iface: "iot", family: "IPv6", address: "fe80::1", prefixLength: 128 },
    ]);
  });

  it("reads the host's own interfaces when given none", () => {
    expect(localNets()).toEqual(localNets(IFACES));
  });
});

describe("carriesAddress", () => {
  const nets = localNets(IFACES);

  it("knows the host's own addresses, an IPv6 one with or without zone and case", () => {
    expect(carriesAddress("192.168.1.5", "IPv4", nets)).toBe(true);
    expect(carriesAddress("FE80::1%iot", "IPv6", nets)).toBe(true);
  });

  it("does not know an address no interface carries", () => {
    expect(carriesAddress("192.0.2.1", "IPv4", nets)).toBe(false);
    expect(carriesAddress("127.0.0.2", "IPv4", nets)).toBe(false);
  });

  // round 182 (R182-13, krobi 2026-11-16 17:31: what one picks, and the adapter works on that address alone)
  it("knows a chosen loopback address the host carries — it is the only one", () => {
    expect(carriesAddress("127.0.0.1", "IPv4", nets)).toBe(true);
    expect(ownNets("127.0.0.1", nets).map(n => n.address)).toEqual(["127.0.0.1"]);
    expect(isOwnPeer("127.0.0.1", "127.0.0.1", nets)).toBe(true);
    expect(isOwnPeer("192.168.1.77", "127.0.0.1", nets)).toBe(false);
    expect(ownAddressFor("127.0.0.1", "127.0.0.1", nets)).toBe("127.0.0.1");
    expect(announceAddresses("127.0.0.1", "IPv4", nets)).toEqual(["127.0.0.1"]);
    expect(interfaceAddresses("127.0.0.1", nets)).toEqual(["127.0.0.1"]);
  });

  // round 182 (R182-9, hueemu 6f8327df1d1a): a setting holds one family, json-config's ip field offers both
  it("does not know an own address of the other family than the setting holds", () => {
    expect(carriesAddress("2001:db8::5", "IPv4", nets)).toBe(false);
    expect(carriesAddress("FE80::1%iot", "IPv4", nets)).toBe(false);
    expect(carriesAddress("192.168.1.5", "IPv6", nets)).toBe(false);
    expect(carriesAddress("2001:db8::5", "IPv6", nets)).toBe(true);
  });

  it("reads the host's own interfaces when given none", () => {
    expect(carriesAddress("192.168.1.5", "IPv4")).toBe(true);
    expect(carriesAddress("192.0.2.1", "IPv4")).toBe(false);
  });
});

describe("ownNets", () => {
  const nets = localNets(IFACES);

  it("is every network but loopback with every address", () => {
    expect(ownNets(undefined, nets)).toEqual(nets.slice(1));
    expect(isOwnPeer("127.0.0.1", undefined, nets)).toBe(false);
  });

  it("is the networks of the chosen address's interface", () => {
    expect(ownNets("192.168.1.5", nets).map(n => n.address)).toEqual(["192.168.1.5", "2001:db8::5"]);
    expect(ownNets("fe80::1%iot", nets).map(n => n.address)).toEqual(["192.0.2.2", "fe80::1"]);
  });

  it("is nothing for an address no interface carries", () => {
    expect(ownNets("192.0.2.1", nets)).toEqual([]);
  });

  it("reads the host's own interfaces when given none", () => {
    expect(ownNets(undefined)).toEqual(localNets(IFACES).slice(1));
  });
});

describe("isOwnPeer", () => {
  const nets = localNets(IFACES);

  it("answers a peer in the chosen network, IPv4, IPv4-mapped and IPv6", () => {
    expect(isOwnPeer("192.168.1.77", "192.168.1.5", nets)).toBe(true);
    expect(isOwnPeer("::FFFF:192.168.1.77", "192.168.1.5", nets)).toBe(true);
    expect(isOwnPeer("2001:db8::77", "192.168.1.5", nets)).toBe(true);
  });

  it("answers no peer outside the chosen network — another own network, loopback, nothing", () => {
    expect(isOwnPeer("192.0.2.2", "192.168.1.5", nets)).toBe(false);
    expect(isOwnPeer("127.0.0.1", "192.168.1.5", nets)).toBe(false);
    expect(isOwnPeer(undefined, "192.168.1.5", nets)).toBe(false);
    expect(isOwnPeer("", undefined, nets)).toBe(false);
  });

  it("answers a peer of any own network with every address, and nothing outside", () => {
    expect(isOwnPeer("192.0.2.2", undefined, nets)).toBe(true);
    expect(isOwnPeer("fe80::1%iot", undefined, nets)).toBe(true);
    expect(isOwnPeer("10.47.4.9", undefined, nets)).toBe(false);
  });

  it("answers no peer in a form that is no IP address", () => {
    expect(isOwnPeer("not an address", undefined, nets)).toBe(false);
  });

  it("refuses a network the check cannot take", () => {
    expect(isOwnPeer("1.2.3.4", undefined, [{ iface: "x", family: "IPv4", address: "nope", prefixLength: 8 }])).toBe(
      false,
    );
  });

  it("reads the host's own interfaces when given none", () => {
    expect(isOwnPeer("192.168.1.77", undefined)).toBe(true);
    expect(isOwnPeer("10.47.4.9", undefined)).toBe(false);
  });
});

// Round 177 (krobi 2026-11-11 19:34, the fleet rule): without a chosen address every peer is told the host's address in
// its own network — never the first one, never an order of the adapter's own
describe("ownAddressFor", () => {
  const nets = localNets(IFACES);

  it("tells each peer the host's address in its own network, IPv4, IPv4-mapped and IPv6", () => {
    expect(ownAddressFor("192.0.2.2", undefined, nets)).toBe("192.0.2.2");
    expect(ownAddressFor("192.168.1.77", undefined, nets)).toBe("192.168.1.5");
    expect(ownAddressFor("::ffff:192.168.1.77", undefined, nets)).toBe("192.168.1.5");
    expect(ownAddressFor("2001:db8::77", undefined, nets)).toBe("2001:db8::5");
    expect(ownAddressFor("fe80::1%iot", undefined, nets)).toBe("fe80::1");
  });

  it("tells no address to a peer outside every own network, to loopback and to nothing", () => {
    expect(ownAddressFor("10.47.4.9", undefined, nets)).toBeUndefined();
    expect(ownAddressFor("127.0.0.1", undefined, nets)).toBeUndefined();
    expect(ownAddressFor(undefined, undefined, nets)).toBeUndefined();
  });

  it("tells the chosen address to a peer in its networks and nothing to any other", () => {
    expect(ownAddressFor("192.168.1.77", "192.168.1.5", nets)).toBe("192.168.1.5");
    expect(ownAddressFor("2001:db8::77", "192.168.1.5", nets)).toBe("192.168.1.5");
    expect(ownAddressFor("192.0.2.2", "192.168.1.5", nets)).toBeUndefined();
  });

  it("reads the host's own interfaces when given none", () => {
    expect(ownAddressFor("192.168.1.77", undefined)).toBe("192.168.1.5");
    expect(ownAddressFor("10.47.4.9", "192.168.1.5")).toBeUndefined();
  });

  // Round 179 (R179-10, finding 997073a2305a): a list made before any display asks holds one entry; its address is
  // filled in when a display asks — two displays in two own networks, two addresses, none chosen ahead for all
  it("fills a value made before any peer asked with the address of the network the asking peer sits in", () => {
    const entry = { name: "VIS-2: main" };
    // the fixture's `iot` address carries no cidr (a /32): here its interface names its network
    const iot = { address: "192.0.2.2", netmask: "255.255.255.0", family: "IPv4" as const, mac: "", internal: false };
    const two = localNets({ ...IFACES, iot: [{ ...iot, cidr: "192.0.2.2/24" }] });
    const forPeer = (peer: string): string => `${entry.name} http://${ownAddressFor(peer, undefined, two)}:8082`;
    expect(forPeer("192.168.1.77")).toBe("VIS-2: main http://192.168.1.5:8082");
    expect(forPeer("192.0.2.40")).toBe("VIS-2: main http://192.0.2.2:8082");
  });
});

// Round 179 (R179-10, finding eaacd7e14658; UPnP Device Architecture 2.0 §1.2.2): an announcement nobody asked for
// goes out from each own network with that network's address — never one address picked for all
describe("announceAddresses", () => {
  const nets = localNets(IFACES);

  it("is the host's address in each own network of the family without a chosen address", () => {
    expect(announceAddresses(undefined, "IPv4", nets)).toEqual(["192.168.1.5", "192.0.2.2"]);
    expect(announceAddresses(undefined, "IPv6", nets)).toEqual(["2001:db8::5", "fe80::1"]);
  });

  it("is the chosen address alone, in its family only, and nothing for one no interface carries", () => {
    expect(announceAddresses("192.0.2.2", "IPv4", nets)).toEqual(["192.0.2.2"]);
    expect(announceAddresses("FE80::1%iot", "IPv6", nets)).toEqual(["fe80::1"]);
    expect(announceAddresses("192.0.2.2", "IPv6", nets)).toEqual([]);
    expect(announceAddresses("10.47.4.9", "IPv4", nets)).toEqual([]);
  });

  it("names each address once and reads the host's own interfaces when given none", () => {
    expect(announceAddresses(undefined, "IPv4", [...nets, ...nets])).toEqual(["192.168.1.5", "192.0.2.2"]);
    expect(announceAddresses(undefined, "IPv4")).toEqual(["192.168.1.5", "192.0.2.2"]);
  });
});

// Round 180 (R180-10, finding 74d84aa54d89; krobi 2026-11-15 20:36, in English: as the source recommends it, and the
// blocked addresses are not even offered in our admins): one list of what an announcement and the admin's choice
// leave out — RFC 3927 §1.9, RFC 6762 §6.2, UPnP Device Architecture 2.0 Annex A.2.3
describe("blockedAddress", () => {
  const net = (iface: string, family: "IPv4" | "IPv6", address: string): LocalNet => ({
    iface,
    family,
    address,
    prefixLength: family === "IPv4" ? 16 : 64,
  });
  const MIXED = [
    net("eth0", "IPv4", "192.168.1.5"),
    net("eth0", "IPv4", "169.254.7.7"),
    net("usb0", "IPv4", "169.254.9.9"),
    net("lo", "IPv4", "127.0.0.1"),
    net("eth0", "IPv6", "fe80::1"),
    net("eth0", "IPv6", "2001:db8::5"),
    net("old", "IPv6", "fec0::1"),
    net("old", "IPv6", "::192.0.2.1"),
    net("old", "IPv6", "3ffe::1"),
    net("old", "IPv6", "2002:c000:201::1"),
    net("old", "IPv6", "2001:0:4136:e378::1"),
    net("isatap", "IPv6", "fe80::5efe:192.0.2.1"),
    net("isatap", "IPv6", "2001:db8::200:5efe:c000:201"),
    net("docker0", "IPv4", "172.17.0.1"),
    net("tailscale0", "IPv4", "100.64.0.1"),
  ];
  const blocked = (address: string): boolean => blockedAddress(MIXED.filter(n => n.address === address)[0], MIXED);

  it("leaves out loopback and IPv4 link-local while its interface carries another IPv4", () => {
    expect(blocked("127.0.0.1")).toBe(true);
    expect(blocked("169.254.7.7")).toBe(true);
    expect(blocked("192.168.1.5")).toBe(false);
  });

  it("keeps IPv4 link-local alone on its interface, IPv6 link-local, Docker, VPN and CGNAT", () => {
    expect(blocked("169.254.9.9")).toBe(false);
    expect(blocked("fe80::1")).toBe(false);
    expect(blocked("2001:db8::5")).toBe(false);
    expect(blocked("172.17.0.1")).toBe(false);
    expect(blocked("100.64.0.1")).toBe(false);
  });

  it("leaves out the IPv6 forms of UPnP Device Architecture 2.0 Annex A.2.3", () => {
    for (const address of [
      "fec0::1",
      "::192.0.2.1",
      "3ffe::1",
      "2002:c000:201::1",
      "2001:0:4136:e378::1",
      "fe80::5efe:192.0.2.1",
      "2001:db8::200:5efe:c000:201",
    ]) {
      expect(blocked(address), address).toBe(true);
    }
  });

  it("leaves out an address the check cannot read, and reads the host's own interfaces when given none", () => {
    expect(blockedAddress(net("x", "IPv4", "nope"), [])).toBe(true);
    expect(blockedAddress(net("x", "IPv6", "nope"), [])).toBe(true);
    expect(blockedAddress(localNets(IFACES)[1])).toBe(false);
  });

  it("reads an IPv6 address written out in full or ending in its gap", () => {
    expect(blockedAddress(net("x", "IPv6", "2001:db8:0:0:0:0:0:7"), [])).toBe(false);
    expect(blockedAddress(net("x", "IPv6", "2001:db8:2::"), [])).toBe(false);
    expect(blockedAddress(net("x", "IPv6", "2001:db8:0:0:0:5efe:c000:201"), [])).toBe(true);
  });

  it("makes every other answer leave the blocked addresses out", () => {
    const fine = ["192.168.1.5", "169.254.9.9", "fe80::1", "2001:db8::5", "172.17.0.1", "100.64.0.1"];
    expect(announceableNets(MIXED).map(n => n.address)).toEqual(fine);
    expect(announceableNets().map(n => n.address)).toEqual(
      localNets(IFACES)
        .slice(1)
        .map(n => n.address),
    );
    expect(announceableNets([...MIXED, { ...net("lo0", "IPv6", "fe80::1"), internal: true }]).length).toBe(fine.length);
    expect(announceAddresses(undefined, "IPv4", MIXED)).toEqual([
      "192.168.1.5",
      "169.254.9.9",
      "172.17.0.1",
      "100.64.0.1",
    ]);
  });

  // round 182 (R182-13, krobi 2026-11-16 17:31): a chosen address is the user's — blocked or not, it is the only one
  it("leaves no chosen address out the host carries, a blocked one included", () => {
    expect(carriesAddress("169.254.7.7", "IPv4", MIXED)).toBe(true);
    expect(carriesAddress("169.254.9.9", "IPv4", MIXED)).toBe(true);
    expect(announceAddresses("169.254.7.7", "IPv4", MIXED)).toEqual(["169.254.7.7"]);
    expect(interfaceAddresses("169.254.7.7", MIXED)).toEqual(["192.168.1.5", "169.254.7.7", "fe80::1", "2001:db8::5"]);
  });

  it("names in an announcement only the addresses of the interface it goes out from", () => {
    expect(interfaceAddresses("192.168.1.5", MIXED)).toEqual(["192.168.1.5", "fe80::1", "2001:db8::5"]);
    expect(interfaceAddresses("FE80::1%eth0", MIXED)).toEqual(["192.168.1.5", "fe80::1", "2001:db8::5"]);
    expect(interfaceAddresses("169.254.9.9", MIXED)).toEqual(["169.254.9.9"]);
    expect(interfaceAddresses("10.47.4.9", MIXED)).toEqual([]);
    expect(interfaceAddresses("192.168.1.5", [...MIXED, ...MIXED])).toEqual(["192.168.1.5", "fe80::1", "2001:db8::5"]);
    expect(interfaceAddresses("192.168.1.5")).toEqual(["192.168.1.5", "2001:db8::5"]);
  });
});
