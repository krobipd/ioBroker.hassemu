/**
 * Client Registry — persistent multi-client store.
 *
 * Each client gets a channel `clients.<id>` with native.cookie / native.token
 * and states visUrl / ip / hostname / remove. Cookie is the primary identity
 * (auto-sent by browsers on page navigation), IP is only advisory.
 *
 * Registry state is dual-homed: in-memory maps for hot lookups, ioBroker
 * objects for persistence and user-visible config.
 */

import crypto from 'node:crypto';
import { coerceString, coerceUuid, coerceSafeUrl, isPlainObject } from './coerce';
import { generateClientId } from './network';
import type { AdapterInterface, ClientRecord, UrlStates } from './types';

/** Extended adapter interface for registry — needs object and state operations. */
export type RegistryAdapter = AdapterInterface &
    Pick<
        ioBroker.Adapter,
        | 'namespace'
        | 'getForeignObjectsAsync'
        | 'getStateAsync'
        | 'setObjectNotExistsAsync'
        | 'extendObjectAsync'
        | 'setStateAsync'
        | 'delObjectAsync'
    >;

const CLIENTS_PREFIX = 'clients.';

/** Persistent multi-client store: cookie → channel, with in-memory lookup maps. */
export class ClientRegistry {
    private readonly adapter: RegistryAdapter;
    private readonly byCookie = new Map<string, ClientRecord>();
    private readonly byId = new Map<string, ClientRecord>();
    private readonly byToken = new Map<string, ClientRecord>();
    private currentUrlStates: UrlStates = {};
    /**
     * In-flight client creations keyed by remote IP. Keeps parallel cookieless
     * requests from the same display (typical on first connect: HA clients fire
     * `GET /`, `GET /api/`, `POST /auth/login_flow` almost simultaneously) from
     * each creating a separate client record. The first request starts the
     * create; parallel requests await the same Promise and receive the same
     * client + cookie.
     */
    private readonly pendingByIp = new Map<string, Promise<ClientRecord>>();

    /** @param adapter Adapter instance used for object/state I/O. */
    constructor(adapter: RegistryAdapter) {
        this.adapter = adapter;
    }

    /** Loads existing clients from ioBroker objects into memory. Call once on adapter start. */
    async restore(): Promise<void> {
        let channels: Record<string, ioBroker.ChannelObject> = {};
        try {
            channels =
                (await this.adapter.getForeignObjectsAsync(`${this.adapter.namespace}.clients.*`, 'channel')) ?? {};
        } catch (err) {
            this.adapter.log.debug(`client-registry: restore failed: ${String(err)}`);
            return;
        }

        for (const [fullId, obj] of Object.entries(channels)) {
            const id = fullId.substring(`${this.adapter.namespace}.clients.`.length);
            if (!id || id.includes('.')) {
                continue;
            }
            const native = isPlainObject(obj.native) ? obj.native : {};
            const cookie = coerceUuid(native.cookie);
            if (!cookie) {
                continue;
            }
            const visUrl = coerceSafeUrl(await this.readState(`${id}.visUrl`));
            const ip = coerceString(await this.readState(`${id}.ip`));
            const token = coerceUuid(native.token);

            // Legacy migration (<=1.1.1): hostname lived in its own state. If present,
            // move the value into common.name and drop the state.
            const legacyHostname = coerceString(await this.readState(`${id}.hostname`));
            let channelName = coerceString(obj.common?.name);
            if (legacyHostname) {
                if (legacyHostname !== channelName) {
                    await this.adapter.extendObjectAsync(`clients.${id}`, { common: { name: legacyHostname } });
                    channelName = legacyHostname;
                }
                try {
                    await this.adapter.delObjectAsync(`clients.${id}.hostname`);
                } catch {
                    /* best effort — ignore */
                }
            }
            const hostname = channelName && channelName !== ip && channelName !== id ? channelName : null;

            const record: ClientRecord = { id, cookie, token, visUrl, ip, hostname };
            this.trackInMemory(record);
        }
        this.adapter.log.debug(`client-registry: restored ${this.byId.size} client(s)`);
    }

