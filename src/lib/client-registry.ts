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
import { coerceSafeUrl, coerceString, coerceUuid, isPlainObject, oneLine } from "./coerce";
import {
  evictOldest,
  isBareStringName,
  nameText,
  parseAdapterStateId,
  safeGetState,
  shallowStatesEqual,
} from "./object-utils";
import { buildDropdownStates, parseManualUrlWrite, parseModeWrite } from "./state-write-rules";
import {
  CLIENT_OBJECTS_VERSION,
  GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
  LASTSEEN_FLUSH_INTERVAL_MS,
  MODE_GLOBAL,
  MODE_MANUAL,
  NEW_CLIENT_BURST_CAP,
  NO_CHOICE,
  NEW_CLIENT_BURST_WARN_THRESHOLD,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S,
  IP_CHANGE_MIN_INTERVAL_MS,
} from "./constants";
import { errText } from "./err-text";
import { resolveLabel, tName, tRaw } from "./i18n";
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
    | "setStateChangedAsync"
    | "delObjectAsync"
    | "setForeignObject"
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
  /** When each display's address last changed — the window of {@link IP_CHANGE_MIN_INTERVAL_MS}. */
  private readonly ipChangedAt = new Map<string, number>();
  /**
   * v1.19.0 (G5): per-IP burst tracking for broken-cookie displays. v1.37.0 (M4):
   * the window is now SLIDING — keyed on `lastActivity`, not a fixed start — so an
   * IP that keeps spraying cookieless requests stays throttled instead of getting
   * a fresh NEW_CLIENT_THROTTLE_PER_HOUR budget every hour. An IP idle for a full
   * NEW_CLIENT_WINDOW_MS recovers and can mint persistent clients again.
   */
  private readonly newClientBurst = new Map<string, { count: number; lastActivity: number; warnedAt: number }>();
  /**
   * IP-INDEPENDENT sliding-window counter for persistent cookieless creates — a
   * second ceiling below the per-IP {@link isIpThrottled} one. The per-IP throttle
   * keys on `req.ip`; with `trustProxy` on but no sanitising proxy in front, a single
   * device can rotate `X-Forwarded-For` per request so every request looks like a
   * fresh IP and never trips it, minting unbounded persisted `clients.<id>` objects.
   * This window closes that hole regardless of IP spoofing. Same reset-on-idle shape
   * as {@link newClientBurst}. See {@link GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW}.
   */
  private globalBurst = { count: 0, lastCreate: 0, warnedAt: 0 };
  /**
   * Legacy `clients.<id>.visUrl` values seen during {@link restore}, keyed by client id.
   *
   * `migrateVisUrlToMode` used to ask the broker for this state once per client on every
   * single start — sequentially, and on every installation migrated since v1.2.0 the
   * answer was `null` every time. `restore()` already reads that client's states in one
   * parallel batch, so the value comes along for free and the migration needs no
   * round-trip of its own. Consumed (and cleared) by {@link takeLegacyVisUrls}: a value
   * is offered exactly once, so a failed migration attempt is not retried against a
   * stale copy but against the broker on the next start.
   */
  private readonly legacyVisUrls = new Map<string, unknown>();

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
      // Query each client-container type EXPLICITLY and merge. A string pattern with
      // NO type argument resolves to js-controller's `state` object view
      // (`getObjectView('system', type || 'state')`, verified in js-controller v7.2.2),
      // so it returns ONLY sub-states — NEVER the `device`/`channel` client containers.
      // restoreChannel then skips every state (its id contains a dot) → restore()
      // silently loaded ZERO clients (regression from v1.37.0/I22, which dropped the
      // previous `"channel"` type filter). Both types are required because the
      // channel→device migration (I22) is still in flight: legacy installs carry
      // `channel` containers, migrated/new ones carry `device`. Fleet gotcha:
      // reference_getforeignobjects_state_default (hueemu v1.12.0 hit the same class).
      const pattern = `${this.adapter.namespace}.${CLIENTS_PREFIX}*`;
      const [devices, channels] = await Promise.all([
        this.adapter.getForeignObjectsAsync(pattern, "device"),
        this.adapter.getForeignObjectsAsync(pattern, "channel"),
      ]);
      objects = { ...(channels ?? {}), ...(devices ?? {}) };
    } catch (err) {
      // A total restore failure is user-visible: every known display is re-created
      // as a fresh client (duplicate objects, "lost" config). Warn, not debug —
      // the operator needs the anchor when "New client connected" lines pile up
      // for long-known displays. v1.37.0 (L4).
      this.adapter.log.warn(
        `client-registry: restore failed — known displays will be re-created as new clients: ${errText(err)}`,
      );
      return;
    }

    // All displays in parallel — restoreChannel shares nothing between displays except
    // synchronous Map writes, and each has its own try/catch. Serial, this was N × (five
    // reads + five existence checks + one object read) before the port was bound
    // (audit 2026-09-15, D1).
    await Promise.all(Object.entries(objects).map(([fullId, obj]) => this.restoreChannel(fullId, obj)));
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
          this.adapter.log.debug(`client-registry: orphan cleanup failed for ${id}: ${errText(err)}`);
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
          this.adapter.log.debug(`client-registry: channel→device migration failed for ${id}: ${errText(err)}`);
        }
      }
      // v1.9.0 (D8): the reads of one display run in parallel; since the audit of
      // 2026-09-15 the displays themselves do too (restore() above), so a start costs
      // one round of round-trips instead of one per display.
      // The fifth read is the pre-1.2.0 `visUrl` the migration needs. It rides along in
      // the batch that already runs here instead of costing the migration its own
      // sequential round-trip per client on every start (see legacyVisUrls).
      const [modeRaw, manualUrlRaw, ipRaw, hostnameRaw, legacyVisUrlRaw] = await Promise.all([
        this.readState(`${id}.mode`),
        this.readState(`${id}.manualUrl`),
        this.readState(`${id}.ip`),
        this.readState(`${id}.hostname`),
        this.readState(`${id}.visUrl`),
      ]);
      if (legacyVisUrlRaw !== null && legacyVisUrlRaw !== undefined && legacyVisUrlRaw !== "") {
        this.legacyVisUrls.set(id, legacyVisUrlRaw);
      }
      const mode = typeof modeRaw === "string" ? modeRaw : "";
      // A pre-v1.43.0 install may still hold "" in the state; normalise on the way in so
      // exactly one form lives in memory.
      const normalisedMode = mode === "" ? NO_CHOICE : mode;
      const manualUrl = coerceSafeUrl(manualUrlRaw);
      const ip = coerceString(ipRaw);
      const token = coerceUuid(native.token);
      const refreshToken = coerceUuid(native.refreshToken);
      // The lastSeen throttle window survives a restart: the persisted stamp IS the last
      // flush. Without this every display's first contact after a restart re-wrote a
      // `lastSeen` that was seconds old — N object writes per restart for nothing
      // (audit 2026-09-15, C1). A stamp older than the window is refreshed as before.
      // gcStaleClients reads the same map instead of re-reading every object (D1).
      if (typeof native.lastSeen === "number" && Number.isFinite(native.lastSeen)) {
        this.lastSeenFlushedAt.set(id, native.lastSeen);
      }
      // v1.36.0 (S5): restore the persisted access-token expiry so a token that
      // already expired before the restart is rejected by getByToken on next use.
      const tokenExpiresAt = token && typeof native.tokenExpiresAt === "number" ? native.tokenExpiresAt : null;

      // Legacy migration (<=1.1.1): hostname lived in its own state. If present,
      // move the value into common.name and drop the state.
      const legacyHostname = coerceString(hostnameRaw);
      // `nameText`, not `coerceString`: the name is a bare string on every client created
      // before v1.41.0 and a translation object afterwards — reading only the string form
      // would make an already-converted client look nameless and re-stamp its IP over the
      // hostname on the next restore.
      const rawChannelName = obj.common?.name;
      let channelName = nameText(rawChannelName);
      // v1.41.0: convert a client created before this version to a translation object.
      // The TEXT is kept exactly as it stands — it is the display's hostname, or a name
      // the user typed in the admin UI; only the form changes (core team, nut2 #15).
      // Guarded on the bare-string form, so an already-converted client is left alone
      // and this costs one write once per client, not one per start.
      if (isBareStringName(rawChannelName)) {
        await this.adapter.extendObject(`clients.${id}`, { common: { name: tRaw(rawChannelName) } });
      }
      if (legacyHostname) {
        this.adapter.log.debug(
          `restore: legacy hostname migration for client ${id} — '${legacyHostname}' moved to common.name`,
        );
        if (legacyHostname !== channelName) {
          await this.adapter.extendObject(`clients.${id}`, { common: { name: tRaw(legacyHostname) } });
          channelName = legacyHostname;
        }
        try {
          await this.adapter.delObjectAsync(`clients.${id}.hostname`);
        } catch {
          /* best effort — ignore */
        }
      }
      const hostname = channelName && channelName !== ip && channelName !== id ? channelName : null;

      const record: ClientRecord = {
        id,
        cookie,
        token,
        tokenExpiresAt,
        refreshToken,
        mode: normalisedMode,
        manualUrl,
        ip,
        hostname,
        persistent: true,
      };
      this.trackInMemory(record);
      // Text revision this client's objects were last written with. Missing/older →
      // ensureObjects refreshes the texts once and re-stamps; equal → it only guarantees
      // the objects EXIST and writes nothing (see CLIENT_OBJECTS_VERSION).
      const storedVersion = typeof native.objectsVersion === "number" ? native.objectsVersion : 0;
      // Legacy clients (v1.1.x) only had `visUrl` + `ip` + `remove` objects;
      // ensure the v1.2.0+ objects (`mode`, `manualUrl`) exist before any
      // state writes from migration land — otherwise js-controller logs
      // "State has no existing object" warnings.
      await this.ensureObjects(record, false, storedVersion);
      // Promote a blank mode value to the string "0" so the dropdown renders the
      // `0='---'` option as selected. v1.2.0 installs left the value as `''`
      // which matches no common.states entry. Reuses `mode` from the parallel
      // read above (which is `''` for both a blank and a missing value) —
      // ensureObjects() only writes objects, never the mode value, so a second
      // getState would return the same thing. v1.37.0 (L24).
      if (mode === "") {
        await this.adapter.setState(`clients.${id}.mode`, { val: NO_CHOICE, ack: true });
      }
    } catch (err) {
      this.adapter.log.debug(`client-registry: skipping ${id} during restore — ${errText(err)}`);
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
   * @param opts.create    False: a request without a known cookie gets a transient record, never
   *   a new display (HEAD requests, audit 2026-09-25, H2). Default true.
   */
  async identifyOrCreate(
    cookie: string | null,
    ip: string | null,
    opts: { hostname?: string | null; userAgent?: string | null; create?: boolean } = {},
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
    // HEAD never mints a display: uptime monitors, port scanners and both Companion apps'
    // connectivity checks send HEAD without a cookie — each used to create a device tree
    // that lived 30 days (audit 2026-09-25, H2). Nothing is counted against the throttles.
    if (opts.create === false) {
      this.adapter.log.debug("identify: no known cookie on a request that may not create a display — transient record");
      return this.transientRecord(ip, hostname);
    }
    // IP-INDEPENDENT ceiling on persistent creation, checked before the per-IP path
    // below. Closes the trustProxy / spoofed-X-Forwarded-For hole: a device rotating
    // its apparent IP never trips the per-IP throttle, so without this it could grow
    // the object DB without bound. Over budget → transient record (still resolves to
    // the dashboard, just no persisted identity until the burst subsides). The per-IP
    // window is still refreshed so a throttled real IP keeps its own budget accurate.
    const now = Date.now();
    if (this.isGloballyThrottled(now)) {
      if (ip) {
        this.recordNewClientActivity(ip, false, now);
      }
      this.warnGlobalThrottleOnce(now);
      this.adapter.log.debug("identify: global new-client ceiling reached — serving a transient record (no object)");
      return this.transientRecord(ip, hostname);
    }
    // No valid cookie: before spinning up a new client, check whether this
    // IP already has a create in flight. If so, await that Promise — the
    // parallel request of the same display's initial burst will get the
    // same cookie + client, no more duplicate "New client" log entries.
    //
    // v1.17.0 (C8): the bucket key combines the IP and a hash of the User-Agent, so
    // two different displays behind the same NAT address do NOT fall into the same
    // pending lock (before: same cookie/token/mode — a way to steal a cookie). The UA
    // hash is cut to 12 hex characters to keep the memory footprint small. With no
    // UA the bucket falls back to the IP alone.
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
        // v1.21.0 (D3): the pending promise can reject — e.g. when createClient
        // fails asynchronously (broker disconnect, object create error). There is
        // nothing to recover (the first caller has failed already), but the error
        // must stay diagnosable: catch + rethrow gives one log line instead of an
        // unhandled rejection in the fastify error handler.
        return pending.catch(err => {
          this.adapter.log.debug(`client-registry: pending createClient for ${bucketKey} rejected: ${errText(err)}`);
          throw err;
        });
      }
      const promise = this.createClient(ip, hostname);
      this.pendingByIp.set(bucketKey, promise);
      try {
        return await promise;
      } catch (err) {
        // Technical diagnosis with stack detail — stays debug (maintainers only).
        this.adapter.log.debug(`client-registry: createClient failed for IP ${ip}: ${errText(err)}`);
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
   * Persist the URL a display was just sent to.
   *
   * Written only when the answer CHANGED (the caller already tracks that for its log line),
   * so a display polling every 15–30 s costs no writes while nothing moves.
   *
   * @param id  Client id.
   * @param url The resolved URL, or null for the landing page.
   */
  async setResolvedUrl(id: string, url: string | null): Promise<void> {
    if (!this.byId.has(id)) {
      return; // transient (throttled) record — it owns no objects
    }
    // setStateChanged, not setState: the caller only knows what it served since the
    // restart, so a display's first poll after a restart looked like a change and
    // re-wrote the value already in the datapoint (audit 2026-09-15, C2). The controller
    // compares against the stored state and writes nothing when it is equal.
    await this.adapter
      .setStateChangedAsync(`clients.${id}.resolvedUrl`, { val: url ?? "", ack: true })
      .catch(err => this.adapter.log.debug(`setResolvedUrl failed for ${id}: ${errText(err)}`));
  }

  /**
   * Hand over the legacy `visUrl` values collected during {@link restore} and forget them.
   *
   * Empty on every installation migrated since v1.2.0 — which is the point: the migration
   * then does nothing at all instead of asking the broker once per client, every start.
   * Handing them over exactly once keeps a failed migration honest: the next start reads
   * the broker again rather than a stale in-memory copy.
   *
   * @returns Map of client id → raw legacy value; empty when there is nothing to migrate.
   */
  takeLegacyVisUrls(): Map<string, unknown> {
    const taken = new Map(this.legacyVisUrls);
    this.legacyVisUrls.clear();
    return taken;
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
    this.trackToken(record, token);
    await this.adapter.extendObject(`clients.${id}`, {
      native: { token, tokenExpiresAt: record.tokenExpiresAt },
    });
  }

  /**
   * Sets access AND refresh token in one object write — the onboarding grant and the
   * revoke both change the pair, and two extendObject calls on the same object per
   * onboarding were one too many (audit 2026-09-15, G1). The refresh token is stored
   * plain-text in `clients.<id>.native.refreshToken` — same exposure profile as the
   * access token (see {@link ClientRecord.refreshToken}).
   *
   * @param id           Client id.
   * @param token        New bearer token, or null to clear.
   * @param refreshToken New refresh token, or null to clear.
   */
  async setTokens(id: string, token: string | null, refreshToken: string | null): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    this.trackToken(record, token);
    if (record.refreshToken) {
      this.byRefreshToken.delete(record.refreshToken);
    }
    record.refreshToken = refreshToken;
    if (refreshToken) {
      this.byRefreshToken.set(refreshToken, record);
    }
    await this.adapter.extendObject(`clients.${id}`, {
      native: { token, tokenExpiresAt: record.tokenExpiresAt, refreshToken },
    });
  }

  /**
   * In-memory half of an access-token change: frees the old lookup entry, stamps the
   * expiry and indexes the new token.
   *
   * @param record Tracked client record.
   * @param token  New bearer token, or null to clear.
   */
  private trackToken(record: ClientRecord, token: string | null): void {
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
    // v1.23.0 (F2): central validation through parseModeWrite. client-registry and
    // global-config used to duplicate ~80% of the logic (no choice, non-string,
    // sentinel, URL coercion).
    const result = parseModeWrite(rawValue, [MODE_GLOBAL, MODE_MANUAL]);
    switch (result.kind) {
      case "no-choice":
        // "0" in memory too, not "" — the value the state carries and the dropdown key.
        // Two representations for one meaning made `bulkSetMode`'s equality skip miss:
        // a client sitting on "" got a pointless write every time the master switch went
        // off. I19 (v1.37.0) unified the STORED value; this unifies the in-memory one.
        record.mode = NO_CHOICE;
        await this.adapter.setState(`clients.${id}.mode`, { val: NO_CHOICE, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → cleared (no-choice)`);
        return;
      case "rejected-non-string":
        // v1.18.0 (G7): debug instead of warn — non-string mode writes are a UI
        // echo, not a server concern.
        this.adapter.log.debug(`client-registry: rejected non-string mode for ${id}`);
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || NO_CHOICE, ack: true });
        return;
      case "sentinel":
        if (result.value === MODE_MANUAL && !record.manualUrl) {
          // debug, not warn: writing the mode before the URL is a normal order (a script, two
          // clicks); the landing page and clients.<id>.resolvedUrl show the outcome
          // (audit 2026-09-25, Z1).
          this.adapter.log.debug(
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
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || NO_CHOICE, ack: true });
        return;
      case "url":
        record.mode = result.value;
        await this.adapter.setState(`clients.${id}.mode`, { val: result.value, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → ${result.value} (direct URL)`);
        return;
      // 'rejected-disallowed-sentinel' cannot occur here, because both sentinels
      // (global/manual) are allowed. Defensive: revert.
      default:
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || NO_CHOICE, ack: true });
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
      // debug, not warn: clearing the URL before switching the mode is a normal order (N8).
      this.adapter.log.debug(
        `Client ${id}: manualUrl cleared while mode is "manual" — display will see the setup page`,
      );
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
    // v1.8.1 (D7): parallel setState instead of sequential — with 50 displays that
    // used to be 50 sequential broker round trips. setState is broker-internal, running
    // them in parallel is safe.
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
    this.untrack(record);
    let objectRemoved = true;
    try {
      await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
    } catch (err) {
      objectRemoved = false;
      // Stack-trace level — Maintainer-Diagnose, EN bleibt.
      this.adapter.log.debug(`client-registry: delObject failed for ${id}: ${errText(err)}`);
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
    // v1.27.2: extendObject deep-merges `common.states` — URL keys that are no longer
    // discovered would stay in the dropdown (seen after the v1.26→v1.27 URL format
    // change: old `vis-2.0/main/index.html` keys beside new `vis-2/index.html?main`).
    // Read the object, replace common.states wholesale, then ONE full write via
    // replaceObjectPreservingValue (setForeignObject since v1.45.0 — the earlier
    // delete + recreate pair struck the datapoint from every enum).
    // v1.30.0 (R4): get+write per client in parallel instead of sequentially, like
    // gcStaleClients in main.ts (v1.28.3 M5) — noticeable on display farms with 30+
    // clients, which used to cost 2×N broker round-trips in sequence.
    await Promise.all(
      Array.from(this.byId.keys()).map(async id => {
        const stateId = `clients.${id}.mode`;
        const existing = await this.adapter.getObjectAsync(stateId);
        if (!existing) {
          return;
        }
        // Skip the write when the dropdown is already identical — avoids a full
        // object write (jsonl churn + objectChange fan-out) per client on every
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

  /**
   * Drop a record from every lookup map — the inverse of {@link trackInMemory}.
   *
   * @param record The record to forget in memory.
   */
  private untrack(record: ClientRecord): void {
    this.byId.delete(record.id);
    this.byCookie.delete(record.cookie);
    if (record.token) {
      this.byToken.delete(record.token);
    }
    if (record.refreshToken) {
      this.byRefreshToken.delete(record.refreshToken);
    }
    // v1.8.1 (D2): the lastSeen throttle entry goes too — on an id reuse (16M space, possible
    // after years) it would suppress the new display's first lastSeen write; plus a small leak.
    this.lastSeenFlushedAt.delete(record.id);
    this.ipChangedAt.delete(record.id);
  }

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

  /**
   * A random id no tracked client holds. Shared by the persistent and the transient
   * path: a transient id that collided with a live display used to make that display's
   * `byId` checks succeed for a stranger's request (audit 2026-09-15, B3).
   */
  private freshClientId(): string {
    let id = generateClientId();
    while (this.byId.has(id)) {
      id = generateClientId();
    }
    return id;
  }

  private async createClient(ip: string | null, hostname: string | null): Promise<ClientRecord> {
    const record = this.buildRecord(this.freshClientId(), ip, hostname, true);
    const { id } = record;
    // Tracked BEFORE the objects are written: freshClientId() checks byId, so a second
    // display arriving meanwhile cannot draw the same id.
    this.trackInMemory(record);
    try {
      await this.createObjects(record);
    } catch (err) {
      // A display whose objects could not be written must not stay in the lookup maps: it
      // would answer byId/byCookie with no object behind it, grow the maps with every retry,
      // and neither throttle would count it (audit 2026-09-25, L6).
      this.untrack(record);
      throw err;
    }
    this.touchLastSeen(record);
    this.adapter.log.info(
      ip ? `New client connected: ${id} (${oneLine(hostname ?? ip)})` : `New client connected: ${id}`,
    );
    // Count this persistent create against the global, IP-independent ceiling
    // (the trustProxy / spoofed-X-Forwarded-For bound; see isGloballyThrottled).
    this.recordGlobalCreate();
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
   * True when the global persistent-create window is over budget. IP-independent
   * companion to {@link isIpThrottled}; see {@link globalBurst} +
   * {@link GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW}. Read-only — the window is advanced
   * by {@link recordGlobalCreate} on an actual persistent create, and reset after a
   * full idle {@link NEW_CLIENT_WINDOW_MS}.
   *
   * @param now Current time in ms (injectable for tests).
   */
  private isGloballyThrottled(now: number = Date.now()): boolean {
    if (now - this.globalBurst.lastCreate >= NEW_CLIENT_WINDOW_MS) {
      return false;
    }
    return this.globalBurst.count >= GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW;
  }

  /**
   * Records one persistent cookieless create into the global window. Resets the
   * window (count + warn cooldown) after a full idle {@link NEW_CLIENT_WINDOW_MS}, so
   * a continuous spray keeps the window alive and stays throttled while normal
   * onboarding — gaps far longer than the window — always starts fresh. Called only
   * from {@link createClient}, the single persistent-create site.
   *
   * @param now Current time in ms (injectable for tests).
   */
  private recordGlobalCreate(now: number = Date.now()): void {
    if (now - this.globalBurst.lastCreate >= NEW_CLIENT_WINDOW_MS) {
      this.globalBurst.count = 0;
      this.globalBurst.warnedAt = 0;
    }
    this.globalBurst.count += 1;
    this.globalBurst.lastCreate = now;
  }

  /**
   * One warn per window when the global ceiling is serving transient records — the
   * signature of a spoofed-`X-Forwarded-For` spray (or `trustProxy` set without a
   * sanitising proxy). Deduplicated against `warnedAt`, which resets with the window.
   *
   * @param now Current time in ms.
   */
  private warnGlobalThrottleOnce(now: number): void {
    if (now - this.globalBurst.warnedAt > NEW_CLIENT_WINDOW_MS) {
      this.adapter.log.warn(
        `More than ${GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW} new clients within an hour across all IPs — throttling persistent client creation (a spoofed X-Forwarded-For spray, or trustProxy enabled without a sanitising reverse proxy?)`,
      );
      this.globalBurst.warnedAt = now;
    }
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
    return this.buildRecord(this.freshClientId(), ip, hostname, false);
  }

  /**
   * Builds a fresh ClientRecord with a new cookie and the current default mode.
   * Single construction site so every field — notably the nullable
   * token / tokenExpiresAt / refreshToken — is set in exactly one place:
   * createClient persists + tracks it, transientRecord hands it out untracked.
   * v1.37.0 (L13).
   *
   * @param id         Short client id (see {@link freshClientId}).
   * @param ip         Last observed IP.
   * @param hostname   Reverse-DNS hostname, if any.
   * @param persistent Whether the record is backed by objects (see {@link ClientRecord.persistent}).
   */
  private buildRecord(id: string, ip: string | null, hostname: string | null, persistent: boolean): ClientRecord {
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
      persistent,
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
    // Only for persistent, tracked records. A transient (throttled) record owns no
    // objects, and a record removed while a request was still in flight must not be
    // resurrected by this fire-and-forget upsert — extendObject would re-create
    // the channel as a cookie-less orphan. v1.37.0 (M5).
    if (!record.persistent || !this.byId.has(record.id)) {
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
      .catch(err => this.adapter.log.debug(`touchLastSeen failed for ${record.id}: ${errText(err)}`));
  }

  /**
   * v1.19.0 (F11): the one path that seeds lastSeen. main.ts gcStaleClients used to
   * carry its own extendObject call with the same native format — a duplicate that
   * would break the day the format changes. Both paths use this method now. The
   * throttle map is updated too, so the next touchLastSeen does not overwrite the
   * seed right away.
   *
   * @param id  Client id (short segment, without the `clients.` prefix).
   * @param now Optional timestamp for tests; default Date.now().
   */
  async seedLastSeen(id: string, now: number = Date.now()): Promise<void> {
    this.lastSeenFlushedAt.set(id, now);
    try {
      await this.adapter.extendObject(`clients.${id}`, { native: { lastSeen: now } });
    } catch (err) {
      this.adapter.log.debug(`seedLastSeen failed for ${id}: ${errText(err)}`);
    }
  }

  /**
   * The last `native.lastSeen` this registry knows for a client — restored from the
   * object on start, advanced by every flush. `undefined` for a client that never got
   * a stamp (pre-1.2.0) — the stale-GC seeds one then. Lets the GC decide without a
   * second object read per display (audit 2026-09-15, D1).
   *
   * @param id Client id.
   */
  lastSeenOf(id: string): number | undefined {
    return this.lastSeenFlushedAt.get(id);
  }

  /**
   * Builds the dropdown-states map for `clients.<id>.mode`. Includes the
   * `0='---'` no-choice fallback (analogous to the govee-smart pattern), the
   * `'global'` + `'manual'` sentinels, and all currently discovered URLs.
   */
  private buildModeStates(): UrlStates {
    // v1.20.0 (F4): the shared helper (state-write-rules.ts). global-config used to
    // duplicate it — except for the extra `global` sentinel here: a client can delegate
    // to global with `mode='global'`, global itself cannot.
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
   * @param record        Client to create or ensure objects for.
   * @param refreshStates  When true (runtime) the mode dropdown states are compared and
   *                       refreshed; when false (restore, before URL discovery) only a
   *                       broken schema is repaired and states are left untouched (L1).
   * @param storedVersion  The `native.objectsVersion` this client's objects were last
   *                       written with. Equal to {@link CLIENT_OBJECTS_VERSION} → the texts
   *                       are current and only EXISTENCE is guaranteed (no write). Older or
   *                       missing → the texts are refreshed once and the stamp is renewed.
   *                       Defaults to 0 (unknown) so `createClient` always writes in full.
   */
  private async ensureObjects(record: ClientRecord, refreshStates = true, storedVersion = 0): Promise<void> {
    const { id, cookie, ip, hostname } = record;
    const mergedStates = this.buildModeStates();
    // Whether the four per-client texts have to be (re)written this start. See
    // CLIENT_OBJECTS_VERSION: v1.41.0 wrote them unconditionally — four broker calls per
    // display per start to deliver a text that changes about once a year.
    const textsCurrent = storedVersion === CLIENT_OBJECTS_VERSION;

    // Device (I22 v1.37.0): each client is a `device` — it represents a physical
    // display, matching the ioBroker convention (and govee-smart) of `device` for a
    // physical thing. Legacy `channel` client objects are migrated to `device` on
    // restore (see restoreChannel). setObjectNotExistsAsync — common.name is updated
    // dynamically by updateIpHostname() when reverse-DNS resolves; we must not clobber it.
    // v1.41.0: the auto-name goes in as a translation object like every other name
    // (core team, nut2 #15). The TEXT is unchanged — it is the display's own hostname
    // (or its IP / id); `tRaw` only offers it under every language key so the object
    // browser shows it whatever the system language is.
    // A freshly created device carries the current text revision from the start: its
    // objects are written with the current texts below, so the separate stamp write
    // and the second name write of the old create path were two writes for nothing
    // (audit 2026-09-15, G2). On restore the object exists and this is a no-op.
    await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
      type: "device",
      common: { name: tRaw(hostname ?? ip ?? id) },
      native: { cookie, token: null, objectsVersion: CLIENT_OBJECTS_VERSION },
    });

    // States:
    //   - `clients.<id>.mode` uses get + one full write (replaceObjectPreservingValue,
    //     like the `global-config.ts` v1.27.2 fix): extendObject deep-merges
    //     common.states, so old i18n-object keys from pre-v1.28.4 installs stayed
    //     under the same keys → React error #31 when the admin opened the dropdown.
    //     The full write replaces common wholesale (custom subscriptions such as
    //     influxdb.0 survive via the spread of `existing`).
    //   - The repair path for partially formed objects (v1.2.0 migration bug: common
    //     without top-level type/name/role) is covered too: the existing fields are
    //     overwritten completely by the full schema common.
    //   - `clients.<id>.manualUrl` stays extendObject — it has no states field, so
    //     no risk of an i18n object there.
    const modeFullCommon: ioBroker.StateCommon = {
      // tName returns StringOrTranslated, which common.name/desc accept directly.
      name: tName("clientMode"),
      // M3 (v1.38.0): explain the mode dropdown (incl. the "---" landing-page option)
      // right on the datapoint. New/repaired objects carry it; existing valid objects
      // are intentionally not rewritten just to add a doc field (would defeat L1).
      desc: tName("clientModeDesc"),
      // 'mixed' future-proofs against the upcoming js-controller
      // strict-type cast (see govee-smart v1.11.0 pattern).
      type: "mixed",
      role: "state",
      read: true,
      write: true,
      // I19: no-choice sentinel is the STRING "0" everywhere (matches the dropdown key
      // built by buildDropdownStates); a numeric default would be a lone drift from
      // that convention. v1.38.0 (I2).
      def: NO_CHOICE,
      states: mergedStates,
    };
    const ensureModeObject = async (refreshStates: boolean): Promise<void> => {
      const path = `clients.${id}.mode`;
      const existing = await this.adapter.getObjectAsync(path);
      if (!existing) {
        await this.adapter.setObjectNotExistsAsync(path, { type: "state", common: modeFullCommon, native: {} });
        return;
      }
      // ensureObjects runs on every restart for every client. Skip the rewrite when the
      // object already matches the desired schema — an unconditional replace was 1
      // write/client/start plus an objectChange fan-out for no change (I6). On the
      // RESTORE pass (refreshStates=false) currentUrlStates is still empty (discovery
      // runs later), so mergedStates carries no URL keys; comparing/writing states here
      // would STRIP the persisted URLs only for syncUrlDropdown to write them straight
      // back — 2× object replace per client per restart (L1 v1.38.0). syncUrlDropdown
      // is the single states authority, so on restore we repair only a broken schema
      // and never touch states.
      const c = existing.common;
      const schemaOk = existing.type === "state" && c?.type === "mixed" && c.role === "state";
      const statesOk = refreshStates ? shallowStatesEqual(c?.states, mergedStates) : true;
      if (schemaOk && statesOk) {
        return;
      }
      // The name/desc of `.mode` are the adapter's own text (tName), never the user's —
      // a broken schema is repaired with the CURRENT text, not with whatever the tree
      // held (audit 2026-09-15, E3; the device name is the user-owned one, not this).
      const preservedStates = refreshStates ? mergedStates : (c?.states ?? mergedStates);
      existing.common = { ...c, ...modeFullCommon, states: preservedStates };
      existing.type = "state";
      await replaceObjectPreservingValue(this.adapter, path, existing);
    };
    // v1.41.0: the schema pass above deliberately keeps whatever name is in the tree
    // (and returns early when the schema is fine), so the CURRENT text can only reach an
    // existing object through its own `extendObject`. Sequenced AFTER the schema pass —
    // running both concurrently would let the full-object replace overwrite this write.
    // Only name/desc go in: `states` stays with syncUrlDropdown, its single authority,
    // and `extendObject` deep-merges `states` (v1.27.2).
    const refreshModeText = async (): Promise<void> => {
      await ensureModeObject(refreshStates);
      if (!textsCurrent) {
        await this.adapter.extendObject(`clients.${id}.mode`, {
          common: { name: tName("clientMode"), desc: tName("clientModeDesc") },
        });
      }
    };

    // The three plain states. `extendObject` carries a CHANGED text into an object that
    // already exists (what `setObjectNotExists` never did — measured on the live tree
    // 2026-09-03: `.ip` still read "Client IP", `.remove` "Forget this client"), but it
    // also writes when nothing changed. So: write in full only while the stamp is behind,
    // and otherwise fall back to `setObjectNotExists`, which still RE-CREATES an object
    // somebody deleted in the object browser but writes nothing when it is there.
    const stateSchemas: Array<[string, ioBroker.StateCommon]> = [
      [
        `clients.${id}.manualUrl`,
        {
          name: tName("clientManualUrl"),
          desc: tName("clientManualUrlDesc"),
          type: "string",
          role: "url",
          read: true,
          write: true,
          def: "",
        },
      ],
      [
        `clients.${id}.ip`,
        { name: tName("clientIp"), type: "string", role: "info.ip", read: true, write: false, def: "" },
      ],
      [
        // Read-only: what the resolver ACTUALLY answered for this display. `mode` shows the
        // CHOICE; with `mode = global` the user had to walk the chain (global.mode → maybe
        // global.manualUrl) by hand to learn where the display went. The adapter computes
        // this on every request anyway — it just never wrote it down.
        `clients.${id}.resolvedUrl`,
        {
          name: tName("clientResolvedUrl"),
          desc: tName("clientResolvedUrlDesc"),
          type: "string",
          role: "url",
          read: true,
          write: false,
          def: "",
        },
      ],
      [
        `clients.${id}.remove`,
        {
          name: tName("clientRemove"),
          desc: tName("clientRemoveDesc"),
          type: "boolean",
          role: "button",
          read: false,
          write: true,
          def: false,
        },
      ],
    ];

    await Promise.all([
      refreshModeText(),
      ...stateSchemas.map(([path, common]) =>
        textsCurrent
          ? this.adapter.setObjectNotExistsAsync(path, { type: "state", common, native: {} })
          : this.adapter.extendObject(path, { type: "state", common, native: {} }),
      ),
    ]);

    // Stamp the revision so the next start can skip the refresh above. Written only when
    // it actually moved — otherwise this would be the very write it exists to avoid.
    if (!textsCurrent) {
      await this.adapter
        .extendObject(`clients.${id}`, { native: { objectsVersion: CLIENT_OBJECTS_VERSION } })
        .catch(err => this.adapter.log.debug(`client-registry: version stamp failed for ${id}: ${errText(err)}`));
    }
  }

  private async createObjects(record: ClientRecord): Promise<void> {
    // The objects of a new display are created with the current texts — the revision
    // is current by construction, so ensureObjects takes the existence-only path.
    await this.ensureObjects(record, true, CLIENT_OBJECTS_VERSION);
    const { id, mode, ip } = record;
    await Promise.all([
      this.adapter.setState(`clients.${id}.ip`, { val: ip ?? "", ack: true }),
      this.adapter.setState(`clients.${id}.mode`, { val: mode, ack: true }),
      this.adapter.setState(`clients.${id}.manualUrl`, { val: "", ack: true }),
    ]);
  }

  /**
   * Store a display's new address, and carry it into the device name while that name is still
   * the previous auto-address.
   *
   * @param record The display.
   * @param ip     Its new address.
   */
  private async applyIpChange(record: ClientRecord, ip: string): Promise<void> {
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
      // Only the previous auto-IP counts as "auto" here — deliberately NOT record.id:
      // a web request always carries an IP, so a client is never id-named in practice,
      // and keeping the set minimal preserves the exact pre-v1.38.0 behavior. L4.
      await this.applyAutoName(record.id, ip, [previousIp]);
    }
  }

  private async updateIpHostname(record: ClientRecord, ip: string | null, hostname: string | null): Promise<void> {
    if (ip && ip !== record.ip) {
      const now = Date.now();
      // At most one address change per window: with trustProxy the address is a
      // client-supplied header, and every rotated value cost a state and an object write
      // (audit 2026-09-25, H4). Neither memory nor state moves inside the window — updating
      // memory alone would leave the datapoint stale for good.
      if (now - (this.ipChangedAt.get(record.id) ?? 0) < IP_CHANGE_MIN_INTERVAL_MS) {
        this.adapter.log.silly(`client-registry: address change for ${record.id} deferred (at most one per minute)`);
      } else {
        this.ipChangedAt.set(record.id, now);
        await this.applyIpChange(record, ip);
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
    await this.applyAutoName(record.id, hostname, [previousHostname, record.ip, record.id]);
  }

  /**
   * Write `newName` to the client channel's `common.name`, but ONLY when the current
   * name is still an auto-assigned value (one of `autoValues`, or unset) — never clobber
   * a name the user set in the admin UI. onObjectChange does not observe clients.* renames,
   * so record.hostname can't be relied on; this read-before-overwrite is the guard. The IP
   * branch and the reverse-DNS branch shared this logic verbatim before it was consolidated
   * here. v1.36.0 (C4) / v1.37.0 (M1) / v1.38.0 (L4).
   *
   * @param recordId   Client id (channel is `clients.<recordId>`).
   * @param newName    Name to write when the current one is still auto.
   * @param autoValues Values considered auto-assigned (a null entry never matches a string name).
   */
  private async applyAutoName(recordId: string, newName: string, autoValues: (string | null)[]): Promise<void> {
    const obj = await this.adapter.getObjectAsync(`clients.${recordId}`);
    const currentName = obj?.common?.name;
    // v1.41.0: the name is a translation object now, so the "is it still auto?" test
    // reads the TEXT out of either form (`nameText`). Comparing the raw value would
    // never match once converted — every display would look user-renamed and the
    // hostname/IP update would silently stop working.
    const currentText = nameText(currentName);
    const isAutoName = currentName === undefined || (currentText !== null && autoValues.includes(currentText));
    if (isAutoName) {
      await this.adapter.extendObject(`clients.${recordId}`, { common: { name: tRaw(newName) } });
    }
  }

  private async readState(subId: string): Promise<unknown> {
    // v1.20.0 (F10): the shared helper (object-utils.ts) — global-config.safeGetState
    // used to duplicate it (same try/catch + null fallback, only the path prefix
    // differed).
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
  // v1.20.0 (F9): the generic parseAdapterStateId helper. client-registry used to
  // duplicate the prefix + tail validation of global-config.parseGlobalStateId.
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
