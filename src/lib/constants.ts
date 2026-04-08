/**
 * Shared constants for the hassemu adapter
 */

/** Emulated Home Assistant version (March 2026) */
export const HA_VERSION = '2026.3.1';

/** Session TTL: 10 minutes */
export const SESSION_TTL_MS = 10 * 60 * 1000;

/** Cleanup interval: 5 minutes */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Login form schema for Home Assistant auth flow */
export const LOGIN_SCHEMA = [
    { name: 'username', required: true, type: 'string' },
    { name: 'password', required: true, type: 'string' },
] as const;
