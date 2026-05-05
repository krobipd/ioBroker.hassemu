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
 */
export function getLocalIp(): string {
    const interfaces = os.networkInterfaces();
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
                return iface.address;
            }
            if (iface.family === 'IPv6' && !ipv6Fallback) {
                ipv6Fallback = iface.address;
            }
        }
    }
    return ipv6Fallback ?? '127.0.0.1';
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
