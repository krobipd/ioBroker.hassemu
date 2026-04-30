/**
 * Shared constants for the hassemu adapter
 */

/**
 * Emulated Home Assistant version reported to clients. HA dashboards / wall
 * displays are tolerant about the value — bumping is mostly cosmetic and not
 * tied to specific monthly HA releases.
 */
export const HA_VERSION = '2026.4.0';

/** Session TTL: 10 minutes */
export const SESSION_TTL_MS = 10 * 60 * 1000;

/** Cleanup interval: 5 minutes */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** OAuth2 access-token TTL — 30 min, matches Home Assistant default. */
export const OAUTH_ACCESS_TOKEN_TTL_S = 30 * 60;

/** Brute-force lockout threshold: failed login attempts per IP before lock kicks in. */
export const LOGIN_LOCKOUT_THRESHOLD = 5;

/** Brute-force lockout window: how long an IP stays locked after threshold reached. */
export const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/** Login form schema for Home Assistant auth flow */
export const LOGIN_SCHEMA = [
    { name: 'username', required: true, type: 'string' },
    { name: 'password', required: true, type: 'string' },
] as const;
