import { expect } from 'chai';
import {
    UrlDiscovery,
    buildCrossRefs,
    collectFromInstance,
    resolvePlaceholders,
    type DiscoveryAdapter,
} from './url-discovery';

type TimerCallback = () => void;

interface MockAdapter {
    _timers: Map<number, { cb: TimerCallback; ms: number }>;
    _instances: Record<string, unknown>;
    _dirs: Record<string, unknown[] | Error>;
    _logs: string[];
    getForeignObjectsAsync: (pattern: string, type: 'instance') => Promise<Record<string, unknown>>;
    readDirAsync: (adapterName: string, path: string) => Promise<unknown[]>;
}

function createMockAdapter(): MockAdapter & DiscoveryAdapter {
    const timers = new Map<number, { cb: TimerCallback; ms: number }>();
    let nextId = 1;
    const logs: string[] = [];
    const mock = {
        _timers: timers,
        _instances: {} as Record<string, unknown>,
        _dirs: {} as Record<string, unknown[] | Error>,
        _logs: logs,
        log: {
            debug: (m: string): void => {
                logs.push(`[debug] ${m}`);
            },
            info: (m: string): void => {
                logs.push(`[info] ${m}`);
            },
            warn: (m: string): void => {
                logs.push(`[warn] ${m}`);
            },
            error: (m: string): void => {
                logs.push(`[error] ${m}`);
            },
        },
        setInterval: () => undefined,
        clearInterval: () => undefined,
        setTimeout: (cb: TimerCallback, ms: number) => {
            const id = nextId++;
            timers.set(id, { cb, ms });
            return id;
        },
        clearTimeout: (id: unknown) => {
            timers.delete(id as number);
        },
        getForeignObjectsAsync: async (): Promise<Record<string, unknown>> => mock._instances,
        readDirAsync: async (adapterName: string): Promise<unknown[]> => {
            const d = mock._dirs[adapterName];
            if (d instanceof Error) {
                throw d;
            }
            return d ?? [];
        },
    };
    return mock as never;
}

function enabledInstance(partial: Record<string, unknown>): Record<string, unknown> {
    return {
        common: { enabled: true, ...((partial.common as object) ?? {}) },
        native: partial.native ?? {},
    };
}

