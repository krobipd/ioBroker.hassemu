import { expect } from 'chai';
import { GlobalConfig, parseGlobalStateId } from './global-config';
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
    objects: Map<string, ObjEntry>;
    states: Map<string, { val: unknown; ack: boolean }>;
    logs: LogEntry[];
}

function createMockAdapter(namespace = 'hassemu.0'): {
    store: MockStore;
    adapter: ReturnType<typeof build>;
} {
    const store: MockStore = { objects: new Map(), states: new Map(), logs: [] };

    function build(): {
        namespace: string;
        log: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
        setInterval: () => undefined;
        clearInterval: () => undefined;
        setTimeout: () => undefined;
        clearTimeout: () => undefined;
        getStateAsync: (id: string) => Promise<{ val: unknown; ack: boolean } | null>;
        setStateAsync: (id: string, value: { val: unknown; ack?: boolean }) => Promise<void>;
        extendObjectAsync: (id: string, obj: Partial<ObjEntry>) => Promise<void>;
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
            getStateAsync: async (id: string) => store.states.get(`${namespace}.${id}`) ?? null,
            setStateAsync: async (id: string, value: { val: unknown; ack?: boolean }) => {
                store.states.set(`${namespace}.${id}`, { val: value.val, ack: value.ack ?? false });
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
        };
    }

    return { store, adapter: build() };
}

function makeRecord(visUrl: string | null): ClientRecord {
    return { id: 'abc123', cookie: 'x', token: null, visUrl, ip: null, hostname: null };
}

describe('GlobalConfig', () => {
    let store: MockStore;
    let adapter: ReturnType<typeof createMockAdapter>['adapter'];
    let g: GlobalConfig;

    beforeEach(() => {
        const built = createMockAdapter();
        store = built.store;
        adapter = built.adapter;
        g = new GlobalConfig(adapter as never);
    });

    describe('restore', () => {
        it('defaults to null URL and disabled on empty state', async () => {
            await g.restore();
            expect(g.getGlobalUrl()).to.be.null;
            expect(g.isEnabled()).to.be.false;
        });

        it('loads URL and enabled flag from states', async () => {
            store.states.set('hassemu.0.global.visUrl', { val: 'http://vis.local/', ack: true });
            store.states.set('hassemu.0.global.enabled', { val: true, ack: true });
            await g.restore();
            expect(g.getGlobalUrl()).to.equal('http://vis.local/');
            expect(g.isEnabled()).to.be.true;
        });

        it('ignores unsafe URLs on restore', async () => {
            store.states.set('hassemu.0.global.visUrl', { val: 'javascript:alert(1)', ack: true });
            await g.restore();
            expect(g.getGlobalUrl()).to.be.null;
        });

        it('treats non-boolean enabled as false', async () => {
            store.states.set('hassemu.0.global.enabled', { val: 'true', ack: true });
            await g.restore();
            expect(g.isEnabled()).to.be.false;
        });
    });

    describe('resolveUrlFor', () => {
        it('returns client visUrl when override is disabled', async () => {
            await g.handleVisUrlWrite('http://global.local/');
            const rec = makeRecord('http://client.local/');
            expect(g.resolveUrlFor(rec)).to.equal('http://client.local/');
        });

        it('returns global URL when override is enabled', async () => {
            await g.handleVisUrlWrite('http://global.local/');
            await g.handleEnabledWrite(true);
            const rec = makeRecord('http://client.local/');
            expect(g.resolveUrlFor(rec)).to.equal('http://global.local/');
        });

        it('falls through to client when override is enabled but URL is empty', async () => {
            await g.handleEnabledWrite(true);
            const rec = makeRecord('http://client.local/');
            expect(g.resolveUrlFor(rec)).to.equal('http://client.local/');
        });

        it('returns null when nothing is configured', async () => {
            const rec = makeRecord(null);
            expect(g.resolveUrlFor(rec)).to.be.null;
        });
    });

    describe('handleVisUrlWrite', () => {
        it('accepts safe http URL', async () => {
            await g.handleVisUrlWrite('http://ok.local/');
            expect(g.getGlobalUrl()).to.equal('http://ok.local/');
        });

        it('clears URL on empty string', async () => {
            await g.handleVisUrlWrite('http://old/');
            await g.handleVisUrlWrite('');
            expect(g.getGlobalUrl()).to.be.null;
        });

        it('rejects javascript: URL and restores previous state', async () => {
            await g.handleVisUrlWrite('http://safe.local/');
            await g.handleVisUrlWrite('javascript:alert(1)');
            expect(g.getGlobalUrl()).to.equal('http://safe.local/');
            const warn = store.logs.find(l => l.level === 'warn');
            expect(warn?.msg).to.include('rejected unsafe global.visUrl');
        });

        it('rejects URLs with embedded credentials', async () => {
            await g.handleVisUrlWrite('http://user:pass@host/');
            expect(g.getGlobalUrl()).to.be.null;
        });

        it('persists accepted URL to state', async () => {
            await g.handleVisUrlWrite('http://persisted.local/');
            expect(store.states.get('hassemu.0.global.visUrl')?.val).to.equal('http://persisted.local/');
        });
    });

    describe('handleEnabledWrite', () => {
        it('persists true', async () => {
            await g.handleEnabledWrite(true);
            expect(g.isEnabled()).to.be.true;
            expect(store.states.get('hassemu.0.global.enabled')?.val).to.equal(true);
        });

        it('persists false', async () => {
            await g.handleEnabledWrite(true);
            await g.handleEnabledWrite(false);
            expect(g.isEnabled()).to.be.false;
        });

        it('coerces non-boolean to false', async () => {
            await g.handleEnabledWrite('true');
            expect(g.isEnabled()).to.be.false;
        });
    });

    describe('syncUrlDropdown', () => {
        it('writes common.states to the global.visUrl object', async () => {
            await g.syncUrlDropdown({ 'http://a/': 'A', 'http://b/': 'B' });
            const obj = store.objects.get('hassemu.0.global.visUrl');
            expect(obj?.common?.states).to.deep.equal({ 'http://a/': 'A', 'http://b/': 'B' });
        });
    });
});

describe('parseGlobalStateId', () => {
    const ns = 'hassemu.0';

    it('parses visUrl writes', () => {
        expect(parseGlobalStateId('hassemu.0.global.visUrl', ns)).to.equal('visUrl');
    });

    it('parses enabled writes', () => {
        expect(parseGlobalStateId('hassemu.0.global.enabled', ns)).to.equal('enabled');
    });

    it('returns null for unknown sub-state', () => {
        expect(parseGlobalStateId('hassemu.0.global.other', ns)).to.be.null;
    });

    it('returns null for foreign IDs', () => {
        expect(parseGlobalStateId('other.0.global.visUrl', ns)).to.be.null;
    });

    it('returns null for client IDs', () => {
        expect(parseGlobalStateId('hassemu.0.clients.abc.visUrl', ns)).to.be.null;
    });
});