    /**
     * Find the client for this cookie or create a new one.
     * Creates channel + states on first call and updates IP/hostname if changed.
     *
     * @param cookie   Incoming cookie value (may be null/invalid).
     * @param ip       Remote IP observed by the server.
     * @param hostname Optional hostname (from reverse DNS), stored for the admin UI.
     */
    async identifyOrCreate(cookie: string | null, ip: string | null, hostname: string | null): Promise<ClientRecord> {
        const validCookie = coerceUuid(cookie);
        if (validCookie) {
            const existing = this.byCookie.get(validCookie);
            if (existing) {
                await this.updateIpHostname(existing, ip, hostname);
                return existing;
            }
        }
        // No valid cookie: before spinning up a new client, check whether this
        // IP already has a create in flight. If so, await that Promise — the
        // parallel request of the same display's initial burst will get the
        // same cookie + client, no more duplicate "New client" log entries.
        if (ip) {
            const pending = this.pendingByIp.get(ip);
            if (pending) {
                return pending;
            }
            const promise = this.createClient(ip, hostname);
            this.pendingByIp.set(ip, promise);
            try {
                return await promise;
            } finally {
                this.pendingByIp.delete(ip);
            }
        }
        return this.createClient(ip, hostname);
    }

    /**
     * Lookup by short client id (channel segment).
     *
     * @param id Client id.
     */
    getById(id: string): ClientRecord | null {
        return this.byId.get(id) ?? null;
    }

    /**
     * Lookup by cookie value. Invalid UUIDs return null.
     *
     * @param cookie Raw cookie string.
     */
    getByCookie(cookie: string): ClientRecord | null {
        const v = coerceUuid(cookie);
        return v ? (this.byCookie.get(v) ?? null) : null;
    }

    /**
     * Lookup by access token issued during the auth flow.
     *
     * @param token Bearer token.
     */
    getByToken(token: string): ClientRecord | null {
        return this.byToken.get(token) ?? null;
    }

    /** Returns a snapshot array of all registered clients. */
    listAll(): ClientRecord[] {
        return [...this.byId.values()];
    }

    /**
     * Updates in-memory token and persists to channel.native. Old token is freed.
     *
     * @param id    Client id.
     * @param token New bearer token, or null to clear.
     */
    async setToken(id: string, token: string | null): Promise<void> {
        const record = this.byId.get(id);
        if (!record) {
            return;
        }
        if (record.token) {
            this.byToken.delete(record.token);
        }
        record.token = token;
        if (token) {
            this.byToken.set(token, record);
        }
        await this.adapter.extendObjectAsync(`clients.${id}`, { native: { token } });
    }

