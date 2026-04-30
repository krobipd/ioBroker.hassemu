import crypto from 'node:crypto';
import os from 'node:os';

/** Returns the first non-internal IPv4 address, or `127.0.0.1` as fallback. */
export function getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
        if (!ifaces) {
            continue;
        }
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
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
