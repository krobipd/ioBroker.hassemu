import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";

/**
 * Interfaces that are not the LAN a display lives in: container and VM bridges, VPN tunnels.
 * Their addresses are only a last resort (audit 2026-09-25, H10 — before, only the Docker
 * default bridges 172.17.x/172.18.x were recognised, by prefix; a Compose bridge 172.20.x or a
 * Tailscale 100.64.x address was advertised whenever its interface came first).
 */
const VIRTUAL_IFACE =
  /^(docker|br-|veth|virbr|lxcbr|lxdbr|cni|flannel|cali|kube|podman|vmnet|vboxnet|tailscale|zt|wg|tun|tap|utun|ham)/i;

/**
 * A link-local address (fe80::/10, 169.254.0.0/16): valid only on one link and, for IPv6,
 * only with a zone id — useless in a URL a display is given.
 *
 * @param iface Interface entry.
 */
function isLinkLocal(iface: os.NetworkInterfaceInfo): boolean {
  return iface.family === "IPv6" ? /^fe[89ab]/i.test(iface.address) : iface.address.startsWith("169.254.");
}

/**
 * A container/VM/VPN interface — by name, plus the Docker default bridges by address.
 *
 * @param name  Interface name.
 * @param iface Interface entry.
 */
function isVirtual(name: string, iface: os.NetworkInterfaceInfo): boolean {
  return (
    VIRTUAL_IFACE.test(name) ||
    (iface.family === "IPv4" && (iface.address.startsWith("172.17.") || iface.address.startsWith("172.18.")))
  );
}

/**
 * The address this host is reachable at from the LAN, in this order: a physical IPv4, a
 * physical IPv6, a virtual IPv4, a virtual IPv6, finally `127.0.0.1`. Internal and link-local
 * addresses never count. A physical IPv6 goes before a virtual IPv4 because the virtual one is
 * not reachable from the LAN at all.
 *
 * v1.15.0 (D10): an IPv6-only LAN host no longer advertises loopback. v1.21.0 (E6): container
 * bridges rank last. Audit 2026-09-25 (H10): link-local skipped, bridges and VPNs by name.
 */
export function getLocalIp(): string {
  let physicalV6: string | null = null;
  let virtualV4: string | null = null;
  let virtualV6: string | null = null;
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.internal || isLinkLocal(iface)) {
        continue;
      }
      const virtual = isVirtual(name, iface);
      if (iface.family === "IPv4") {
        if (!virtual) {
          return iface.address;
        }
        virtualV4 ??= iface.address;
      } else if (iface.family === "IPv6") {
        if (virtual) {
          virtualV6 ??= iface.address;
        } else {
          physicalV6 ??= iface.address;
        }
      }
    }
  }
  return physicalV6 ?? virtualV4 ?? virtualV6 ?? "127.0.0.1";
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
 * The base URL this server advertises (mDNS TXT `base_url`/`internal_url`, `/api/discovery_info`).
 *
 * @param bindAddress The configured bind address.
 * @param port        The listen port.
 */
export function advertisedBaseUrl(bindAddress: string | undefined | null, port: number): string {
  return `http://${hostForUrl(resolveAdvertisedHost(bindAddress))}:${port}`;
}

/**
 * Returns true if the bind address means "any interface" (0.0.0.0, empty or undefined).
 *
 * @param bindAddress The configured bind address.
 */
export function isWildcardBind(bindAddress: string | undefined | null): boolean {
  if (!bindAddress) {
    return true;
  }
  return bindAddress === "0.0.0.0" || bindAddress === "::";
}

/**
 * Returns the host this server should advertise as its OWN address — used by
 * both the mDNS `base_url`/`internal_url` TXT records and `/api/discovery_info`.
 *
 * A concrete (non-wildcard) bind address is exactly where the server listens,
 * so advertise it verbatim. Only for a wildcard bind (`0.0.0.0` / `::` / empty)
 * do we fall back to the first routable non-internal IPv4 via {@link getLocalIp}.
 *
 * Single source of truth so the two discovery channels never diverge: before
 * this, `mdns.ts` advertised `getLocalIp()` unconditionally while
 * `/api/discovery_info` already preferred the bind address — on a multi-homed
 * host mDNS could point Home Assistant clients at a different interface than the
 * one actually bound, breaking auto-discovery.
 *
 * @param bindAddress The configured bind address.
 */
export function resolveAdvertisedHost(bindAddress: string | undefined | null): string {
  // The `bindAddress &&` keeps the type narrowed to a non-empty string for the
  // return (isWildcardBind alone doesn't narrow); it also short-circuits the
  // wildcard/empty cases to getLocalIp below.
  if (bindAddress && !isWildcardBind(bindAddress)) {
    return bindAddress;
  }
  return getLocalIp();
}

/**
 * Generates a short (6-char), URL-safe, lowercase hex client ID.
 * 16^6 = 16.7 million combinations — sufficient for home networks, readable as
 * a datapoint segment. Uses `crypto.randomBytes` for consistency with the rest
 * of the codebase (cookies, session ids, tokens are all crypto-secure).
 */
export function generateClientId(): string {
  return crypto.randomBytes(3).toString("hex");
}
