import { expect } from 'chai';
import crypto from 'node:crypto';
import { CLIENT_COOKIE, WebServer } from './webserver';
import { ClientRegistry } from './client-registry';
import { GlobalConfig, MODE_GLOBAL, MODE_MANUAL } from './global-config';
import { HA_VERSION } from './constants';
import type { AdapterConfig, ClientRecord } from './types';

interface ObjEntry {
    type: string;
    common?: Record<string, unknown>;
    native?: Record<string, unknown>;
}

interface MockStore {
    namespace: string;
    objects: Map<string, ObjEntry>;
    states: Map<string, { val: unknown; ack: boolean }>;
    logs: { level: string; msg: string }[];
}

function createMockAdapter(namespace = 'hassemu.0'): {
    store: MockStore;
    adapter: ReturnType<typeof build>;
} {
    const store: MockStore = {
        namespace,
        objects: new Map(),
        states: new Map(),
        logs: [],
    };

    function build() {
        return {
            namespace,
            log: {
                debug: (m: string) => store.logs.push({ level: 'debug', msg: m }),
                info: (m: string) => store.logs.push({ level: 'info', msg: m }),
                warn: (m: string) => store.logs.push({ level: 'warn', msg: m }),
                error: (m: string) => store.logs.push({ level: 'error', msg: m }),
            },
            setInterval: (_cb: () => void, _ms: number) => undefined,
            clearInterval: () => undefined,
            setTimeout: () => undefined,
            clearTimeout: () => undefined,
            getForeignObjectsAsync: async (pattern: string) => {
                const prefix = pattern.replace('*', '');
                const out: Record<string, ObjEntry> = {};
                for (const [id, obj] of store.objects) {
                    if (id.startsWith(prefix) && obj.type === 'channel') {
                        out[id] = obj;
                    }
                }
                return out;
            },
            getStateAsync: async (id: string) => store.states.get(`${namespace}.${id}`) ?? null,
            setObjectNotExistsAsync: async (id: string, obj: ObjEntry) => {
                const full = `${namespace}.${id}`;
                if (!store.objects.has(full)) {
                    store.objects.set(full, obj);
                }
            },
            extendObjectAsync: async (id: string, obj: Partial<ObjEntry>) => {
                const full = `${namespace}.${id}`;
                const ex = store.objects.get(full) ?? { type: 'state' };
                store.objects.set(full, {
                    ...ex,
                    ...obj,
                    common: { ...(ex.common ?? {}), ...(obj.common ?? {}) },
                    native: { ...(ex.native ?? {}), ...(obj.native ?? {}) },
                });
            },
            setStateAsync: async (id: string, val: { val: unknown; ack?: boolean }) => {
                store.states.set(`${namespace}.${id}`, { val: val.val, ack: val.ack ?? false });
            },
            delObjectAsync: async (id: string) => {
                const full = `${namespace}.${id}`;
                store.objects.delete(full);
                for (const k of [...store.objects.keys()]) {
                    if (k.startsWith(`${full}.`)) store.objects.delete(k);
                }
                for (const k of [...store.states.keys()]) {
                    if (k === full || k.startsWith(`${full}.`)) store.states.delete(k);
                }
            },
        };
    }

    return { store, adapter: build() };
}

const baseConfig: AdapterConfig = {
    port: 0,
    bindAddress: '127.0.0.1',
    authRequired: false,
    username: 'admin',
    password: 'secret',
    mdnsEnabled: false,
    serviceName: 'TestServer',
};

/**
 * Build a GlobalConfig with optional `global.mode` (sentinel or URL) and
 * `global.manualUrl` set up via the migration helper. `enabled` flag is
 * persisted but does NOT bulk-sync clients here — that lives in main.ts.
 */
async function buildGlobalConfig(
    adapter: ReturnType<typeof createMockAdapter>['adapter'],
    mode: string | null = null,
    manualUrl: string | null = null,
    enabled = false,
): Promise<GlobalConfig> {
    const g = new GlobalConfig(adapter as never);
    if (mode !== null) {
        await g.migrationSet(mode, manualUrl);
    }
    if (enabled) {
        await g.handleEnabledWrite(true);
    }
    return g;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
    if (!setCookieHeader) return null;
    const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    const match = header.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
    return match ? match[1] : null;
}

