// Fleet master (.consistency-master/src/lib/network-address.ts) — never edit the copy in an adapter.
//
// The address a user picks in the instance settings (jsonConfig `type: "ip"`) is the only one the adapter listens,
// sends and connects on — the cloud included (krobi 2026-10-03 00:27, 11:38). One the host does not carry falls back to
// every address with exactly one warning, and only a client in the chosen network — or, with every address, in one of the
// host's own networks — is answered (fakeroku F-05/F-06 as the fleet rule). This file is the one form of that core: what
// counts as "every address", whether the host carries an address, which networks are own, whether a peer is in one, and
// which address of the host a peer is told (round 177: without a chosen address, the host's address in the peer's
// network). Where no peer asks yet (round 179), two forms: a value made before any question — a list a user picks
// from, a stored target — carries one entry and gets its address from `ownAddressFor` when the peer asks; an
// announcement nobody asked for goes out once per address of `announceAddresses`, from that address's interface and
// naming it. The host's interfaces are read here and nowhere else.
// Round 180 (R180-10): which addresses an announcement and its address records leave out stands here once
// (`blockedAddress`). Round 182 (R182-13, krobi 2026-11-16 17:35: what ioBroker brings, the fleet uses): the admin's choice
// is json-config's own field `type: "ip"` with `listenOnAllPorts` and `noInternal` — ioBroker lists the host's addresses,
// loopback too while `noInternal` filters nothing (socket-client `parseIPAddresses`). A chosen address an interface of the
// host carries is the only one, loopback and link-local included (krobi 2026-11-16 17:31: what one picks, and the adapter
// works on that address alone); `blockedAddress` holds for an announcement without a chosen address only.
// The sockets themselves stay the adapter's — the inventory suites "chosen network address" / "missing network address"
// judge what it does with them.
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** The OS network-interface map (the `os.networkInterfaces()` shape). */
export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

/**
 * One address of the host's interfaces, with its network. Loopback carries `internal`: no device sits in it, so it counts
 * only as a chosen address — never as an own network with every address, never in an announcement.
 */
export interface LocalNet {
  /** The interface name (`eth0`, `wlan0` …). */
  iface: string;
  /** The address family. */
  family: "IPv4" | "IPv6";
  /** The host's own address in this network (IPv6 without a zone suffix). */
  address: string;
  /** The prefix length of the network (from `cidr`). */
  prefixLength: number;
  /** Set for an address the OS marks internal (loopback). */
  internal?: true;
}

/**
 * The chosen address of a setting, or undefined for "every address": the empty value and the wildcards `0.0.0.0` and
 * `::` (what the admin's "all" choice stores) choose none.
 *
 * @param value the native value as stored
 * @returns the chosen address, trimmed
 */
export function chosenAddress(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text === "0.0.0.0" || text === "::" ? undefined : text;
}

/**
 * Every address of the host's interfaces with its network, loopback marked `internal`; an address without a usable
 * prefix counts as just itself (/32, /128). Pure when the map is handed in.
 *
 * @param interfaces the OS network-interface map, read fresh when not given
 * @returns the host's networks, in enumeration order
 */
export function localNets(interfaces: InterfaceMap = networkInterfaces()): LocalNet[] {
  const out: LocalNet[] = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" && addr.family !== "IPv6") {
        continue;
      }
      const bits = typeof addr.cidr === "string" ? Number(addr.cidr.split("/")[1]) : NaN;
      const prefixLength = Number.isInteger(bits) ? bits : addr.family === "IPv4" ? 32 : 128;
      const address = addr.family === "IPv6" ? addr.address.split("%")[0].toLowerCase() : addr.address;
      out.push({
        iface,
        family: addr.family,
        address,
        prefixLength,
        ...(addr.internal ? { internal: true as const } : {}),
      });
    }
  }
  return out;
}

