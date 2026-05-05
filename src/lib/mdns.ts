import Bonjour, { type Service } from 'bonjour-service';
import { HA_VERSION } from './constants';
import { getLocalIp } from './network';
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

    /** First non-internal IPv4 address (wraps shared helper for backwards-compat). */
    getLocalIP(): string {
        return getLocalIp();
    }

    /** Start mDNS broadcasting via bonjour-service */
    start(): void {
        const localIP = getLocalIp();
        const baseUrl = `http://${localIP}:${this.config.port}`;
        const serviceName = this.config.serviceName || 'ioBroker';

        try {
            this.bonjour = new Bonjour();

            // Empty TXT records are dropped — bonjour-service publishes them as
            // empty strings otherwise, which clutters the discovery payload.
            const txt: Record<string, string> = {
                base_url: baseUrl,
                internal_url: baseUrl,
                version: HA_VERSION,
                uuid: this.uuid,
                location_name: serviceName,
                requires_api_password: 'True',
            };

            this.published = this.bonjour.publish({
                name: serviceName,
                type: 'home-assistant',
                protocol: 'tcp',
                port: this.config.port,
                txt,
            });

            this.active = true;

            this.adapter.log.debug(
                `mDNS: Broadcasting ${serviceName}._home-assistant._tcp.local on ${localIP}:${this.config.port}`,
            );
            this.adapter.log.debug(`mDNS: UUID: ${this.uuid}`);
        } catch (error) {
            const err = error as Error;
            this.adapter.log.warn(`mDNS: Failed to start: ${err.message}`);
            // Wichtig: bonjour-instance freigeben sonst leakt der UDP-Socket
            // über die Adapter-Lifetime. `stop()` short-circuit'd auf
            // `!this.active` und würde nichts cleanen.
            try {
                this.bonjour?.destroy();
            } catch {
                /* destroy darf re-throwen — wir wollen nur die Resource lossen */
            }
            this.bonjour = null;
            this.published = null;
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
