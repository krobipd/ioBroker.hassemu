/**
 * Client Registry — persistent multi-client store.
 *
 * Each client gets a channel `clients.<id>` with native.cookie / native.token
 * and states mode / manualUrl / ip / remove. Cookie is the primary identity
 * (auto-sent by browsers on page navigation), IP is only advisory.
 *
 * Registry state is dual-homed: in-memory maps for hot lookups, ioBroker
 * objects for persistence and user-visible config.
 */

import crypto from 'node:crypto';
import {
    buildDropdownStates,
    coerceSafeUrl,
    coerceString,
    coerceUuid,
    isPlainObject,
    parseAdapterStateId,
    parseManualUrlWrite,
    parseModeWrite,
    safeGetState,
} from './coerce';
import { MODE_GLOBAL, MODE_MANUAL } from './constants';
import { tLog } from './i18n-logs';
import { generateClientId } from './network';
import type { AdapterInterface, ClientRecord, UrlStates } from './types';

/** Extended adapter interface for registry — needs object and state operations. */
export type RegistryAdapter = AdapterInterface &
    Pick<
        ioBroker.Adapter,
        | 'namespace'
        | 'getForeignObjectsAsync'
        | 'getStateAsync'
        | 'getObjectAsync'
        | 'setObjectNotExistsAsync'
        | 'setObjectAsync'
        | 'extendObjectAsync'
        | 'setStateAsync'
        | 'delObjectAsync'
    >;

const CLIENTS_PREFIX = 'clients.';

/** Provides the default mode value for a freshly created client. */
export type NewClientModeProvider = () => string;

/** Persistent multi-client store: cookie → channel, with in-memory lookup maps. */
export class ClientRegistry {
    private readonly adapter: RegistryAdapter;
    private readonly byCookie = new Map<string, ClientRecord>();
    private readonly byId = new Map<string, ClientRecord>();
    private readonly byToken = new Map<string, ClientRecord>();
    private currentUrlStates: UrlStates = {};
    private newClientModeProvider: NewClientModeProvider = () => MODE_GLOBAL;
    /**
     * In-flight client creations keyed by remote IP. Keeps parallel cookieless
     * requests from the same display (typical on first connect: HA clients fire
     * `GET /`, `GET /api/`, `POST /auth/login_flow` almost simultaneously) from
     * each creating a separate client record. The first request starts the
     * create; parallel requests await the same Promise and receive the same
     * client + cookie.
     */
    private readonly pendingByIp = new Map<string, Promise<ClientRecord>>();
    /**
     * Throttle for lastSeen-updates per client. Keyed by client id, value is the
     * last `Date.now()` we wrote `native.lastSeen` to ioBroker. Throttle window
     * is one hour — saves us extendObject roundtrips on every request.
     */
    private readonly lastSeenFlushedAt = new Map<string, number>();
    /**
     * v1.19.0 (G5): per-IP burst tracking für broken-cookie-Displays.
     * Wenn eine IP > 3 neue Clients in einer Stunde erzeugt, kommt ein
     * einmaliger warn-log mit Hinweis (cookie-Persistenz auf Display kaputt).
     */
    private readonly newClientBurst = new Map<string, { count: number; since: number; warnedAt: number }>();

    /** @param adapter Adapter instance used for object/state I/O. */
    constructor(adapter: RegistryAdapter) {
        this.adapter = adapter;
    }

