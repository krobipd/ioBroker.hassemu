import crypto from 'node:crypto';
import type { Application, Request, Response, NextFunction } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import { HA_VERSION, SESSION_TTL_MS, CLEANUP_INTERVAL_MS, LOGIN_SCHEMA } from './constants';
import type { AdapterConfig, SessionData, AdapterInterface } from './types';

/** Express web server emulating Home Assistant API */
export class WebServer {
    private readonly adapter: AdapterInterface;
    private readonly config: AdapterConfig;
    private readonly app: Application;
    private server: Server | null = null;
    public readonly sessions: Map<string, SessionData> = new Map();
    private cleanupTimer: unknown = null;
    public readonly instanceUuid: string;

    /**
     * Creates a new WebServer instance
     *
     * @param adapter - Adapter interface for logging and state management
     * @param config - Adapter configuration
     * @param instanceUuid - Shared UUID for consistent identity across WebServer and mDNS
     */
    constructor(adapter: AdapterInterface, config: AdapterConfig, instanceUuid: string) {
        this.adapter = adapter;
        this.config = config;
        this.app = express();
        this.instanceUuid = instanceUuid;
    }

    /** Configured service name */
    get serviceName(): string {
        return this.config.serviceName || 'ioBroker';
    }

    /** Returns the actual address the server is bound to, or null if not running */
    get boundAddress(): { address: string; port: number } | null {
        if (!this.server) {
            return null;
        }
        const addr = this.server.address();
        if (typeof addr === 'string' || !addr) {
            return null;
        }
        return { address: addr.address, port: addr.port };
    }

    // --- Helpers ---

    private json(res: Response, data: unknown, status = 200): void {
        res.status(status).json(data);
    }

    /**
     * Create a session entry with automatic expiration
     *
     * @param key - Unique session identifier
     */
    createSession(key: string): void {
        this.sessions.set(key, { created: Date.now() });
    }

    /** Periodic cleanup of expired sessions */
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

    // --- Middleware ---

