import crypto from 'node:crypto';
import * as utils from '@iobroker/adapter-core';
import { MDNSService } from './lib/mdns';
import { WebServer } from './lib/webserver';
import type { AdapterConfig } from './lib/types';

/** Native adapter configuration from io-package.json */
interface NativeConfig {
    port: number;
    bindAddress: string;
    visUrl: string;
    authRequired: boolean;
    username: string;
    password: string;
    mdnsEnabled: boolean;
    serviceName: string;
}

class HassEmu extends utils.Adapter {
    private mdnsService: MDNSService | null = null;
    private webServer: WebServer | null = null;

    declare config: NativeConfig;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'hassemu',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        try {
            await this.setStateAsync('info.connection', false, true);

            // Validate configuration
            if (!this.config.visUrl) {
                this.log.error('No redirect URL configured! Please configure a URL in the adapter settings.');
            }

            const config: AdapterConfig = {
                port: this.config.port || 8123,
                bindAddress: this.config.bindAddress || '0.0.0.0',
                visUrl: this.config.visUrl || '',
                authRequired: this.config.authRequired === true,
                username: this.config.username || 'admin',
                password: this.config.password || '',
                mdnsEnabled: this.config.mdnsEnabled !== false,
                serviceName: this.config.serviceName || 'ioBroker',
            };

            // Single UUID shared between WebServer and mDNS for consistency
            const instanceUuid = crypto.randomUUID();

            this.log.debug(`Config: port=${config.port}, auth=${config.authRequired}, mdns=${config.mdnsEnabled}`);

            if (config.visUrl) {
                this.log.debug(`Target URL: ${config.visUrl}`);

                if (/\blocalhost\b|127\.0\.0\.1/.test(config.visUrl)) {
                    this.log.warn(
                        'visUrl contains localhost — the display cannot reach this! Use the real IP address.',
                    );
                }
            }

            this.webServer = new WebServer(this, config, instanceUuid);
            await this.webServer.start();

            if (config.mdnsEnabled) {
                this.mdnsService = new MDNSService(this, config, instanceUuid);
                this.mdnsService.start();
            } else {
                this.log.debug('mDNS disabled — enter URL manually on the display');
            }

            await this.setStateAsync('info.connection', true, true);
            const bindAddr = config.bindAddress || '0.0.0.0';
            this.log.info(
                `HA emulation running on ${bindAddr}:${config.port}${config.mdnsEnabled ? ', mDNS active' : ''}`,
            );
        } catch (error) {
            const err = error as Error;
            this.log.error(`Failed to start: ${err.message}`);
            if (err.stack) {
                this.log.debug(err.stack);
            }
        }
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.mdnsService) {
                this.mdnsService.stop();
                this.mdnsService = null;
            }

            if (this.webServer) {
                this.webServer.stop().catch((err: Error) => this.log.error(`Server stop error: ${err.message}`));
                this.webServer = null;
            }

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
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HassEmu(options);
} else {
    // Otherwise start the instance directly
    (() => new HassEmu())();
}
