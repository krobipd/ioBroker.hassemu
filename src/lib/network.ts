import net from "node:net";
import { chosenAddress, localNets, ownAddressFor, type LocalNet } from "./network-address";

/**
 * A link-local address (fe80::/10, 169.254.0.0/16): valid only on one link and, for IPv6,
 * only with a zone id — useless in a URL a display is given.
 *
 * @param address An address of this host.
 */
function isLinkLocal(address: string): boolean {
  return net.isIPv6(address) ? /^fe[89ab]/i.test(address) : address.startsWith("169.254.");
}

/**
 * A host as it goes into a URL: an IPv6 address in brackets (`http://2001:db8::5:8123` does not
 * parse as a URL — audit 2026-09-25, H10).
 *
 * @param host Hostname, IPv4 or IPv6 address.
 */
export function hostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/**
 * The base URL a display is given for this server (mDNS TXT `base_url`/`internal_url`, `/api/discovery_info`).
 *
 * With HTTPS (K4) the scheme is `https` and the host is the name the certificate is valid for — a client checks the
 * certificate against the host it connects to; only a certificate without a name keeps the address.
 *
 * @param address The address of this host the display is named ({@link addressForPeer}, or one of {@link hostNets}).
 * @param port    The listen port.
 * @param secure  The HTTPS part (`name`: the certificate's name), or nothing for plain HTTP.
 */
export function advertisedBaseUrl(address: string, port: number, secure?: { name: string | undefined } | null): string {
  if (secure) {
    return `https://${hostForUrl(secure.name ?? address)}:${port}`;
  }
  return `http://${hostForUrl(address)}:${port}`;
}

/**
 * The address of this host a display reaches: the chosen one, else the host's address in the display's own network —
 * the fleet master `ownAddressFor` (krobi 2026-11-11 19:34 as the fleet rule: every display gets the address under which
 * hassemu is reachable in its own network; hassemu picks no address by itself, and no Docker, VM or VPN interface is
 * put back).
 *
 * @param peer The display's address from the socket.
 * @param bind The bind setting.
 * @param nets The host's networks (test seam; read fresh by default).
 * @returns The address, or undefined when no own network holds the display (the peer guard answers it with 403).
 */
export function addressForPeer(
  peer: string | undefined,
  bind: string | undefined | null,
  nets: readonly LocalNet[] = localNets(),
): string | undefined {
  return ownAddressFor(peer, chosenAddress(bind), nets);
}

/**
 * The networks a display can reach this host in when no display asks — the mDNS announcement, the dashboard list: the
 * network of the chosen address, else every network the host sits in. A list, nothing is chosen (fleet master
 * `localNets`); a link-local address is left out — no display can be given it in a URL. The start already listens on
 * every address when the host does not carry the chosen one (DD 36), so the setting here names a carried address.
 *
 * @param bind The bind setting as the start settled it.
 * @param nets The host's networks (test seam; read fresh by default).
 */
export function hostNets(bind: string | undefined | null, nets: readonly LocalNet[] = localNets()): LocalNet[] {
  const chosen = chosenAddress(bind);
  if (chosen !== undefined) {
    return nets.filter(n => n.address === chosen);
  }
  const seen = new Set<string>();
  return nets.filter(n => !isLinkLocal(n.address) && !seen.has(n.address) && seen.add(n.address));
}

/**
 * The own address a list that is built before any display asks carries for a dashboard on every address — one entry
 * (werkbank standard on D17, 2026-11-15: a list made before any question carries one entry, and the answer to a display
 * puts in the address of the display's own network, {@link targetForPeer}). It is the chosen address, else the host's
 * first IPv4 address in the order the system lists them (an IPv6 address only on a host without IPv4) — no display is
 * given it as it stands. Without any network the loopback address, which the list leaves out (K11).
 *
 * @param bind The bind setting as the start settled it.
 * @param nets The host's networks (test seam; read fresh by default).
 */
export function listAddress(bind: string | undefined | null, nets: readonly LocalNet[] = localNets()): string {
  const all = hostNets(bind, nets);
  return (all.find(n => n.family === "IPv4") ?? all[0])?.address ?? "127.0.0.1";
}

/**
 * A target as one display gets it: an address of this host in it becomes the host's address in the display's own
 * network, decided by the master `ownAddressFor` at the moment the display asks (werkbank standard on D17, 2026-11-15,
 * the way admin 8.3.5 puts in the address its viewer reached it at — `getHostname` → `currentHostname`). The display's
 * address family decides; a target on another host, or a display no own network holds, keeps the target as it is. Only
 * the host part changes — the rest of the text stays byte for byte.
 *
 * @param url  The resolved target.
 * @param peer The display's address from the socket (never `X-Forwarded-For`, DD 36).
 * @param bind The bind setting.
 * @param nets The host's networks (test seam; read fresh by default).
 */
export function targetForPeer(
  url: string,
  peer: string | undefined,
  bind: string | undefined | null,
  nets: readonly LocalNet[] = localNets(),
): string {
  const authority = /^([a-z][a-z\d+.-]*:\/\/)(\[[^\]]*\]|[^/?#:]*)/i.exec(url);
  if (!authority) {
    return url;
  }
  const host = authority[2].replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!nets.some(n => n.address === host)) {
    return url;
  }
  const own = ownAddressFor(peer, chosenAddress(bind), nets);
  if (own === undefined || own === host) {
    return url;
  }
  return `${authority[1]}${hostForUrl(own)}${url.slice(authority[0].length)}`;
}
