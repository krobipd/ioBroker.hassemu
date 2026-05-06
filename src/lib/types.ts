/**
 * Type definitions for the hassemu adapter.
 */

/** Adapter configuration from io-package.json native section. */
export interface AdapterConfig {
    /** HTTP port for the web server (fixed at 8123 for HA compatibility). */
    port: number;
    /** IP address to bind the server to (0.0.0.0 = all interfaces). */
    bindAddress: string;
    /** Whether authentication is required. */
    authRequired: boolean;
    /** Username for authentication (only used when authRequired=true). */
    username: string;
    /** Password for authentication (only used when authRequired=true). */
    password: string;
    /** Whether mDNS broadcasting is enabled. */
    mdnsEnabled: boolean;
    /** Service name for mDNS discovery. */
    serviceName: string;
    /**
     * v1.25.0 (C11): nur aktivieren wenn der Adapter hinter einem **trusted**
     * Reverse-Proxy mit TLS-Termination läuft. Effekte:
     * - Fastify `trustProxy: true` (req.ip kommt aus X-Forwarded-For)
     * - Cookie `secure: true` wenn der Proxy `X-Forwarded-Proto: https` setzt
     *
     * Achtung: bei `trustProxy: true` ohne echten Reverse-Proxy kann jeder
     * Client per `X-Forwarded-For` den Brute-Force-Lockout umgehen. Default
     * ist `false`. Optional in jsonConfig.
     */
    trustProxy?: boolean;
}

/**
 * Mode value for `clients.<id>.mode` and `global.mode`.
 *
 * - `'global'` (clients only) — delegate to the global mode/manualUrl.
 * - `'manual'` — use the corresponding manualUrl datapoint.
 * - any URL string — redirect there directly. Validated via {@link coerceSafeUrl}.
 *
 * Stored as a plain string state with `common.states` populated by the URL
 * discovery (plus the sentinels above). Empty string / null = no choice yet,
 * resolver returns null which triggers the setup page.
 */
export type ModeValue = string;

/** In-memory record for a known client. Mirrors the clients.<id>.* channel. */
export interface ClientRecord {
    /** Short client ID — used as datapoint segment (e.g. "a4b9c2"). */
    id: string;
    /** Cookie value (UUID) — persistent browser-side identifier. */
    cookie: string;
    /** Currently active OAuth2 access token, or null if not authenticated. */
    token: string | null;
    /**
     * Mode dropdown value: `'global'`, `'manual'` or a concrete URL.
     * See {@link ModeValue}. Empty string until first user choice.
     */
    mode: ModeValue;
    /** Free-text URL used when {@link mode} is `'manual'`. */
    manualUrl: string | null;
    /** Last observed client IP. */
    ip: string | null;
    /** Reverse-DNS hostname of last observed IP (null if lookup failed). */
    hostname: string | null;
}

/** Session data for in-flight OAuth2 flow/code entries. */
export interface SessionData {
    /** Timestamp when the session was created. */
    created: number;
    /** ClientId this session belongs to (set by cookie at flow start). */
    clientId: string | null;
}

/** Minimal adapter interface for dependency injection in library modules. */
export type AdapterInterface = Pick<
    ioBroker.Adapter,
    'log' | 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'
>;

/** Entry returned by URL discovery: key = URL, value = human-readable label. */
export type UrlStates = Record<string, string>;