    /**
     * Wires the default-mode provider used when a new client is registered.
     * Called from main.ts once registry, globalConfig and urlDiscovery exist.
     *
     * @param provider Function returning the desired default mode for a new client.
     */
    setNewClientModeProvider(provider: NewClientModeProvider): void {
        this.newClientModeProvider = provider;
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
            // v1.9.0 (D8): vier readState-Calls parallel statt sequenziell.
            // Mit 50 Clients waren das vorher 200 sequenzielle Round-Trips
            // bevor der WebServer up war; jetzt 50 parallele 4er-Gruppen.
            const [modeRaw, manualUrlRaw, ipRaw, hostnameRaw] = await Promise.all([
                this.readState(`${id}.mode`),
                this.readState(`${id}.manualUrl`),
                this.readState(`${id}.ip`),
                this.readState(`${id}.hostname`),
            ]);
            const mode = typeof modeRaw === 'string' ? modeRaw : '';
            const manualUrl = coerceSafeUrl(manualUrlRaw);
            const ip = coerceString(ipRaw);
            const token = coerceUuid(native.token);

            // Legacy migration (<=1.1.1): hostname lived in its own state. If present,
            // move the value into common.name and drop the state.
            const legacyHostname = coerceString(hostnameRaw);
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

            const record: ClientRecord = { id, cookie, token, mode, manualUrl, ip, hostname };
            this.trackInMemory(record);
            // Legacy clients (v1.1.x) only had `visUrl` + `ip` + `remove` objects;
            // ensure the v1.2.0+ objects (`mode`, `manualUrl`) exist before any
            // state writes from migration land — otherwise js-controller logs
            // "State has no existing object" warnings.
            await this.ensureObjects(record);
            // Promote blank state-value to numeric 0 so the dropdown renders
            // the `0='---'` option as selected. v1.2.0 installs left the value
            // as `''` which doesn't match any common.states entry.
            const modeStateRaw = await this.readState(`${id}.mode`);
            if (modeStateRaw === '' || modeStateRaw === null || modeStateRaw === undefined) {
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: 0, ack: true });
            }
        }
        this.adapter.log.debug(`client-registry: restored ${this.byId.size} client(s)`);
    }

    /**
     * Find the client for this cookie or create a new one.
     * Creates channel + states on first call and updates IP/hostname if changed.
     *
     * @param cookie    Incoming cookie value (may be null/invalid).
     * @param ip        Remote IP observed by the server.
     * @param hostname  Optional hostname (from reverse DNS), stored for the admin UI.
     * @param userAgent Optional User-Agent header for NAT-collision-Schutz im Pending-Lock.
     */
    async identifyOrCreate(
        cookie: string | null,
        ip: string | null,
        hostname: string | null,
        userAgent: string | null = null,
    ): Promise<ClientRecord> {
        const validCookie = coerceUuid(cookie);
        if (validCookie) {
            const existing = this.byCookie.get(validCookie);
            if (existing) {
                await this.updateIpHostname(existing, ip, hostname);
                this.touchLastSeen(existing);
                return existing;
            }
        }
        // No valid cookie: before spinning up a new client, check whether this
        // IP already has a create in flight. If so, await that Promise — the
        // parallel request of the same display's initial burst will get the
        // same cookie + client, no more duplicate "New client" log entries.
        //
        // v1.17.0 (C8): Bucket-Key kombiniert IP + User-Agent-Hash, sodass
        // zwei verschiedene Displays hinter derselben NAT-IP NICHT in denselben
        // Pending-Lock fallen (vorher: gleicher Cookie/Token/Mode → Cookie-
        // Klau-Vektor). UA-Hash truncated auf 12 Hex-Chars um Memory-Footprint
        // klein zu halten. Bei UA=null fällt der Bucket auf reines IP zurück.
        if (ip) {
            const bucketKey = userAgent
                ? `${ip}|${crypto.createHash('sha256').update(userAgent).digest('hex').substring(0, 12)}`
                : ip;
            const pending = this.pendingByIp.get(bucketKey);
            if (pending) {
                // v1.21.0 (D3): pending-promise kann rejecten — z.B. wenn
                // createClient async failed (broker-disconnect, object-create-
                // error). Wir können nicht recover'n (der erste Caller hat eh
                // schon gefailt), aber wir wollen den Fehler diagnostizierbar
                // machen. catch+rethrow sorgt für ein einzelnes log statt
                // unhandled-rejection im fastify-error-handler.
                return pending.catch(err => {
                    this.adapter.log.debug(
                        `client-registry: pending createClient for ${bucketKey} rejected: ${String(err)}`,
                    );
                    throw err;
                });
            }
            const promise = this.createClient(ip, hostname);
            this.pendingByIp.set(bucketKey, promise);
            try {
                return await promise;
            } catch (err) {
                // Tech-Diagnose mit Stack-Detail — bleibt debug (Maintainer-only).
                this.adapter.log.debug(
                    `client-registry: createClient failed for IP ${ip}: ${err instanceof Error ? err.message : String(err)}`,
                );
                throw err;
            } finally {
                this.pendingByIp.delete(bucketKey);
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
     * Accept an external mode write on `clients.<id>.mode`.
     *
     * Allowed values: `'global'`, `'manual'`, or any URL that passes
     * {@link coerceSafeUrl}. Empty string clears the choice → setup page.
     *
     * @param id       Client id.
     * @param rawValue Value written to the state.
     */
    async handleModeWrite(id: string, rawValue: unknown): Promise<void> {
        const record = this.byId.get(id);
        if (!record) {
            return;
        }
        // v1.23.0 (F2): zentralisierte Validierung via parseModeWrite. Vorher
        // hatten client-registry und global-config ~80% identische Logik
        // (no-choice, non-string, sentinel, URL-coerce) dupliziert.
        const result = parseModeWrite(rawValue, [MODE_GLOBAL, MODE_MANUAL]);
        switch (result.kind) {
            case 'no-choice':
                record.mode = '';
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: 0, ack: true });
                return;
            case 'rejected-non-string':
                // v1.18.0 (G7): debug statt warn — nicht-string mode-Schreibungen
                // sind UI-Echo, kein Server-Concern.
                this.adapter.log.debug(`client-registry: rejected non-string mode for ${id}`);
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode || 0, ack: true });
                return;
            case 'sentinel':
                if (result.value === MODE_MANUAL && !record.manualUrl) {
                    this.adapter.log.warn(tLog(this.adapter.systemLanguage, 'clientModeManualButEmpty', { id }));
                }
                record.mode = result.value;
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: result.value, ack: true });
                return;
            case 'rejected-unsafe-url':
                this.adapter.log.warn(tLog(this.adapter.systemLanguage, 'clientModeUnsafe', { id, value: result.raw }));
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode, ack: true });
                return;
            case 'url':
                record.mode = result.value;
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: result.value, ack: true });
                return;
            // 'rejected-disallowed-sentinel' kommt hier nicht vor weil beide
            // Sentinels (global/manual) erlaubt sind. Defensive: revert.
            default:
                await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode || 0, ack: true });
        }
    }

    /**
     * Accept an external manualUrl write on `clients.<id>.manualUrl`.
     * Free-text — must pass {@link coerceSafeUrl} or be empty (clears).
     *
     * @param id       Client id.
     * @param rawValue Value written to the state.
     */
    async handleManualUrlWrite(id: string, rawValue: unknown): Promise<void> {
        const record = this.byId.get(id);
        if (!record) {
            return;
        }
        const result = parseManualUrlWrite(rawValue);
        if (!result.ok) {
            this.adapter.log.warn(tLog(this.adapter.systemLanguage, 'clientManualUrlUnsafe', { id }));
            await this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: record.manualUrl ?? '', ack: true });
            return;
        }
        record.manualUrl = result.safe;
        await this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: result.safe ?? '', ack: true });
        if (record.mode === MODE_MANUAL && !result.safe) {
            this.adapter.log.warn(tLog(this.adapter.systemLanguage, 'clientManualUrlClearedWhileManual', { id }));
        }
    }

    /**
     * Set every client's `mode` to the same value. Used by the master switch
     * (`global.enabled`) to bulk-sync all displays — `'global'` when on,
     * the first discovered URL when off.
     *
     * Skips clients whose mode already matches (no spurious state writes).
     *
     * @param value New mode value (sentinel or URL).
     */
    async bulkSetMode(value: string): Promise<void> {
        // v1.8.1 (D7): parallele setStateAsync statt sequenziell. Mit 50 Displays
        // war das vorher 50 Broker-Round-Trips. setStateAsync ist Broker-internal,
        // Parallelism ist safe.
        const writes: Array<Promise<unknown>> = [];
        let changed = 0;
        for (const record of this.byId.values()) {
            if (record.mode === value) {
                continue;
            }
            record.mode = value;
            writes.push(this.adapter.setStateAsync(`clients.${record.id}.mode`, { val: value, ack: true }));
            changed++;
        }
        if (writes.length > 0) {
            await Promise.all(writes);
        }
        if (changed > 0) {
            this.adapter.log.debug(`bulkSetMode applied to ${changed} client(s)`);
        }
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
        // v1.8.1 (D2): lastSeenFlushedAt war früher nicht aufgeräumt — bei
        // ID-Reuse (16M-Space, möglich nach 100+ Clients über Jahre) hätte
        // die alte Throttle-Entry den ersten lastSeen-Write des neuen Clients
        // inhibiert. Plus minimal Memory-Leak.
        this.lastSeenFlushedAt.delete(id);
        try {
            await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
        } catch (err) {
            // Stack-trace level — Maintainer-Diagnose, EN bleibt.
            this.adapter.log.debug(`client-registry: delObject failed for ${id}: ${String(err)}`);
        }
        this.adapter.log.info(tLog(this.adapter.systemLanguage, 'clientForgotten', { id }));
    }

    /**
     * Updates the mode dropdown states (`common.states`) on every client's mode datapoint.
     * Adds the `'global'` and `'manual'` sentinels on top of the discovered URLs.
     *
     * @param states Discovered URL → label map.
     */
    async syncUrlDropdown(states: UrlStates): Promise<void> {
        this.currentUrlStates = states;
        const merged = this.buildModeStates();
        for (const id of this.byId.keys()) {
            // v1.27.2: extendObjectAsync mergt `common.states` tief — alte
            // URL-Schlüssel die nicht mehr discovered werden, blieben sonst im
            // Dropdown stehen (sichtbar nach v1.26→v1.27 URL-Format-Wechsel:
            // alte `vis-2.0/main/index.html`-Keys neben neuen `vis-2/index.html?main`).
            // Object lesen, common.states komplett ersetzen, dann setObjectAsync.
            const stateId = `clients.${id}.mode`;
            const existing = await this.adapter.getObjectAsync(stateId);
            if (!existing) {
                continue;
            }
            existing.common.states = merged;
            await this.adapter.setObjectAsync(stateId, existing);
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
        const mode = this.newClientModeProvider();
        const record: ClientRecord = { id, cookie, token: null, mode, manualUrl: null, ip, hostname };
        this.trackInMemory(record);
        await this.createObjects(record);
        this.touchLastSeen(record);
        this.adapter.log.info(
            ip
                ? tLog(this.adapter.systemLanguage, 'newClientRegisteredWithHost', { id, hostname: hostname ?? ip })
                : tLog(this.adapter.systemLanguage, 'newClientRegistered', { id }),
        );
        // v1.19.0 (G5): IP-Burst-Detection für broken-cookie-Displays. Wenn
        // dieselbe IP > 3 neue Clients in einer Stunde erzeugt, ist der Cookie-
        // Mechanismus auf dem Display kaputt (aggressive Privacy, refresh-bug).
        // Einmaliger warn-Hinweis pro IP pro Stunde — danach bleibt der info-
        // log normal, aber der Operator hat wenigstens einen Anker zur Diagnose.
        if (ip) {
            this.recordNewClientIp(ip);
        }
        return record;
    }

    /**
     * v1.19.0 (G5): tracking-only — wenn eine IP > 3 neue Clients pro Stunde
     * erzeugt, einmaliger warn-log mit Diagnose-Hinweis. Danach 1h cooldown
     * pro IP. Map-Cap 200 (FIFO).
     *
     * @param ip Remote IP that just got a new ClientRecord assigned.
     */
    private recordNewClientIp(ip: string): void {
        const now = Date.now();
        const HOUR = 60 * 60 * 1000;
        const entry = this.newClientBurst.get(ip) ?? { count: 0, since: now, warnedAt: 0 };
        if (now - entry.since > HOUR) {
            // Window expired — reset.
            entry.count = 0;
            entry.since = now;
        }
        entry.count += 1;
        if (entry.count > 3 && now - entry.warnedAt > HOUR) {
            this.adapter.log.warn(tLog(this.adapter.systemLanguage, 'cookieBurstDetected', { ip, count: entry.count }));
            entry.warnedAt = now;
        }
        this.newClientBurst.set(ip, entry);
        // Soft-cap to keep the map bounded (analog der anderen Caps).
        if (this.newClientBurst.size > 200) {
            const oldest = this.newClientBurst.keys().next().value;
            if (oldest !== undefined) {
                this.newClientBurst.delete(oldest);
            }
        }
    }

    /**
     * Updates `native.lastSeen` on the channel, throttled to once per hour per
     * client. Used for the stale-client-GC: clients without token + lastSeen
     * older than 30 days get auto-removed on adapter start.
     *
     * Fire-and-forget — failures only debug-logged.
     *
     * @param record Client whose lastSeen-timestamp should be refreshed.
     */
    private touchLastSeen(record: ClientRecord): void {
        const now = Date.now();
        const last = this.lastSeenFlushedAt.get(record.id) ?? 0;
        if (now - last < 60 * 60 * 1000) {
            return; // throttle: 1× per hour
        }
        this.lastSeenFlushedAt.set(record.id, now);
        this.adapter
            .extendObjectAsync(`clients.${record.id}`, { native: { lastSeen: now } })
            .catch(err => this.adapter.log.debug(`touchLastSeen failed for ${record.id}: ${String(err)}`));
    }

    /**
     * v1.19.0 (F11): zentraler lastSeen-Seed-Pfad. Vorher hatte main.ts
     * gcStaleClients seinen eigenen extendObjectAsync-Call mit identischem
     * native-Format — DRY-Violation und gefährlich wenn das Format mal ändert.
     * Jetzt nutzen beide Pfade diese Methode. Throttle-Map wird auch upgedated,
     * damit der nächste touchLastSeen den seed nicht direkt überschreibt.
     *
     * @param id  Client id (short segment, ohne `clients.`-Prefix).
     * @param now Optionaler Timestamp für tests; default Date.now().
     */
    async seedLastSeen(id: string, now: number = Date.now()): Promise<void> {
        this.lastSeenFlushedAt.set(id, now);
        try {
            await this.adapter.extendObjectAsync(`clients.${id}`, { native: { lastSeen: now } });
        } catch (err) {
            this.adapter.log.debug(`seedLastSeen failed for ${id}: ${String(err)}`);
        }
    }

    /**
     * Builds the dropdown-states map for `clients.<id>.mode`. Includes the
     * `0='---'` no-choice fallback (analogous to the govee-smart pattern), the
     * `'global'` + `'manual'` sentinels, and all currently discovered URLs.
     */
    private buildModeStates(): UrlStates {
        // v1.20.0 (F4): Helper aus coerce.ts. Vorher dupliziert mit global-config
        // (bis auf den zusätzlichen `global`-Sentinel hier, weil clients per
        // `mode='global'` an global delegieren können — global selbst nicht).
        return buildDropdownStates(
            {
                [MODE_GLOBAL]: 'Global URL',
                [MODE_MANUAL]: 'Manual URL',
            },
            this.currentUrlStates,
        );
    }

    /**
     * Idempotently creates all per-client objects (channel + states). Safe to
     * call repeatedly — uses `setObjectNotExistsAsync` everywhere. Called from
     * both `restore()` (so legacy v1.1.x clients gain the new mode/manualUrl
     * objects before migration writes states) and `createClient()`.
     *
     * @param record Client to create or ensure objects for.
     */
    private async ensureObjects(record: ClientRecord): Promise<void> {
        const { id, cookie, ip, hostname } = record;
        const mergedStates = this.buildModeStates();

        // Channel: setObjectNotExistsAsync — common.name is updated dynamically
        // by updateIpHostname() when reverse-DNS resolves; we must not clobber it.
        await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
            type: 'channel',
            common: { name: hostname ?? ip ?? id },
            native: { cookie, token: null },
        });

        // States: extendObjectAsync — REPAIRS partial objects from the v1.2.0
        // migration bug (extendObjectAsync was called with only common.type:'mixed',
        // creating an object without top-level type/name/role/read/write/def).
        // Using extend instead of setObjectNotExists merges missing properties
        // onto the existing partial object so js-controller stops warning
        // "obj.type has to exist" and the dropdown renders correctly.
        await Promise.all([
            this.adapter.extendObjectAsync(`clients.${id}.mode`, {
                type: 'state',
                common: {
                    name: 'Redirect mode',
                    // 'mixed' future-proofs against the upcoming js-controller
                    // strict-type cast (see govee-smart v1.11.0 pattern).
                    type: 'mixed',
                    role: 'value',
                    read: true,
                    write: true,
                    def: 0,
                    states: mergedStates,
                },
                native: {},
            }),
            this.adapter.extendObjectAsync(`clients.${id}.manualUrl`, {
                type: 'state',
                common: {
                    name: 'Manual URL',
                    type: 'string',
                    role: 'url',
                    read: true,
                    write: true,
                    def: '',
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
    }

    private async createObjects(record: ClientRecord): Promise<void> {
        await this.ensureObjects(record);
        const { id, mode, ip } = record;
        await Promise.all([
            this.adapter.setStateAsync(`clients.${id}.ip`, { val: ip ?? '', ack: true }),
            this.adapter.setStateAsync(`clients.${id}.mode`, { val: mode, ack: true }),
            this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: '', ack: true }),
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
        // v1.20.0 (F10): Helper aus coerce.ts — vorher dupliziert mit
        // global-config.safeGetState (gleicher try/catch-+-null-Fallback,
        // nur Pfad-Prefix anders).
        const s = await safeGetState(this.adapter, `clients.${subId}`);
        return s?.val ?? null;
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
): { id: string; kind: 'mode' | 'manualUrl' | 'remove' } | null {
    // v1.20.0 (F9): generischer parseAdapterStateId-Helper. Vorher hatte
    // client-registry seine eigene Prefix-+-Tail-Validierung dupliziert mit
    // global-config.parseGlobalStateId.
    const parts = parseAdapterStateId(fullId, namespace, CLIENTS_PREFIX, 2);
    if (!parts) {
        return null;
    }
    const [id, kind] = parts;
    // v1.9.0 (E5): empty id rejection (`clients..mode` would parse to id='').
    if (!id) {
        return null;
    }
    if (kind !== 'mode' && kind !== 'manualUrl' && kind !== 'remove') {
        return null;
    }
    return { id, kind };
}
