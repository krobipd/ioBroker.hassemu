/**
 * Shared constants for the hassemu adapter
 */

/**
 * Emulated Home Assistant version reported to clients. HA dashboards / wall
 * displays are tolerant about the value — bumping is mostly cosmetic and not
 * tied to specific monthly HA releases.
 */
export const HA_VERSION = "2026.4.0";

/**
 * Default mDNS service name / HTTP `location_name` when the user leaves the
 * `serviceName` config blank. Single source so the mDNS advert and the HTTP
 * responses never advertise different names.
 */
export const DEFAULT_SERVICE_NAME = "ioBroker";

/** Session TTL: 10 minutes */
export const SESSION_TTL_MS = 10 * 60 * 1000;

/** Cleanup interval: 5 minutes */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** OAuth2 access-token TTL — 30 min, matches Home Assistant default. */
export const OAUTH_ACCESS_TOKEN_TTL_S = 30 * 60;

/**
 * Fail-fast window for the `/api/websocket` handshake: if no valid `auth` frame
 * arrives within this time, the socket is closed. Keeps the WS from hanging the
 * HA Companion App's best-effort `getCurrentUser()` call (which a clean 404
 * previously failed fast on). 5 s is generous for a LAN round-trip.
 */
export const WS_AUTH_TIMEOUT_MS = 5 * 1000;

/**
 * Max accepted WebSocket frame size in bytes. hassemu's WS frames are tiny
 * auth/command JSON messages — without an explicit cap, `@fastify/websocket`
 * inherits ws's 100 MiB default, letting an unauthenticated client buffer
 * huge pre-auth frames (memory pressure). 64 KiB is far above any real HA
 * command frame.
 */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Keep-alive ping cadence for an authenticated `/api/websocket` connection.
 * After `auth_ok` the server pings each socket every interval; a socket that
 * has not answered a pong since the previous ping is terminated. Bounds the
 * FD/memory build-up from displays that are power-cut without a clean close
 * (ws 8.x does not ping server-side on its own — verified against the bundled lib).
 */
export const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * Reverse-DNS lookup deadline. Beyond this the lookup is abandoned (Promise.race)
 * so a slow or broken resolver never stalls a request. Named here alongside the
 * other adapter time windows (was an inline `5_000`).
 */
export const DNS_REVERSE_TIMEOUT_MS = 5 * 1000;

/**
 * Negative-cache window for reverse DNS: once a lookup yields no hostname for an
 * IP, it is not retried until this elapses. Without it a DHCP client with no PTR
 * record (the LAN norm) triggers a fresh `dns.reverse` + timeout timer on every
 * single request. An IP change or a hostname the user set still short-circuits it.
 */
export const DNS_NEGATIVE_CACHE_MS = 60 * 60 * 1000;

/** Stale-Client-GC threshold: clients without token + lastSeen older are auto-removed. */
export const STALE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** `native.lastSeen` is rewritten at most once per this window per client (GC input). */
export const LASTSEEN_FLUSH_INTERVAL_MS = 60 * 60 * 1000;

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
 * Hard cap for the per-IP new-client burst tracker (`client-registry.newClientBurst`).
 * FIFO-Eviction analog der anderen Caps; verhindert unbounded growth bei broken-cookie
 * Display-Farmen oder Brute-Force-Burst.
 */
export const NEW_CLIENT_BURST_CAP = 200;

/**
 * Above this many new (cookieless) clients per hour from a single IP, the
 * registry stops minting *persistent* `clients.<id>` objects for that IP and
 * serves transient (non-persisted) records instead — so a cookieless request
 * spray (or a badly broken client that never keeps its cookie) cannot grow the
 * ioBroker object DB without bound. Generous: a normal install onboards a
 * handful of displays once each (each then keeps its cookie), so a real client
 * never approaches this; the existing burst-warn already fires at
 * NEW_CLIENT_BURST_WARN_THRESHOLD/h.
 */
export const NEW_CLIENT_THROTTLE_PER_HOUR = 30;

/**
 * Rolling window for the per-IP new-client tracking. Both the throttle decision
 * ({@link NEW_CLIENT_THROTTLE_PER_HOUR}) and the burst-warn operate on the same
 * `newClientBurst` map, so they MUST share this window — one named constant
 * keeps them from drifting apart.
 */
export const NEW_CLIENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * A one-time burst warning fires once an IP mints more than this many new
 * clients within {@link NEW_CLIENT_WINDOW_MS} (typically a display not keeping
 * its cookie). The lower rung of the escalation ladder below the throttle.
 */
export const NEW_CLIENT_BURST_WARN_THRESHOLD = 3;

/**
 * Resolver-Sentinels für `client.mode` und `global.mode`. `'global'` heißt:
 * delegate an `global.mode`. `'manual'` heißt: nutze die zugehörige
 * `manualUrl`-State. Jeder andere String wird als URL interpretiert.
 */
export const MODE_GLOBAL = "global";
export const MODE_MANUAL = "manual";

/**
 * Timeout for one reachability probe of the redirect target (v1.39.0). Short on
 * purpose: the probe answers "does anything answer on that address", not "is the
 * dashboard healthy" — a LAN target that needs longer than this is down for the
 * display's practical purposes too.
 */
export const TARGET_PROBE_TIMEOUT_MS = 4_000;

/**
 * How long one probe result stays valid (v1.39.0). Slightly below the wrapper's
 * 30s poll interval so every poll round triggers at most ONE fresh probe per
 * target, no matter how many displays share it.
 */
export const TARGET_PROBE_CACHE_MS = 25_000;

/**
 * FIFO cap for the target-health cache (v1.39.0). Targets come from config
 * (discovered dashboards + manual URLs), so a handful is the norm — the cap only
 * guards against unbounded growth if targets churn over months.
 */
export const TARGET_HEALTH_CACHE_CAP = 50;

/** Login form schema for Home Assistant auth flow */
export const LOGIN_SCHEMA = [
  { name: "username", required: true, type: "string" },
  { name: "password", required: true, type: "string" },
] as const;