    /**
     * Accept an external visUrl write on `clients.<id>.visUrl`.
     * Unsafe URLs are rejected (state is reset to the current value).
     * Empty string / null clears the override — client falls back to global
     * URL or the setup page.
     *
     * @param id       Client id.
     * @param rawValue Value written to the state (any type — coerced + validated).
     */
    async handleVisUrlWrite(id: string, rawValue: unknown): Promise<void> {
        const record = this.byId.get(id);
        if (!record) {
            return;
        }
        const empty = rawValue === '' || rawValue === null || rawValue === undefined;
        const safe = empty ? null : coerceSafeUrl(rawValue);
        if (!empty && !safe) {
            this.adapter.log.warn(`client-registry: rejected unsafe visUrl for ${id}`);
            await this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: record.visUrl, ack: true });
            return;
        }
        record.visUrl = safe;
        await this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: safe ?? '', ack: true });
    }

    /**
     * Removes the client entirely — channel + states deleted, next visit creates a new entry.
     *
     * @param id Client id to forget.
     */
    async remove(id: string): Promise<void> {
        const record = this.byId.get(id);
        if (!record) {
            return;
        }
        this.byId.delete(id);
        this.byCookie.delete(record.cookie);
        if (record.token) {
            this.byToken.delete(record.token);
        }
        try {
            await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
        } catch (err) {
            this.adapter.log.warn(`client-registry: delObject failed for ${id}: ${String(err)}`);
        }
        this.adapter.log.info(`Client forgotten: ${id}`);
    }

    /**
     * Updates the visUrl dropdown states (common.states) on every client's visUrl datapoint.
     *
     * @param states Discovered URL → label map.
     */
    async syncUrlDropdown(states: UrlStates): Promise<void> {
        this.currentUrlStates = states;
        for (const id of this.byId.keys()) {
            await this.adapter.extendObjectAsync(`clients.${id}.visUrl`, {
                common: { states: { ...states } },
            });
        }
    }

    // --- internal ---

    private trackInMemory(record: ClientRecord): void {
        this.byId.set(record.id, record);
        this.byCookie.set(record.cookie, record);
        if (record.token) {
            this.byToken.set(record.token, record);
        }
    }

    private async createClient(ip: string | null, hostname: string | null): Promise<ClientRecord> {
        let id = generateClientId();
        while (this.byId.has(id)) {
            id = generateClientId();
        }
        const cookie = crypto.randomUUID();
        const record: ClientRecord = { id, cookie, token: null, visUrl: null, ip, hostname };
        this.trackInMemory(record);
        await this.createObjects(record);
        this.adapter.log.info(`New client registered: ${id}${ip ? ` (${hostname ?? ip})` : ''}`);
        return record;
    }

    private async createObjects(record: ClientRecord): Promise<void> {
        const { id, cookie, ip, hostname } = record;

        await Promise.all([
            this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
                type: 'channel',
                common: { name: hostname ?? ip ?? id },
                native: { cookie, token: null },
            }),
            this.adapter.setObjectNotExistsAsync(`clients.${id}.visUrl`, {
                type: 'state',
                common: {
                    name: 'Redirect URL',
                    type: 'string',
                    role: 'url',
                    read: true,
                    write: true,
                    def: '',
                    states: { ...this.currentUrlStates },
                },
                native: {},
            }),
            this.adapter.setObjectNotExistsAsync(`clients.${id}.ip`, {
                type: 'state',
                common: { name: 'Client IP', type: 'string', role: 'info.ip', read: true, write: false, def: '' },
                native: {},
            }),
            this.adapter.setObjectNotExistsAsync(`clients.${id}.remove`, {
                type: 'state',
                common: {
                    name: 'Forget this client',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                    def: false,
                },
                native: {},
            }),
        ]);

        await Promise.all([
            this.adapter.setStateAsync(`clients.${id}.ip`, { val: ip ?? '', ack: true }),
            this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: '', ack: true }),
        ]);
    }

    private async updateIpHostname(record: ClientRecord, ip: string | null, hostname: string | null): Promise<void> {
        if (ip && ip !== record.ip) {
            record.ip = ip;
            await this.adapter.setStateAsync(`clients.${record.id}.ip`, { val: ip, ack: true });
            // If no hostname known yet, common.name falls back to the IP — keep it current.
            if (!record.hostname) {
                await this.adapter.extendObjectAsync(`clients.${record.id}`, { common: { name: ip } });
            }
        }
        if (hostname && hostname !== record.hostname) {
            record.hostname = hostname;
            await this.adapter.extendObjectAsync(`clients.${record.id}`, { common: { name: hostname } });
        }
    }

    private async readState(subId: string): Promise<unknown> {
        try {
            const s = await this.adapter.getStateAsync(`clients.${subId}`);
            return s?.val ?? null;
        } catch {
            return null;
        }
    }
}

/**
 * Check whether a full state ID matches a client control datapoint and extract id + kind.
 *
 * @param fullId    The full state id from a state change event.
 * @param namespace The adapter namespace (e.g. `hassemu.0`).
 */
export function parseClientStateId(
    fullId: string,
    namespace: string,
): { id: string; kind: 'visUrl' | 'remove' } | null {
    const prefix = `${namespace}.${CLIENTS_PREFIX}`;
    if (!fullId.startsWith(prefix)) {
        return null;
    }
    const tail = fullId.substring(prefix.length);
    const parts = tail.split('.');
    if (parts.length !== 2) {
        return null;
    }
    const [id, kind] = parts;
    if (kind !== 'visUrl' && kind !== 'remove') {
        return null;
    }
    return { id, kind };
}
