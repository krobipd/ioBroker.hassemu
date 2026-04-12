import crypto from 'node:crypto';
import * as utils from '@iobroker/adapter-core';
import { MDNSService } from './lib/mdns';
import { WebServer } from './lib/webserver';
import type { AdapterConfig } from './lib/types';

class HassEmu extends utils.Adapter {
    private mdnsService: MDNSService | null = null;
    private webServer: WebServer | null = null;

    declare config: AdapterConfig;

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

            if (!this.config.visUrl) {
                this.log.error('No redirect URL configured! Please configure a URL in the adapter settings.');
            }

            const instanceUuid = crypto.randomUUID();

            this.log.debug(
                `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`,
            );

            if (this.config.visUrl) {
                this.log.debug(`Target URL: ${this.config.visUrl}`);

                if (/\blocalhost\b|127\.0\.0\.1/.test(this.config.visUrl)) {
                    this.log.warn(
                        'visUrl contains localhost — the display cannot reach this! Use the real IP address.',
                    );
                }
            }

            this.webServer = new WebServer(this, this.config, instanceUuid);
            await this.webServer.start();

            if (this.config.mdnsEnabled) {
                this.mdnsService = new MDNSService(this, this.config, instanceUuid);
                this.mdnsService.start();
            } else {
                this.log.debug('mDNS disabled — enter URL manually on the display');
            }

            await this.setStateAsync('info.connection', true, true);
            const bindAddr = this.config.bindAddress || '0.0.0.0';
            this.log.info(
                `HA emulation running on ${bindAddr}:${this.config.port}${this.config.mdnsEnabled ? ', mDNS active' : ''}`,
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