// Round 180 (R180-10, finding 74d84aa54d89; krobi 2026-11-15 20:36, in English: as the source recommends it, and the
// blocked addresses are not even offered in our admins): the sources' list of what an announcement leaves
// out — never loopback; IPv4 link-local (169.254/16) only while its interface carries another IPv4 (RFC 3927 §1.9 rules
// 2 and 3); the IPv6 forms of UPnP Device Architecture 2.0 Annex A.2.3 (site-local, IPv4-compatible, 6bone, 6to4,
// Teredo, an ISATAP interface id). IPv6 link-local stays (RFC 6762 §6.2), and no source leaves out a Docker, VM, VPN or
// CGNAT address.
const LOOPBACK_V4 = new BlockList();
LOOPBACK_V4.addSubnet("127.0.0.0", 8, "ipv4");
const LINK_LOCAL_V4 = new BlockList();
LINK_LOCAL_V4.addSubnet("169.254.0.0", 16, "ipv4");
const BLOCKED_V6 = new BlockList();
for (const [prefix, bits] of [
  ["fec0::", 10],
  ["::", 96],
  ["3ffe::", 16],
  ["2002::", 16],
  ["2001::", 32],
] as const) {
  BLOCKED_V6.addSubnet(prefix, bits, "ipv6");
}

/**
 * The eight 16-bit groups of an IPv6 address, an IPv4 in its last 32 bits included.
 *
 * @param address an IPv6 address without zone
 * @returns the groups, or undefined for no IPv6 address
 */
function v6Groups(address: string): number[] | undefined {
  if (!isIPv6(address)) {
    return undefined;
  }
  let text = address;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map(group => parseInt(group, 16));
}

/**
 * Does an announcement without a chosen address leave this network's address out — its senders and its address records?
 * An address the check cannot read is left out. A chosen address is the user's and is never left out (round 182).
 *
 * @param net one of the host's networks
 * @param nets the host's networks (the other addresses of its interface decide IPv4 link-local)
 * @returns true if the address is never announced or offered
 */
export function blockedAddress(net: LocalNet, nets: readonly LocalNet[] = localNets()): boolean {
  // node's BlockList answers false for a text it cannot read (measured on node 22) — the form is checked first
  if (net.family === "IPv4") {
    const linkLocal = (address: string): boolean => LINK_LOCAL_V4.check(address, "ipv4");
    return (
      !isIPv4(net.address) ||
      LOOPBACK_V4.check(net.address, "ipv4") ||
      (linkLocal(net.address) &&
        nets.some(other => other.iface === net.iface && other.family === "IPv4" && !linkLocal(other.address)))
    );
  }
  const groups = v6Groups(net.address);
  return (
    groups === undefined ||
    BLOCKED_V6.check(net.address, "ipv6") ||
    ((groups[4] === 0 || groups[4] === 0x200) && groups[5] === 0x5efe)
  );
}

/**
 * The host's networks a device sits in — every one but loopback (`internal`).
 *
 * @param nets the host's networks
 * @returns the networks without loopback, in enumeration order
 */
function deviceNets(nets: readonly LocalNet[]): LocalNet[] {
  return nets.filter(net => !net.internal);
}

/**
 * The host's networks an announcement without a chosen address may name — every network a device sits in but the
 * blocked ones (`blockedAddress`).
 *
 * @param nets the host's networks
 * @returns the announceable networks, in enumeration order
 */
export function announceableNets(nets: readonly LocalNet[] = localNets()): LocalNet[] {
  return deviceNets(nets).filter(net => !blockedAddress(net, nets));
}

/**
 * Does the host carry this address on one of its interfaces, in the family the setting holds? Then it is the only one,
 * loopback and link-local included (round 182, krobi 2026-11-16 17:31). A chosen address it does not carry falls back to
 * every address, with exactly one warning — one of the other family too (round 182: a socket of the setting's family
 * cannot listen on it).
 *
 * @param address the chosen address
 * @param family the address family the setting holds
 * @param nets the host's networks
 * @returns true if an interface carries it in that family
 */
export function carriesAddress(
  address: string,
  family: "IPv4" | "IPv6",
  nets: readonly LocalNet[] = localNets(),
): boolean {
  const plain = address.split("%")[0].toLowerCase();
  return nets.some(net => net.family === family && net.address === plain);
}

/**
 * The networks that count as own: with a chosen address the networks of the interface that carries it (loopback's when
 * it is chosen), otherwise every network of the host a device sits in.
 *
 * @param address the chosen address, undefined for every address
 * @param nets the host's networks
 * @returns the own networks (empty when no interface carries the chosen address)
 */
export function ownNets(address: string | undefined, nets: readonly LocalNet[] = localNets()): LocalNet[] {
  if (address === undefined) {
    return deviceNets(nets);
  }
  const plain = address.split("%")[0].toLowerCase();
  const iface = nets.find(net => net.address === plain)?.iface;
  return iface === undefined ? [] : nets.filter(net => net.iface === iface);
}