    private setupMiddleware(): void {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // Handle JSON parse errors — return 400 instead of generic 500
        this.app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
            if (err instanceof SyntaxError && 'body' in err) {
                this.adapter.log.debug(`Malformed JSON in request: ${err.message}`);
                res.status(400).json({ error: 'Invalid JSON in request body' });
                return;
            }
            next(err);
        });

        // Request logging — use debug level to keep production logs clean
        this.app.use((req: Request, _res: Response, next: NextFunction) => {
            this.adapter.log.debug(`${req.method} ${req.path}`);
            next();
        });
    }

    // --- Routes ---

    private setupRoutes(): void {
        this.setupApiRoutes();
        this.setupAuthRoutes();
        this.setupMiscRoutes();
        this.setupCatchAll();
    }

    private setupApiRoutes(): void {
        // CRITICAL: trailing slash — HA clients check this endpoint for discovery
        this.app.get('/api/', (_req: Request, res: Response) => {
            this.json(res, { message: 'API running.' });
        });

        this.app.get('/api/config', (_req: Request, res: Response) => {
            this.json(res, {
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
            });
        });

        this.app.get('/api/discovery_info', (req: Request, res: Response) => {
            const baseUrl = `http://${req.hostname}:${this.config.port}`;
            this.json(res, {
                base_url: baseUrl,
                external_url: null,
                internal_url: baseUrl,
                location_name: this.serviceName,
                requires_api_password: true,
                uuid: this.instanceUuid,
                version: HA_VERSION,
            });
        });

        // Stub-Endpoints for HA-API compatibility
        for (const path of ['/api/states', '/api/services', '/api/events']) {
            this.app.get(path, (_req: Request, res: Response) => this.json(res, []));
        }
        this.app.get('/api/error_log', (_req: Request, res: Response) => this.json(res, ''));
    }

    private setupAuthRoutes(): void {
        // Step 0: Auth providers
        this.app.get('/auth/providers', (_req: Request, res: Response) => {
            this.json(res, [
                {
                    name: 'Home Assistant Local',
                    type: 'homeassistant',
                    id: null,
                },
            ]);
        });

        // Step 1: Initiate login flow
        this.app.post('/auth/login_flow', (_req: Request, res: Response) => {
            const flowId = crypto.randomUUID();
            this.createSession(flowId);
            this.adapter.log.debug(`Auth flow created: ${flowId}`);

            this.json(res, {
                type: 'form',
                flow_id: flowId,
                handler: ['homeassistant', null],
                step_id: 'init',
                data_schema: LOGIN_SCHEMA,
                description_placeholders: null,
                errors: null,
            });
        });

        // Step 2: Submit credentials
        this.app.post('/auth/login_flow/:flowId', (req: Request, res: Response) => {
            const flowId = req.params.flowId as string;

            if (!this.sessions.has(flowId)) {
                this.adapter.log.warn(`Unknown flow_id: ${flowId}`);
                this.json(
                    res,
                    {
                        type: 'abort',
                        flow_id: flowId,
                        reason: 'unknown_flow',
                    },
                    400,
                );
                return;
            }

            // Validate credentials if auth is enabled
            if (this.config.authRequired) {
                const { username, password } = req.body as { username?: string; password?: string };
                if (username !== this.config.username || password !== this.config.password) {
                    this.adapter.log.warn('Invalid credentials');
                    this.json(
                        res,
                        {
                            type: 'form',
                            flow_id: flowId,
                            handler: ['homeassistant', null],
                            step_id: 'init',
                            data_schema: LOGIN_SCHEMA,
                            errors: { base: 'invalid_auth' },
                            description_placeholders: null,
                        },
                        400,
                    );
                    return;
                }
            }

            // Auth OK — generate code
            this.sessions.delete(flowId);
            const code = crypto.randomUUID();
            this.createSession(code);
            this.adapter.log.debug('Auth flow completed — code issued');

            this.json(res, {
                version: 1,
                type: 'create_entry',
                flow_id: flowId,
                handler: ['homeassistant', null],
                result: code,
                description: null,
                description_placeholders: null,
            });
        });

        // Step 3: Exchange code for token
        this.app.post('/auth/token', (req: Request, res: Response) => {
            const { code, grant_type } = req.body as { code?: string; grant_type?: string };

            if (grant_type === 'authorization_code' && code && this.sessions.has(code)) {
                this.sessions.delete(code);
                this.adapter.log.debug('Display authenticated successfully');

                this.json(res, {
                    access_token: crypto.randomUUID(),
                    token_type: 'Bearer',
                    refresh_token: crypto.randomUUID(),
                    expires_in: 1800,
                });
                return;
            }

            // Refresh token — issue new token
            if (grant_type === 'refresh_token') {
                this.json(res, {
                    access_token: crypto.randomUUID(),
                    token_type: 'Bearer',
                    expires_in: 1800,
                });
                return;
            }

            this.adapter.log.warn(`Token exchange failed: grant_type=${grant_type}`);
            this.json(
                res,
                {
                    error: 'invalid_request',
                    error_description: 'Invalid or expired code',
                },
                400,
            );
        });
    }

    private setupMiscRoutes(): void {
        this.app.get('/health', (_req: Request, res: Response) => {
            this.json(res, {
                status: 'ok',
                adapter: 'hassemu',
                version: HA_VERSION,
                config: {
                    mdns: this.config.mdnsEnabled,
                    auth: this.config.authRequired,
                    redirectTo: this.config.visUrl,
                },
            });
        });

        this.app.get('/manifest.json', (_req: Request, res: Response) => {
            this.json(res, {
                name: this.serviceName,
                short_name: this.serviceName,
                start_url: '/',
                display: 'standalone',
                background_color: '#ffffff',
                theme_color: '#03a9f4',
            });
        });

        // Redirect — Display WebView follows 302 natively
        this.app.get('/', (_req: Request, res: Response) => {
            if (!this.config.visUrl) {
                this.adapter.log.error('No redirect URL configured!');
                this.json(
                    res,
                    {
                        error: 'No redirect URL configured',
                        message: 'Please configure a redirect URL in the adapter settings.',
                    },
                    500,
                );
                return;
            }
            this.adapter.log.debug(`Redirecting to: ${this.config.visUrl}`);
            res.redirect(this.config.visUrl);
        });
    }

    private setupCatchAll(): void {
        this.app.use((req: Request, res: Response) => {
            this.adapter.log.debug(`404: ${req.method} ${req.path}`);
            this.json(res, { error: 'Not Found', path: req.path }, 404);
        });
    }

    // --- Lifecycle ---

    /** Start the web server and session cleanup timer */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.setupMiddleware();
            this.setupRoutes();

            const bindAddress = this.config.bindAddress || '0.0.0.0';
            this.server = this.app.listen(this.config.port, bindAddress, () => {
                this.adapter.log.debug(`Web server listening on ${bindAddress}:${this.config.port}`);
                resolve();
            });

            this.server.on('error', (error: NodeJS.ErrnoException) => {
                const msg =
                    error.code === 'EADDRINUSE'
                        ? `Port ${this.config.port} is already in use!`
                        : `Server error: ${error.message}`;
                this.adapter.log.error(msg);
                reject(error);
            });

            // Session cleanup timer (adapter-managed for automatic cleanup on unload)
            this.cleanupTimer = this.adapter.setInterval(() => this.cleanupSessions(), CLEANUP_INTERVAL_MS);
        });
    }

    /** Stop the web server and cleanup timer */
    async stop(): Promise<void> {
        if (this.cleanupTimer) {
            this.adapter.clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        return new Promise(resolve => {
            if (this.server) {
                this.server.close(() => {
                    this.adapter.log.info('Web server stopped');
                    this.server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}
