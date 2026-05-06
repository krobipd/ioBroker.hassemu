import { expect } from 'chai';
import crypto from 'node:crypto';
import { MDNSService } from './mdns';
import type { AdapterConfig } from './types';

interface LogEntry {
    level: string;
    msg: string;
}

interface MockAdapter {
    log: {
        debug: (msg: string) => void;
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    _logs: LogEntry[];
}

// Mock adapter for testing
function createMockAdapter(): MockAdapter {
    const logs: LogEntry[] = [];
    return {
        log: {
            debug: (msg: string): void => {
                logs.push({ level: 'debug', msg });
            },
            info: (msg: string): void => {
                logs.push({ level: 'info', msg });
            },
            warn: (msg: string): void => {
                logs.push({ level: 'warn', msg });
            },
            error: (msg: string): void => {
                logs.push({ level: 'error', msg });
            },
        },
        _logs: logs,
    };
}

describe('MDNSService', () => {
    let service: MDNSService;
    let adapter: MockAdapter;
    const config: AdapterConfig = {
        port: 8123,
        bindAddress: '0.0.0.0',
        authRequired: false,
        username: 'admin',
        password: 'secret',
        mdnsEnabled: true,
        serviceName: 'TestService',
    };

    beforeEach(() => {
        adapter = createMockAdapter();
        service = new MDNSService(adapter as never, config, crypto.randomUUID());
    });

    afterEach(() => {
        service.stop();
    });

    describe('constructor', () => {
        it('should use the provided UUID', () => {
            expect(service.uuid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        });

        it('should not be active initially', () => {
            expect(service.isActive()).to.be.false;
        });

        it('should use different UUIDs when different UUIDs are provided', () => {
            const service2 = new MDNSService(adapter as never, config, crypto.randomUUID());
            expect(service.uuid).to.not.equal(service2.uuid);
        });
    });

    describe('getLocalIP', () => {
        it('should return an IP address string', () => {
            const ip = service.getLocalIP();
            expect(ip).to.be.a('string');
            // Should be either a valid IPv4 or fallback 127.0.0.1
            expect(ip).to.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        });
    });

    describe('start/stop lifecycle', () => {
        it('should not throw on start', () => {
            expect(() => service.start()).to.not.throw();
        });

        it('should be active after start', () => {
            service.start();
            expect(service.isActive()).to.be.true;
        });

        it('should log debug on start', () => {
            service.start();
            const debugLogs = adapter._logs.filter(l => l.level === 'debug');
            const broadcastLog = debugLogs.find(l => l.msg.includes('mDNS: Broadcasting'));
            expect(broadcastLog).to.not.be.undefined;
            expect(broadcastLog!.msg).to.include('TestService');
        });

        it('should include port in start log', () => {
            service.start();
            const debugLogs = adapter._logs.filter(l => l.level === 'debug');
            const broadcastLog = debugLogs.find(l => l.msg.includes('mDNS: Broadcasting'));
            expect(broadcastLog!.msg).to.include('8123');
        });

        it('should not be active after stop', () => {
            service.start();
            expect(service.isActive()).to.be.true;
            service.stop();
            expect(service.isActive()).to.be.false;
        });

        it('should handle stop when not active', () => {
            expect(service.isActive()).to.be.false;
            expect(() => service.stop()).to.not.throw();
        });

        it('should handle multiple stop calls', () => {
            service.start();
            service.stop();
            expect(() => service.stop()).to.not.throw();
        });

        it('should handle start-stop-start cycle', () => {
            service.start();
            expect(service.isActive()).to.be.true;
            service.stop();
            expect(service.isActive()).to.be.false;
            service.start();
            expect(service.isActive()).to.be.true;
        });
    });

    describe('service name', () => {
        it('should use configured service name', () => {
            service.start();
            const debugLogs = adapter._logs.filter(l => l.level === 'debug');
            const broadcastLog = debugLogs.find(l => l.msg.includes('mDNS: Broadcasting'));
            expect(broadcastLog!.msg).to.include('TestService._home-assistant._tcp');
        });

        it('should use ioBroker as default service name', () => {
            const defaultConfig: AdapterConfig = {
                ...config,
                serviceName: '',
            };
            const defaultService = new MDNSService(adapter as never, defaultConfig, crypto.randomUUID());
            defaultService.start();
            const debugLogs = adapter._logs.filter(l => l.level === 'debug');
            const broadcastLog = debugLogs.find(l => l.msg.includes('mDNS: Broadcasting'));
            expect(broadcastLog!.msg).to.include('ioBroker._home-assistant._tcp');
            defaultService.stop();
        });
    });
});

describe('MDNSService cross-platform', () => {
    it('should work without avahi (cross-platform)', () => {
        // bonjour-service works on all platforms — no avahi needed
        const adapter = createMockAdapter();
        const service = new MDNSService(
            adapter as never,
            {
                port: 8123,
                bindAddress: '0.0.0.0',
                authRequired: false,
                username: '',
                password: '',
                mdnsEnabled: true,
                serviceName: 'CrossPlatformTest',
            },
            crypto.randomUUID(),
        );

        service.start();
        expect(service.isActive()).to.be.true;

        // No error logs — bonjour-service works everywhere
        const errorLogs = adapter._logs.filter(l => l.level === 'error');
        expect(errorLogs.length).to.equal(0);

        service.stop();
        expect(service.isActive()).to.be.false;
    });

    describe('async error handling (J6 v1.25.0 — D12 v1.15.0 coverage)', () => {
        it('async publish error sets active=false and warns', () => {
            const localAdapter = createMockAdapter();
            const localService = new MDNSService(
                localAdapter as never,
                {
                    port: 8123,
                    bindAddress: '0.0.0.0',
                    authRequired: false,
                    username: '',
                    password: '',
                    mdnsEnabled: true,
                    serviceName: 'AsyncErrorTest',
                },
                crypto.randomUUID(),
            );

            localService.start();
            expect(localService.isActive()).to.be.true;

            // Fire async 'error' event auf das publish'd service-objekt — bonjour-
            // service's Service extends EventEmitter, so .emit() ist available.
            const internal = localService as unknown as {
                published: { emit?: (event: string, err: Error) => void } | null;
            };
            internal.published?.emit?.('error', new Error('mock dgram bind failure'));

            expect(localService.isActive()).to.be.false;
            const warns = localAdapter._logs.filter(
                l => l.level === 'warn' && l.msg.includes('async publish error'),
            );
            expect(warns).to.have.length(1);
            expect(warns[0].msg).to.include('mock dgram bind failure');

            localService.stop();
        });
    });
});