describe('WebServer', () => {
    let server: WebServer;
    let registry: ClientRegistry;
    let globalConfig: GlobalConfig;
    let store: MockStore;

    beforeEach(async () => {
        const built = createMockAdapter();
        store = built.store;
        registry = new ClientRegistry(built.adapter as never);
        // global.mode = direct URL; new client default mode='global' delegates here
        globalConfig = await buildGlobalConfig(built.adapter, 'http://example.com/vis', null, true);
        server = new WebServer(built.adapter as never, baseConfig, registry, globalConfig, crypto.randomUUID());
        await server['app'].register((await import('@fastify/cookie')).default);
        await server['app'].register((await import('@fastify/formbody')).default);
        server['setupErrorHandler']();
        server['setupRoutes']();
        await server['app'].ready();
    });

    afterEach(async () => {
        await server['app'].close();
    });

    describe('constructor', () => {
        it('generates a valid UUID', () => {
            expect(server.instanceUuid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        it('uses configured service name', () => {
            expect(server.serviceName).to.equal('TestServer');
        });

        it('falls back to ioBroker when service name is empty', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, serviceName: '' },
                reg,
                g,
                crypto.randomUUID(),
            );
            expect(s.serviceName).to.equal('ioBroker');
        });
    });

    describe('API endpoints', () => {
        it('GET /api/ returns API status', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/' });
            expect(res.statusCode).to.equal(200);
            expect(res.json()).to.deep.equal({ message: 'API running.' });
        });

        it('GET /api/config returns HA config with version + service name', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/config' });
            const body = res.json() as Record<string, unknown>;
            expect(body.version).to.equal(HA_VERSION);
            expect(body.location_name).to.equal('TestServer');
            expect(body.components).to.include('homeassistant');
        });

        it('GET /api/discovery_info returns discovery info with uuid', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/discovery_info' });
            const body = res.json() as Record<string, unknown>;
            expect(body.uuid).to.equal(server.instanceUuid);
            expect(body.location_name).to.equal('TestServer');
            expect(body.version).to.equal(HA_VERSION);
        });

        it('GET /api/states returns empty array', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/states' });
            expect(res.json()).to.deep.equal([]);
        });

        it('GET /api/services returns empty array', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/services' });
            expect(res.json()).to.deep.equal([]);
        });

        it('GET /api/events returns empty array', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/events' });
            expect(res.json()).to.deep.equal([]);
        });

        it('GET /api/error_log returns empty string', async () => {
            const res = await server.inject({ method: 'GET', url: '/api/error_log' });
            expect(res.body).to.equal('');
        });
    });

    describe('auth flow', () => {
        it('GET /auth/providers returns homeassistant provider', async () => {
            const res = await server.inject({ method: 'GET', url: '/auth/providers' });
            const body = res.json() as Array<Record<string, unknown>>;
            expect(body).to.have.lengthOf(1);
            expect(body[0].type).to.equal('homeassistant');
        });

        it('POST /auth/login_flow creates a flow and sets cookie on first visit', async () => {
            const res = await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const body = res.json() as Record<string, unknown>;
            expect(body.type).to.equal('form');
            expect(body.flow_id).to.match(/^[0-9a-f-]{36}$/);
            expect(extractCookie(res.headers['set-cookie'])).to.match(/^[0-9a-f-]{36}$/);
        });

        it('POST /auth/login_flow binds flow to the client cookie', async () => {
            const res1 = await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const cookie = extractCookie(res1.headers['set-cookie']);
            expect(cookie).to.not.be.null;
            const client = registry.getByCookie(cookie!);
            expect(client).to.not.be.null;
        });

        it('POST /auth/login_flow/:flowId with unknown flow returns 400', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/login_flow/00000000-0000-0000-0000-000000000000',
                payload: { username: 'admin', password: 'secret' },
            });
            expect(res.statusCode).to.equal(400);
            expect((res.json() as { reason: string }).reason).to.equal('unknown_flow');
        });

        it('completes full auth flow end-to-end and stores refresh token', async () => {
            const r1 = await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const flowId = (r1.json() as { flow_id: string }).flow_id;

            const r2 = await server.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                payload: { username: 'admin', password: 'secret' },
            });
            const code = (r2.json() as { result: string }).result;
            expect(code).to.match(/^[0-9a-f-]{36}$/);

            const r3 = await server.inject({
                method: 'POST',
                url: '/auth/token',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                payload: { grant_type: 'authorization_code', code },
            });
            const tokens = r3.json() as { access_token: string; refresh_token: string };
            expect(tokens.access_token).to.match(/^[0-9a-f-]{36}$/);
            expect(tokens.refresh_token).to.match(/^[0-9a-f-]{36}$/);

            const client = registry.getByCookie(cookie);
            expect(client?.token).to.equal(tokens.access_token);

            // Refresh token must be stored — security fix v1.2.0
            expect(server.refreshTokens.has(tokens.refresh_token)).to.be.true;
            expect(server.refreshTokens.get(tokens.refresh_token)).to.equal(client!.id);
        });

        it('POST /auth/token with VALID refresh_token issues a new access token', async () => {
            // First do a real login to get a valid refresh token
            const r1 = await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await server.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                payload: { username: 'admin', password: 'secret' },
            });
            const code = (r2.json() as { result: string }).result;
            const r3 = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'authorization_code', code },
            });
            const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;

            // Use the valid refresh token to mint a new access token
            const r4 = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'refresh_token', refresh_token: refreshToken },
            });
            expect(r4.statusCode).to.equal(200);
            expect((r4.json() as { access_token: string }).access_token).to.match(/^[0-9a-f-]{36}$/);
        });

        it('POST /auth/token with UNKNOWN refresh_token returns 400 (security fix v1.2.0)', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'refresh_token', refresh_token: crypto.randomUUID() },
            });
            expect(res.statusCode).to.equal(400);
            expect((res.json() as { error: string }).error).to.equal('invalid_grant');
        });

        it('POST /auth/token with missing refresh_token returns 400', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'refresh_token' },
            });
            expect(res.statusCode).to.equal(400);
        });

        it('POST /auth/token rejects unknown code', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'authorization_code', code: 'bogus' },
            });
            expect(res.statusCode).to.equal(400);
        });

        it('POST /auth/token accepts application/x-www-form-urlencoded body (OAuth2-Spec, v1.4.0)', async () => {
            // Real HA-Reference-Clients (Wall Display, frontend) senden urlencoded —
            // ohne @fastify/formbody würde Fastify mit 415 antworten und Auth wäre tot.
            // Tests via inject({payload:{}}) serialisieren zu JSON und maskieren das.
            const r1 = await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await server.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                payload: { username: 'admin', password: 'secret' },
            });
            const code = (r2.json() as { result: string }).result;

            const r3 = await server.inject({
                method: 'POST',
                url: '/auth/token',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                payload: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
            });
            expect(r3.statusCode).to.equal(200);
            const body = r3.json() as { access_token: string; refresh_token: string };
            expect(body.access_token).to.match(/^[0-9a-f-]{36}$/);
            expect(body.refresh_token).to.match(/^[0-9a-f-]{36}$/);
        });

        it('POST /auth/token with form-urlencoded refresh_token also works', async () => {
            const r1 = await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await server.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                payload: { username: 'admin', password: 'secret' },
            });
            const code = (r2.json() as { result: string }).result;
            const r3 = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'authorization_code', code },
            });
            const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;

            const r4 = await server.inject({
                method: 'POST',
                url: '/auth/token',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                payload: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
            });
            expect(r4.statusCode).to.equal(200);
        });

        it('rejects invalid credentials when authRequired is true', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter, 'http://example.com/vis', null, true);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, authRequired: true },
                reg,
                g,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            const r1 = await s.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await s.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                payload: { username: 'wrong', password: 'wrong' },
            });
            expect(r2.statusCode).to.equal(400);
            expect((r2.json() as { errors: { base: string } }).errors.base).to.equal('invalid_auth');

            await s['app'].close();
        });

        it('accepts correct credentials via timing-safe compare (security fix v1.2.0)', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter, 'http://example.com/vis', null, true);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, authRequired: true },
                reg,
                g,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            const r1 = await s.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await s.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                payload: { username: 'admin', password: 'secret' },
            });
            expect((r2.json() as { result?: string }).result).to.match(/^[0-9a-f-]{36}$/);
            await s['app'].close();
        });

        it('rejects username with mismatched length (timing-safe handles both branches)', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter, 'http://example.com/vis', null, true);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, authRequired: true },
                reg,
                g,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            const r1 = await s.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await s.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                payload: { username: 'short', password: 'doesnotmatter' },
            });
            expect((r2.json() as { errors: { base: string } }).errors.base).to.equal('invalid_auth');
            await s['app'].close();
        });
    });

    describe('misc endpoints', () => {
        it('GET /health returns liveness without any config leak (security fix v1.5.0)', async () => {
            const res = await server.inject({ method: 'GET', url: '/health' });
            const body = res.json() as Record<string, unknown>;
            expect(body.status).to.equal('ok');
            expect(body.version).to.equal(HA_VERSION);
            // v1.5.0: complete config-block removed (was previously exposing `mdns` + `auth` flags
            // unauthenticated — Reconnaissance vector for network attackers).
            expect(body).to.not.have.property('config');
        });

        it('GET /manifest.json returns PWA manifest with service name', async () => {
            const res = await server.inject({ method: 'GET', url: '/manifest.json' });
            const body = res.json() as { name: string };
            expect(body.name).to.equal('TestServer');
        });

        it("GET / serves wrapper HTML pointing at global URL when client default mode='global' (v1.7.0)", async () => {
            const res = await server.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).to.equal(200);
            expect(res.headers['content-type']).to.include('text/html');
            expect(res.body).to.include('<iframe src="http://example.com/vis"');
            expect(res.body).to.include('/api/redirect_check');
        });

        it('GET / sets cookie for new clients', async () => {
            const res = await server.inject({ method: 'GET', url: '/' });
            expect(extractCookie(res.headers['set-cookie'])).to.match(/^[0-9a-f-]{36}$/);
        });

        it('GET / reuses existing cookie for returning clients', async () => {
            const r1 = await server.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const r2 = await server.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(r2.headers['set-cookie']).to.be.undefined;
            expect(registry.getByCookie(cookie)).to.not.be.null;
        });

        it("GET / wrapper for client.mode='manual' uses manualUrl in iframe", async () => {
            const r1 = await server.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const client = registry.getByCookie(cookie)!;
            client.mode = MODE_MANUAL;
            client.manualUrl = 'http://override.local/ui';
            const r2 = await server.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(r2.statusCode).to.equal(200);
            expect(r2.body).to.include('<iframe src="http://override.local/ui"');
        });

        it('GET / wrapper uses direct-URL mode in iframe', async () => {
            const r1 = await server.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const client = registry.getByCookie(cookie)!;
            client.mode = 'http://direct.local/ui';
            const r2 = await server.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(r2.statusCode).to.equal(200);
            expect(r2.body).to.include('<iframe src="http://direct.local/ui"');
        });

        it('GET /api/redirect_check returns current target (v1.7.0)', async () => {
            const r1 = await server.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const r2 = await server.inject({
                method: 'GET',
                url: '/api/redirect_check',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(r2.statusCode).to.equal(200);
            expect(r2.json()).to.deep.equal({ target: 'http://example.com/vis' });
        });

        it('GET /api/redirect_check reflects mode-changes for the same client', async () => {
            const r1 = await server.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const client = registry.getByCookie(cookie)!;
            client.mode = MODE_MANUAL;
            client.manualUrl = 'http://newurl.local/dashboard';
            const r2 = await server.inject({
                method: 'GET',
                url: '/api/redirect_check',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(r2.json()).to.deep.equal({ target: 'http://newurl.local/dashboard' });
        });

        it('GET / serves the landing page when nothing is configured', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            // global empty + no client mode set after creation
            const g = await buildGlobalConfig(built.adapter);
            const s = new WebServer(built.adapter as never, baseConfig, reg, g, crypto.randomUUID());
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            // First clear the default 'global' mode so the resolver returns null
            const r0 = await s.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r0.headers['set-cookie'])!;
            const client = reg.getByCookie(cookie)!;
            client.mode = ''; // user has not picked anything
            const res = await s.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(res.statusCode).to.equal(200);
            expect(res.headers['content-type']).to.match(/^text\/html/);
            expect(res.body).to.include('Device ID');
            expect(res.body).to.include('clients.');
            expect(res.body).to.include('banner');
            expect(res.body).to.include('✓');
            await s['app'].close();
        });

        it('GET / landing page honours the ioBroker system language (de)', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter);
            const s = new WebServer(built.adapter as never, baseConfig, reg, g, crypto.randomUUID(), 'de');
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            // Force an empty-mode client so the landing page is served
            const r0 = await s.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r0.headers['set-cookie'])!;
            reg.getByCookie(cookie)!.mode = '';
            const res = await s.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(res.body).to.include('Display verbunden');
            expect(res.body).to.include('lang="de"');
            await s['app'].close();
        });

        it('GET / landing page falls back to English for unknown language', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter);
            const s = new WebServer(built.adapter as never, baseConfig, reg, g, crypto.randomUUID(), 'eo');
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            const r0 = await s.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r0.headers['set-cookie'])!;
            reg.getByCookie(cookie)!.mode = '';
            const res = await s.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(res.body).to.include('Display connected');
            await s['app'].close();
        });

        it('GET /unknown returns 404', async () => {
            const res = await server.inject({ method: 'GET', url: '/unknown' });
            expect(res.statusCode).to.equal(404);
            expect((res.json() as { error: string }).error).to.equal('Not Found');
        });
    });

    describe('multi-client', () => {
        it('creates separate records for distinct cookie-less visits', async () => {
            await server.inject({ method: 'GET', url: '/' });
            await server.inject({ method: 'GET', url: '/' });
            expect(registry.listAll().length).to.equal(2);
        });

        it('creates client state objects in ioBroker (mode + manualUrl)', async () => {
            await server.inject({ method: 'GET', url: '/' });
            const clientIds = registry.listAll().map(c => c.id);
            expect(clientIds.length).to.equal(1);
            expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.mode`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.manualUrl`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.visUrl`)).to.be.false;
        });

        it('unknown cookie from another adapter instance creates a new client', async () => {
            const stranger = crypto.randomUUID();
            const res = await server.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${stranger}` },
            });
            const cookie = extractCookie(res.headers['set-cookie']);
            expect(cookie).to.match(/^[0-9a-f-]{36}$/);
            expect(cookie).to.not.equal(stranger);
        });

        it('garbage cookie is replaced with a fresh UUID', async () => {
            const res = await server.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=not-a-uuid` },
            });
            expect(extractCookie(res.headers['set-cookie'])).to.match(/^[0-9a-f-]{36}$/);
        });
    });

    describe('validation / error handling', () => {
        it('returns 400 for malformed JSON', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/login_flow',
                headers: { 'content-type': 'application/json' },
                payload: '{not json',
            });
            expect(res.statusCode).to.equal(400);
        });
    });

    describe('session cleanup', () => {
        it('removes expired sessions', () => {
            server.sessions.set('old', {
                created: Date.now() - 1_000_000_000,
                clientId: null,
            });
            server.sessions.set('fresh', { created: Date.now(), clientId: null });
            server.cleanupSessions();
            expect(server.sessions.has('old')).to.be.false;
            expect(server.sessions.has('fresh')).to.be.true;
        });

        it('is a no-op when nothing has expired', () => {
            server.sessions.set('a', { created: Date.now(), clientId: null });
            server.cleanupSessions();
            expect(server.sessions.size).to.equal(1);
        });
    });

    describe('sessions cap (security fix v1.2.0)', () => {
        it('drops the oldest session when cap is exceeded', async () => {
            // Fire 105 login_flow calls — cap is 100
            for (let i = 0; i < 105; i++) {
                await server.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
            }
            expect(server.sessions.size).to.be.at.most(100);
        });
    });

    describe('brute-force lockout (security fix v1.3.0)', () => {
        async function buildAuthServer(): Promise<WebServer> {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter, 'http://example.com/vis', null, true);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, authRequired: true },
                reg,
                g,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupAuthGuard']();
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();
            return s;
        }

        async function loginWith(s: WebServer, password: string, remoteAddress = '10.0.0.5'): Promise<number> {
            const r1 = await s.inject({
                method: 'POST',
                url: '/auth/login_flow',
                payload: {},
                remoteAddress,
            });
            const flowId = (r1.json() as { flow_id: string }).flow_id;
            const r2 = await s.inject({
                method: 'POST',
                url: `/auth/login_flow/${flowId}`,
                payload: { username: 'admin', password },
                remoteAddress,
            });
            return r2.statusCode;
        }

        it('locks an IP after 5 failed attempts (returns 429)', async () => {
            const s = await buildAuthServer();
            try {
                for (let i = 0; i < 5; i++) {
                    expect(await loginWith(s, 'wrong')).to.equal(400);
                }
                // 6th attempt should be locked out
                expect(await loginWith(s, 'wrong')).to.equal(429);
                expect(await loginWith(s, 'secret')).to.equal(429); // even right password locked
            } finally {
                await s['app'].close();
            }
        });

        it('clears the failure counter on a successful login', async () => {
            const s = await buildAuthServer();
            try {
                for (let i = 0; i < 4; i++) {
                    expect(await loginWith(s, 'wrong')).to.equal(400);
                }
                // 5th attempt: correct password — should succeed AND reset counter
                expect(await loginWith(s, 'secret')).to.equal(200);
                // Now we can fail again without immediate lock
                expect(await loginWith(s, 'wrong')).to.equal(400);
                expect(s.loginAttempts.get('10.0.0.5')?.failedCount).to.equal(1);
            } finally {
                await s['app'].close();
            }
        });

        it('tracks lockouts per IP independently', async () => {
            const s = await buildAuthServer();
            try {
                for (let i = 0; i < 5; i++) {
                    await loginWith(s, 'wrong', '10.0.0.5');
                }
                expect(await loginWith(s, 'wrong', '10.0.0.5')).to.equal(429);
                // Different IP should still be allowed
                expect(await loginWith(s, 'wrong', '10.0.0.6')).to.equal(400);
            } finally {
                await s['app'].close();
            }
        });

        it('does not track failures when authRequired is disabled', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter, 'http://example.com/vis', null, true);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, authRequired: false },
                reg,
                g,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
            await s['app'].register((await import('@fastify/formbody')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();
            try {
                // Even with wrong password, no auth check happens at all → no failures recorded
                for (let i = 0; i < 10; i++) {
                    await loginWith(s, 'wrong');
                }
                expect(s.loginAttempts.size).to.equal(0);
            } finally {
                await s['app'].close();
            }
        });

        it('cleanupSessions() prunes expired lockouts', async () => {
            const s = await buildAuthServer();
            try {
                const now = Date.now();
                // Inject an expired lockout entry directly
                s.loginAttempts.set('10.0.0.99', { failedCount: 5, lockedUntil: now - 1000, lastSeen: now });
                s.loginAttempts.set('10.0.0.100', { failedCount: 2, lockedUntil: 0, lastSeen: now }); // recent failed
                expect(s.loginAttempts.size).to.equal(2);
                s.cleanupSessions();
                expect(s.loginAttempts.has('10.0.0.99')).to.be.false; // pruned (expired lockout)
                expect(s.loginAttempts.has('10.0.0.100')).to.be.true; // still within window
            } finally {
                await s['app'].close();
            }
        });

        it('POST /auth/token with refresh_token: 5 invalid attempts → 429 (C7 v1.11.0)', async () => {
            const s = await buildAuthServer();
            try {
                // 5x with bogus refresh_token — each triggers recordLoginFailure
                for (let i = 0; i < 5; i++) {
                    const res = await s.inject({
                        method: 'POST',
                        url: '/auth/token',
                        payload: { grant_type: 'refresh_token', refresh_token: crypto.randomUUID() },
                    });
                    // First 5 still return 400 invalid_grant (counter reaches threshold ON 5th)
                    expect(res.statusCode).to.equal(400);
                }
                expect(s.loginAttempts.size).to.equal(1);
                const entry = [...s.loginAttempts.values()][0];
                expect(entry.failedCount).to.be.at.least(5);
                expect(entry.lockedUntil).to.be.greaterThan(Date.now());
                // 6th attempt → 429 because IP is now locked
                const r6 = await s.inject({
                    method: 'POST',
                    url: '/auth/token',
                    payload: { grant_type: 'refresh_token', refresh_token: crypto.randomUUID() },
                });
                expect(r6.statusCode).to.equal(429);
                expect((r6.json() as { error: string }).error).to.equal('rate_limited');
            } finally {
                await s['app'].close();
            }
        });

        it('POST /auth/token with VALID refresh_token does NOT count as failure (C7 v1.11.0)', async () => {
            const s = await buildAuthServer();
            try {
                // Real login first to obtain a valid refresh_token
                const r1 = await s.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
                const cookie = extractCookie(r1.headers['set-cookie'])!;
                const flowId = (r1.json() as { flow_id: string }).flow_id;
                const r2 = await s.inject({
                    method: 'POST',
                    url: `/auth/login_flow/${flowId}`,
                    headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                    payload: { username: 'admin', password: 'secret' },
                });
                const code = (r2.json() as { result: string }).result;
                const r3 = await s.inject({
                    method: 'POST',
                    url: '/auth/token',
                    payload: { grant_type: 'authorization_code', code },
                });
                const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;
                // Use the valid token 10x — should never lockout
                for (let i = 0; i < 10; i++) {
                    const res = await s.inject({
                        method: 'POST',
                        url: '/auth/token',
                        payload: { grant_type: 'refresh_token', refresh_token: refreshToken },
                    });
                    expect(res.statusCode).to.equal(200);
                }
                expect(s.loginAttempts.size).to.equal(0);
            } finally {
                await s['app'].close();
            }
        });

        it('cleanupSessions() prunes stale failure-counts (v1.5.0)', async () => {
            const s = await buildAuthServer();
            try {
                const now = Date.now();
                // Stale: failedCount>0, no lockout, lastSeen older than the window
                s.loginAttempts.set('10.0.0.101', {
                    failedCount: 2,
                    lockedUntil: 0,
                    lastSeen: now - 16 * 60 * 1000, // > LOGIN_LOCKOUT_WINDOW_MS (15 min)
                });
                // Fresh failure within window — keep
                s.loginAttempts.set('10.0.0.102', { failedCount: 2, lockedUntil: 0, lastSeen: now });
                s.cleanupSessions();
                expect(s.loginAttempts.has('10.0.0.101')).to.be.false; // pruned (stale)
                expect(s.loginAttempts.has('10.0.0.102')).to.be.true; // fresh
            } finally {
                await s['app'].close();
            }
        });

        it('GET /health does not leak adapter config (v1.5.0)', async () => {
            const s = await buildAuthServer();
            try {
                const res = await s.inject({ method: 'GET', url: '/health' });
                expect(res.statusCode).to.equal(200);
                const body = res.json() as Record<string, unknown>;
                expect(body).to.have.keys(['status', 'adapter', 'version']);
                expect(body).to.not.have.property('config');
            } finally {
                await s['app'].close();
            }
        });

        it('GET /api/discovery_info reports requires_api_password from config (v1.5.0)', async () => {
            const s = await buildAuthServer();
            try {
                const res = await s.inject({ method: 'GET', url: '/api/discovery_info' });
                expect(res.statusCode).to.equal(200);
                const body = res.json() as { requires_api_password: boolean };
                // buildAuthServer sets authRequired=true, so discovery_info must mirror that
                expect(body.requires_api_password).to.equal(true);
            } finally {
                await s['app'].close();
            }
        });

        // --- C3: auth pre-handler-guard für /api/* (v1.6.0) ---

        it('GET /api/states without Bearer returns 401 when authRequired=true (v1.6.0)', async () => {
            const s = await buildAuthServer();
            try {
                const res = await s.inject({ method: 'GET', url: '/api/states' });
                expect(res.statusCode).to.equal(401);
                const body = res.json() as { error: string };
                expect(body.error).to.equal('unauthorized');
            } finally {
                await s['app'].close();
            }
        });

        it('GET /api/states with invalid Bearer returns 401 (v1.6.0)', async () => {
            const s = await buildAuthServer();
            try {
                const res = await s.inject({
                    method: 'GET',
                    url: '/api/states',
                    headers: { authorization: 'Bearer invalid-token-12345' },
                });
                expect(res.statusCode).to.equal(401);
                const body = res.json() as { error: string };
                expect(body.error).to.equal('invalid_token');
            } finally {
                await s['app'].close();
            }
        });

        it('GET /api/states with valid Bearer returns 200 (v1.6.0)', async () => {
            const s = await buildAuthServer();
            try {
                // Run a real login to get a valid access token
                const r1 = await s.inject({ method: 'POST', url: '/auth/login_flow', payload: {} });
                const cookie = extractCookie(r1.headers['set-cookie'])!;
                const flowId = (r1.json() as { flow_id: string }).flow_id;
                const r2 = await s.inject({
                    method: 'POST',
                    url: `/auth/login_flow/${flowId}`,
                    headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
                    payload: { username: 'admin', password: 'secret' },
                });
                const code = (r2.json() as { result: string }).result;
                const r3 = await s.inject({
                    method: 'POST',
                    url: '/auth/token',
                    payload: { grant_type: 'authorization_code', code },
                });
                const accessToken = (r3.json() as { access_token: string }).access_token;

                // Now access protected endpoint with the bearer
                const res = await s.inject({
                    method: 'GET',
                    url: '/api/states',
                    headers: { authorization: `Bearer ${accessToken}` },
                });
                expect(res.statusCode).to.equal(200);
                expect(res.json()).to.deep.equal([]);
            } finally {
                await s['app'].close();
            }
        });

        it('Whitelisted endpoints stay open without auth even when authRequired=true (v1.6.0)', async () => {
            const s = await buildAuthServer();
            try {
                // /api/ heartbeat
                const r1 = await s.inject({ method: 'GET', url: '/api/' });
                expect(r1.statusCode).to.equal(200);
                // /health
                const r2 = await s.inject({ method: 'GET', url: '/health' });
                expect(r2.statusCode).to.equal(200);
                // /manifest.json
                const r3 = await s.inject({ method: 'GET', url: '/manifest.json' });
                expect(r3.statusCode).to.equal(200);
                // /api/discovery_info — pre-auth probe used by HA-Clients
                const r4 = await s.inject({ method: 'GET', url: '/api/discovery_info' });
                expect(r4.statusCode).to.equal(200);
            } finally {
                await s['app'].close();
            }
        });

        it('Auth guard is no-op when authRequired=false (v1.6.0)', async () => {
            // server (top-level beforeEach) uses authRequired=false
            const res = await server.inject({ method: 'GET', url: '/api/states' });
            // No 401 — open access since auth is disabled
            expect(res.statusCode).to.equal(200);
        });
    });
});

describe('WebServer bindAddress / start-stop', () => {
    it('defaults to 0.0.0.0 when bindAddress is falsy', async () => {
        const built = createMockAdapter();
        const reg = new ClientRegistry(built.adapter as never);
        const g = await buildGlobalConfig(built.adapter, 'http://x/');
        const s = new WebServer(
            built.adapter as never,
            { ...baseConfig, port: 0, bindAddress: '' },
            reg,
            g,
            crypto.randomUUID(),
        );
        await s.start();
        const addr = s.boundAddress;
        expect(addr).to.not.be.null;
        expect(['0.0.0.0', '::', '::ffff:0.0.0.0']).to.include(addr!.address);
        await s.stop();
    });

    it('binds to 127.0.0.1 when configured', async () => {
        const built = createMockAdapter();
        const reg = new ClientRegistry(built.adapter as never);
        const g = await buildGlobalConfig(built.adapter, 'http://x/');
        const s = new WebServer(
            built.adapter as never,
            { ...baseConfig, port: 0, bindAddress: '127.0.0.1' },
            reg,
            g,
            crypto.randomUUID(),
        );
        await s.start();
        expect(s.boundAddress?.address).to.equal('127.0.0.1');
        await s.stop();
    });

    it('returns null for boundAddress when server not running', async () => {
        const built = createMockAdapter();
        const reg = new ClientRegistry(built.adapter as never);
        const g = await buildGlobalConfig(built.adapter, 'http://x/');
        const s = new WebServer(built.adapter as never, baseConfig, reg, g, crypto.randomUUID());
        expect(s.boundAddress).to.be.null;
    });

    // --- D6: Request-error log cooldown (v1.9.x) ---

    describe('shouldEmitRequestErrorWarn — 5xx log dedup (D6 v1.9.x)', () => {
        const buildServer = async (): Promise<WebServer> => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            const g = await buildGlobalConfig(built.adapter, 'http://x/');
            return new WebServer(built.adapter as never, baseConfig, reg, g, crypto.randomUUID());
        };

        it('returns true on first occurrence of a message', async () => {
            const s = await buildServer();
            expect(s.shouldEmitRequestErrorWarn('boom', 1000)).to.be.true;
        });

        it('returns false within cooldown window for same message', async () => {
            const s = await buildServer();
            s.shouldEmitRequestErrorWarn('boom', 1000);
            // 59s later — still in cooldown (< REQUEST_ERROR_COOLDOWN_MS=60000)
            expect(s.shouldEmitRequestErrorWarn('boom', 60_000)).to.be.false;
        });

        it('returns true after cooldown elapsed for same message', async () => {
            const s = await buildServer();
            s.shouldEmitRequestErrorWarn('boom', 1000);
            // 61s later — outside cooldown window
            expect(s.shouldEmitRequestErrorWarn('boom', 62_000)).to.be.true;
        });

        it('different messages have independent cooldowns', async () => {
            const s = await buildServer();
            expect(s.shouldEmitRequestErrorWarn('a', 1000)).to.be.true;
            expect(s.shouldEmitRequestErrorWarn('b', 1001)).to.be.true; // 1ms later, but different key
            expect(s.shouldEmitRequestErrorWarn('a', 1002)).to.be.false; // a is in cooldown
        });

        it('FIFO-caps the cooldown map (E9 + D6 consistency)', async () => {
            const s = await buildServer();
            for (let i = 0; i < 250; i++) {
                s.shouldEmitRequestErrorWarn(`err-${i}`, 1000 + i);
            }
            const cooldown = (s as unknown as { errorLogCooldown: Map<string, number> }).errorLogCooldown;
            expect(cooldown.size).to.equal(200); // REQUEST_ERROR_COOLDOWN_CAP
            // oldest 50 (err-0..err-49) should be evicted, newest 200 (err-50..err-249) survive
            expect(cooldown.has('err-0')).to.be.false;
            expect(cooldown.has('err-49')).to.be.false;
            expect(cooldown.has('err-50')).to.be.true;
            expect(cooldown.has('err-249')).to.be.true;
        });
    });
});
