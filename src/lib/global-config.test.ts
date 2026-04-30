import { expect } from 'chai';
import { GlobalConfig, MODE_GLOBAL, MODE_MANUAL, parseGlobalStateId } from './global-config';
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

function makeRecord(opts: Partial<ClientRecord>): ClientRecord {
    return {
        id: 'abc123',
        cookie: 'x',
        token: null,
        mode: '',
        manualUrl: null,
        ip: null,
        hostname: null,
        ...opts,
    };
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
        // restore() reads broker-state into private fields; we verify via the
        // public surface (resolveUrlFor + isEnabled) — no getter leakage.

        it('defaults to empty mode, null manualUrl, disabled', async () => {
            await g.restore();
            const rec = makeRecord({ mode: MODE_GLOBAL });
            // empty global.mode → resolveGlobalMode returns null
            expect(g.resolveUrlFor(rec)).to.be.null;
            expect(g.isEnabled()).to.be.false;
        });

        it('loads mode + manualUrl + enabled from states', async () => {
            store.states.set('hassemu.0.global.mode', { val: MODE_MANUAL, ack: true });
            store.states.set('hassemu.0.global.manualUrl', { val: 'http://vis.local/', ack: true });
            store.states.set('hassemu.0.global.enabled', { val: true, ack: true });
            await g.restore();
            const rec = makeRecord({ mode: MODE_GLOBAL });
            // global.mode='manual' delegates to global.manualUrl
            expect(g.resolveUrlFor(rec)).to.equal('http://vis.local/');
            expect(g.isEnabled()).to.be.true;
        });

        it('loads URL-mode (direct URL value)', async () => {
            store.states.set('hassemu.0.global.mode', { val: 'http://direct/', ack: true });
            await g.restore();
            const rec = makeRecord({ mode: MODE_GLOBAL });
            expect(g.resolveUrlFor(rec)).to.equal('http://direct/');
        });

        it('ignores unsafe persisted manualUrl', async () => {
            // Mode='manual' to force the global manualUrl branch in resolveGlobalMode
            store.states.set('hassemu.0.global.mode', { val: MODE_MANUAL, ack: true });
            store.states.set('hassemu.0.global.manualUrl', { val: 'javascript:alert(1)', ack: true });
            await g.restore();
            const rec = makeRecord({ mode: MODE_GLOBAL });
            expect(g.resolveUrlFor(rec)).to.be.null;
        });

        it('treats non-boolean enabled as false', async () => {
            store.states.set('hassemu.0.global.enabled', { val: 'true', ack: true });
            await g.restore();
            expect(g.isEnabled()).to.be.false;
        });
    });

    describe('resolveUrlFor — delegate via record.mode', () => {
        it("returns client manualUrl when mode='manual'", () => {
            const rec = makeRecord({ mode: MODE_MANUAL, manualUrl: 'http://m/' });
            expect(g.resolveUrlFor(rec)).to.equal('http://m/');
        });

        it("returns null when mode='manual' but manualUrl empty", () => {
            const rec = makeRecord({ mode: MODE_MANUAL, manualUrl: null });
            expect(g.resolveUrlFor(rec)).to.be.null;
        });

        it('returns the URL when mode is a URL string', () => {
            const rec = makeRecord({ mode: 'http://direct/' });
            expect(g.resolveUrlFor(rec)).to.equal('http://direct/');
        });

        it('returns null when mode is empty', () => {
            const rec = makeRecord({ mode: '' });
            expect(g.resolveUrlFor(rec)).to.be.null;
        });

        it("delegates to global when mode='global' (URL value)", async () => {
            await g.handleModeWrite('http://global/');
            const rec = makeRecord({ mode: MODE_GLOBAL });
            expect(g.resolveUrlFor(rec)).to.equal('http://global/');
        });

        it("delegates to global manualUrl when mode='global' and global.mode='manual'", async () => {
            await g.handleManualUrlWrite('http://gm/');
            await g.handleModeWrite(MODE_MANUAL);
            const rec = makeRecord({ mode: MODE_GLOBAL });
            expect(g.resolveUrlFor(rec)).to.equal('http://gm/');
        });

        it("returns null when mode='global' but global has nothing usable", () => {
            const rec = makeRecord({ mode: MODE_GLOBAL });
            expect(g.resolveUrlFor(rec)).to.be.null;
        });

        it('returns null for unknown / garbage mode value', () => {
            const rec = makeRecord({ mode: 'something-weird' });
            expect(g.resolveUrlFor(rec)).to.be.null;
        });
    });

    describe('handleModeWrite', () => {
        const modeVal = (): unknown => store.states.get('hassemu.0.global.mode')?.val ?? '';

        it("accepts 'manual' sentinel", async () => {
            await g.handleModeWrite(MODE_MANUAL);
            expect(modeVal()).to.equal(MODE_MANUAL);
        });

        it("warns when 'manual' is set but global.manualUrl is empty", async () => {
            await g.handleModeWrite(MODE_MANUAL);
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('manualUrl is empty'));
            expect(warn).to.not.be.undefined;
        });

        it("rejects 'global' (self-referential)", async () => {
            await g.handleModeWrite(MODE_GLOBAL);
            expect(modeVal()).to.equal(''); // unchanged
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('self-referential'));
            expect(warn).to.not.be.undefined;
        });

        it('accepts a safe URL', async () => {
            await g.handleModeWrite('http://ok.local/');
            expect(modeVal()).to.equal('http://ok.local/');
        });

        it('accepts empty string (clears mode → numeric 0)', async () => {
            await g.handleModeWrite('http://x/');
            await g.handleModeWrite('');
            // Cleared modes are persisted as numeric 0 (matches the dropdown's '---' option).
            expect(modeVal()).to.equal(0);
        });

        it('accepts numeric 0 (no-choice marker)', async () => {
            await g.handleModeWrite('http://x/');
            await g.handleModeWrite(0);
            expect(modeVal()).to.equal(0);
        });

        it("accepts string '0' (dropdown selection of '---')", async () => {
            await g.handleModeWrite('http://x/');
            await g.handleModeWrite('0');
            expect(modeVal()).to.equal(0);
        });

        it('rejects javascript: URL and keeps previous value', async () => {
            await g.handleModeWrite('http://safe/');
            await g.handleModeWrite('javascript:alert(1)');
            expect(modeVal()).to.equal('http://safe/');
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('unsafe'));
            expect(warn).to.not.be.undefined;
        });

        it('rejects non-string non-zero numbers', async () => {
            await g.handleModeWrite(42 as unknown);
            // mode stays unchanged → state is reverted to current value (0 by default)
            expect(modeVal()).to.equal(0);
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('non-string'));
            expect(warn).to.not.be.undefined;
        });
    });

    describe('handleManualUrlWrite', () => {
        const manualUrlVal = (): unknown => store.states.get('hassemu.0.global.manualUrl')?.val ?? '';

        it('accepts safe URL', async () => {
            await g.handleManualUrlWrite('http://m/');
            expect(manualUrlVal()).to.equal('http://m/');
        });

        it('clears on empty string', async () => {
            await g.handleManualUrlWrite('http://m/');
            await g.handleManualUrlWrite('');
            expect(manualUrlVal()).to.equal('');
        });

        it('rejects unsafe URL', async () => {
            await g.handleManualUrlWrite('javascript:alert(1)');
            // unsafe input → reverted to previous (null → '' in state)
            expect(manualUrlVal()).to.equal('');
        });

        it("warns when manualUrl cleared while mode='manual'", async () => {
            await g.handleManualUrlWrite('http://x/');
            await g.handleModeWrite(MODE_MANUAL);
            store.logs.length = 0;
            await g.handleManualUrlWrite('');
            const warn = store.logs.find(l => l.level === 'warn' && l.msg.includes('manualUrl cleared'));
            expect(warn).to.not.be.undefined;
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

    describe('migrationSet', () => {
        it('sets mode + manualUrl in one call without validation', async () => {
            await g.migrationSet(MODE_MANUAL, 'http://from-legacy/');
            expect(store.states.get('hassemu.0.global.mode')?.val).to.equal(MODE_MANUAL);
            expect(store.states.get('hassemu.0.global.manualUrl')?.val).to.equal('http://from-legacy/');
        });

        it('persists both states with ack=true', async () => {
            await g.migrationSet('http://x/', null);
            expect(store.states.get('hassemu.0.global.mode')?.ack).to.be.true;
            expect(store.states.get('hassemu.0.global.manualUrl')?.ack).to.be.true;
        });
    });

    describe('syncUrlDropdown', () => {
        it("writes common.states to global.mode with 0='---' + 'manual' sentinel added", async () => {
            await g.syncUrlDropdown({ 'http://a/': 'A', 'http://b/': 'B' });
            const obj = store.objects.get('hassemu.0.global.mode');
            expect(obj?.common?.states).to.deep.equal({
                0: '---',
                'http://a/': 'A',
                'http://b/': 'B',
                [MODE_MANUAL]: 'Manual URL',
            });
        });

        it("does NOT add 'global' sentinel (would be self-referential)", async () => {
            await g.syncUrlDropdown({ 'http://a/': 'A' });
            const obj = store.objects.get('hassemu.0.global.mode');
            const states = obj?.common?.states as Record<string, string>;
            expect(states[MODE_GLOBAL]).to.be.undefined;
        });
    });
});

describe('parseGlobalStateId', () => {
    const ns = 'hassemu.0';

    it('parses mode writes', () => {
        expect(parseGlobalStateId('hassemu.0.global.mode', ns)).to.equal('mode');
    });

    it('parses manualUrl writes', () => {
        expect(parseGlobalStateId('hassemu.0.global.manualUrl', ns)).to.equal('manualUrl');
    });

    it('parses enabled writes', () => {
        expect(parseGlobalStateId('hassemu.0.global.enabled', ns)).to.equal('enabled');
    });

    it('returns null for the now-removed visUrl path', () => {
        expect(parseGlobalStateId('hassemu.0.global.visUrl', ns)).to.be.null;
    });

    it('returns null for unknown sub-state', () => {
        expect(parseGlobalStateId('hassemu.0.global.other', ns)).to.be.null;
    });

    it('returns null for foreign IDs', () => {
        expect(parseGlobalStateId('other.0.global.mode', ns)).to.be.null;
    });

    it('returns null for client IDs', () => {
        expect(parseGlobalStateId('hassemu.0.clients.abc.mode', ns)).to.be.null;
    });
});