/**
 * Is a peer in one of the own networks? There is no exception: not loopback unless it is chosen, not link-local unless
 * the interface carries such an address, not a routed private network. A dual-stack socket's IPv4-mapped form counts as the IPv4 it
 * carries; anything that is no IP address is in no network.
 *
 * @param peer the peer address from the socket
 * @param address the chosen address, undefined for every address
 * @param nets the host's networks
 * @returns true if the peer may be answered
 */
export function isOwnPeer(
  peer: string | undefined,
  address: string | undefined,
  nets: readonly LocalNet[] = localNets(),
): boolean {
  if (!peer) {
    return false;
  }
  const ip = peer
    .replace(/^::ffff:/i, "")
    .split("%")[0]
    .toLowerCase();
  return ownNets(address, nets).some(net => {
    try {
      const list = new BlockList();
      list.addSubnet(net.address, net.prefixLength, net.family === "IPv4" ? "ipv4" : "ipv6");
      return list.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
    } catch {
      // a peer in a form the check refuses lies in no network
      return false;
    }
  });
}

/**
 * The address of this host a peer can reach — the one the adapter names to it (a callback URL, an SSDP location, an mDNS
 * record). With a chosen address it is that address, for a peer in one of its networks; without one it is the host's
 * own address in the network the peer sits in (krobi 2026-11-11 19:34 as the fleet rule): the adapter never picks an
 * address by itself — not the first, not a "physical before virtual" order, no Docker or VPN filter. A value made
 * before any peer asks (one list entry for every display, a stored target) holds no address; this call fills it in
 * when the peer asks, like admin's own host name for its viewer.
 *
 * @param peer the peer address from the socket
 * @param address the chosen address, undefined for every address
 * @param nets the host's networks
 * @returns the address to name to the peer, or undefined when no own network holds it (the peer is not answered)
 */
export function ownAddressFor(
  peer: string | undefined,
  address: string | undefined,
  nets: readonly LocalNet[] = localNets(),
): string | undefined {
  if (address !== undefined) {
    return isOwnPeer(peer, address, nets) ? address : undefined;
  }
  return deviceNets(nets).find(net => isOwnPeer(peer, net.address, [net]))?.address;
}

/**
 * The addresses an announcement goes out from — a message into the network that no peer asked for (an SSDP alive, an
 * mDNS announcement): with a chosen address that one alone, when an interface carries it in the family; without one the
 * host's address in each of its networks of the family, each sent from its interface and naming that address (UPnP
 * Device Architecture 2.0 §1.2.2) — never one address picked for all networks, never a blocked one (`blockedAddress`).
 *
 * @param address the chosen address, undefined for every address
 * @param family the address family the announcement travels in
 * @param nets the host's networks
 * @returns the addresses to announce from, each once (empty when no own network of the family holds the chosen one)
 */
export function announceAddresses(
  address: string | undefined,
  family: "IPv4" | "IPv6",
  nets: readonly LocalNet[] = localNets(),
): string[] {
  const plain = address?.split("%")[0].toLowerCase();
  const from = (plain === undefined ? announceableNets(nets) : nets).filter(
    net => net.family === family && (plain === undefined || net.address === plain),
  );
  return [...new Set(from.map(net => net.address))];
}

/**
 * The addresses an announcement sent from `from` names — its address records (mDNS A/AAAA), its location: `from` itself
 * (a chosen address, blocked or loopback included) and the announceable addresses of the interface that carries it,
 * never one of another interface (RFC 6762 §6.2; UPnP Device Architecture 2.0 §1.2.2).
 *
 * @param from the address the announcement goes out from (one of `announceAddresses`)
 * @param nets the host's networks
 * @returns the addresses of that interface, each once (empty when no interface carries `from`)
 */
export function interfaceAddresses(from: string, nets: readonly LocalNet[] = localNets()): string[] {
  const plain = from.split("%")[0].toLowerCase();
  const iface = nets.find(net => net.address === plain)?.iface;
  const named = new Set(announceableNets(nets).map(net => net.address));
  return iface === undefined
    ? []
    : [
        ...new Set(
          nets
            .filter(net => net.iface === iface && (net.address === plain || named.has(net.address)))
            .map(n => n.address),
        ),
      ];
}
