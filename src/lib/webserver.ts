import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { HA_VERSION, SESSION_TTL_MS, CLEANUP_INTERVAL_MS, LOGIN_SCHEMA } from './constants';
import { coerceString, coerceUuid } from './coerce';
import type { ClientRegistry } from './client-registry';
import type { GlobalConfig } from './global-config';
import { renderSetupPage } from './setup-page';
import type { AdapterConfig, AdapterInterface, ClientRecord, SessionData } from './types';

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

    /** Periodic cleanup of expired in-flight auth sessions. */
    public cleanupSessions(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, session] of this.sessions) {
            if (now - session.created > SESSION_TTL_MS) {
                this.sessions.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.adapter.log.debug(`Session cleanup: removed ${cleaned} expired sessions`);
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
                requires_api_password: true,
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
            this.sessions.set(flowId, { created: Date.now(), clientId: client.id });
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
                    const { username, password } = req.body ?? {};
                    if (username !== this.config.username || password !== this.config.password) {
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
                }

                this.sessions.delete(flowId);
                const code = crypto.randomUUID();
                this.sessions.set(code, { created: Date.now(), clientId: session.clientId });
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
                const { code, grant_type } = req.body ?? {};

                if (grant_type === 'authorization_code' && code && this.sessions.has(code)) {
                    const session = this.sessions.get(code)!;
                    this.sessions.delete(code);
                    const token = crypto.randomUUID();
                    if (session.clientId) {
                        await this.registry.setToken(session.clientId, token);
                        this.adapter.log.debug(`Display authenticated — client ${session.clientId}`);
                    }
                    return {
                        access_token: token,
                        token_type: 'Bearer',
                        refresh_token: crypto.randomUUID(),
                        expires_in: 1800,
                    };
                }

                if (grant_type === 'refresh_token') {
                    return {
                        access_token: crypto.randomUUID(),
                        token_type: 'Bearer',
                        expires_in: 1800,
                    };
                }

                this.adapter.log.warn(`Token exchange failed: grant_type=${String(grant_type)}`);
                reply.status(400);
                return { error: 'invalid_request', error_description: 'Invalid or expired code' };
            },
        );
    }

    private setupMiscRoutes(): void {
        this.app.get('/health', () => ({
            status: 'ok',
            adapter: 'hassemu',
            version: HA_VERSION,
            config: {
                mdns: this.config.mdnsEnabled,
                auth: this.config.authRequired,
                globalRedirect: this.globalConfig.isEnabled() ? this.globalConfig.getGlobalUrl() : null,
            },
        }));

        this.app.get('/manifest.json', () => ({
            name: this.serviceName,
            short_name: this.serviceName,
            start_url: '/',
            display: 'standalone',
            background_color: '#ffffff',
            theme_color: '#03a9f4',
        }));

        // Root — 302 redirect, or setup page when no URL is configured
        this.app.get('/', async (req, reply) => {
            const client = await this.identify(req, reply);
            const url = this.globalConfig.resolveUrlFor(client);
            if (!url) {
                this.adapter.log.debug(`No redirect URL for client ${client.id} — serving setup page`);
                return reply
                    .status(200)
                    .type('text/html; charset=utf-8')
                    .send(renderSetupPage(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
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
