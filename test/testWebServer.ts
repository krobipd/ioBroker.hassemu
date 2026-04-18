import { expect } from 'chai';
import crypto from 'node:crypto';
import { CLIENT_COOKIE, WebServer } from '../src/lib/webserver';
import { ClientRegistry } from '../src/lib/client-registry';
import { HA_VERSION } from '../src/lib/constants';
import type { AdapterConfig } from '../src/lib/types';

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
    defaultVisUrl: 'http://example.com/vis',
    authRequired: false,
    username: 'admin',
    password: 'secret',
    mdnsEnabled: false,
    serviceName: 'TestServer',
};

function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
    if (!setCookieHeader) return null;
    const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    const match = header.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
    return match ? match[1] : null;
}

describe('WebServer', () => {
    let server: WebServer;
    let registry: ClientRegistry;
    let store: MockStore;

    beforeEach(async () => {
        const built = createMockAdapter();
        store = built.store;
        registry = new ClientRegistry(built.adapter as never, baseConfig.defaultVisUrl);
        server = new WebServer(built.adapter as never, baseConfig, registry, crypto.randomUUID());
        // ready() instead of listen() — we use inject(), not a real socket
        await server['app'].register((await import('@fastify/cookie')).default);
        server['setupErrorHandler']();
        server['setupRoutes']();
        await server['app'].ready();
    });

    afterEach(async () => {
        await server['app'].close();
    });

    describe('constructor', () => {
        it('generates a valid UUID', () => {
            expect(server.instanceUuid).to.match(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            );
        });

        it('uses configured service name', () => {
            expect(server.serviceName).to.equal('TestServer');
        });

        it('falls back to ioBroker when service name is empty', () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never, '');
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, serviceName: '' },
                reg,
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
            const res1 = await server.inject({
                method: 'POST',
                url: '/auth/login_flow',
                payload: {},
            });
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

        it('completes full auth flow end-to-end', async () => {
            const r1 = await server.inject({
                method: 'POST',
                url: '/auth/login_flow',
                payload: {},
            });
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

            const client = registry.getByCookie(cookie);
            expect(client?.token).to.equal(tokens.access_token);
        });

        it('POST /auth/token with refresh_token returns new token', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'refresh_token', refresh_token: 'any' },
            });
            expect(res.statusCode).to.equal(200);
            expect((res.json() as { access_token: string }).access_token).to.match(/^[0-9a-f-]{36}$/);
        });

        it('POST /auth/token rejects unknown code', async () => {
            const res = await server.inject({
                method: 'POST',
                url: '/auth/token',
                payload: { grant_type: 'authorization_code', code: 'bogus' },
            });
            expect(res.statusCode).to.equal(400);
        });

        it('rejects invalid credentials when authRequired is true', async () => {
            // rebuild with authRequired = true
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never, baseConfig.defaultVisUrl);
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, authRequired: true },
                reg,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
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
            const body = r2.json() as { errors: { base: string } };
            expect(body.errors.base).to.equal('invalid_auth');

            await s['app'].close();
        });
    });

    describe('misc endpoints', () => {
        it('GET /health returns health status', async () => {
            const res = await server.inject({ method: 'GET', url: '/health' });
            const body = res.json() as { status: string; version: string };
            expect(body.status).to.equal('ok');
            expect(body.version).to.equal(HA_VERSION);
        });

        it('GET /manifest.json returns PWA manifest with service name', async () => {
            const res = await server.inject({ method: 'GET', url: '/manifest.json' });
            const body = res.json() as { name: string };
            expect(body.name).to.equal('TestServer');
        });

        it('GET / redirects to defaultVisUrl for new clients', async () => {
            const res = await server.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).to.equal(302);
            expect(res.headers.location).to.equal('http://example.com/vis');
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
            // No new cookie set when the sent one is valid
            expect(r2.headers['set-cookie']).to.be.undefined;
            expect(registry.getByCookie(cookie)).to.not.be.null;
        });

        it('GET / uses per-client visUrl override if set', async () => {
            const r1 = await server.inject({ method: 'GET', url: '/' });
            const cookie = extractCookie(r1.headers['set-cookie'])!;
            const client = registry.getByCookie(cookie)!;
            client.visUrl = 'http://override.local/ui';
            const r2 = await server.inject({
                method: 'GET',
                url: '/',
                headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
            });
            expect(r2.headers.location).to.equal('http://override.local/ui');
        });

        it('GET / returns 500 when neither per-client nor defaultVisUrl is set', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never, '');
            const s = new WebServer(
                built.adapter as never,
                { ...baseConfig, defaultVisUrl: '' },
                reg,
                crypto.randomUUID(),
            );
            await s['app'].register((await import('@fastify/cookie')).default);
            s['setupErrorHandler']();
            s['setupRoutes']();
            await s['app'].ready();

            const res = await s.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).to.equal(500);
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

        it('creates client state objects in ioBroker', async () => {
            await server.inject({ method: 'GET', url: '/' });
            const clientIds = registry.listAll().map(c => c.id);
            expect(clientIds.length).to.equal(1);
            expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.visUrl`)).to.be.true;
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
});

describe('WebServer bindAddress / start-stop', () => {
    it('defaults to 0.0.0.0 when bindAddress is falsy', async () => {
        const built = createMockAdapter();
        const reg = new ClientRegistry(built.adapter as never, 'http://x/');
        const s = new WebServer(
            built.adapter as never,
            { ...baseConfig, port: 0, bindAddress: '' },
            reg,
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
        const reg = new ClientRegistry(built.adapter as never, 'http://x/');
        const s = new WebServer(
            built.adapter as never,
            { ...baseConfig, port: 0, bindAddress: '127.0.0.1' },
            reg,
            crypto.randomUUID(),
        );
        await s.start();
        expect(s.boundAddress?.address).to.equal('127.0.0.1');
        await s.stop();
    });

    it('returns null for boundAddress when server not running', () => {
        const built = createMockAdapter();
        const reg = new ClientRegistry(built.adapter as never, 'http://x/');
        const s = new WebServer(built.adapter as never, baseConfig, reg, crypto.randomUUID());
        expect(s.boundAddress).to.be.null;
    });
});
