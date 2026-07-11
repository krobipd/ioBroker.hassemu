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

import crypto from "node:crypto";
import {
  buildDropdownStates,
  coerceSafeUrl,
  coerceString,
  coerceUuid,
  evictOldest,
  isPlainObject,
  oneLine,
  parseAdapterStateId,
  parseManualUrlWrite,
  parseModeWrite,
  safeGetState,
  shallowStatesEqual,
} from "./coerce";
import {
  LASTSEEN_FLUSH_INTERVAL_MS,
  MODE_GLOBAL,
  MODE_MANUAL,
  NEW_CLIENT_BURST_CAP,
  NEW_CLIENT_BURST_WARN_THRESHOLD,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S,
} from "./constants";
import { resolveLabel, tName } from "./i18n";
import { generateClientId } from "./network";
import { replaceObjectPreservingValue } from "./object-repair";
import type { AdapterInterface, ClientRecord, UrlStates } from "./types";

/** Extended adapter interface for registry — needs object and state operations. */
export type RegistryAdapter = AdapterInterface &
  Pick<
    ioBroker.Adapter,
    | "namespace"
    | "getForeignObjectsAsync"
    | "getStateAsync"
    | "getObjectAsync"
    | "setObjectNotExistsAsync"
    | "extendObject"
    | "setState"
    | "delObjectAsync"
  >;

const CLIENTS_PREFIX = "clients.";

/** Provides the default mode value for a freshly created client. */
export type NewClientModeProvider = () => string;

/** Persistent multi-client store: cookie → channel, with in-memory lookup maps. */
export class ClientRegistry {
  private readonly adapter: RegistryAdapter;
  private readonly byCookie = new Map<string, ClientRecord>();
  private readonly byId = new Map<string, ClientRecord>();
  private readonly byToken = new Map<string, ClientRecord>();
  private readonly byRefreshToken = new Map<string, ClientRecord>();
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
   * v1.19.0 (G5): per-IP burst tracking for broken-cookie displays. v1.37.0 (M4):
   * the window is now SLIDING — keyed on `lastActivity`, not a fixed start — so an
   * IP that keeps spraying cookieless requests stays throttled instead of getting
   * a fresh NEW_CLIENT_THROTTLE_PER_HOUR budget every hour. An IP idle for a full
   * NEW_CLIENT_WINDOW_MS recovers and can mint persistent clients again.
   */
  private readonly newClientBurst = new Map<string, { count: number; lastActivity: number; warnedAt: number }>();

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
    let objects: Record<string, ioBroker.Object> = {};
    try {
      // I22 (v1.37.0): query WITHOUT a type filter so both legacy `channel` client
      // objects and current `device` ones are found (during/after the channel→device
      // migration). Sub-states (clients.<id>.mode …) come back too, but restoreChannel
      // skips them (their id contains a dot).
      objects = (await this.adapter.getForeignObjectsAsync(`${this.adapter.namespace}.${CLIENTS_PREFIX}*`)) ?? {};
    } catch (err) {
      // A total restore failure is user-visible: every known display is re-created
      // as a fresh client (duplicate objects, "lost" config). Warn, not debug —
      // the operator needs the anchor when "New client connected" lines pile up
      // for long-known displays. v1.37.0 (L4).
      this.adapter.log.warn(
        `client-registry: restore failed — known displays will be re-created as new clients: ${String(err)}`,
      );
      return;
    }

