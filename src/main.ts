import crypto from 'node:crypto';
import * as utils from '@iobroker/adapter-core';
import { ClientRegistry, parseClientStateId } from './lib/client-registry';
import { GlobalConfig, parseGlobalStateId } from './lib/global-config';
import { MDNSService } from './lib/mdns';
import { UrlDiscovery } from './lib/url-discovery';
import { WebServer } from './lib/webserver';
import type { AdapterConfig } from './lib/types';

class HassEmu extends utils.Adapter {
    private mdnsService: MDNSService | null = null;
    private webServer: WebServer | null = null;
    private registry: ClientRegistry | null = null;
    private globalConfig: GlobalConfig | null = null;
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

        this.globalConfig = new GlobalConfig(this);
        await this.globalConfig.restore();
        await this.migrateLegacyDefaultVisUrl();

        const instanceUuid = crypto.randomUUID();
        this.log.debug(
            `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`,
        );

        this.registry = new ClientRegistry(this);
        await this.registry.restore();

        this.urlDiscovery = new UrlDiscovery(this, async states => {
            await this.globalConfig?.syncUrlDropdown(states);
            await this.registry?.syncUrlDropdown(states);
        });
        await this.urlDiscovery.collect();

        // Watch broker state for new/removed instances, VIS projects and client/global writes
        await this.subscribeForeignObjectsAsync('system.adapter.*');
        await this.subscribeStatesAsync('clients.*');
        await this.subscribeStatesAsync('global.*');

        try {
            this.webServer = new WebServer(this, this.config, this.registry, this.globalConfig, instanceUuid);
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
     * 1.0.x / 1.1.0 → 1.1.1 migration — move the legacy `defaultVisUrl` from
     * instance native into `global.visUrl` + `global.enabled=true` and drop it
     * from native. Runs once; subsequent starts see empty/missing legacy fields.
     */
    private async migrateLegacyDefaultVisUrl(): Promise<void> {
        const legacy = this.config as AdapterConfig & { defaultVisUrl?: string; visUrl?: string };
        const url = legacy.defaultVisUrl || legacy.visUrl;
        if (!url || !this.globalConfig) {
            return;
        }
        this.log.info('Migrating defaultVisUrl → global.visUrl + global.enabled');
        await this.globalConfig.handleVisUrlWrite(url);
        if (this.globalConfig.getGlobalUrl()) {
            await this.globalConfig.handleEnabledWrite(true);
        }
        try {
            const id = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(id);
            if (obj?.native) {
                delete obj.native.defaultVisUrl;
                delete obj.native.visUrl;
                await this.setForeignObjectAsync(id, obj);
            }
        } catch (err) {
            this.log.warn(`Legacy config cleanup failed: ${String(err)}`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const clientParsed = this.registry ? parseClientStateId(id, this.namespace) : null;
        if (clientParsed) {
            if (clientParsed.kind === 'visUrl') {
                await this.registry!.handleVisUrlWrite(clientParsed.id, state.val);
            } else if (clientParsed.kind === 'remove' && state.val === true) {
                await this.registry!.remove(clientParsed.id);
            }
            return;
        }
        const globalParsed = this.globalConfig ? parseGlobalStateId(id, this.namespace) : null;
        if (globalParsed === 'visUrl') {
            await this.globalConfig!.handleVisUrlWrite(state.val);
        } else if (globalParsed === 'enabled') {
            await this.globalConfig!.handleEnabledWrite(state.val);
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
            this.globalConfig = null;
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
