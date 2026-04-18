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
 * Resolves a bind address to a reachable IP: if wildcard, falls back to getLocalIp().
 *
 * @param bindAddress The configured bind address.
 */
export function resolveBindToReachable(bindAddress: string | undefined | null): string {
    return isWildcardBind(bindAddress) ? getLocalIp() : bindAddress!;
}

const CLIENT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generates a short (6-char), URL-safe, lowercase alphanumeric client ID.
 * ~2 billion combinations — good enough for home networks, plain-readable as a datapoint segment.
 */
export function generateClientId(): string {
    let out = '';
    for (let i = 0; i < 6; i++) {
        out += CLIENT_ID_CHARS[Math.floor(Math.random() * CLIENT_ID_CHARS.length)];
    }
    return out;
}
