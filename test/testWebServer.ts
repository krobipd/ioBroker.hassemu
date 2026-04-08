import { expect } from 'chai';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebServer } from '../src/lib/webserver';
import { HA_VERSION } from '../src/lib/constants';
import type { AdapterConfig } from '../src/lib/types';

interface MockAdapter {
    log: {
        debug: () => void;
        info: () => void;
        warn: () => void;
        error: () => void;
    };
    setInterval: (callback: () => void, ms: number) => unknown;
    clearInterval: (id: unknown) => void;
}

// Mock adapter for testing
function createMockAdapter(): MockAdapter {
    return {
        log: {
            debug: (): void => {},
            info: (): void => {},
            warn: (): void => {},
            error: (): void => {},
        },
        setInterval: (cb: () => void, ms: number): unknown => setInterval(cb, ms),
        clearInterval: (id: unknown): void => clearInterval(id as ReturnType<typeof setInterval>),
    };
}

interface HttpResponse {
    statusCode: number | undefined;
    headers: http.IncomingHttpHeaders;
    body: unknown;
    rawBody: string;
}

// Helper to make HTTP requests
function httpRequest(options: http.RequestOptions, body: unknown = null): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk.toString()));
            res.on('end', () => {
                try {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: data ? JSON.parse(data) : null,
                        rawBody: data,
                    });
                } catch {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: null,
                        rawBody: data,
                    });
                }
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

