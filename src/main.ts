import crypto from 'node:crypto';
import * as utils from '@iobroker/adapter-core';
import { ClientRegistry, parseClientStateId } from './lib/client-registry';
import { coerceSafeUrl } from './lib/coerce';
import { GlobalConfig, MODE_GLOBAL, MODE_MANUAL, parseGlobalStateId } from './lib/global-config';
import { MDNSService } from './lib/mdns';
import { UrlDiscovery } from './lib/url-discovery';
import { WebServer } from './lib/webserver';
import type { AdapterConfig } from './lib/types';

/** Stale-Client-GC threshold: clients without token + lastSeen older are auto-removed. */
const STALE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class HassEmu extends utils.Adapter {
    private mdnsService: MDNSService | null = null;
    private webServer: WebServer | null = null;
    private registry: ClientRegistry | null = null;
    private globalConfig: GlobalConfig | null = null;
    private urlDiscovery: UrlDiscovery | null = null;
    private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;
    private uncaughtExceptionHandler: ((err: Error) => void) | null = null;

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

        // Last-line-of-defence against unhandled rejections / sync throws from
        // fire-and-forget paths. The per-handler wrappers cover documented async
        // paths; this catches anything that slips past during refactors.
        this.unhandledRejectionHandler = (reason: unknown) => {
            this.log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
        };
        this.uncaughtExceptionHandler = (err: Error) => {
            this.log.error(`Uncaught exception: ${err.message}`);
        };
        process.on('unhandledRejection', this.unhandledRejectionHandler);
        process.on('uncaughtException', this.uncaughtExceptionHandler);
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', { val: false, ack: true });

        this.globalConfig = new GlobalConfig(this);
        await this.globalConfig.restore();

        this.registry = new ClientRegistry(this);
        await this.registry.restore();

        // Migrations run before subscriptions / webserver — first the legacy
        // 1.0.x-style native config, then the visUrl → mode/manualUrl move,
        // then a defensive schema repair for users upgrading from v1.2.0+
        // (where the partial-formed mode-object from the v1.2.0 extend-bug
        // persists since `legacy.visUrl` is already gone and migrate doesn't trigger).
        await this.migrateLegacyDefaultVisUrl();
        await this.migrateVisUrlToMode();
        await this.repairGlobalSchemas();

        // Garbage-collect stale clients (no token + lastSeen older than 30 days).
        await this.gcStaleClients();

        const instanceUuid = crypto.randomUUID();
        this.log.debug(
            `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`,
        );

        this.urlDiscovery = new UrlDiscovery(this, async states => {
            await this.globalConfig?.syncUrlDropdown(states);
            await this.registry?.syncUrlDropdown(states);
        });
        await this.urlDiscovery.collect();

        // After discovery: wire the default-mode provider for new clients.
        // - global.enabled=true → new clients default to 'global' (follow master)
        // - global.enabled=false → first discovered URL, fallback 'manual'
        this.registry.setNewClientModeProvider(() => this.computeNewClientMode());

        // Watch broker state for new/removed instances, VIS projects and client/global writes
        await this.subscribeForeignObjectsAsync('system.adapter.*');
        await this.subscribeStatesAsync('clients.*');
        await this.subscribeStatesAsync('global.*');
        await this.subscribeStatesAsync('info.refresh_urls');

        const systemLanguage = await this.readSystemLanguage();

        try {
            this.webServer = new WebServer(
                this,
                this.config,
                this.registry,
                this.globalConfig,
                instanceUuid,
                systemLanguage,
            );
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
     * Default mode for newly registered clients. Respects the master switch:
     * - `global.enabled=true`  → `'global'` (follow master)
     * - `global.enabled=false` → first discovered URL, fallback `'manual'`
     */
    private computeNewClientMode(): string {
        if (this.globalConfig?.isEnabled()) {
            return MODE_GLOBAL;
        }
        const first = this.urlDiscovery?.getFirstDiscoveredUrl();
        return first ?? MODE_MANUAL;
    }

    /**
     * Read the ioBroker system language (set in Admin → Main Settings).
     * Used for the landing page so the end-user sees the same language as
     * their admin UI. Falls back to `en` when `system.config` can't be read
     * or holds a language we don't translate. Read once on startup — a
     * language switch at runtime only takes effect after an adapter restart,
     * which is fine for a setup-hint page that most users see once.
     */
    private async readSystemLanguage(): Promise<string> {
        try {
            const cfg = await this.getForeignObjectAsync('system.config');
            const lang = (cfg?.common as { language?: string } | undefined)?.language;
            return typeof lang === 'string' && lang.length > 0 ? lang : 'en';
        } catch {
            return 'en';
        }
    }

    /**
     * 1.0.x / 1.1.0 → 1.1.1 migration — move the legacy `defaultVisUrl` from
     * instance native into `global.visUrl` + `global.enabled=true` and drop it
     * from native. Subsequent migrations (`migrateVisUrlToMode`) then move
     * `global.visUrl` into the mode/manualUrl model.
     */
    private async migrateLegacyDefaultVisUrl(): Promise<void> {
        const legacy = this.config as AdapterConfig & { defaultVisUrl?: string; visUrl?: string };
        const url = legacy.defaultVisUrl || legacy.visUrl;
        if (!url) {
            return;
        }
        // Defensive: validiere die legacy-URL bevor wir sie nach `global.visUrl`
        // schreiben. Malicious-Werte (`javascript:`, `data:`) sollen nicht durch
        // die Migration durchrutschen — `migrateVisUrlToMode` validiert zwar
        // nochmal, aber zwischen den Migrations-Schritten würde unsafe-Wert
        // sichtbar sein, und die native-Cleanup ist unbedingt.
        const safe = coerceSafeUrl(url);
        if (!safe) {
            this.log.warn(
                `Legacy URL rejected as unsafe — dropping native.defaultVisUrl/visUrl without migration: ${String(url)}`,
            );
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
            return;
        }

        this.log.info('Migrating legacy native.defaultVisUrl/visUrl → global.visUrl');
        // We cannot call globalConfig.handleVisUrlWrite — that method is gone in
        // v1.2.0. Write the legacy state directly so migrateVisUrlToMode picks it up.
        // Wichtig: wenn der State-Write FEHLSCHLÄGT (z.B. weil global.visUrl-Object
        // in v1.2.0+ schon weg ist), dürfen wir die native-Werte NICHT löschen —
        // sonst ist die User-URL silent verloren. Stattdessen direkt nach
        // global.mode/manualUrl schreiben (das Ziel wo migrateVisUrlToMode
        // sie sonst hingeschrieben hätte).
        let stateWritten = false;
        try {
            await this.setStateAsync('global.visUrl', { val: safe, ack: true });
            stateWritten = true;
        } catch {
            // global.visUrl-Object existiert nicht mehr → direkt ins Ziel schreiben
            try {
                if (this.globalConfig) {
                    await this.globalConfig.migrationSet(MODE_MANUAL, safe);
                    this.log.info(
                        `Migration shortcut: global.visUrl-state missing → wrote directly to global.mode='manual', manualUrl='${safe}'`,
                    );
                    stateWritten = true;
                }
            } catch (err) {
                this.log.warn(`Legacy URL migration failed at fallback: ${String(err)}`);
            }
        }

        if (!stateWritten) {
            // Both paths failed — keep native values as a recovery anchor for
            // the user. Don't clean up.
            this.log.warn('Legacy URL preserved in native — neither global.visUrl nor global.mode write succeeded');
            return;
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

    /**
     * 1.x → 1.2.0 migration — move legacy per-client `visUrl`-states to the
     * `mode`/`manualUrl` model, plus the global `visUrl` to `global.mode` +
     * `global.manualUrl`. Old datapoints are removed, type of mode-states
     * upgraded to 'mixed'. Idempotent — does nothing on subsequent starts.
     */
    private async migrateVisUrlToMode(): Promise<void> {
        // 1) Global visUrl → mode + manualUrl
        try {
            const legacyGlobal = await this.getStateAsync('global.visUrl');
            if (
                legacyGlobal &&
                legacyGlobal.val !== undefined &&
                legacyGlobal.val !== null &&
                legacyGlobal.val !== ''
            ) {
                const safe = coerceSafeUrl(legacyGlobal.val);
                if (safe) {
                    await this.globalConfig!.migrationSet(MODE_MANUAL, safe);
                    this.log.info(`Migration: global.visUrl → mode='manual', manualUrl='${safe}'`);
                } else {
                    await this.globalConfig!.migrationSet(MODE_MANUAL, null);
                    this.log.warn(`Migration: legacy global.visUrl rejected as unsafe — set global.manualUrl manually`);
                }
            }
        } catch {
            /* state didn't exist — fresh install or already migrated */
        }
        try {
            await this.delObjectAsync('global.visUrl');
        } catch {
            /* didn't exist */
        }

        // 2) Per-client visUrl → mode='manual' + manualUrl
        const records = this.registry?.listAll() ?? [];
        for (const record of records) {
            try {
                const legacy = await this.getStateAsync(`clients.${record.id}.visUrl`);
                if (legacy && legacy.val !== undefined && legacy.val !== null && legacy.val !== '') {
                    const safe = coerceSafeUrl(legacy.val);
                    if (safe) {
                        record.mode = MODE_MANUAL;
                        record.manualUrl = safe;
                        await this.setStateAsync(`clients.${record.id}.mode`, { val: MODE_MANUAL, ack: true });
                        await this.setStateAsync(`clients.${record.id}.manualUrl`, { val: safe, ack: true });
                        this.log.info(
                            `Migration: client ${record.id} visUrl='${safe}' → mode='manual', manualUrl='${safe}'`,
                        );
                    } else {
                        this.log.warn(
                            `Migration: client ${record.id} legacy visUrl rejected as unsafe — set clients.${record.id}.manualUrl manually`,
                        );
                    }
                }
            } catch {
                /* state didn't exist for this client */
            }
            try {
                await this.delObjectAsync(`clients.${record.id}.visUrl`);
            } catch {
                /* didn't exist */
            }
        }

        // 3) global.mode + global.manualUrl repair handled by repairGlobalSchemas()
        // (called separately in onReady so it ALSO runs for users upgrading from
        // v1.2.0/v1.3.0/v1.3.1 where the legacy visUrl is already gone but the
        // partial-formed mode-object from the v1.2.0 extendObject-bug persists).
    }

    /**
     * Repairs partial-formed `global.mode` / `global.manualUrl` objects from
     * the v1.2.0 migration bug (extendObjectAsync was called with only
     * `common.type:'mixed'` — leaving the object without top-level `type`,
     * name, role, read, write, def). `extendObjectAsync` here merges the full
     * instanceObjects schema onto the existing partial object so js-controller
     * stops warning "obj.type has to exist" and the dropdown renders correctly.
     *
     * Idempotent — extending an already-complete object is a no-op write.
     */
    private async repairGlobalSchemas(): Promise<void> {
        try {
            await this.extendObjectAsync('global.mode', {
                type: 'state',
                common: {
                    name: 'Global redirect mode',
                    type: 'mixed',
                    role: 'value',
                    read: true,
                    write: true,
                    def: 0,
                },
                native: {},
            });
        } catch (err) {
            this.log.debug(`repair global.mode failed: ${String(err)}`);
        }
        try {
            await this.extendObjectAsync('global.manualUrl', {
                type: 'state',
                common: {
                    name: "Global manual URL (used when mode='manual')",
                    type: 'string',
                    role: 'url',
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });
        } catch (err) {
            this.log.debug(`repair global.manualUrl failed: ${String(err)}`);
        }
    }

    /**
     * Removes clients that are clearly stale: no auth token (= never authenticated
     * or revoked) AND `native.lastSeen` older than {@link STALE_CLIENT_TTL_MS}.
     * Clients without `lastSeen` (pre-1.2.0) get the timestamp seeded on this run
     * — GC kicks in only on subsequent restarts.
     */
    private async gcStaleClients(): Promise<void> {
        const now = Date.now();
        const records = this.registry?.listAll() ?? [];
        let removed = 0;
        for (const record of records) {
            if (record.token) {
                continue;
            }
            try {
                const obj = await this.getObjectAsync(`clients.${record.id}`);
                const native = (obj?.native as { lastSeen?: number } | undefined) ?? {};
                const lastSeen = typeof native.lastSeen === 'number' ? native.lastSeen : 0;
                if (lastSeen === 0) {
                    // Pre-v1.2.0 client — seed timestamp, GC waits one cycle.
                    await this.extendObjectAsync(`clients.${record.id}`, { native: { lastSeen: now } });
                    continue;
                }
                if (now - lastSeen > STALE_CLIENT_TTL_MS) {
                    await this.registry!.remove(record.id);
                    removed++;
                }
            } catch (err) {
                this.log.debug(`Stale-GC: failed for ${record.id}: ${String(err)}`);
            }
        }
        if (removed > 0) {
            this.log.info(`Stale-Client-GC: removed ${removed} client(s) (no token + idle >30 days)`);
        }
    }

    /**
     * Master-switch action: when `global.enabled` flips, propagate to every
     * client's `mode`. true → all clients follow `'global'`. false → fall back
     * to the first discovered URL, or `'manual'` if discovery is empty.
     *
     * @param enabled New value of `global.enabled`.
     */
    private async applyMasterSwitch(enabled: boolean): Promise<void> {
        if (!this.registry) {
            return;
        }
        if (enabled) {
            await this.registry.bulkSetMode(MODE_GLOBAL);
            return;
        }
        const first = this.urlDiscovery?.getFirstDiscoveredUrl();
        if (first) {
            await this.registry.bulkSetMode(first);
        } else {
            await this.registry.bulkSetMode(MODE_MANUAL);
            this.log.warn(
                "global.enabled=false but no discovered VIS URL — clients set to 'manual'; " +
                    'fill clients.<id>.manualUrl per client',
            );
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const clientParsed = this.registry ? parseClientStateId(id, this.namespace) : null;
        if (clientParsed) {
            if (clientParsed.kind === 'mode') {
                await this.registry!.handleModeWrite(clientParsed.id, state.val);
                // B4: if the user picked 'global' but global resolves to nothing,
                // give them a one-shot heads-up so the cause of the empty redirect
                // is obvious without digging through the resolver code.
                const record = this.registry!.getById(clientParsed.id);
                if (record?.mode === MODE_GLOBAL && this.globalConfig!.resolveUrlFor(record) === null) {
                    this.log.warn(
                        `Client ${record.id}: mode='global' but global has no resolvable URL — ` +
                            'fill global.mode/manualUrl, or pick a different client mode',
                    );
                }
            } else if (clientParsed.kind === 'manualUrl') {
                await this.registry!.handleManualUrlWrite(clientParsed.id, state.val);
            } else if (clientParsed.kind === 'remove' && state.val === true) {
                await this.registry!.remove(clientParsed.id);
            }
            return;
        }
        const globalParsed = this.globalConfig ? parseGlobalStateId(id, this.namespace) : null;
        if (globalParsed === 'mode') {
            await this.globalConfig!.handleModeWrite(state.val);
        } else if (globalParsed === 'manualUrl') {
            await this.globalConfig!.handleManualUrlWrite(state.val);
        } else if (globalParsed === 'enabled') {
            await this.globalConfig!.handleEnabledWrite(state.val);
            await this.applyMasterSwitch(this.globalConfig!.isEnabled());
            return;
        }

        // info.refresh_urls — User-Trigger für manuelles Dropdown-Refresh ohne
        // Adapter-Neustart. Re-scan'd den Broker nach VIS/VIS-2-Projekten und
        // Admin-Tiles, schreibt die neuen states-Maps in alle Mode-Dropdowns.
        if (id === `${this.namespace}.info.refresh_urls` && state.val === true) {
            await this.handleRefreshUrlsWrite();
        }
    }

    /**
     * Handler for the `info.refresh_urls` button.
     * Triggert eine sofortige `urlDiscovery.collect()` (statt Debounce-Schedule),
     * damit der User nicht 2s warten muss. Schreibt anschließend `false ack` damit
     * der Button in der Admin-UI wieder „klickbar" wird.
     */
    private async handleRefreshUrlsWrite(): Promise<void> {
        if (!this.urlDiscovery) {
            return;
        }
        try {
            await this.urlDiscovery.collect();
            this.log.info('URL discovery refreshed on user request');
        } catch (err) {
            this.log.warn(`URL refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            await this.setStateAsync('info.refresh_urls', { val: false, ack: true }).catch(() => {});
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

            // Detach process-level last-line-of-defence handlers
            if (this.unhandledRejectionHandler) {
                process.off('unhandledRejection', this.unhandledRejectionHandler);
                this.unhandledRejectionHandler = null;
            }
            if (this.uncaughtExceptionHandler) {
                process.off('uncaughtException', this.uncaughtExceptionHandler);
                this.uncaughtExceptionHandler = null;
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
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HassEmu(options);
} else {
    (() => new HassEmu())();
}