describe('url-discovery helpers', () => {
    describe('buildCrossRefs', () => {
        it('extracts short keys from system.adapter.* IDs', () => {
            const refs = buildCrossRefs({
                'system.adapter.web.0': { native: { port: 8082 } },
                'system.adapter.admin.0': { native: { port: 8081 } },
            });
            expect(refs.has('web.0')).to.be.true;
            expect(refs.has('admin.0')).to.be.true;
            expect(refs.size).to.equal(2);
        });

        it('skips non-object entries', () => {
            const refs = buildCrossRefs({
                'system.adapter.web.0': null,
                'system.adapter.admin.0': 'bad',
                'system.adapter.good.0': { native: {} },
            });
            expect(refs.size).to.equal(1);
            expect(refs.has('good.0')).to.be.true;
        });
    });

    describe('resolvePlaceholders', () => {
        const ctx = {
            instanceId: 'web.0',
            native: { bind: '192.168.1.10', port: 8082, secure: false },
            crossRefs: new Map(),
            hostIp: '192.168.1.99',
        };

        it('resolves %ip%', () => {
            expect(resolvePlaceholders('http://%ip%/', ctx)).to.equal('http://192.168.1.99/');
        });

        it('resolves %bind% to instance native bind', () => {
            expect(resolvePlaceholders('http://%bind%/', ctx)).to.equal('http://192.168.1.10/');
        });

        it('resolves %bind% to hostIp when bind is 0.0.0.0', () => {
            const wild = { ...ctx, native: { ...ctx.native, bind: '0.0.0.0' } };
            expect(resolvePlaceholders('http://%bind%/', wild)).to.equal('http://192.168.1.99/');
        });

        it('resolves %port%', () => {
            expect(resolvePlaceholders(':%port%/', ctx)).to.equal(':8082/');
        });

        it('resolves %protocol% based on secure', () => {
            expect(resolvePlaceholders('%protocol%', ctx)).to.equal('http');
            const secure = { ...ctx, native: { ...ctx.native, secure: true } };
            expect(resolvePlaceholders('%protocol%', secure)).to.equal('https');
        });

        it('resolves %secure% to "true" / "false"', () => {
            expect(resolvePlaceholders('%secure%', ctx)).to.equal('false');
            const secure = { ...ctx, native: { ...ctx.native, secure: true } };
            expect(resolvePlaceholders('%secure%', secure)).to.equal('true');
        });

        it('resolves %instance% to instance number', () => {
            expect(resolvePlaceholders('%instance%', ctx)).to.equal('0');
        });

        it('resolves %native_<field>%', () => {
            const c = { ...ctx, native: { ...ctx.native, path: '/admin' } };
            expect(resolvePlaceholders('%native_path%', c)).to.equal('/admin');
        });

        it('resolves cross-instance placeholder', () => {
            const crossRefs = new Map<string, Record<string, unknown>>();
            crossRefs.set('web.0', { native: { port: 8082, secure: true, bind: '192.168.1.10' } });
            const c = { ...ctx, crossRefs };
            expect(resolvePlaceholders('%web.0_port%', c)).to.equal('8082');
            expect(resolvePlaceholders('%web.0_protocol%', c)).to.equal('https');
            expect(resolvePlaceholders('%web.0_bind%', c)).to.equal('192.168.1.10');
        });

        it('returns null when cross-instance reference missing', () => {
            expect(resolvePlaceholders('%web.0_port%', ctx)).to.be.null;
        });

        it('returns null on unknown token', () => {
            expect(resolvePlaceholders('http://%unknown%/', ctx)).to.be.null;
        });

        it('returns template verbatim with no placeholders', () => {
            expect(resolvePlaceholders('http://static/', ctx)).to.equal('http://static/');
        });

        it('resolves %port% to null when native.port is not numeric', () => {
            const bad = { ...ctx, native: { ...ctx.native, port: 'abc' } };
            expect(resolvePlaceholders('%port%', bad)).to.be.null;
        });
    });

    describe('collectFromInstance', () => {
        const hostIp = '192.168.1.99';
        const crossRefs = new Map<string, Record<string, unknown>>();

        it('skips non-object', () => {
            const result: Record<string, string> = {};
            collectFromInstance('system.adapter.bad.0', null, crossRefs, hostIp, result);
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('skips disabled instances', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.admin.0',
                {
                    common: { enabled: false, localLink: 'http://%ip%:8081' },
                    native: {},
                },
                crossRefs,
                hostIp,
                result,
            );
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('extracts legacy localLink', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.admin.0',
                enabledInstance({ common: { localLink: 'http://%ip%:8081/' } }),
                crossRefs,
                hostIp,
                result,
            );
            expect(result['http://192.168.1.99:8081/']).to.equal('admin.0');
        });

        it('prefers localLinks over legacy localLink when both present', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.admin.0',
                enabledInstance({
                    common: {
                        localLink: 'http://%ip%:8081/',
                        localLinks: {
                            _default: { link: 'http://%ip%:8081/new/', name: 'Admin' },
                        },
                    },
                }),
                crossRefs,
                hostIp,
                result,
            );
            expect(result['http://192.168.1.99:8081/new/']).to.equal('admin.0: Admin');
            expect(result['http://192.168.1.99:8081/']).to.be.undefined;
        });

        it('extracts welcomeScreen (single object)', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.vis.0',
                enabledInstance({
                    common: { welcomeScreen: { link: 'http://%ip%/vis/', name: 'VIS Main' } },
                }),
                crossRefs,
                hostIp,
                result,
            );
            expect(result['http://192.168.1.99/vis/']).to.equal('vis.0: VIS Main');
        });

        it('extracts welcomeScreen (array)', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.admin.0',
                enabledInstance({
                    common: {
                        welcomeScreen: [
                            { link: 'http://%ip%:8081/', name: 'Admin' },
                            { link: 'http://%ip%:8081/log', name: 'Logs' },
                        ],
                    },
                }),
                crossRefs,
                hostIp,
                result,
            );
            expect(result['http://192.168.1.99:8081/']).to.equal('admin.0: Admin');
            expect(result['http://192.168.1.99:8081/log']).to.equal('admin.0: Logs');
        });

        it('extracts welcomeScreenPro', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.admin.0',
                enabledInstance({
                    common: { welcomeScreenPro: { link: 'http://%ip%:8081/pro', name: 'Admin Pro' } },
                }),
                crossRefs,
                hostIp,
                result,
            );
            expect(result['http://192.168.1.99:8081/pro']).to.equal('admin.0: Admin Pro');
        });

        it('skips entries with non-http URLs', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.bad.0',
                enabledInstance({ common: { localLink: 'javascript:alert(1)' } }),
                crossRefs,
                hostIp,
                result,
            );
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('skips entries whose placeholders fail to resolve', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.bad.0',
                enabledInstance({
                    common: { localLink: 'http://%web.0_port%/' },
                    native: {},
                }),
                crossRefs,
                hostIp,
                result,
            );
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('uses instanceId as label when entry has no name', () => {
            const result: Record<string, string> = {};
            collectFromInstance(
                'system.adapter.x.0',
                enabledInstance({
                    common: { localLinks: { _default: { link: 'http://%ip%/' } } },
                }),
                crossRefs,
                hostIp,
                result,
            );
            expect(result['http://192.168.1.99/']).to.equal('x.0');
        });
    });
});