    for (const [fullId, obj] of Object.entries(objects)) {
      await this.restoreChannel(fullId, obj);
    }
    this.adapter.log.debug(`client-registry: restored ${this.byId.size} client(s)`);
  }

  /**
   * Restore a single `clients.<id>` channel into the in-memory registry. Extracted
   * from restore() (I11 v1.37.0) so restore() reads as a thin loop over the channels.
   * Per-client try/catch (HE1 v1.28.3): one broken channel — a corrupt state during a
   * jsonl-store migration, a missing object — costs only itself, never the whole restore.
   *
   * @param fullId Full object id (`<namespace>.clients.<id>`).
   * @param obj    The client object (channel or device) read from the objects DB.
   */
  private async restoreChannel(fullId: string, obj: ioBroker.Object): Promise<void> {
    const id = fullId.substring(`${this.adapter.namespace}.${CLIENTS_PREFIX}`.length);
    if (!id || id.includes(".")) {
      return;
    }
    try {
      const native = isPlainObject(obj.native) ? obj.native : {};
      const cookie = coerceUuid(native.cookie);
      if (!cookie) {
        // A clients.<id> channel with no valid cookie cannot belong to any
        // display — the cookie is the identity and is written at creation. Such
        // a channel can only be an orphan left by an object write that raced a
        // remove(). restore() runs before the web server starts, so nothing is
        // mid-creation here; delete it so it stops lingering in the object tree
        // (where nothing ever reaps it — it has no cookie to restore). v1.37.0 (M5).
        this.adapter.log.warn(`client-registry: removing orphaned client channel without cookie: ${id}`);
        try {
          await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
        } catch (err) {
          this.adapter.log.debug(`client-registry: orphan cleanup failed for ${id}: ${String(err)}`);
        }
        return;
      }
      // I22 (v1.37.0): migrate a legacy `channel` client object to `device` in place —
      // preserves cookie/token/name/states, no re-onboarding. New clients are already
      // created as devices by ensureObjects().
      if (obj.type === "channel") {
        try {
          await this.adapter.extendObject(`clients.${id}`, { type: "device" });
        } catch (err) {
          this.adapter.log.debug(`client-registry: channel→device migration failed for ${id}: ${String(err)}`);
        }
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
      const mode = typeof modeRaw === "string" ? modeRaw : "";
      const manualUrl = coerceSafeUrl(manualUrlRaw);
      const ip = coerceString(ipRaw);
      const token = coerceUuid(native.token);
      const refreshToken = coerceUuid(native.refreshToken);
      // v1.36.0 (S5): restore the persisted access-token expiry so a token that
      // already expired before the restart is rejected by getByToken on next use.
      const tokenExpiresAt = token && typeof native.tokenExpiresAt === "number" ? native.tokenExpiresAt : null;

      // Legacy migration (<=1.1.1): hostname lived in its own state. If present,
      // move the value into common.name and drop the state.
      const legacyHostname = coerceString(hostnameRaw);
      let channelName = coerceString(obj.common?.name);
      if (legacyHostname) {
        this.adapter.log.debug(
          `restore: legacy hostname migration for client ${id} — '${legacyHostname}' moved to common.name`,
        );
        if (legacyHostname !== channelName) {
          await this.adapter.extendObject(`clients.${id}`, { common: { name: legacyHostname } });
          channelName = legacyHostname;
        }
        try {
          await this.adapter.delObjectAsync(`clients.${id}.hostname`);
        } catch {
          /* best effort — ignore */
        }
      }
      const hostname = channelName && channelName !== ip && channelName !== id ? channelName : null;

      const record: ClientRecord = { id, cookie, token, tokenExpiresAt, refreshToken, mode, manualUrl, ip, hostname };
      this.trackInMemory(record);
      // Legacy clients (v1.1.x) only had `visUrl` + `ip` + `remove` objects;
      // ensure the v1.2.0+ objects (`mode`, `manualUrl`) exist before any
      // state writes from migration land — otherwise js-controller logs
      // "State has no existing object" warnings.
      await this.ensureObjects(record);
      // Promote a blank mode value to the string "0" so the dropdown renders the
      // `0='---'` option as selected. v1.2.0 installs left the value as `''`
      // which matches no common.states entry. Reuses `mode` from the parallel
      // read above (which is `''` for both a blank and a missing value) —
      // ensureObjects() only writes objects, never the mode value, so a second
      // getState would return the same thing. v1.37.0 (L24).
      if (mode === "") {
        await this.adapter.setState(`clients.${id}.mode`, { val: "0", ack: true });
      }
    } catch (err) {
      this.adapter.log.debug(`client-registry: skipping ${id} during restore — ${String(err)}`);
    }
  }

  /**
   * Find the client for this cookie or create a new one.
   * Creates channel + states on first call and updates IP/hostname if changed.
   *
   * @param cookie         Incoming cookie value (may be null/invalid).
   * @param ip             Remote IP observed by the server.
   * @param opts           Optional details, named so a call site can't transpose the nullable strings. v1.37.0 (L30).
   * @param opts.hostname  Hostname (from reverse DNS), stored for the admin UI.
   * @param opts.userAgent User-Agent header for NAT-collision protection in the pending lock.
   */
  async identifyOrCreate(
    cookie: string | null,
    ip: string | null,
    opts: { hostname?: string | null; userAgent?: string | null } = {},
  ): Promise<ClientRecord> {
    const hostname = opts.hostname ?? null;
    const userAgent = opts.userAgent ?? null;
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
      // Refuse to mint a new *persistent* client for an IP spraying cookieless
      // requests — hand out a transient (non-persisted, no object) record so the
      // ioBroker object DB cannot grow without bound. A real display keeps its
      // cookie and is identified above, so it never reaches this throttle.
      if (this.isIpThrottled(ip)) {
        // Keep the sliding window alive so a continuously-spraying IP never
        // recovers, but do NOT mint a persistent client (persistent = false).
        // v1.37.0 (M4).
        this.recordNewClientActivity(ip, false);
        this.adapter.log.debug(`identify: IP ${ip} over new-client throttle — serving a transient record (no object)`);
        return this.transientRecord(ip, hostname);
      }
      const bucketKey = userAgent
        ? `${ip}|${crypto.createHash("sha256").update(userAgent).digest("hex").substring(0, 12)}`
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
          this.adapter.log.debug(`client-registry: pending createClient for ${bucketKey} rejected: ${String(err)}`);
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
    const record = this.byToken.get(token);
    if (!record) {
      return null;
    }
    // v1.36.0 (S5): reject (and drop) an expired access token so the advertised
    // 30-min TTL is enforced — a captured token stops working once it expires.
    // Refresh tokens stay long-lived (byRefreshToken) for HA Companion compat.
    if (record.tokenExpiresAt != null && Date.now() > record.tokenExpiresAt) {
      this.byToken.delete(token);
      if (record.token === token) {
        record.token = null;
      }
      return null;
    }
    return record;
  }

  /**
   * Lookup by refresh token issued during the auth flow.
   *
   * @param refreshToken Refresh token value.
   */
  getByRefreshToken(refreshToken: string): ClientRecord | null {
    return this.byRefreshToken.get(refreshToken) ?? null;
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
    // v1.36.0 (S5): stamp the access-token expiry so the advertised 30-min TTL is
    // actually enforced (see getByToken) — a captured token can't be replayed forever.
    record.tokenExpiresAt = token ? Date.now() + OAUTH_ACCESS_TOKEN_TTL_S * 1000 : null;
    if (token) {
      this.byToken.set(token, record);
    }
    await this.adapter.extendObject(`clients.${id}`, {
      native: { token, tokenExpiresAt: record.tokenExpiresAt },
    });
  }

  /**
   * Updates in-memory refresh token and persists to channel.native. Old refresh
   * token is freed. Stored plain-text in `clients.<id>.native.refreshToken` —
   * same exposure profile as the access token (see {@link ClientRecord.refreshToken}).
   *
   * @param id           Client id.
   * @param refreshToken New refresh token, or null to clear.
   */
  async setRefreshToken(id: string, refreshToken: string | null): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    if (record.refreshToken) {
      this.byRefreshToken.delete(record.refreshToken);
    }
    record.refreshToken = refreshToken;
    if (refreshToken) {
      this.byRefreshToken.set(refreshToken, record);
    }
    await this.adapter.extendObject(`clients.${id}`, { native: { refreshToken } });
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
      case "no-choice":
        record.mode = "";
        await this.adapter.setState(`clients.${id}.mode`, { val: "0", ack: true });
        this.adapter.log.debug(`Client ${id}: mode → cleared (no-choice)`);
        return;
      case "rejected-non-string":
        // v1.18.0 (G7): debug statt warn — nicht-string mode-Schreibungen
        // sind UI-Echo, kein Server-Concern.
        this.adapter.log.debug(`client-registry: rejected non-string mode for ${id}`);
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || "0", ack: true });
        return;
      case "sentinel":
        if (result.value === MODE_MANUAL && !record.manualUrl) {
          this.adapter.log.warn(
            `Client ${id}: mode set to "manual" but manualUrl is empty — fill clients.${id}.manualUrl to redirect`,
          );
        }
        record.mode = result.value;
        await this.adapter.setState(`clients.${id}.mode`, { val: result.value, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → '${result.value}' (sentinel)`);
        return;
      case "rejected-unsafe-url":
        // L1(b): raw is an unvalidated state value — flatten and cap it so a
        // multi-MB / multi-line script write can't flood or inject the log.
        this.adapter.log.warn(`Client ${id}: rejected unsafe mode value "${oneLine(result.raw).substring(0, 120)}"`);
        // L37: revert to `record.mode || 0` (not bare `record.mode`) so a blank
        // mode reverts to the string "0" the dropdown renders, matching the other
        // revert paths — a bare "" regresses the dropdown to no selection.
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || "0", ack: true });
        return;
      case "url":
        record.mode = result.value;
        await this.adapter.setState(`clients.${id}.mode`, { val: result.value, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → ${result.value} (direct URL)`);
        return;
      // 'rejected-disallowed-sentinel' kommt hier nicht vor weil beide
      // Sentinels (global/manual) erlaubt sind. Defensive: revert.
      default:
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || "0", ack: true });
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
      this.adapter.log.warn(`Client ${id}: rejected unsafe manualUrl value`);
      await this.adapter.setState(`clients.${id}.manualUrl`, { val: record.manualUrl ?? "", ack: true });
      return;
    }
    record.manualUrl = result.safe;
    await this.adapter.setState(`clients.${id}.manualUrl`, { val: result.safe ?? "", ack: true });
    this.adapter.log.debug(`Client ${id}: manualUrl → ${result.safe ?? "cleared"}`);
    if (record.mode === MODE_MANUAL && !result.safe) {
      this.adapter.log.warn(`Client ${id}: manualUrl cleared while mode is "manual" — display will see the setup page`);
    }
  }

  /**
   * Set every client's `mode` to the same value. Used by the master switch
   * (`global.enabled`) to bulk-sync all displays — `'global'` when on,
   * `'0'` (no-choice → landing page) when off.
   *
   * Skips clients whose mode already matches (no spurious state writes).
   *
   * @param value New mode value (sentinel or URL).
   */
  async bulkSetMode(value: string): Promise<void> {
    // v1.8.1 (D7): parallele setState statt sequenziell. Mit 50 Displays
    // war das vorher 50 Broker-Round-Trips. setState ist Broker-internal,
    // Parallelism ist safe.
    const writes: Array<Promise<unknown>> = [];
    let changed = 0;
    for (const record of this.byId.values()) {
      if (record.mode === value) {
        continue;
      }
      record.mode = value;
      writes.push(this.adapter.setState(`clients.${record.id}.mode`, { val: value, ack: true }));
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
    if (record.refreshToken) {
      this.byRefreshToken.delete(record.refreshToken);
    }
    // v1.8.1 (D2): lastSeenFlushedAt war früher nicht aufgeräumt — bei
    // ID-Reuse (16M-Space, möglich nach 100+ Clients über Jahre) hätte
    // die alte Throttle-Entry den ersten lastSeen-Write des neuen Clients
    // inhibiert. Plus minimal Memory-Leak.
    this.lastSeenFlushedAt.delete(id);
    let objectRemoved = true;
    try {
      await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
    } catch (err) {
      objectRemoved = false;
      // Stack-trace level — Maintainer-Diagnose, EN bleibt.
      this.adapter.log.debug(`client-registry: delObject failed for ${id}: ${String(err)}`);
    }
    if (objectRemoved) {
      this.adapter.log.info(`Client forgotten: ${id}`);
    } else {
      // The in-memory maps are already cleared, but the object survived and will
      // be read back as a client on the next restart — don't claim success, or
      // the "why is it back?" diagnosis costs the time this log should save.
      // v1.37.0 (L28).
      this.adapter.log.warn(
        `Client ${id} forgotten in memory, but its object could not be removed — it will reappear after an adapter restart`,
      );
    }
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
    // v1.27.2: extendObject mergt `common.states` tief — alte
    // URL-Schlüssel die nicht mehr discovered werden, blieben sonst im
    // Dropdown stehen (sichtbar nach v1.26→v1.27 URL-Format-Wechsel:
    // alte `vis-2.0/main/index.html`-Keys neben neuen `vis-2/index.html?main`).
    // Object lesen, common.states komplett ersetzen, dann setObject.
    // v1.30.0 (R4): pro-Client get+set parallel statt sequentiell. Analog
    // gcStaleClients in main.ts (v1.28.3 M5). Spürbar bei Display-Farmen
    // mit 30+ Clients — vorher 2×N Broker-Round-Trips sequenziell.
    await Promise.all(
      Array.from(this.byId.keys()).map(async id => {
        const stateId = `clients.${id}.mode`;
        const existing = await this.adapter.getObjectAsync(stateId);
        if (!existing) {
          return;
        }
        // Skip the write when the dropdown is already identical — avoids a
        // setObject (jsonl churn + objectChange fan-out) per client on every
        // discovery run that changed nothing. v1.37.0 (I4).
        if (shallowStatesEqual(existing.common.states, merged)) {
          return;
        }
        existing.common.states = merged;
        await replaceObjectPreservingValue(this.adapter, stateId, existing);
      }),
    );
  }

  // --- internal ---

  private trackInMemory(record: ClientRecord): void {
    this.byId.set(record.id, record);
    this.byCookie.set(record.cookie, record);
    if (record.token) {
      this.byToken.set(record.token, record);
    }
    if (record.refreshToken) {
      this.byRefreshToken.set(record.refreshToken, record);
    }
  }

  private async createClient(ip: string | null, hostname: string | null): Promise<ClientRecord> {
    let id = generateClientId();
    while (this.byId.has(id)) {
      id = generateClientId();
    }
    const record = this.buildRecord(id, ip, hostname);
    this.trackInMemory(record);
    await this.createObjects(record);
    this.touchLastSeen(record);
    this.adapter.log.info(
      ip ? `New client connected: ${id} (${oneLine(hostname ?? ip)})` : `New client connected: ${id}`,
    );
    // v1.19.0 (G5): IP burst detection for broken-cookie displays. A persistent
    // create bumps the sliding-window count and warns once per window if the same
    // IP mints more than NEW_CLIENT_BURST_WARN_THRESHOLD clients (cookie mechanism
    // broken on the display: aggressive privacy, refresh bug).
    if (ip) {
      this.recordNewClientActivity(ip, true);
    }
    return record;
  }

  /**
   * True when `ip` has minted at least {@link NEW_CLIENT_THROTTLE_PER_HOUR} new
   * clients AND is still active within the sliding {@link NEW_CLIENT_WINDOW_MS}.
   * Once true, `identifyOrCreate` hands out transient records (no object). An IP
   * that stops spraying for a full window recovers here; {@link recordNewClientActivity}
   * refreshes the window on every cookieless request (throttled or not), so
   * continuous spraying never recovers. v1.37.0 (M4).
   *
   * @param ip  Remote IP to check.
   * @param now Current time in ms (injectable for tests).
   */
  private isIpThrottled(ip: string, now: number = Date.now()): boolean {
    const entry = this.newClientBurst.get(ip);
    if (!entry || now - entry.lastActivity >= NEW_CLIENT_WINDOW_MS) {
      return false;
    }
    return entry.count >= NEW_CLIENT_THROTTLE_PER_HOUR;
  }

  /**
   * A non-persisted, untracked client handed out when an IP is over the
   * new-client throttle. No `clients.<id>` object is created and the record is
   * not added to any lookup map, so a cookieless spray cannot grow the object
   * DB. Mode is the normal new-client default, so a legitimate-but-throttled
   * client (e.g. behind a busy NAT) still resolves to the configured dashboard
   * — it just doesn't get a persistent identity.
   *
   * @param ip       Remote IP (advisory).
   * @param hostname Reverse-DNS hostname, if any.
   */
  private transientRecord(ip: string | null, hostname: string | null): ClientRecord {
    return this.buildRecord(generateClientId(), ip, hostname);
  }

  /**
   * Builds a fresh ClientRecord with a new cookie and the current default mode.
   * Single construction site so every field — notably the nullable
   * token / tokenExpiresAt / refreshToken — is set in exactly one place:
   * createClient persists + tracks it, transientRecord hands it out untracked.
   * v1.37.0 (L13).
   *
   * @param id       Short client id (createClient de-dupes it against byId).
   * @param ip       Last observed IP.
   * @param hostname Reverse-DNS hostname, if any.
   */
  private buildRecord(id: string, ip: string | null, hostname: string | null): ClientRecord {
    return {
      id,
      cookie: crypto.randomUUID(),
      token: null,
      tokenExpiresAt: null,
      refreshToken: null,
      mode: this.newClientModeProvider(),
      manualUrl: null,
      ip,
      hostname,
    };
  }

  /**
   * Records cookieless-identify activity for an IP into the sliding burst window.
   * Called on EVERY cookieless identify — a persistent create (`persistent = true`,
   * bumps the count and may warn once per window) and a throttled transient
   * (`persistent = false`, only refreshes `lastActivity`). Refreshing on the
   * throttled path is what keeps a continuously-spraying IP from recovering. The
   * window resets only after a full idle window. Map-cap 200 (FIFO).
   * v1.19.0 (G5); sliding window v1.37.0 (M4).
   *
   * @param ip         Remote IP that just performed a cookieless identify.
   * @param persistent True if a persistent client was minted (bumps the count).
   * @param now        Current time in ms (injectable for tests).
   */
  private recordNewClientActivity(ip: string, persistent: boolean, now: number = Date.now()): void {
    let entry = this.newClientBurst.get(ip);
    if (!entry || now - entry.lastActivity >= NEW_CLIENT_WINDOW_MS) {
      // Fresh IP, or one idle for a full window → start a new window.
      entry = { count: 0, lastActivity: now, warnedAt: 0 };
    }
    entry.lastActivity = now;
    if (persistent) {
      entry.count += 1;
      if (entry.count > NEW_CLIENT_BURST_WARN_THRESHOLD && now - entry.warnedAt > NEW_CLIENT_WINDOW_MS) {
        this.adapter.log.warn(
          `IP ${ip} created ${entry.count} clients within an hour — display likely is not persisting cookies (privacy mode? refresh bug?)`,
        );
        entry.warnedAt = now;
      }
    }
    this.newClientBurst.set(ip, entry);
    // v1.32.0: soft-cap via shared `evictOldest`.
    evictOldest(this.newClientBurst, NEW_CLIENT_BURST_CAP);
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
    // Only for tracked records. A transient (throttled) record is never in byId,
    // and a record removed while a request was still in flight must not be
    // resurrected by this fire-and-forget upsert — extendObject would re-create
    // the channel as a cookie-less orphan. v1.37.0 (M5).
    if (!this.byId.has(record.id)) {
      return;
    }
    const now = Date.now();
    const last = this.lastSeenFlushedAt.get(record.id) ?? 0;
    if (now - last < LASTSEEN_FLUSH_INTERVAL_MS) {
      return; // throttle: once per flush interval
    }
    this.lastSeenFlushedAt.set(record.id, now);
    this.adapter
      .extendObject(`clients.${record.id}`, { native: { lastSeen: now } })
      .catch(err => this.adapter.log.debug(`touchLastSeen failed for ${record.id}: ${String(err)}`));
  }

  /**
   * v1.19.0 (F11): zentraler lastSeen-Seed-Pfad. Vorher hatte main.ts
   * gcStaleClients seinen eigenen extendObject-Call mit identischem
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
      await this.adapter.extendObject(`clients.${id}`, { native: { lastSeen: now } });
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
    // resolveLabel() returns a plain string (I18n.translate, resolved in the
    // system language loaded at I18n.init) — NOT a translation object: Admin
    // renders common.states VALUES directly as a React child and crashes on
    // translation objects with React Error #31. v1.28.0 slipped a translation
    // object in here via an `as unknown as string` cast that satisfied the type
    // check but broke the admin dropdown on open.
    // Memory `reference_common_states_plain_string_only`.
    return buildDropdownStates(
      {
        [MODE_GLOBAL]: resolveLabel("globalUrl"),
        [MODE_MANUAL]: resolveLabel("manualUrl"),
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

    // Device (I22 v1.37.0): each client is a `device` — it represents a physical
    // display, matching the ioBroker convention (and govee-smart) of `device` for a
    // physical thing. Legacy `channel` client objects are migrated to `device` on
    // restore (see restoreChannel). setObjectNotExistsAsync — common.name is updated
    // dynamically by updateIpHostname() when reverse-DNS resolves; we must not clobber it.
    await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
      type: "device",
      common: { name: hostname ?? ip ?? id },
      native: { cookie, token: null },
    });

    // States:
    //   - `clients.<id>.mode` uses get+setObject (analog `global-config.ts`
    //     v1.27.2-Fix): extendObject deep-merges common.states, weshalb
    //     alte i18n-Object-Keys aus pre-v1.28.4-Installs unter den gleichen
    //     keys hängen blieben → React Error #31 beim Admin-Dropdown-Open.
    //     setObject ersetzt common komplett (custom-Custom-Subscriptions
    //     wie influxdb.0 bleiben via spread aus existing erhalten).
    //   - Repair-Pfad für partial-formed Objects (v1.2.0-Migration-Bug, common
    //     ohne top-level type/name/role) ist auch abgedeckt: existing-fields
    //     werden von der full schema common komplett überschrieben.
    //   - `clients.<id>.manualUrl` bleibt extendObject — kein states-Feld,
    //     daher kein i18n-Object-Risiko.
    const modeFullCommon: ioBroker.StateCommon = {
      // tName returns StringOrTranslated, which common.name accepts directly.
      name: tName("clientMode"),
      // 'mixed' future-proofs against the upcoming js-controller
      // strict-type cast (see govee-smart v1.11.0 pattern).
      type: "mixed",
      role: "state",
      read: true,
      write: true,
      def: 0,
      states: mergedStates,
    };
    const ensureModeObject = async (): Promise<void> => {
      const existing = await this.adapter.getObjectAsync(`clients.${id}.mode`);
      if (existing) {
        // ensureObjects runs on every restart for every client. Skip the rewrite
        // when the object already matches the desired schema (dropdown states
        // included) — an unconditional setObject was 1 write/client/start plus an
        // objectChange fan-out for no change. Any mismatch falls through to a full
        // repair below. v1.37.0 (I6).
        const c = existing.common;
        if (
          existing.type === "state" &&
          c?.type === "mixed" &&
          c.role === "state" &&
          shallowStatesEqual(c.states, mergedStates)
        ) {
          return;
        }
        const preservedName = existing.common?.name;
        existing.common = { ...existing.common, ...modeFullCommon };
        if (preservedName !== undefined) {
          existing.common.name = preservedName;
        }
        existing.type = "state";
        await replaceObjectPreservingValue(this.adapter, `clients.${id}.mode`, existing);
      } else {
        await this.adapter.setObjectNotExistsAsync(`clients.${id}.mode`, {
          type: "state",
          common: modeFullCommon,
          native: {},
        });
      }
    };
    await Promise.all([
      ensureModeObject(),
      this.adapter.extendObject(
        `clients.${id}.manualUrl`,
        {
          type: "state",
          common: {
            name: tName("clientManualUrl"),
            type: "string",
            role: "url",
            read: true,
            write: true,
            def: "",
          },
          native: {},
        },
        { preserve: { common: ["name"] } },
      ),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.ip`, {
        type: "state",
        common: {
          name: tName("clientIp"),
          type: "string",
          role: "info.ip",
          read: true,
          write: false,
          def: "",
        },
        native: {},
      }),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.remove`, {
        type: "state",
        common: {
          name: tName("clientRemove"),
          type: "boolean",
          role: "button",
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
      this.adapter.setState(`clients.${id}.ip`, { val: ip ?? "", ack: true }),
      this.adapter.setState(`clients.${id}.mode`, { val: mode, ack: true }),
      this.adapter.setState(`clients.${id}.manualUrl`, { val: "", ack: true }),
    ]);
  }

  private async updateIpHostname(record: ClientRecord, ip: string | null, hostname: string | null): Promise<void> {
    if (ip && ip !== record.ip) {
      const previousIp = record.ip;
      record.ip = ip;
      await this.adapter.setState(`clients.${record.id}.ip`, { val: ip, ack: true });
      // If no hostname is known, common.name falls back to the IP. Only refresh it
      // when the channel name is STILL the old auto-IP — never clobber a name the
      // user set in the admin UI (the README documents the channel name as the
      // user-owned display label). onObjectChange does not observe clients.* renames,
      // so record.hostname stays null and this read-before-overwrite is the only
      // guard protecting a user rename across an IP change. v1.36.0 (C4).
      if (!record.hostname) {
        const obj = await this.adapter.getObjectAsync(`clients.${record.id}`);
        const currentName = obj?.common?.name;
        if (currentName === undefined || (typeof currentName === "string" && currentName === previousIp)) {
          await this.adapter.extendObject(`clients.${record.id}`, { common: { name: ip } });
        }
      }
    }
    if (hostname && hostname !== record.hostname) {
      await this.applyHostname(record, hostname);
    }
  }

  /**
   * Updates a KNOWN client's reverse-DNS hostname — the target of the web server's
   * asynchronous reverse-DNS callback. A byCookie miss is a deliberate no-op: the
   * client was removed (or the cookie became unknown) while the up-to-5s lookup
   * ran, and we must NOT create a new client here — that would mint a ghost with a
   * fresh cookie no display owns. Replaces the earlier `identifyOrCreate` misuse
   * as an update channel. v1.37.0 (M5).
   *
   * @param cookie   Cookie of the client whose hostname resolved.
   * @param hostname Reverse-DNS hostname.
   */
  async updateHostname(cookie: string, hostname: string): Promise<void> {
    const record = this.getByCookie(cookie);
    if (!record || !hostname || hostname === record.hostname) {
      return;
    }
    await this.applyHostname(record, hostname);
  }

  /**
   * Writes the reverse-DNS hostname to the record and the channel's common.name,
   * but only when common.name still holds an auto value (the previous hostname,
   * the current IP, or the id) — never clobber a name the user set in the admin
   * UI. onObjectChange does not observe clients.* renames, so record.hostname
   * stays null and this read-before-overwrite is the only guard protecting a user
   * rename across a late-resolving reverse-DNS result. The IP branch above guards
   * the same way; before v1.37.0 this hostname branch overwrote unconditionally.
   * v1.36.0 (C4) / v1.37.0 (M1).
   *
   * @param record   Tracked client record.
   * @param hostname Resolved hostname (already non-empty and != record.hostname).
   */
  private async applyHostname(record: ClientRecord, hostname: string): Promise<void> {
    const previousHostname = record.hostname;
    record.hostname = hostname;
    const obj = await this.adapter.getObjectAsync(`clients.${record.id}`);
    const currentName = obj?.common?.name;
    const isAutoName =
      currentName === undefined ||
      (typeof currentName === "string" &&
        (currentName === previousHostname || currentName === record.ip || currentName === record.id));
    if (isAutoName) {
      await this.adapter.extendObject(`clients.${record.id}`, { common: { name: hostname } });
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
): { id: string; kind: "mode" | "manualUrl" | "remove" } | null {
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
  if (kind !== "mode" && kind !== "manualUrl" && kind !== "remove") {
    return null;
  }
  return { id, kind };
}
