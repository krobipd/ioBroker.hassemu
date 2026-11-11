import net from "node:net";
import os from "node:os";
import { chosenAddress } from "./network-address";

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
 * With HTTPS (K4) the scheme is `https` and the host is the name the certificate is valid for — a client checks the
 * certificate against the host it connects to; only a certificate without a name keeps the address.
 *
 * @param bindAddress The configured bind address.
 * @param port        The listen port.
 * @param secure      The HTTPS part (`name`: the certificate's name), or nothing for plain HTTP.
 */
export function advertisedBaseUrl(
  bindAddress: string | undefined | null,
  port: number,
  secure?: { name: string | undefined } | null,
): string {
  if (secure) {
    return `https://${hostForUrl(secure.name ?? resolveAdvertisedHost(bindAddress))}:${port}`;
  }
  return `http://${hostForUrl(resolveAdvertisedHost(bindAddress))}:${port}`;
}

/**
 * Returns the host this server should advertise as its OWN address — used by
 * both the mDNS `base_url`/`internal_url` TXT records and `/api/discovery_info`.
 *
 * A concrete (non-wildcard) bind address is exactly where the server listens,
 * so advertise it verbatim. Only for every address (`0.0.0.0` / `::` / empty, see
 * {@link chosenAddress}) do we fall back to the first routable non-internal IPv4 via {@link getLocalIp}.
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
  // "Every address" (empty, 0.0.0.0, ::) is read by the fleet master alone (review
  // 2026-11-07, R-20 — the own wildcard check here was a second form of it).
  return chosenAddress(bindAddress) ?? getLocalIp();
}