describe('UrlDiscovery', () => {
    let adapter: ReturnType<typeof createMockAdapter>;
    let discovery: UrlDiscovery;

    beforeEach(() => {
        adapter = createMockAdapter();
        discovery = new UrlDiscovery(adapter);
    });

    describe('collect()', () => {
        it('returns empty when no instances exist', async () => {
            const result = await discovery.collect();
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('gracefully handles getForeignObjectsAsync failure', async () => {
            adapter.getForeignObjectsAsync = async () => {
                throw new Error('boom');
            };
            const result = await discovery.collect();
            expect(Object.keys(result)).to.have.lengthOf(0);
            const debugs = adapter._logs.filter(l => l.startsWith('[debug]'));
            expect(debugs.some(l => l.includes('getForeignObjectsAsync failed'))).to.be.true;
        });

        it('finds VIS-2 projects and builds URLs', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({
                    native: { bind: '192.168.1.10', port: 8082, secure: false },
                }),
            };
            adapter._dirs['vis-2.0'] = [
                { file: 'main', isDir: true },
                { file: 'kitchen', isDir: true },
                { file: '_globals', isDir: true },
                { file: 'readme.txt', isDir: false },
            ];
            const result = await discovery.collect();
            expect(result['http://192.168.1.10:8082/vis-2/index.html?main']).to.equal('VIS-2: main');
            expect(result['http://192.168.1.10:8082/vis-2/index.html?kitchen']).to.equal('VIS-2: kitchen');
            expect(result['http://192.168.1.10:8082/vis-2/index.html?_globals']).to.be.undefined;
        });

        it('finds VIS-1 projects', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({ native: { bind: '192.168.1.10', port: 8082 } }),
            };
            adapter._dirs['vis.0'] = [{ file: 'legacy', isDir: true }];
            const result = await discovery.collect();
            expect(result['http://192.168.1.10:8082/vis/index.html?legacy']).to.equal('VIS: legacy');
        });

        it('builds VIS URLs with HTTPS when web.0 is secure', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({
                    native: { bind: '192.168.1.10', port: 8082, secure: true },
                }),
            };
            adapter._dirs['vis-2.0'] = [{ file: 'main', isDir: true }];
            const result = await discovery.collect();
            expect(result['https://192.168.1.10:8082/vis-2/index.html?main']).to.equal('VIS-2: main');
        });

        it('skips VIS discovery when web.0 is missing', async () => {
            adapter._dirs['vis-2.0'] = [{ file: 'main', isDir: true }];
            const result = await discovery.collect();
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('skips VIS discovery when web.0 has no port', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({ native: { bind: '192.168.1.10' } }),
            };
            adapter._dirs['vis-2.0'] = [{ file: 'main', isDir: true }];
            const result = await discovery.collect();
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('gracefully handles readDirAsync errors', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({ native: { bind: '192.168.1.10', port: 8082 } }),
            };
            adapter._dirs['vis-2.0'] = new Error('vis-2 not installed');
            const result = await discovery.collect();
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('skips non-array readDirAsync results', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({ native: { bind: '192.168.1.10', port: 8082 } }),
            };
            adapter.readDirAsync = async () => 'garbage' as unknown as unknown[];
            const result = await discovery.collect();
            expect(Object.keys(result)).to.have.lengthOf(0);
        });

        it('combines intro-tiles and VIS projects into a single result', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({ native: { bind: '192.168.1.10', port: 8082 } }),
                'system.adapter.admin.0': enabledInstance({
                    common: { localLinks: { _default: { link: 'http://%ip%:8081/', name: 'Admin' } } },
                }),
            };
            adapter._dirs['vis-2.0'] = [{ file: 'main', isDir: true }];
            const result = await discovery.collect();
            expect(Object.keys(result).length).to.be.greaterThanOrEqual(2);
        });

        it('resolves %web.0_port% cross-instance', async () => {
            adapter._instances = {
                'system.adapter.web.0': enabledInstance({ native: { bind: '192.168.1.10', port: 8082 } }),
                'system.adapter.jarvis.0': enabledInstance({
                    common: {
                        localLinks: {
                            _default: { link: 'http://%ip%:%web.0_port%/jarvis/', name: 'Jarvis' },
                        },
                    },
                }),
            };
            const result = await discovery.collect();
            const anyUrl = Object.keys(result).find(u => u.includes('jarvis'));
            expect(anyUrl).to.match(/^http:\/\/[\d.]+:8082\/jarvis\/$/);
        });

        it('updates cache after collect()', async () => {
            adapter._instances = {
                'system.adapter.admin.0': enabledInstance({
                    common: { localLinks: { _default: { link: 'http://%ip%:8081/', name: 'Admin' } } },
                }),
            };
            expect(Object.keys(discovery.getCached())).to.have.lengthOf(0);
            await discovery.collect();
            expect(Object.keys(discovery.getCached()).length).to.be.greaterThan(0);
        });

        it('getCached returns a copy, not a reference', async () => {
            await discovery.collect();
            const c1 = discovery.getCached();
            c1['http://evil.com/'] = 'hack';
            expect(discovery.getCached()['http://evil.com/']).to.be.undefined;
        });
    });

    describe('scheduleRefresh / cancelRefresh', () => {
        it('schedules a timer', () => {
            discovery.scheduleRefresh(1000);
            expect(adapter._timers.size).to.equal(1);
        });

        it('coalesces multiple schedule calls', () => {
            discovery.scheduleRefresh(1000);
            discovery.scheduleRefresh(1000);
            discovery.scheduleRefresh(1000);
            expect(adapter._timers.size).to.equal(1);
        });

        it('cancelRefresh clears the pending timer', () => {
            discovery.scheduleRefresh(1000);
            discovery.cancelRefresh();
            expect(adapter._timers.size).to.equal(0);
        });

        it('cancelRefresh is a no-op when no timer is pending', () => {
            expect(() => discovery.cancelRefresh()).to.not.throw();
        });
    });
});
