import crypto from 'node:crypto';
import * as utils from '@iobroker/adapter-core';
import { ClientRegistry, parseClientStateId } from './lib/client-registry';
import { MDNSService } from './lib/mdns';
import { UrlDiscovery } from './lib/url-discovery';
import { WebServer } from './lib/webserver';
import type { AdapterConfig } from './lib/types';

class HassEmu extends utils.Adapter {
    private mdnsService: MDNSService | null = null;
    private webServer: WebServer | null = null;
    private registry: ClientRegistry | null = null;
    private urlDiscovery: UrlDiscovery | null = null;

    declare config: AdapterConfig;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hassemu' });

        this.on('ready', () => {
            this.onReady().catch(err => this.log.error(`onReady unhandled: ${String(err)}`));
        });
        this.on('stateChange', (id, state) => {
            this.onStateChange(id, state).catch(err => this.log.error(`stateChange unhandled: ${String(err)}`));
        });
        this.on('objectChange', () => {
            // Foreign object changed — refresh URL dropdown (debounced inside discovery)
            this.urlDiscovery?.scheduleRefresh();
        });
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', { val: false, ack: true });

        await this.migrateConfig();

        if (!this.config.defaultVisUrl) {
            this.log.error('No default redirect URL configured. Set it in the adapter settings.');
        }

        const instanceUuid = crypto.randomUUID();
        this.log.debug(
            `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`,
        );

        if (this.config.defaultVisUrl) {
            this.log.debug(`Default target URL: ${this.config.defaultVisUrl}`);
            if (/\blocalhost\b|127\.0\.0\.1/.test(this.config.defaultVisUrl)) {
                this.log.warn(
                    'defaultVisUrl contains localhost — the display cannot reach this. Use the real IP address.',
                );
            }
        }

        this.registry = new ClientRegistry(this, this.config.defaultVisUrl);
        await this.registry.restore();

        this.urlDiscovery = new UrlDiscovery(this, states => this.registry?.syncUrlDropdown(states));
        await this.urlDiscovery.collect();

        // Watch broker state for new/removed instances and VIS projects
        await this.subscribeForeignObjectsAsync('system.adapter.*');
        await this.subscribeStatesAsync('clients.*');

        try {
            this.webServer = new WebServer(this, this.config, this.registry, instanceUuid);
            await this.webServer.start();
        } catch (err) {
            this.log.error(`Web server failed to start: ${String(err)}`);
            return;
        }

        if (this.config.mdnsEnabled) {
            this.mdnsService = new MDNSService(this, this.config, instanceUuid);
            this.mdnsService.start();
        } else {
            this.log.debug('mDNS disabled — clients must enter the URL manually.');
        }

        await this.setState('info.connection', { val: true, ack: true });
        const bindAddr = this.config.bindAddress || '0.0.0.0';
        this.log.info(
            `HA emulation running on ${bindAddr}:${this.config.port}${this.config.mdnsEnabled ? ', mDNS active' : ''}`,
        );
    }

    /**
     * 1.0.x → 1.1.0 migration — rename `visUrl` to `defaultVisUrl`.
     * Persists to the instance object and saves the adapter from restarting:
     * we only touch the in-memory config, the write happens async.
     */
    private async migrateConfig(): Promise<void> {
        const legacy = this.config as AdapterConfig & { visUrl?: string };
        if (!legacy.visUrl || this.config.defaultVisUrl) {
            return;
        }
        this.log.info('Migrating config: visUrl → defaultVisUrl');
        this.config.defaultVisUrl = legacy.visUrl;
        try {
            const id = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(id);
            if (obj?.native) {
                obj.native.defaultVisUrl = legacy.visUrl;
                delete obj.native.visUrl;
                await this.setForeignObjectAsync(id, obj);
            }
        } catch (err) {
            this.log.warn(`Config migration write failed: ${String(err)}`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !this.registry) {
            return;
        }
        const parsed = parseClientStateId(id, this.namespace);
        if (!parsed) {
            return;
        }
        if (parsed.kind === 'visUrl') {
            await this.registry.handleVisUrlWrite(parsed.id, state.val);
        } else if (parsed.kind === 'remove' && state.val === true) {
            await this.registry.remove(parsed.id);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            this.urlDiscovery?.cancelRefresh();
            this.urlDiscovery = null;

            if (this.mdnsService) {
                this.mdnsService.stop();
                this.mdnsService = null;
            }

            if (this.webServer) {
                this.webServer.stop().catch((err: Error) => this.log.error(`Server stop error: ${err.message}`));
                this.webServer = null;
            }

            this.registry = null;
            void this.setState('info.connection', { val: false, ack: true });
        } catch (error) {
            const err = error as Error;
            this.log.error(`Shutdown error: ${err.message}`);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HassEmu(options);
} else {
    (() => new HassEmu())();
}
