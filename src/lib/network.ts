import crypto from 'node:crypto';
import os from 'node:os';

/**
 * Returns the first non-internal IPv4 address, falls back to non-internal
 * IPv6, finally `127.0.0.1`.
 *
 * v1.15.0 (D10): Pure-IPv6-LAN-Hosts hatten nur `127.0.0.1` als advertise-IP
 * — mDNS broadcastete dann unbrauchbares Loopback. Jetzt: IPv6-Fallback
 * vor Loopback. IPv4 hat weiterhin Vorrang weil HA-Clients (Wall Display
 * etc.) traditionell IPv4 erwarten.
 *
 * v1.21.0 (E6): Docker-Bridge-IPs (172.17.x.x default + ähnliche Container-
 * Bridges) werden gegenüber „echten" LAN-IPs deprioritisiert — `bind: 0.0.0.0`
 * + Docker führte sonst dazu, dass mDNS die Container-Bridge advertised, die
 * vom LAN aus nicht erreichbar ist. Echte LAN-IPs (192.168.x.x, 10.x.x.x,
 * 172.16-31.x.x außer 172.17) haben Vorrang.
 */
export function getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    let dockerBridgeFallback: string | null = null;
    let ipv6Fallback: string | null = null;
    for (const ifaces of Object.values(interfaces)) {
        if (!ifaces) {
            continue;
        }
        for (const iface of ifaces) {
            if (iface.internal) {
                continue;
            }
            if (iface.family === 'IPv4') {
                if (iface.address.startsWith('172.17.') || iface.address.startsWith('172.18.')) {
                    // Default Docker-Bridge — only use as last resort.
                    if (!dockerBridgeFallback) {
                        dockerBridgeFallback = iface.address;
                    }
                    continue;
                }
                return iface.address;
            }
            if (iface.family === 'IPv6' && !ipv6Fallback) {
                ipv6Fallback = iface.address;
            }
        }
    }
    return dockerBridgeFallback ?? ipv6Fallback ?? '127.0.0.1';
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
    return bindAddress === '0.0.0.0' || bindAddress === '::';
}

/**
 * Generates a short (6-char), URL-safe, lowercase hex client ID.
 * 16^6 = 16.7 million combinations — sufficient for home networks, readable as
 * a datapoint segment. Uses `crypto.randomBytes` for consistency with the rest
 * of the codebase (cookies, session ids, tokens are all crypto-secure).
 */
export function generateClientId(): string {
    return crypto.randomBytes(3).toString('hex');
}
