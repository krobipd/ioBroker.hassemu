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

/** Stale-Client-GC threshold: clients without token + lastSeen older are auto-removed. */
export const STALE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Browser cookie lifetime (10 years) — clients keep their identity essentially forever. */
export const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60;

/** Hard cap on in-flight auth flow sessions. Older entries are dropped FIFO when full. */
export const SESSIONS_CAP = 100;
/**
 * Hard cap on mobile-app webhook registrations (HA Companion App). Older
 * entries are dropped FIFO when full. Each Shelly Wall Display / HA app
 * onboarding adds exactly one entry; a typical install has <10 active
 * registrations.
 */
export const WEBHOOK_REGISTRATIONS_CAP = 200;
/**
 * Cooldown window between repeated `warn`-level logs of the same 5xx error
 * message — first occurrence pro unique message comes through at warn, all
 * repeats within this window fall to debug. Prevents log-spam under probe
 * traffic / malformed request attacks.
 */
export const REQUEST_ERROR_COOLDOWN_MS = 60 * 1000;
/** Hard cap on tracked unique error-message keys for cooldown deduplication. */
export const REQUEST_ERROR_COOLDOWN_CAP = 200;

/**
 * Resolver-Sentinels für `client.mode` und `global.mode`. `'global'` heißt:
 * delegate an `global.mode`. `'manual'` heißt: nutze die zugehörige
 * `manualUrl`-State. Jeder andere String wird als URL interpretiert.
 */
export const MODE_GLOBAL = 'global';
export const MODE_MANUAL = 'manual';

/** Login form schema for Home Assistant auth flow */
export const LOGIN_SCHEMA = [
    { name: 'username', required: true, type: 'string' },
    { name: 'password', required: true, type: 'string' },
] as const;
