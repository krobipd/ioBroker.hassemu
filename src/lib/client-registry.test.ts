import { expect } from 'chai';
import crypto from 'node:crypto';
import { ClientRegistry, parseClientStateId } from './client-registry';
import type { ClientRecord } from './types';

interface ObjEntry {
    type: string;
    common?: Record<string, unknown>;
    native?: Record<string, unknown>;
}

interface LogEntry {
    level: string;
    msg: string;
}

interface MockStore {
    namespace: string;
    objects: Map<string, ObjEntry>;
    states: Map<string, { val: unknown; ack: boolean }>;
    logs: LogEntry[];
}

function createMockAdapter(namespace = 'hassemu.0'): {
    store: MockStore;
    adapter: ReturnType<typeof buildAdapter>;
} {
    const store: MockStore = {
        namespace,
        objects: new Map(),
        states: new Map(),
        logs: [],
    };

    function buildAdapter(): {
        namespace: string;
        log: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
        setInterval: () => undefined;
        clearInterval: () => undefined;
        setTimeout: () => undefined;
        clearTimeout: () => undefined;
        getForeignObjectsAsync: (pattern: string, type: 'channel') => Promise<Record<string, ObjEntry>>;
        getStateAsync: (id: string) => Promise<{ val: unknown; ack: boolean } | null>;
        setObjectNotExistsAsync: (id: string, obj: ObjEntry) => Promise<void>;
        extendObjectAsync: (id: string, obj: Partial<ObjEntry>) => Promise<void>;
        setStateAsync: (id: string, value: { val: unknown; ack?: boolean }, _ack?: boolean) => Promise<void>;
        delObjectAsync: (id: string, options?: { recursive?: boolean }) => Promise<void>;
    } {
        return {
            namespace,
            log: {
                debug: (m: string) => void store.logs.push({ level: 'debug', msg: m }),
                info: (m: string) => void store.logs.push({ level: 'info', msg: m }),
                warn: (m: string) => void store.logs.push({ level: 'warn', msg: m }),
                error: (m: string) => void store.logs.push({ level: 'error', msg: m }),
            },
            setInterval: () => undefined,
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
                const fullId = `${namespace}.${id}`;
                if (!store.objects.has(fullId)) {
                    store.objects.set(fullId, obj);
                }
            },
            extendObjectAsync: async (id: string, obj: Partial<ObjEntry>) => {
                const fullId = `${namespace}.${id}`;
                const existing = store.objects.get(fullId) ?? { type: 'state' };
                store.objects.set(fullId, {
                    ...existing,
                    ...obj,
                    common: { ...(existing.common ?? {}), ...(obj.common ?? {}) },
                    native: { ...(existing.native ?? {}), ...(obj.native ?? {}) },
                });
            },
            setStateAsync: async (id: string, value: { val: unknown; ack?: boolean }) => {
                store.states.set(`${namespace}.${id}`, { val: value.val, ack: value.ack ?? false });
            },
            delObjectAsync: async (id: string) => {
                const fullId = `${namespace}.${id}`;
                store.objects.delete(fullId);
                for (const k of [...store.states.keys()]) {
                    if (k === fullId || k.startsWith(`${fullId}.`)) {
                        store.states.delete(k);
                    }
                }
                for (const k of [...store.objects.keys()]) {
                    if (k.startsWith(`${fullId}.`)) {
                        store.objects.delete(k);
                    }
                }
            },
        };
    }

    return { store, adapter: buildAdapter() };
}

