import os from 'node:os';
import Bonjour, { type Service } from 'bonjour-service';
import { HA_VERSION } from './constants';
import type { AdapterConfig, AdapterInterface } from './types';

/** mDNS service for Home Assistant discovery via bonjour-service */
export class MDNSService {
    private readonly adapter: AdapterInterface;
    private readonly config: AdapterConfig;
    public readonly uuid: string;
    public active = false;
    private bonjour: Bonjour | null = null;
    private published: Service | null = null;

    /**
     * Creates a new MDNSService instance
     *
     * @param adapter - Adapter interface for logging
     * @param config - Adapter configuration
     * @param uuid - Shared UUID for consistent identity across WebServer and mDNS
     */
    constructor(adapter: AdapterInterface, config: AdapterConfig, uuid: string) {
        this.adapter = adapter;
        this.config = config;
        this.uuid = uuid;
    }

    /** First non-internal IPv4 address */
    getLocalIP(): string {
        const interfaces = os.networkInterfaces();
        for (const ifaces of Object.values(interfaces)) {
            if (!ifaces) {
                continue;
            }
            for (const iface of ifaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return '127.0.0.1';
    }

    /** Start mDNS broadcasting via bonjour-service */
    start(): void {
        const localIP = this.getLocalIP();
        const baseUrl = `http://${localIP}:${this.config.port}`;
        const serviceName = this.config.serviceName || 'ioBroker';

        try {
            this.bonjour = new Bonjour();

            this.published = this.bonjour.publish({
                name: serviceName,
                type: 'home-assistant',
                protocol: 'tcp',
                port: this.config.port,
                txt: {
                    base_url: baseUrl,
                    internal_url: baseUrl,
                    external_url: '',
                    version: HA_VERSION,
                    uuid: this.uuid,
                    location_name: serviceName,
                    requires_api_password: 'True',
                },
            });

            this.active = true;

            this.adapter.log.debug(
                `mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local on ${localIP}:${this.config.port}`,
            );
            this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
        } catch (error) {
            const err = error as Error;
            this.adapter.log.warn(`mDNS: Failed to start: ${err.message}`);
        }
    }

    /** Stop mDNS broadcasting */
    stop(): void {
        if (!this.active) {
            return;
        }

        try {
            if (this.published) {
                this.published.stop?.();
                this.published = null;
            }
            if (this.bonjour) {
                this.bonjour.destroy();
                this.bonjour = null;
            }
            this.adapter.log.debug('mDNS: Service stopped');
        } catch (error) {
            const err = error as Error;
            this.adapter.log.warn(`mDNS: Could not stop cleanly: ${err.message}`);
        }

        this.active = false;
    }
}
