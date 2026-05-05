import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
    HA_VERSION,
    SESSION_TTL_MS,
    CLEANUP_INTERVAL_MS,
    LOGIN_SCHEMA,
    OAUTH_ACCESS_TOKEN_TTL_S,
    LOGIN_LOCKOUT_THRESHOLD,
    LOGIN_LOCKOUT_WINDOW_MS,
} from './constants';
import { coerceString, coerceUuid } from './coerce';
import type { ClientRegistry } from './client-registry';
import type { GlobalConfig } from './global-config';
import { renderLandingPage } from './landing-page';
import type { AdapterConfig, AdapterInterface, ClientRecord, SessionData } from './types';

/** Hard cap on in-flight auth flow sessions. Older entries are dropped FIFO when full. */
const SESSIONS_CAP = 100;
/** Hard cap on remembered refresh tokens. Older entries are dropped FIFO when full. */
const REFRESH_TOKENS_CAP = 200;
/**
 * Hard cap on tracked login-attempt entries. Internet-exposed instances see
 * carrier-grade-NAT IPs accumulate over time — without a cap, the map leaks.
 * Older entries are dropped FIFO when full.
 */
const LOGIN_ATTEMPTS_CAP = 1000;

/**
 * Constant-time string comparison for credential checks. Returns false for length mismatch.
 *
 * @param a First string to compare.
 * @param b Second string to compare.
 */
function safeStringEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) {
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

/** Adapter surface the WebServer depends on — adds `namespace` for the setup page. */
export type WebServerAdapter = AdapterInterface & Pick<ioBroker.Adapter, 'namespace'>;

/** Browser cookie name. Client identity lives here — auto-sent on every page navigation. */
export const CLIENT_COOKIE = 'hassemu_client';
/** Cookie lifetime (10 years). Clients stay identified essentially forever unless removed. */
const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60;

/**
 * Fastify web server emulating the HA REST API.
 *
 * Each incoming request is identified by cookie → {@link ClientRegistry} entry; new clients
 * get a channel created on first hit. Express was swapped for Fastify in 1.1.0 for first-party
 * cookie support, schema validation and a lighter runtime.
 */
export class WebServer {
    private readonly adapter: WebServerAdapter;
    private readonly config: AdapterConfig;
    private readonly registry: ClientRegistry;
    private readonly globalConfig: GlobalConfig;
    private readonly app: FastifyInstance;
    public readonly sessions: Map<string, SessionData> = new Map();
    /**
     * Issued refresh tokens → owning clientId. Validated on every refresh-grant —
     * unknown tokens are rejected (was: any string accepted).
     */
    public readonly refreshTokens: Map<string, string> = new Map();
    /**
     * Brute-force lockout state per remote IP. Each entry tracks failed login
     * attempts and the timestamp of the last failure; once
     * {@link LOGIN_LOCKOUT_THRESHOLD} is reached, `lockedUntil` is set and
     * further attempts from that IP are rejected with HTTP 429 until the
     * window passes. The map is FIFO-capped at {@link LOGIN_ATTEMPTS_CAP}
     * (else internet-exposed instances leak slowly via stray failure counts
     * with `lockedUntil=0`); expired and stale entries are pruned in
     * {@link cleanupSessions}.
     */
    public readonly loginAttempts: Map<string, { failedCount: number; lockedUntil: number; lastSeen: number }> =
        new Map();
    private cleanupTimer: ioBroker.Interval | null = null;
    public readonly instanceUuid: string;
    /** ioBroker system language for the setup page — resolved on startup. */
    public readonly systemLanguage: string;
    /** Set of IPs whose reverse DNS lookup is already in-flight — prevents duplicate work. */
    private readonly dnsInFlight = new Set<string>();

    /**
     * @param adapter        Adapter instance used for logging, timers and namespace.
     * @param config         Resolved runtime config.
     * @param registry       Multi-client registry.
     * @param globalConfig   Global redirect override.
     * @param instanceUuid   Stable UUID shared with the mDNS advert.
     * @param systemLanguage ioBroker system language (`en`, `de`, …) used for the setup page.
     */
    constructor(
        adapter: WebServerAdapter,
        config: AdapterConfig,
        registry: ClientRegistry,
        globalConfig: GlobalConfig,
        instanceUuid: string,
        systemLanguage: string = 'en',
    ) {
        this.adapter = adapter;
        this.config = config;
        this.registry = registry;
        this.globalConfig = globalConfig;
        this.instanceUuid = instanceUuid;
        this.systemLanguage = systemLanguage;
        this.app = Fastify({ logger: false, trustProxy: false });
    }

    /** Human-readable service name advertised in responses and mDNS. */
    get serviceName(): string {
        return this.config.serviceName || 'ioBroker';
    }

    /** Resolved listener address once `start()` has completed, or null otherwise. */
    get boundAddress(): { address: string; port: number } | null {
        const addr = this.app.server.address();
        if (!addr || typeof addr === 'string') {
            return null;
        }
        return { address: addr.address, port: addr.port };
    }

    // --- lifecycle ---

    /** Registers plugins and starts the HTTP listener. */
    async start(): Promise<void> {
        await this.app.register(fastifyCookie);
        // OAuth2-Spec verlangt `application/x-www-form-urlencoded` für `/auth/token`.
        // Echte HA-Reference-Clients (frontend/Wall Display SDK) folgen dem.
        // Fastify hat by-default nur einen JSON-Bodyparser — ohne diesen Plugin
        // beantwortet `/auth/token` mit form-Body 415 und der Login bleibt komplett
        // hängen. Tests via `app.inject({payload:{...}})` serialisieren zu JSON
        // und maskieren das.
        await this.app.register(fastifyFormbody);
        this.setupErrorHandler();
        this.setupRoutes();

        const bindAddress = this.config.bindAddress || '0.0.0.0';
        try {
            await this.app.listen({ port: this.config.port, host: bindAddress });
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            const msg =
                e.code === 'EADDRINUSE' ? `Port ${this.config.port} is already in use!` : `Server error: ${e.message}`;
            this.adapter.log.error(msg);
            throw err;
        }
        this.adapter.log.debug(`Web server listening on ${bindAddress}:${this.config.port}`);

        this.cleanupTimer = this.adapter.setInterval(() => this.cleanupSessions(), CLEANUP_INTERVAL_MS) ?? null;
    }

    /** Stops the listener and cancels the session cleanup timer. */
    async stop(): Promise<void> {
        if (this.cleanupTimer) {
            this.adapter.clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        try {
            await this.app.close();
            this.adapter.log.debug('Web server stopped');
        } catch (err) {
            this.adapter.log.error(`Web server stop error: ${String(err)}`);
        }
    }

    /** Exposed for testing — fires injected requests without a real socket. */
    get inject(): FastifyInstance['inject'] {
        return this.app.inject.bind(this.app);
    }

    /** Periodic cleanup of expired in-flight auth sessions and stale lockouts. */
    public cleanupSessions(): void {
        const now = Date.now();
        let cleanedSessions = 0;
        for (const [key, session] of this.sessions) {
            if (now - session.created > SESSION_TTL_MS) {
                this.sessions.delete(key);
                cleanedSessions++;
            }
        }
        if (cleanedSessions > 0) {
            this.adapter.log.debug(`Session cleanup: removed ${cleanedSessions} expired sessions`);
        }
        let cleanedLockouts = 0;
        for (const [ip, entry] of this.loginAttempts) {
            // Expired lockout — IP gets a fresh budget on next attempt.
            if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
                this.loginAttempts.delete(ip);
                cleanedLockouts++;
                continue;
            }
            // Stale failure-count without active lockout (failedCount<threshold,
            // lockedUntil=0). Without this prune, every distinct IP that ever
            // typed a wrong password leaves a row behind forever.
            if (entry.lockedUntil === 0 && entry.failedCount > 0 && now - entry.lastSeen > LOGIN_LOCKOUT_WINDOW_MS) {
                this.loginAttempts.delete(ip);
                cleanedLockouts++;
            }
        }
        if (cleanedLockouts > 0) {
            this.adapter.log.debug(`Lockout cleanup: cleared ${cleanedLockouts} expired/stale IP entries`);
        }
    }

    /**
     * Drops the oldest entry of a Map if it would exceed `cap` after the next insert.
     * Map iteration order in JS is insertion order, so `keys().next()` is the oldest.
     *
     * @param map Map to evict from.
     * @param cap Hard cap; when `map.size >= cap`, the oldest entry is removed.
     */
    private static evictOldest<V>(map: Map<string, V>, cap: number): void {
        if (map.size < cap) {
            return;
        }
        const oldest = map.keys().next().value;
        if (oldest !== undefined) {
            map.delete(oldest);
        }
    }

    /**
     * Inserts a session, dropping the oldest entry if {@link SESSIONS_CAP} is exceeded.
     *
     * @param key  Session key (flow id or auth code).
     * @param data Session payload.
     */
    private storeSession(key: string, data: SessionData): void {
        WebServer.evictOldest(this.sessions, SESSIONS_CAP);
        this.sessions.set(key, data);
    }

    /**
     * Inserts a refresh token mapping, dropping the oldest if cap exceeded.
     *
     * @param token    Refresh token issued in `/auth/token`.
     * @param clientId Owning client id.
     */
    private storeRefreshToken(token: string, clientId: string): void {
        WebServer.evictOldest(this.refreshTokens, REFRESH_TOKENS_CAP);
        this.refreshTokens.set(token, clientId);
    }

    /**
     * Brute-force lockout: returns true if `ip` is currently in the timeout window.
     * Lazy-resets entries whose lockout already expired (caller can immediately try again).
     *
     * @param ip Remote IP, or null when unavailable.
     */
    private isIpLocked(ip: string | null): boolean {
        if (!ip) {
            return false;
        }
        const entry = this.loginAttempts.get(ip);
        if (!entry || entry.lockedUntil === 0) {
            return false;
        }
        if (entry.lockedUntil > Date.now()) {
            return true;
        }
        // Lockout window passed — drop the entry, IP gets a fresh budget.
        this.loginAttempts.delete(ip);
        return false;
    }

    /**
     * Records a failed login attempt for `ip`. When the running count reaches
     * {@link LOGIN_LOCKOUT_THRESHOLD}, the IP is locked for
     * {@link LOGIN_LOCKOUT_WINDOW_MS}.
     *
     * @param ip Remote IP that failed authentication.
     */
    private recordLoginFailure(ip: string | null): void {
        if (!ip) {
            return;
        }
        const now = Date.now();
        const entry = this.loginAttempts.get(ip) ?? { failedCount: 0, lockedUntil: 0, lastSeen: now };
        entry.failedCount += 1;
        entry.lastSeen = now;
        if (entry.failedCount >= LOGIN_LOCKOUT_THRESHOLD) {
            entry.lockedUntil = now + LOGIN_LOCKOUT_WINDOW_MS;
            this.adapter.log.warn(
                `Login lockout: IP ${ip} reached ${LOGIN_LOCKOUT_THRESHOLD} failed attempts — ` +
                    `locked for ${Math.round(LOGIN_LOCKOUT_WINDOW_MS / 60000)} min`,
            );
        }
        // Cap loginAttempts before insert to avoid unbounded growth from stray
        // attempts. evictOldest is a no-op when this ip already exists in map
        // (size won't change on re-set).
        if (!this.loginAttempts.has(ip)) {
            WebServer.evictOldest(this.loginAttempts, LOGIN_ATTEMPTS_CAP);
        }
        this.loginAttempts.set(ip, entry);
    }

    /**
     * Resets the failure counter and any active lockout for `ip`. Called after
     * a successful credential check so legit clients don't accumulate counts
     * across long-lived sessions.
     *
     * @param ip Remote IP that just authenticated successfully.
     */
    private clearLoginAttempts(ip: string | null): void {
        if (ip) {
            this.loginAttempts.delete(ip);
        }
    }

    // --- client identification ---

    private async identify(req: FastifyRequest, reply: FastifyReply): Promise<ClientRecord> {
        const cookie = coerceUuid(req.cookies?.[CLIENT_COOKIE]);
        const ip = coerceString(req.ip);
        const record = await this.registry.identifyOrCreate(cookie, ip, null);
        if (cookie !== record.cookie) {
            reply.setCookie(CLIENT_COOKIE, record.cookie, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                maxAge: COOKIE_MAX_AGE_S,
            });
        }
        if (ip) {
            this.resolveHostnameAsync(record, ip);
        }
        return record;
    }

    private resolveHostnameAsync(record: ClientRecord, ip: string): void {
        if (record.hostname || this.dnsInFlight.has(ip)) {
            return;
        }
        this.dnsInFlight.add(ip);
        dns.reverse(ip)
            .then(names => {
                const name = names[0];
                if (name) {
                    this.registry.identifyOrCreate(record.cookie, ip, name).catch(() => {
                        /* registry itself logs */
                    });
                }
            })
            .catch(() => {
                // Reverse DNS often fails on LAN — intentionally silent.
            })
            .finally(() => {
                this.dnsInFlight.delete(ip);
            });
    }

    // --- error handling ---

    private setupErrorHandler(): void {
        this.app.setErrorHandler((err, _req, reply) => {
            const error = err as Error & { validation?: unknown; statusCode?: number };
            if (error.validation) {
                this.adapter.log.debug(`Validation error: ${error.message}`);
                reply.status(400).send({ error: 'Invalid request', details: error.message });
                return;
            }
            // Fastify body-parsing / client errors already set statusCode in 4xx range
            const code = typeof error.statusCode === 'number' ? error.statusCode : 500;
            if (code >= 400 && code < 500) {
                this.adapter.log.debug(`Client error ${code}: ${error.message}`);
                reply.status(code).send({ error: error.message });
                return;
            }
            this.adapter.log.warn(`Request error: ${error.message}`);
            reply.status(500).send({ error: 'Internal server error' });
        });
    }

    // --- routes ---

    private setupRoutes(): void {
        this.setupApiRoutes();
        this.setupAuthRoutes();
        this.setupMiscRoutes();
        this.setupNotFound();
    }

    private setupApiRoutes(): void {
        // CRITICAL: trailing slash — HA clients check this endpoint for discovery
        this.app.get('/api/', () => ({ message: 'API running.' }));

        this.app.get('/api/config', () => ({
            components: ['http', 'api', 'frontend', 'homeassistant'],
            config_dir: '/config',
            elevation: 0,
            latitude: 0,
            longitude: 0,
            location_name: this.serviceName,
            time_zone: 'UTC',
            unit_system: { length: 'km', mass: 'g', temperature: '°C', volume: 'L' },
            version: HA_VERSION,
            whitelist_external_dirs: [],
        }));

        this.app.get('/api/discovery_info', req => {
            const host = req.hostname || this.config.bindAddress || '0.0.0.0';
            const baseUrl = `http://${host}:${this.config.port}`;
            return {
                base_url: baseUrl,
                external_url: null,
                internal_url: baseUrl,
                location_name: this.serviceName,
                // Vorher hardcoded `true` unabhängig von authRequired — strict HA-Clients
                // versuchten Auth auch bei authRequired=false und scheiterten am leeren Login-Flow.
                requires_api_password: this.config.authRequired,
                uuid: this.instanceUuid,
                version: HA_VERSION,
            };
        });

        for (const path of ['/api/states', '/api/services', '/api/events']) {
            this.app.get(path, () => []);
        }
        this.app.get('/api/error_log', () => '');
    }

    private setupAuthRoutes(): void {
        this.app.get('/auth/providers', () => [{ name: 'Home Assistant Local', type: 'homeassistant', id: null }]);

        this.app.post('/auth/login_flow', async (req, reply) => {
            const client = await this.identify(req, reply);
            const flowId = crypto.randomUUID();
            this.storeSession(flowId, { created: Date.now(), clientId: client.id });
            this.adapter.log.debug(`Auth flow created: ${flowId} for client ${client.id}`);

            return {
                type: 'form',
                flow_id: flowId,
                handler: ['homeassistant', null],
                step_id: 'init',
                data_schema: LOGIN_SCHEMA,
                description_placeholders: null,
                errors: null,
            };
        });

        this.app.post<{
            Params: { flowId: string };
            Body: { username?: string; password?: string };
        }>(
            '/auth/login_flow/:flowId',
            {
                schema: {
                    params: {
                        type: 'object',
                        properties: { flowId: { type: 'string', minLength: 1 } },
                        required: ['flowId'],
                    },
                },
            },
            async (req, reply) => {
                const flowId = req.params.flowId;
                const session = this.sessions.get(flowId);
                if (!session) {
                    this.adapter.log.warn(`Unknown flow_id: ${flowId}`);
                    reply.status(400);
                    return { type: 'abort', flow_id: flowId, reason: 'unknown_flow' };
                }

                if (this.config.authRequired) {
                    const ip = coerceString(req.ip);
                    if (this.isIpLocked(ip)) {
                        this.adapter.log.warn(`Login rejected: IP ${ip} is currently locked out`);
                        reply.status(429);
                        return { type: 'abort', flow_id: flowId, reason: 'too_many_failed_attempts' };
                    }
                    const { username, password } = req.body ?? {};
                    const userOk = typeof username === 'string' && safeStringEqual(username, this.config.username);
                    const passOk = typeof password === 'string' && safeStringEqual(password, this.config.password);
                    if (!userOk || !passOk) {
                        this.recordLoginFailure(ip);
                        this.adapter.log.warn('Invalid credentials');
                        reply.status(400);
                        return {
                            type: 'form',
                            flow_id: flowId,
                            handler: ['homeassistant', null],
                            step_id: 'init',
                            data_schema: LOGIN_SCHEMA,
                            errors: { base: 'invalid_auth' },
                            description_placeholders: null,
                        };
                    }
                    this.clearLoginAttempts(ip);
                }

                this.sessions.delete(flowId);
                const code = crypto.randomUUID();
                this.storeSession(code, { created: Date.now(), clientId: session.clientId });
                this.adapter.log.debug('Auth flow completed — code issued');

                return {
                    version: 1,
                    type: 'create_entry',
                    flow_id: flowId,
                    handler: ['homeassistant', null],
                    result: code,
                    description: null,
                    description_placeholders: null,
                };
            },
        );

        this.app.post<{ Body: { code?: string; grant_type?: string; refresh_token?: string } }>(
            '/auth/token',
            async (req, reply) => {
                const { code, grant_type, refresh_token } = req.body ?? {};

                if (grant_type === 'authorization_code' && code && this.sessions.has(code)) {
                    const session = this.sessions.get(code)!;
                    this.sessions.delete(code);
                    const token = crypto.randomUUID();
                    const refreshToken = crypto.randomUUID();
                    if (session.clientId) {
                        await this.registry.setToken(session.clientId, token);
                        this.storeRefreshToken(refreshToken, session.clientId);
                        this.adapter.log.debug(`Display authenticated — client ${session.clientId}`);
                    }
                    return {
                        access_token: token,
                        token_type: 'Bearer',
                        refresh_token: refreshToken,
                        expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
                    };
                }

                if (grant_type === 'refresh_token') {
                    // Validate the refresh token against issued ones — was previously
                    // accepting any string and minting a new access_token (security fix v1.2.0).
                    const incoming = typeof refresh_token === 'string' ? refresh_token : '';
                    const ownerId = incoming ? this.refreshTokens.get(incoming) : undefined;
                    if (!ownerId) {
                        this.adapter.log.warn('Refresh token rejected — unknown or missing');
                        reply.status(400);
                        return { error: 'invalid_grant', error_description: 'Invalid refresh token' };
                    }
                    const newAccess = crypto.randomUUID();
                    await this.registry.setToken(ownerId, newAccess);
                    return {
                        access_token: newAccess,
                        token_type: 'Bearer',
                        expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
                    };
                }

                this.adapter.log.warn(`Token exchange failed: grant_type=${String(grant_type)}`);
                reply.status(400);
                return { error: 'invalid_request', error_description: 'Invalid or expired code' };
            },
        );
    }

    private setupMiscRoutes(): void {
        // Liveness only — no config leak. Earlier versions exposed the global
        // redirect URL via /health which is unauthenticated; removed in v1.2.0.
        // v1.5.0: auch der `config: { mdns, auth }`-Block raus — Auth-Status leakte
        // unauthenticated und ließ sich von einem Network-Attacker zur Reconnaissance
        // nutzen (auth-disabled Instances quickly mappen).
        this.app.get('/health', () => ({
            status: 'ok',
            adapter: 'hassemu',
            version: HA_VERSION,
        }));

        this.app.get('/manifest.json', () => ({
            name: this.serviceName,
            short_name: this.serviceName,
            start_url: '/',
            display: 'standalone',
            background_color: '#ffffff',
            theme_color: '#03a9f4',
        }));

        // Root — 302 redirect, or landing page when no URL is configured
        this.app.get('/', async (req, reply) => {
            const client = await this.identify(req, reply);
            const url = this.globalConfig.resolveUrlFor(client);
            if (!url) {
                this.adapter.log.debug(`No redirect URL for client ${client.id} — serving landing page`);
                return reply
                    .status(200)
                    .type('text/html; charset=utf-8')
                    .send(renderLandingPage(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
            }
            this.adapter.log.debug(`Redirecting client ${client.id} → ${url}`);
            return reply.redirect(url, 302);
        });
    }

    private setupNotFound(): void {
        this.app.setNotFoundHandler((req, reply) => {
            this.adapter.log.debug(`404: ${req.method} ${req.url}`);
            reply.status(404).send({ error: 'Not Found', path: req.url });
        });
    }
}