describe('WebServer', () => {
    let server: WebServer;
    let adapter: MockAdapter;
    const TEST_PORT = 18123; // Use non-standard port for tests
    const config: AdapterConfig = {
        port: TEST_PORT,
        bindAddress: '0.0.0.0',
        visUrl: 'http://example.com/vis',
        authRequired: false,
        username: 'admin',
        password: 'secret',
        mdnsEnabled: false,
        serviceName: 'TestServer',
    };

    before(async () => {
        adapter = createMockAdapter();
        server = new WebServer(adapter as never, config, crypto.randomUUID());
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    describe('constructor', () => {
        it('should generate a valid UUID', () => {
            expect(server.instanceUuid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        it('should return configured service name', () => {
            expect(server.serviceName).to.equal('TestServer');
        });
    });

    describe('API endpoints', () => {
        it('GET /api/ should return API status', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal({ message: 'API running.' });
        });

        it('GET /api/config should return HA config', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/config',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            const body = res.body as { version: string; location_name: string; unit_system: { temperature: string } };
            expect(body.version).to.equal(HA_VERSION);
            expect(body.location_name).to.equal('TestServer');
            expect(body.unit_system.temperature).to.equal('°C');
        });

        it('GET /api/discovery_info should return discovery info', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/discovery_info',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            const body = res.body as { version: string; requires_api_password: boolean; uuid: string };
            expect(body.version).to.equal(HA_VERSION);
            expect(body.requires_api_password).to.be.true;
            expect(body.uuid).to.equal(server.instanceUuid);
        });

        it('GET /api/states should return empty array', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/states',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal([]);
        });

        it('GET /api/services should return empty array', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/services',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal([]);
        });

        it('GET /api/events should return empty array', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/events',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal([]);
        });

        it('GET /api/error_log should return empty string', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/api/error_log',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            expect(res.body).to.equal('');
        });
    });

    describe('Auth endpoints', () => {
        it('GET /auth/providers should return homeassistant provider', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/auth/providers',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            const body = res.body as { type: string }[];
            expect(body).to.be.an('array').with.lengthOf(1);
            expect(body[0].type).to.equal('homeassistant');
        });

        it('POST /auth/login_flow should create a flow', async () => {
            const res = await httpRequest(
                {
                    hostname: 'localhost',
                    port: TEST_PORT,
                    path: '/auth/login_flow',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
                {},
            );

            expect(res.statusCode).to.equal(200);
            const body = res.body as { type: string; flow_id: string; step_id: string };
            expect(body.type).to.equal('form');
            expect(body.flow_id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            expect(body.step_id).to.equal('init');
        });

        it('POST /auth/login_flow/:flowId with unknown flow should return error', async () => {
            const res = await httpRequest(
                {
                    hostname: 'localhost',
                    port: TEST_PORT,
                    path: '/auth/login_flow/unknown-flow-id',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
                { username: 'admin', password: 'secret' },
            );

            expect(res.statusCode).to.equal(400);
            const body = res.body as { type: string; reason: string };
            expect(body.type).to.equal('abort');
            expect(body.reason).to.equal('unknown_flow');
        });

        it('should complete full auth flow', async () => {
            // Step 1: Create flow
            const flowRes = await httpRequest(
                {
                    hostname: 'localhost',
                    port: TEST_PORT,
                    path: '/auth/login_flow',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
                {},
            );
            expect(flowRes.statusCode).to.equal(200);
            const flowBody = flowRes.body as { flow_id: string };
            const flowId = flowBody.flow_id;

            // Step 2: Submit credentials
            const credRes = await httpRequest(
                {
                    hostname: 'localhost',
                    port: TEST_PORT,
                    path: `/auth/login_flow/${flowId}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
                { username: 'admin', password: 'secret' },
            );
            expect(credRes.statusCode).to.equal(200);
            const credBody = credRes.body as { type: string; result: string };
            expect(credBody.type).to.equal('create_entry');
            const code = credBody.result;

            // Step 3: Exchange code for token
            const tokenRes = await httpRequest(
                {
                    hostname: 'localhost',
                    port: TEST_PORT,
                    path: '/auth/token',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                },
                `grant_type=authorization_code&code=${code}`,
            );
            expect(tokenRes.statusCode).to.equal(200);
            const tokenBody = tokenRes.body as { access_token: string; token_type: string; refresh_token: string };
            expect(tokenBody.access_token).to.exist;
            expect(tokenBody.token_type).to.equal('Bearer');
            expect(tokenBody.refresh_token).to.exist;
        });

        it('POST /auth/token with refresh_token should return new token', async () => {
            const res = await httpRequest(
                {
                    hostname: 'localhost',
                    port: TEST_PORT,
                    path: '/auth/token',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                },
                'grant_type=refresh_token&refresh_token=some-token',
            );

            expect(res.statusCode).to.equal(200);
            const body = res.body as { access_token: string; token_type: string };
            expect(body.access_token).to.exist;
            expect(body.token_type).to.equal('Bearer');
        });
    });

    describe('Misc endpoints', () => {
        it('GET /health should return health status', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/health',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            const body = res.body as { status: string; adapter: string; version: string; config: object };
            expect(body.status).to.equal('ok');
            expect(body.adapter).to.equal('hassemu');
            expect(body.version).to.equal(HA_VERSION);
            expect(body.config).to.be.an('object');
        });

        it('GET /manifest.json should return PWA manifest', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/manifest.json',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(200);
            const body = res.body as { name: string; display: string };
            expect(body.name).to.equal('TestServer');
            expect(body.display).to.equal('standalone');
        });

        it('GET / should redirect to visUrl', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(302);
            expect(res.headers.location).to.equal('http://example.com/vis');
        });

        it('GET /unknown should return 404', async () => {
            const res = await httpRequest({
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/unknown/path',
                method: 'GET',
            });

            expect(res.statusCode).to.equal(404);
            const body = res.body as { error: string };
            expect(body.error).to.equal('Not Found');
        });
    });

    describe('Session management', () => {
        it('should cleanup expired sessions', () => {
            // Clear any existing sessions from previous tests
            server.sessions.clear();

            // Create a session manually with old timestamp
            server.sessions.set('old-session', { created: Date.now() - 20 * 60 * 1000 });
            server.sessions.set('new-session', { created: Date.now() });

            expect(server.sessions.size).to.equal(2);

            server.cleanupSessions();

            expect(server.sessions.size).to.equal(1);
            expect(server.sessions.has('new-session')).to.be.true;
            expect(server.sessions.has('old-session')).to.be.false;
        });
    });
});

describe('WebServer without visUrl', () => {
    let server: WebServer;
    let adapter: MockAdapter;
    const TEST_PORT = 18124;

    before(async () => {
        adapter = createMockAdapter();
        const noVisConfig: AdapterConfig = {
            port: TEST_PORT,
            bindAddress: '0.0.0.0',
            visUrl: '', // No redirect URL configured
            authRequired: false,
            username: '',
            password: '',
            mdnsEnabled: false,
            serviceName: 'TestServer',
        };
        server = new WebServer(adapter as never, noVisConfig, crypto.randomUUID());
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    it('GET / should return error when visUrl not configured', async () => {
        const res = await httpRequest({
            hostname: 'localhost',
            port: TEST_PORT,
            path: '/',
            method: 'GET',
        });

        expect(res.statusCode).to.equal(500);
        const body = res.body as { error: string };
        expect(body.error).to.equal('No redirect URL configured');
    });
});

describe('WebServer with auth required', () => {
    let server: WebServer;
    let adapter: MockAdapter;
    const TEST_PORT = 18125;

    before(async () => {
        adapter = createMockAdapter();
        const authConfig: AdapterConfig = {
            port: TEST_PORT,
            bindAddress: '0.0.0.0',
            visUrl: 'http://example.com',
            authRequired: true,
            username: 'testuser',
            password: 'testpass',
            mdnsEnabled: false,
            serviceName: 'AuthServer',
        };
        server = new WebServer(adapter as never, authConfig, crypto.randomUUID());
        await server.start();
    });

    after(async () => {
        await server.stop();
    });

    it('should reject invalid credentials', async () => {
        // Create flow
        const flowRes = await httpRequest(
            {
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/auth/login_flow',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
            {},
        );
        const flowBody = flowRes.body as { flow_id: string };
        const flowId = flowBody.flow_id;

        // Submit wrong credentials
        const res = await httpRequest(
            {
                hostname: 'localhost',
                port: TEST_PORT,
                path: `/auth/login_flow/${flowId}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
            { username: 'wrong', password: 'wrong' },
        );

        expect(res.statusCode).to.equal(400);
        const body = res.body as { errors: { base: string } };
        expect(body.errors.base).to.equal('invalid_auth');
    });

    it('should accept valid credentials', async () => {
        // Create flow
        const flowRes = await httpRequest(
            {
                hostname: 'localhost',
                port: TEST_PORT,
                path: '/auth/login_flow',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
            {},
        );
        const flowBody = flowRes.body as { flow_id: string };
        const flowId = flowBody.flow_id;

        // Submit correct credentials
        const res = await httpRequest(
            {
                hostname: 'localhost',
                port: TEST_PORT,
                path: `/auth/login_flow/${flowId}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            },
            { username: 'testuser', password: 'testpass' },
        );

        expect(res.statusCode).to.equal(200);
        const body = res.body as { type: string };
        expect(body.type).to.equal('create_entry');
    });
});

describe('WebServer bindAddress', () => {
    it('should bind to 0.0.0.0 by default', async () => {
        const adapter = createMockAdapter();
        const config: AdapterConfig = {
            port: 18126,
            bindAddress: '0.0.0.0',
            visUrl: 'http://example.com',
            authRequired: false,
            username: '',
            password: '',
            mdnsEnabled: false,
            serviceName: 'Test',
        };
        const server = new WebServer(adapter as never, config, crypto.randomUUID());
        await server.start();

        const bound = server.boundAddress;
        expect(bound).to.not.be.null;
        expect(bound!.address).to.equal('0.0.0.0');
        expect(bound!.port).to.equal(18126);

        await server.stop();
    });

    it('should bind to 127.0.0.1 when configured', async () => {
        const adapter = createMockAdapter();
        const config: AdapterConfig = {
            port: 18127,
            bindAddress: '127.0.0.1',
            visUrl: 'http://example.com',
            authRequired: false,
            username: '',
            password: '',
            mdnsEnabled: false,
            serviceName: 'Test',
        };
        const server = new WebServer(adapter as never, config, crypto.randomUUID());
        await server.start();

        const bound = server.boundAddress;
        expect(bound).to.not.be.null;
        expect(bound!.address).to.equal('127.0.0.1');
        expect(bound!.port).to.equal(18127);

        await server.stop();
    });

    it('should fallback to 0.0.0.0 when bindAddress is empty', async () => {
        const adapter = createMockAdapter();
        const config: AdapterConfig = {
            port: 18128,
            bindAddress: '',
            visUrl: 'http://example.com',
            authRequired: false,
            username: '',
            password: '',
            mdnsEnabled: false,
            serviceName: 'Test',
        };
        const server = new WebServer(adapter as never, config, crypto.randomUUID());
        await server.start();

        const bound = server.boundAddress;
        expect(bound).to.not.be.null;
        expect(bound!.address).to.equal('0.0.0.0');

        await server.stop();
    });

    it('should return null for boundAddress when server not running', () => {
        const adapter = createMockAdapter();
        const config: AdapterConfig = {
            port: 18129,
            bindAddress: '127.0.0.1',
            visUrl: 'http://example.com',
            authRequired: false,
            username: '',
            password: '',
            mdnsEnabled: false,
            serviceName: 'Test',
        };
        const server = new WebServer(adapter as never, config, crypto.randomUUID());

        // Server not started yet
        expect(server.boundAddress).to.be.null;
    });
});
