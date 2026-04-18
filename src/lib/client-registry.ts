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
    private readonly defaultVisUrl: string;
    private readonly byCookie = new Map<string, ClientRecord>();
    private readonly byId = new Map<string, ClientRecord>();
    private readonly byToken = new Map<string, ClientRecord>();
    private currentUrlStates: UrlStates = {};

    /**
     * @param adapter       Adapter instance used for object/state I/O.
     * @param defaultVisUrl Fallback URL used when a client has no override.
     */
    constructor(adapter: RegistryAdapter, defaultVisUrl: string) {
        this.adapter = adapter;
        this.defaultVisUrl = defaultVisUrl;
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
            const hostname = coerceString(await this.readState(`${id}.hostname`));
            const token = coerceUuid(native.token);

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

    /**
     * Returns the per-client visUrl if set, otherwise the adapter-wide default.
     *
     * @param record Client to resolve the URL for.
     */
    getVisUrl(record: ClientRecord): string {
        return record.visUrl ?? this.defaultVisUrl;
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
     * Empty string / null clears the override — client uses defaultVisUrl.
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

        await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
            type: 'channel',
            common: { name: hostname ?? ip ?? id },
            native: { cookie, token: null },
        });

        await this.adapter.setObjectNotExistsAsync(`clients.${id}.visUrl`, {
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
        });

        await this.adapter.setObjectNotExistsAsync(`clients.${id}.ip`, {
            type: 'state',
            common: { name: 'Client IP', type: 'string', role: 'info.ip', read: true, write: false, def: '' },
            native: {},
        });

        await this.adapter.setObjectNotExistsAsync(`clients.${id}.hostname`, {
            type: 'state',
            common: {
                name: 'Client hostname',
                type: 'string',
                role: 'info.name',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });

        await this.adapter.setObjectNotExistsAsync(`clients.${id}.remove`, {
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
        });

        await this.adapter.setStateAsync(`clients.${id}.ip`, { val: ip ?? '', ack: true });
        await this.adapter.setStateAsync(`clients.${id}.hostname`, { val: hostname ?? '', ack: true });
        await this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: '', ack: true });
    }

    private async updateIpHostname(record: ClientRecord, ip: string | null, hostname: string | null): Promise<void> {
        if (ip && ip !== record.ip) {
            record.ip = ip;
            await this.adapter.setStateAsync(`clients.${record.id}.ip`, { val: ip, ack: true });
        }
        if (hostname && hostname !== record.hostname) {
            record.hostname = hostname;
            await this.adapter.setStateAsync(`clients.${record.id}.hostname`, {
                val: hostname,
                ack: true,
            });
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