describe('ClientRegistry', () => {
    let store: MockStore;
    let adapter: ReturnType<typeof createMockAdapter>['adapter'];
    let registry: ClientRegistry;

    beforeEach(() => {
        const built = createMockAdapter();
        store = built.store;
        adapter = built.adapter;
        registry = new ClientRegistry(adapter as never);
    });

    describe('identifyOrCreate', () => {
        it('creates a new client when cookie is missing', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', 'tablet.local');
            expect(rec.id).to.match(/^[a-z0-9]{6}$/);
            expect(rec.cookie).to.match(/^[0-9a-f-]{36}$/);
            expect(rec.ip).to.equal('192.168.1.5');
            expect(rec.hostname).to.equal('tablet.local');
        });

        it('creates ioBroker channel + states on new client', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', null);
            expect(store.objects.has(`hassemu.0.clients.${rec.id}`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.ip`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.remove`)).to.be.true;
        });

        it('does not create a legacy hostname state', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', 'tablet.local');
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.hostname`)).to.be.false;
        });

        it('sets common.name to ip when hostname is unknown', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', null);
            const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(ch?.common?.name).to.equal('192.168.1.5');
        });

        it('sets common.name to hostname when known at creation', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', 'tablet.local');
            const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(ch?.common?.name).to.equal('tablet.local');
        });

        it('updates common.name when hostname resolves after creation', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', null);
            await registry.identifyOrCreate(rec.cookie, '192.168.1.5', 'tablet.local');
            const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(ch?.common?.name).to.equal('tablet.local');
        });

        it('keeps common.name in sync with ip while hostname unknown', async () => {
            const rec = await registry.identifyOrCreate(null, '1.1.1.1', null);
            await registry.identifyOrCreate(rec.cookie, '2.2.2.2', null);
            const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(ch?.common?.name).to.equal('2.2.2.2');
        });

        it('keeps common.name fixed to hostname when only ip changes', async () => {
            const rec = await registry.identifyOrCreate(null, '1.1.1.1', 'tablet.local');
            await registry.identifyOrCreate(rec.cookie, '2.2.2.2', null);
            const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(ch?.common?.name).to.equal('tablet.local');
        });

        it('persists cookie in channel.native', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(channel?.native?.cookie).to.equal(rec.cookie);
        });

        it('persists IP to state', async () => {
            const rec = await registry.identifyOrCreate(null, '10.0.0.1', null);
            expect(store.states.get(`hassemu.0.clients.${rec.id}.ip`)?.val).to.equal('10.0.0.1');
        });

        it('returns existing record when cookie matches', async () => {
            const rec1 = await registry.identifyOrCreate(null, '192.168.1.5', null);
            const rec2 = await registry.identifyOrCreate(rec1.cookie, '192.168.1.5', null);
            expect(rec2.id).to.equal(rec1.id);
        });

        it('creates new record when cookie is invalid UUID', async () => {
            const rec1 = await registry.identifyOrCreate('not-a-uuid', '192.168.1.5', null);
            const rec2 = await registry.identifyOrCreate('also-bad', '192.168.1.5', null);
            expect(rec1.id).to.not.equal(rec2.id);
        });

        it('creates new record when cookie is unknown UUID', async () => {
            const rec1 = await registry.identifyOrCreate(null, null, null);
            const stranger = crypto.randomUUID();
            const rec2 = await registry.identifyOrCreate(stranger, null, null);
            expect(rec2.id).to.not.equal(rec1.id);
        });

        // Regression: v1.1.2 and earlier registered a separate client for each
        // parallel cookieless request from the same display on initial connect,
        // leaving orphan clients behind (seen in the log as two "New client
        // registered" lines within 100 ms from the same IP).
        it('returns the same record for parallel cookieless requests from the same IP', async () => {
            const promises = [
                registry.identifyOrCreate(null, '192.168.77.10', null),
                registry.identifyOrCreate(null, '192.168.77.10', null),
                registry.identifyOrCreate(null, '192.168.77.10', null),
            ];
            const results = await Promise.all(promises);
            expect(results[0].id).to.equal(results[1].id);
            expect(results[1].id).to.equal(results[2].id);
            expect(registry.listAll()).to.have.lengthOf(1);
        });

        it('still creates distinct clients for parallel requests from different IPs', async () => {
            const results = await Promise.all([
                registry.identifyOrCreate(null, '10.0.0.1', null),
                registry.identifyOrCreate(null, '10.0.0.2', null),
                registry.identifyOrCreate(null, '10.0.0.3', null),
            ]);
            const ids = new Set(results.map(r => r.id));
            expect(ids.size).to.equal(3);
            expect(registry.listAll()).to.have.lengthOf(3);
        });

        it('clears the pending-lock after creation so sequential cookieless visits create new clients', async () => {
            const rec1 = await registry.identifyOrCreate(null, '192.168.77.20', null);
            // Sequential — the first promise has resolved and been cleared from
            // pendingByIp; a new cookieless visit is a new display session.
            const rec2 = await registry.identifyOrCreate(null, '192.168.77.20', null);
            expect(rec1.id).to.not.equal(rec2.id);
        });

        it('updates IP when it changes on subsequent visit', async () => {
            const rec = await registry.identifyOrCreate(null, '1.1.1.1', null);
            await registry.identifyOrCreate(rec.cookie, '2.2.2.2', null);
            expect(rec.ip).to.equal('2.2.2.2');
            expect(store.states.get(`hassemu.0.clients.${rec.id}.ip`)?.val).to.equal('2.2.2.2');
        });

        it('updates hostname when it changes on subsequent visit', async () => {
            const rec = await registry.identifyOrCreate(null, '1.1.1.1', 'old.local');
            await registry.identifyOrCreate(rec.cookie, '1.1.1.1', 'new.local');
            expect(rec.hostname).to.equal('new.local');
            const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(ch?.common?.name).to.equal('new.local');
        });

        it('does not overwrite ip with null on subsequent visit', async () => {
            const rec = await registry.identifyOrCreate(null, '1.1.1.1', null);
            await registry.identifyOrCreate(rec.cookie, null, null);
            expect(rec.ip).to.equal('1.1.1.1');
        });

        it('generates unique IDs for concurrent clients', async () => {
            const seen = new Set<string>();
            for (let i = 0; i < 20; i++) {
                const rec = await registry.identifyOrCreate(null, null, null);
                expect(seen.has(rec.id)).to.be.false;
                seen.add(rec.id);
            }
            expect(seen.size).to.equal(20);
        });
    });

    describe('lookups', () => {
        let rec: ClientRecord;

        beforeEach(async () => {
            rec = await registry.identifyOrCreate(null, '10.0.0.1', null);
        });

        it('getById returns the record', () => {
            expect(registry.getById(rec.id)).to.equal(rec);
        });

        it('getById returns null for unknown', () => {
            expect(registry.getById('xxxxxx')).to.be.null;
        });

        it('getByCookie returns the record', () => {
            expect(registry.getByCookie(rec.cookie)).to.equal(rec);
        });

        it('getByCookie returns null for invalid cookie string', () => {
            expect(registry.getByCookie('garbage')).to.be.null;
        });

        it('getByToken returns null before token is set', () => {
            expect(registry.getByToken('anything')).to.be.null;
        });

        it('listAll returns all clients', async () => {
            await registry.identifyOrCreate(null, null, null);
            expect(registry.listAll().length).to.equal(2);
        });
    });

    describe('setToken', () => {
        it('sets the token and makes it findable', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const token = crypto.randomUUID();
            await registry.setToken(rec.id, token);
            expect(rec.token).to.equal(token);
            expect(registry.getByToken(token)).to.equal(rec);
        });

        it('persists token to channel.native', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const token = crypto.randomUUID();
            await registry.setToken(rec.id, token);
            const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
            expect(channel?.native?.token).to.equal(token);
        });

        it('clears token on null', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const token = crypto.randomUUID();
            await registry.setToken(rec.id, token);
            await registry.setToken(rec.id, null);
            expect(rec.token).to.be.null;
            expect(registry.getByToken(token)).to.be.null;
        });

        it('replaces old token when new one is set', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const t1 = crypto.randomUUID();
            const t2 = crypto.randomUUID();
            await registry.setToken(rec.id, t1);
            await registry.setToken(rec.id, t2);
            expect(registry.getByToken(t1)).to.be.null;
            expect(registry.getByToken(t2)).to.equal(rec);
        });

        it('no-op when id is unknown', async () => {
            await registry.setToken('xxxxxx', 'any');
            expect(registry.listAll().length).to.equal(0);
        });
    });

    describe('handleVisUrlWrite', () => {
        let rec: ClientRecord;

        beforeEach(async () => {
            rec = await registry.identifyOrCreate(null, null, null);
        });

        it('accepts safe http URL', async () => {
            await registry.handleVisUrlWrite(rec.id, 'http://tablet.local/ui');
            expect(rec.visUrl).to.equal('http://tablet.local/ui');
        });

        it('accepts safe https URL', async () => {
            await registry.handleVisUrlWrite(rec.id, 'https://example.com/dash');
            expect(rec.visUrl).to.equal('https://example.com/dash');
        });

        it('clears override on empty string', async () => {
            rec.visUrl = 'http://old.local/';
            await registry.handleVisUrlWrite(rec.id, '');
            expect(rec.visUrl).to.be.null;
        });

        it('rejects javascript: URL and restores previous value', async () => {
            rec.visUrl = 'http://safe.local/';
            await registry.handleVisUrlWrite(rec.id, 'javascript:alert(1)');
            expect(rec.visUrl).to.equal('http://safe.local/');
            const warn = store.logs.find(l => l.level === 'warn');
            expect(warn?.msg).to.include('rejected unsafe visUrl');
        });

        it('rejects ftp:// URL', async () => {
            await registry.handleVisUrlWrite(rec.id, 'ftp://server/');
            expect(rec.visUrl).to.be.null;
        });

        it('rejects URLs with embedded credentials', async () => {
            await registry.handleVisUrlWrite(rec.id, 'http://user:pass@host/');
            expect(rec.visUrl).to.be.null;
        });

        it('no-op when id is unknown', async () => {
            await registry.handleVisUrlWrite('xxxxxx', 'http://ok/');
            // no throw, no state
        });
    });

    describe('remove', () => {
        it('deletes in-memory entries', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            await registry.remove(rec.id);
            expect(registry.getById(rec.id)).to.be.null;
            expect(registry.getByCookie(rec.cookie)).to.be.null;
        });

        it('deletes ioBroker channel and all child states', async () => {
            const rec = await registry.identifyOrCreate(null, '1.2.3.4', null);
            await registry.remove(rec.id);
            expect(store.objects.has(`hassemu.0.clients.${rec.id}`)).to.be.false;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).to.be.false;
        });

        it('unregisters token so it cannot be reused', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const token = crypto.randomUUID();
            await registry.setToken(rec.id, token);
            await registry.remove(rec.id);
            expect(registry.getByToken(token)).to.be.null;
        });

        it('returning client gets new id and new cookie', async () => {
            const rec1 = await registry.identifyOrCreate(null, '1.1.1.1', null);
            const oldCookie = rec1.cookie;
            await registry.remove(rec1.id);
            const rec2 = await registry.identifyOrCreate(oldCookie, '1.1.1.1', null);
            expect(rec2.id).to.not.equal(rec1.id);
            expect(rec2.cookie).to.not.equal(oldCookie);
        });

        it('logs info on removal', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            await registry.remove(rec.id);
            const info = store.logs.find(l => l.level === 'info' && l.msg.includes('forgotten'));
            expect(info).to.not.be.undefined;
        });

        it('no-op when id is unknown', async () => {
            await registry.remove('xxxxxx');
        });
    });

    describe('syncUrlDropdown', () => {
        it('updates common.states on existing visUrl datapoints', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            await registry.syncUrlDropdown({ 'http://a.local/': 'A', 'http://b.local/': 'B' });
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.visUrl`);
            expect(obj?.common?.states).to.deep.equal({
                'http://a.local/': 'A',
                'http://b.local/': 'B',
            });
        });

        it('uses synced dropdown for newly created clients', async () => {
            await registry.syncUrlDropdown({ 'http://a.local/': 'A' });
            const rec = await registry.identifyOrCreate(null, null, null);
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.visUrl`);
            expect(obj?.common?.states).to.deep.equal({ 'http://a.local/': 'A' });
        });

        it('is a no-op when there are no clients', async () => {
            await registry.syncUrlDropdown({ 'http://a/': 'A' });
        });
    });

    describe('restore', () => {
        it('loads existing clients from ioBroker objects', async () => {
            // Pre-populate store as if adapter was restarted
            const id = 'abc123';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                common: { name: 'tablet.local' },
                native: { cookie, token: null },
            });
            store.states.set(`hassemu.0.clients.${id}.visUrl`, { val: 'http://preserved.local/', ack: true });
            store.states.set(`hassemu.0.clients.${id}.ip`, { val: '192.168.1.20', ack: true });

            await registry.restore();
            const rec = registry.getById(id);
            expect(rec).to.not.be.null;
            expect(rec!.cookie).to.equal(cookie);
            expect(rec!.visUrl).to.equal('http://preserved.local/');
            expect(rec!.ip).to.equal('192.168.1.20');
            expect(rec!.hostname).to.equal('tablet.local');
        });

        it('treats common.name = ip as "no hostname known"', async () => {
            const id = 'noHost';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                common: { name: '192.168.1.20' },
                native: { cookie },
            });
            store.states.set(`hassemu.0.clients.${id}.ip`, { val: '192.168.1.20', ack: true });
            await registry.restore();
            const rec = registry.getById(id);
            expect(rec?.hostname).to.be.null;
        });

        it('migrates legacy hostname state into common.name and drops the state', async () => {
            const id = 'legacy';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                common: { name: '10.0.0.5' },
                native: { cookie },
            });
            store.objects.set(`hassemu.0.clients.${id}.hostname`, { type: 'state' });
            store.states.set(`hassemu.0.clients.${id}.ip`, { val: '10.0.0.5', ack: true });
            store.states.set(`hassemu.0.clients.${id}.hostname`, { val: 'tablet.local', ack: true });

            await registry.restore();
            const rec = registry.getById(id);
            expect(rec?.hostname).to.equal('tablet.local');
            const ch = store.objects.get(`hassemu.0.clients.${id}`);
            expect(ch?.common?.name).to.equal('tablet.local');
            expect(store.objects.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
            expect(store.states.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
        });

        it('skips channels without a valid cookie', async () => {
            store.objects.set('hassemu.0.clients.broken', {
                type: 'channel',
                native: { cookie: 'not-a-uuid' },
            });
            await registry.restore();
            expect(registry.getById('broken')).to.be.null;
        });

        it('returns cookie-identified record after restore', async () => {
            const id = 'def456';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                native: { cookie },
            });
            await registry.restore();
            const rec = await registry.identifyOrCreate(cookie, null, null);
            expect(rec.id).to.equal(id);
        });

        it('re-registers persisted token so token lookups work after restart', async () => {
            const id = 'ghi789';
            const cookie = crypto.randomUUID();
            const token = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                native: { cookie, token },
            });
            await registry.restore();
            expect(registry.getByToken(token)?.id).to.equal(id);
        });

        it('handles empty state', async () => {
            await registry.restore();
            expect(registry.listAll().length).to.equal(0);
        });
    });
});

describe('parseClientStateId', () => {
    const ns = 'hassemu.0';

    it('parses visUrl writes', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.visUrl', ns)).to.deep.equal({
            id: 'abc123',
            kind: 'visUrl',
        });
    });

    it('parses remove button presses', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.remove', ns)).to.deep.equal({
            id: 'abc123',
            kind: 'remove',
        });
    });

    it('returns null for foreign state IDs', () => {
        expect(parseClientStateId('other.0.clients.abc123.visUrl', ns)).to.be.null;
    });

    it('returns null for non-client states', () => {
        expect(parseClientStateId('hassemu.0.info.connection', ns)).to.be.null;
    });

    it('returns null for read-only ip/hostname', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.ip', ns)).to.be.null;
        expect(parseClientStateId('hassemu.0.clients.abc123.hostname', ns)).to.be.null;
    });

    it('returns null for channel ID (no sub-state)', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123', ns)).to.be.null;
    });

    it('returns null for too-deep IDs', () => {
        expect(parseClientStateId('hassemu.0.clients.abc.123.visUrl', ns)).to.be.null;
    });
});
