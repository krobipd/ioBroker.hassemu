import { expect } from 'chai';
import crypto from 'node:crypto';
import { ClientRegistry, parseClientStateId } from './client-registry';
import { MODE_GLOBAL, MODE_MANUAL } from './global-config';
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
        log: {
            debug: (m: string) => void;
            info: (m: string) => void;
            warn: (m: string) => void;
            error: (m: string) => void;
        };
        setInterval: () => undefined;
        clearInterval: () => undefined;
        setTimeout: () => undefined;
        clearTimeout: () => undefined;
        getForeignObjectsAsync: (pattern: string, type: 'channel') => Promise<Record<string, ObjEntry>>;
        getStateAsync: (id: string) => Promise<{ val: unknown; ack: boolean } | null>;
        getObjectAsync: (id: string) => Promise<ObjEntry | null>;
        setObjectAsync: (id: string, obj: ObjEntry) => Promise<void>;
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
            getObjectAsync: async (id: string) => {
                const fullId = id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
                return store.objects.get(fullId) ?? null;
            },
            setObjectAsync: async (id: string, obj: ObjEntry) => {
                const fullId = id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
                store.objects.set(fullId, obj);
            },
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
            expect(rec.id).to.match(/^[0-9a-f]{6}$/);
            expect(rec.cookie).to.match(/^[0-9a-f-]{36}$/);
            expect(rec.ip).to.equal('192.168.1.5');
            expect(rec.hostname).to.equal('tablet.local');
            expect(rec.mode).to.equal(MODE_GLOBAL); // Default provider returns MODE_GLOBAL
            expect(rec.manualUrl).to.be.null;
        });

        it('creates ioBroker channel + mode/manualUrl/ip/remove states on new client', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', null);
            expect(store.objects.has(`hassemu.0.clients.${rec.id}`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.mode`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.manualUrl`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.ip`)).to.be.true;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.remove`)).to.be.true;
        });

        it('mode state has type "mixed" (future-proof against strict-type cast)', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
            expect(obj?.common?.type).to.equal('mixed');
        });

        it('manualUrl state has role "url"', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.manualUrl`);
            expect(obj?.common?.role).to.equal('url');
        });

        it('does not create a legacy hostname state', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', 'tablet.local');
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.hostname`)).to.be.false;
        });

        it('does not create a legacy visUrl state', async () => {
            const rec = await registry.identifyOrCreate(null, '192.168.1.5', null);
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).to.be.false;
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

        it('persists initial mode value to state', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            expect(store.states.get(`hassemu.0.clients.${rec.id}.mode`)?.val).to.equal(rec.mode);
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
        // parallel cookieless request from the same display on initial connect.
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
            const rec2 = await registry.identifyOrCreate(null, '192.168.77.20', null);
            expect(rec1.id).to.not.equal(rec2.id);
        });

        // v1.17.0 (C8) — different User-Agents on the same IP (NAT) get separate
        // ClientRecords statt cookie/token zu teilen.
        it('parallel cookieless requests with different UAs on same IP get distinct clients (C8 v1.17.0)', async () => {
            const promises = [
                registry.identifyOrCreate(null, '10.0.0.1', null, 'Display-A/1.0'),
                registry.identifyOrCreate(null, '10.0.0.1', null, 'Display-B/2.0'),
            ];
            const results = await Promise.all(promises);
            expect(results[0].id).to.not.equal(results[1].id);
            expect(results[0].cookie).to.not.equal(results[1].cookie);
            expect(registry.listAll()).to.have.lengthOf(2);
        });

        // v1.17.0 (C8) — same UA on same IP behaves wie vorher: Bursts kollabieren.
        it('parallel cookieless requests with same UA on same IP collapse to one client', async () => {
            const promises = [
                registry.identifyOrCreate(null, '10.0.0.2', null, 'Display-A/1.0'),
                registry.identifyOrCreate(null, '10.0.0.2', null, 'Display-A/1.0'),
                registry.identifyOrCreate(null, '10.0.0.2', null, 'Display-A/1.0'),
            ];
            const results = await Promise.all(promises);
            expect(results[0].id).to.equal(results[1].id);
            expect(results[1].id).to.equal(results[2].id);
            expect(registry.listAll()).to.have.lengthOf(1);
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

        it('writes lastSeen native on first identify', async () => {
            const before = Date.now();
            const rec = await registry.identifyOrCreate(null, '1.1.1.1', null);
            const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
            const lastSeen = (channel?.native as { lastSeen?: number })?.lastSeen;
            expect(typeof lastSeen).to.equal('number');
            expect(lastSeen!).to.be.at.least(before);
        });
    });

    describe('setNewClientModeProvider', () => {
        it('uses the provider value as default mode for new clients', async () => {
            registry.setNewClientModeProvider(() => 'http://override.local/');
            const rec = await registry.identifyOrCreate(null, null, null);
            expect(rec.mode).to.equal('http://override.local/');
        });

        it("falls back to 'global' when no provider was wired", async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            expect(rec.mode).to.equal(MODE_GLOBAL);
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

    describe('handleModeWrite', () => {
        let rec: ClientRecord;

        beforeEach(async () => {
            rec = await registry.identifyOrCreate(null, null, null);
        });

        it("accepts 'global' sentinel", async () => {
            await registry.handleModeWrite(rec.id, MODE_GLOBAL);
            expect(rec.mode).to.equal(MODE_GLOBAL);
            expect(store.states.get(`hassemu.0.clients.${rec.id}.mode`)?.val).to.equal(MODE_GLOBAL);
        });

        it("accepts 'manual' sentinel", async () => {
            await registry.handleModeWrite(rec.id, MODE_MANUAL);
            expect(rec.mode).to.equal(MODE_MANUAL);
        });

        it("warns when 'manual' is set but manualUrl is empty", async () => {
            await registry.handleModeWrite(rec.id, MODE_MANUAL);
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('manualUrl is empty'));
            expect(warn).to.not.be.undefined;
        });

        it('accepts a safe URL string', async () => {
            await registry.handleModeWrite(rec.id, 'http://tablet.local/ui');
            expect(rec.mode).to.equal('http://tablet.local/ui');
        });

        it('accepts empty string (clears mode)', async () => {
            rec.mode = MODE_GLOBAL;
            await registry.handleModeWrite(rec.id, '');
            expect(rec.mode).to.equal('');
        });

        it('rejects javascript: URL and restores previous value', async () => {
            rec.mode = 'http://safe.local/';
            await registry.handleModeWrite(rec.id, 'javascript:alert(1)');
            expect(rec.mode).to.equal('http://safe.local/');
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('rejected unsafe'));
            expect(warn).to.not.be.undefined;
        });

        it('rejects ftp:// URL', async () => {
            await registry.handleModeWrite(rec.id, 'ftp://server/');
            // mode unchanged (was the provider default)
            expect(rec.mode).to.equal(MODE_GLOBAL);
        });

        it('rejects URLs with embedded credentials', async () => {
            await registry.handleModeWrite(rec.id, 'http://user:pass@host/');
            expect(rec.mode).to.equal(MODE_GLOBAL);
        });

        it('rejects non-string values (logs debug, G7 v1.18.0)', async () => {
            await registry.handleModeWrite(rec.id, 42 as unknown);
            expect(rec.mode).to.equal(MODE_GLOBAL);
            // v1.18.0 (G7): downgrade warn→debug — das war UI-echo, kein Server-Concern.
            const debug = store.logs.find(l => l.level === 'debug' && l.msg.includes('non-string'));
            expect(debug).to.not.be.undefined;
        });

        it('no-op when id is unknown', async () => {
            await registry.handleModeWrite('xxxxxx', 'http://ok/');
        });
    });

    describe('handleManualUrlWrite', () => {
        let rec: ClientRecord;

        beforeEach(async () => {
            rec = await registry.identifyOrCreate(null, null, null);
        });

        it('accepts a safe URL', async () => {
            await registry.handleManualUrlWrite(rec.id, 'http://manual.local/');
            expect(rec.manualUrl).to.equal('http://manual.local/');
        });

        it('accepts empty string (clears value)', async () => {
            rec.manualUrl = 'http://old/';
            await registry.handleManualUrlWrite(rec.id, '');
            expect(rec.manualUrl).to.be.null;
        });

        it('rejects unsafe URL', async () => {
            await registry.handleManualUrlWrite(rec.id, 'javascript:alert(1)');
            expect(rec.manualUrl).to.be.null;
        });

        it("warns when manualUrl is cleared while mode='manual'", async () => {
            rec.mode = MODE_MANUAL;
            rec.manualUrl = 'http://x/';
            await registry.handleManualUrlWrite(rec.id, '');
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('manualUrl cleared'));
            expect(warn).to.not.be.undefined;
        });

        it('no-op when id is unknown', async () => {
            await registry.handleManualUrlWrite('xxxxxx', 'http://ok/');
        });
    });

    describe('bulkSetMode', () => {
        it('sets mode on every client', async () => {
            const r1 = await registry.identifyOrCreate(null, '1.1.1.1', null);
            const r2 = await registry.identifyOrCreate(null, '1.1.1.2', null);
            await registry.bulkSetMode('http://target/');
            expect(r1.mode).to.equal('http://target/');
            expect(r2.mode).to.equal('http://target/');
        });

        it('persists each new mode value to state with ack=true', async () => {
            const r1 = await registry.identifyOrCreate(null, '1.1.1.1', null);
            await registry.bulkSetMode(MODE_GLOBAL);
            const stored = store.states.get(`hassemu.0.clients.${r1.id}.mode`);
            expect(stored?.val).to.equal(MODE_GLOBAL);
            expect(stored?.ack).to.be.true;
        });

        it('skips clients whose mode already matches (no spurious writes)', async () => {
            const r1 = await registry.identifyOrCreate(null, '1.1.1.1', null);
            r1.mode = 'same';
            store.logs.length = 0;
            await registry.bulkSetMode('same');
            const info = store.logs.find(l => l.level === 'info' && l.msg.includes('bulk-set'));
            expect(info).to.be.undefined;
        });

        it('logs debug with count on actual changes', async () => {
            // bulkSetMode-Trigger ist Tech-Internal — auf debug seit v1.27.0
            // (User wollte mode-Werte aus dem User-Log raus). Test prüft den
            // debug-Output mit Count statt info.
            await registry.identifyOrCreate(null, '1.1.1.1', null);
            await registry.identifyOrCreate(null, '1.1.1.2', null);
            store.logs.length = 0;
            await registry.bulkSetMode('http://new/');
            const dbg = store.logs.find(l => l.level === 'debug' && l.msg.includes('bulkSetMode'));
            expect(dbg?.msg).to.match(/2 client/);
        });

        it('is a no-op with no clients', async () => {
            await registry.bulkSetMode(MODE_GLOBAL);
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
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.mode`)).to.be.false;
            expect(store.objects.has(`hassemu.0.clients.${rec.id}.manualUrl`)).to.be.false;
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
        it('updates common.states on existing mode datapoints with sentinels + URLs (plain-string labels, EN fallback)', async () => {
            // v1.28.4: Sentinel-labels sind plain-strings (system-language resolved),
            // nicht mehr Translation-Objects. Admin crasht sonst mit React Error #31.
            const rec = await registry.identifyOrCreate(null, null, null);
            await registry.syncUrlDropdown({ 'http://a.local/': 'A', 'http://b.local/': 'B' });
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
            expect(obj?.common?.states).to.deep.equal({
                0: '---',
                [MODE_GLOBAL]: 'Global URL',
                [MODE_MANUAL]: 'Manual URL',
                'http://a.local/': 'A',
                'http://b.local/': 'B',
            });
        });

        it('uses synced dropdown for newly created clients', async () => {
            await registry.syncUrlDropdown({ 'http://a.local/': 'A' });
            const rec = await registry.identifyOrCreate(null, null, null);
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
            expect(obj?.common?.states).to.deep.equal({
                0: '---',
                [MODE_GLOBAL]: 'Global URL',
                [MODE_MANUAL]: 'Manual URL',
                'http://a.local/': 'A',
            });
        });

        it('common.states VALUES sind alle plain-string (Regression-Test für React #31)', async () => {
            const rec = await registry.identifyOrCreate(null, null, null);
            await registry.syncUrlDropdown({ 'http://a.local/': 'A', 'http://b.local/': 'B' });
            const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
            const states = obj?.common?.states as Record<string, unknown>;
            for (const [key, value] of Object.entries(states)) {
                expect(typeof value, `states[${key}] must be string`).to.equal('string');
            }
        });

        it('is a no-op when there are no clients', async () => {
            await registry.syncUrlDropdown({ 'http://a/': 'A' });
        });
    });

    describe('restore', () => {
        it('loads existing clients with mode + manualUrl from state', async () => {
            const id = 'abc123';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                common: { name: 'tablet.local' },
                native: { cookie, token: null },
            });
            store.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
            store.states.set(`hassemu.0.clients.${id}.manualUrl`, { val: 'http://saved/', ack: true });
            store.states.set(`hassemu.0.clients.${id}.ip`, { val: '192.168.1.20', ack: true });

            await registry.restore();
            const rec = registry.getById(id);
            expect(rec).to.not.be.null;
            expect(rec!.cookie).to.equal(cookie);
            expect(rec!.mode).to.equal(MODE_MANUAL);
            expect(rec!.manualUrl).to.equal('http://saved/');
            expect(rec!.ip).to.equal('192.168.1.20');
            expect(rec!.hostname).to.equal('tablet.local');
        });

        it('loads URL-mode (direct URL value)', async () => {
            const id = 'urlmode';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, {
                type: 'channel',
                native: { cookie },
            });
            store.states.set(`hassemu.0.clients.${id}.mode`, { val: 'http://direct/', ack: true });
            await registry.restore();
            expect(registry.getById(id)?.mode).to.equal('http://direct/');
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

        it('rejects unsafe persisted manualUrl (treats as null)', async () => {
            const id = 'unsafe';
            const cookie = crypto.randomUUID();
            store.objects.set(`hassemu.0.clients.${id}`, { type: 'channel', native: { cookie } });
            store.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
            store.states.set(`hassemu.0.clients.${id}.manualUrl`, { val: 'javascript:bad', ack: true });
            await registry.restore();
            expect(registry.getById(id)?.manualUrl).to.be.null;
        });

        it('a single broken client does not abort restore for the rest (HE1 v1.28.3)', async () => {
            // Three clients in store. The middle one's ensureObjects throws
            // (simulated broker hiccup mid-restore). Before HE1 the rejection
            // in the per-client body aborted the surrounding for-loop and
            // charlie never got restored.
            const cookieA = crypto.randomUUID();
            const cookieB = crypto.randomUUID();
            const cookieC = crypto.randomUUID();

            const localBuilt = createMockAdapter();
            localBuilt.store.objects.set(`hassemu.0.clients.alpha`, {
                type: 'channel',
                native: { cookie: cookieA },
            });
            localBuilt.store.objects.set(`hassemu.0.clients.bravo`, {
                type: 'channel',
                native: { cookie: cookieB },
            });
            localBuilt.store.objects.set(`hassemu.0.clients.charlie`, {
                type: 'channel',
                native: { cookie: cookieC },
            });
            const original = localBuilt.adapter.setObjectNotExistsAsync;
            (
                localBuilt.adapter as { setObjectNotExistsAsync: typeof original }
            ).setObjectNotExistsAsync = async (id: string, obj) => {
                if (id.startsWith('clients.bravo')) {
                    throw new Error('simulated broker hiccup mid-restore');
                }
                return original(id, obj);
            };
            const localReg = new ClientRegistry(localBuilt.adapter as never);
            await localReg.restore();
            expect(localReg.getById('alpha'), 'alpha must restore').to.not.be.null;
            expect(localReg.getById('charlie'), 'charlie must restore').to.not.be.null;
            // bravo's trackInMemory ran before the failing ensureObjects.
            // Per-client try/catch ensures the other two still made it through.
        });
    });

    // --- v1.19.0 (J-Phase Test-Coverage) ---

    describe('seedLastSeen (F11 v1.19.0)', () => {
        it('writes native.lastSeen for the given id', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            built.store.objects.set('hassemu.0.clients.foo', { type: 'channel', native: {} });
            await reg.seedLastSeen('foo', 1234567890);
            const obj = built.store.objects.get('hassemu.0.clients.foo');
            expect(obj?.native?.lastSeen).to.equal(1234567890);
        });

        it('updates throttle map so next touchLastSeen does not double-write', async () => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            built.store.objects.set('hassemu.0.clients.foo', { type: 'channel', native: {} });
            const flushed = (reg as unknown as { lastSeenFlushedAt: Map<string, number> }).lastSeenFlushedAt;
            expect(flushed.has('foo')).to.be.false;
            await reg.seedLastSeen('foo', 9999);
            expect(flushed.get('foo')).to.equal(9999);
        });
    });

    describe('per-IP burst-detection for broken cookies (G5 v1.19.0)', () => {
        const buildReg = (): { reg: ClientRegistry; store: MockStore } => {
            const built = createMockAdapter();
            const reg = new ClientRegistry(built.adapter as never);
            return { reg, store: built.store };
        };

        it('does not warn on first 3 client creations from same IP', () => {
            const { reg, store } = buildReg();
            const access = reg as unknown as { recordNewClientIp: (ip: string) => void };
            access.recordNewClientIp('1.2.3.4');
            access.recordNewClientIp('1.2.3.4');
            access.recordNewClientIp('1.2.3.4');
            const warnings = store.logs.filter(l => l.level === 'warn');
            expect(warnings).to.have.length(0);
        });

        it('emits one warn on the 4th client from same IP within 1h', () => {
            const { reg, store } = buildReg();
            const access = reg as unknown as { recordNewClientIp: (ip: string) => void };
            for (let i = 0; i < 4; i++) {
                access.recordNewClientIp('1.2.3.4');
            }
            const burstWarn = store.logs.filter(l => l.level === 'warn' && l.msg.includes('not persisting cookies'));
            expect(burstWarn).to.have.length(1);
            expect(burstWarn[0].msg).to.include('1.2.3.4');
        });

        it('does not double-warn within 1h cooldown', () => {
            const { reg, store } = buildReg();
            const access = reg as unknown as { recordNewClientIp: (ip: string) => void };
            for (let i = 0; i < 10; i++) {
                access.recordNewClientIp('1.2.3.4');
            }
            const burstWarn = store.logs.filter(l => l.level === 'warn' && l.msg.includes('not persisting cookies'));
            expect(burstWarn).to.have.length(1);
        });

        it('tracks bursts per IP independently', () => {
            const { reg, store } = buildReg();
            const access = reg as unknown as { recordNewClientIp: (ip: string) => void };
            for (let i = 0; i < 4; i++) access.recordNewClientIp('1.2.3.4');
            for (let i = 0; i < 4; i++) access.recordNewClientIp('5.6.7.8');
            const burstWarn = store.logs.filter(l => l.level === 'warn' && l.msg.includes('not persisting cookies'));
            expect(burstWarn).to.have.length(2);
        });

        it('caps the burst-tracking map at 200 entries (FIFO)', () => {
            const { reg } = buildReg();
            const access = reg as unknown as {
                recordNewClientIp: (ip: string) => void;
                newClientBurst: Map<string, unknown>;
            };
            for (let i = 0; i < 250; i++) {
                access.recordNewClientIp(`10.0.0.${i}`);
            }
            expect(access.newClientBurst.size).to.be.at.most(200);
            // Newest entries survive
            expect(access.newClientBurst.has('10.0.0.249')).to.be.true;
        });
    });
});

describe('parseClientStateId', () => {
    const ns = 'hassemu.0';

    it('parses mode writes', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.mode', ns)).to.deep.equal({
            id: 'abc123',
            kind: 'mode',
        });
    });

    it('parses manualUrl writes', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.manualUrl', ns)).to.deep.equal({
            id: 'abc123',
            kind: 'manualUrl',
        });
    });

    it('parses remove button presses', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.remove', ns)).to.deep.equal({
            id: 'abc123',
            kind: 'remove',
        });
    });

    it('returns null for foreign state IDs', () => {
        expect(parseClientStateId('other.0.clients.abc123.mode', ns)).to.be.null;
    });

    it('returns null for non-client states', () => {
        expect(parseClientStateId('hassemu.0.info.connection', ns)).to.be.null;
    });

    it('returns null for the now-removed visUrl path', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.visUrl', ns)).to.be.null;
    });

    it('returns null for read-only ip/hostname', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123.ip', ns)).to.be.null;
        expect(parseClientStateId('hassemu.0.clients.abc123.hostname', ns)).to.be.null;
    });

    it('returns null for channel ID (no sub-state)', () => {
        expect(parseClientStateId('hassemu.0.clients.abc123', ns)).to.be.null;
    });

    it('returns null for too-deep IDs', () => {
        expect(parseClientStateId('hassemu.0.clients.abc.123.mode', ns)).to.be.null;
    });
});
