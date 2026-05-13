"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var client_registry_exports = {};
__export(client_registry_exports, {
  ClientRegistry: () => ClientRegistry,
  parseClientStateId: () => parseClientStateId
});
module.exports = __toCommonJS(client_registry_exports);
var import_node_crypto = __toESM(require("node:crypto"));
var import_coerce = require("./coerce");
var import_constants = require("./constants");
var import_i18n_states = require("./i18n-states");
var import_network = require("./network");
const CLIENTS_PREFIX = "clients.";
class ClientRegistry {
  adapter;
  byCookie = /* @__PURE__ */ new Map();
  byId = /* @__PURE__ */ new Map();
  byToken = /* @__PURE__ */ new Map();
  byRefreshToken = /* @__PURE__ */ new Map();
  currentUrlStates = {};
  newClientModeProvider = () => import_constants.MODE_GLOBAL;
  /**
   * In-flight client creations keyed by remote IP. Keeps parallel cookieless
   * requests from the same display (typical on first connect: HA clients fire
   * `GET /`, `GET /api/`, `POST /auth/login_flow` almost simultaneously) from
   * each creating a separate client record. The first request starts the
   * create; parallel requests await the same Promise and receive the same
   * client + cookie.
   */
  pendingByIp = /* @__PURE__ */ new Map();
  /**
   * Throttle for lastSeen-updates per client. Keyed by client id, value is the
   * last `Date.now()` we wrote `native.lastSeen` to ioBroker. Throttle window
   * is one hour — saves us extendObject roundtrips on every request.
   */
  lastSeenFlushedAt = /* @__PURE__ */ new Map();
  /**
   * v1.19.0 (G5): per-IP burst tracking für broken-cookie-Displays.
   * Wenn eine IP > 3 neue Clients in einer Stunde erzeugt, kommt ein
   * einmaliger warn-log mit Hinweis (cookie-Persistenz auf Display kaputt).
   */
  newClientBurst = /* @__PURE__ */ new Map();
  /** @param adapter Adapter instance used for object/state I/O. */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /**
   * Wires the default-mode provider used when a new client is registered.
   * Called from main.ts once registry, globalConfig and urlDiscovery exist.
   *
   * @param provider Function returning the desired default mode for a new client.
   */
  setNewClientModeProvider(provider) {
    this.newClientModeProvider = provider;
  }
  /** Loads existing clients from ioBroker objects into memory. Call once on adapter start. */
  async restore() {
    var _a, _b;
    let channels = {};
    try {
      channels = (_a = await this.adapter.getForeignObjectsAsync(`${this.adapter.namespace}.clients.*`, "channel")) != null ? _a : {};
    } catch (err) {
      this.adapter.log.debug(`client-registry: restore failed: ${String(err)}`);
      return;
    }
    for (const [fullId, obj] of Object.entries(channels)) {
      const id = fullId.substring(`${this.adapter.namespace}.clients.`.length);
      if (!id || id.includes(".")) {
        continue;
      }
      try {
        const native = (0, import_coerce.isPlainObject)(obj.native) ? obj.native : {};
        const cookie = (0, import_coerce.coerceUuid)(native.cookie);
        if (!cookie) {
          continue;
        }
        const [modeRaw, manualUrlRaw, ipRaw, hostnameRaw] = await Promise.all([
          this.readState(`${id}.mode`),
          this.readState(`${id}.manualUrl`),
          this.readState(`${id}.ip`),
          this.readState(`${id}.hostname`)
        ]);
        const mode = typeof modeRaw === "string" ? modeRaw : "";
        const manualUrl = (0, import_coerce.coerceSafeUrl)(manualUrlRaw);
        const ip = (0, import_coerce.coerceString)(ipRaw);
        const token = (0, import_coerce.coerceUuid)(native.token);
        const refreshToken = (0, import_coerce.coerceUuid)(native.refreshToken);
        const legacyHostname = (0, import_coerce.coerceString)(hostnameRaw);
        let channelName = (0, import_coerce.coerceString)((_b = obj.common) == null ? void 0 : _b.name);
        if (legacyHostname) {
          if (legacyHostname !== channelName) {
            await this.adapter.extendObjectAsync(`clients.${id}`, { common: { name: legacyHostname } });
            channelName = legacyHostname;
          }
          try {
            await this.adapter.delObjectAsync(`clients.${id}.hostname`);
          } catch {
          }
        }
        const hostname = channelName && channelName !== ip && channelName !== id ? channelName : null;
        const record = { id, cookie, token, refreshToken, mode, manualUrl, ip, hostname };
        this.trackInMemory(record);
        await this.ensureObjects(record);
        const modeStateRaw = await this.readState(`${id}.mode`);
        if (modeStateRaw === "" || modeStateRaw === null || modeStateRaw === void 0) {
          await this.adapter.setStateAsync(`clients.${id}.mode`, { val: 0, ack: true });
        }
      } catch (err) {
        this.adapter.log.debug(`client-registry: skipping ${id} during restore \u2014 ${String(err)}`);
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
  async identifyOrCreate(cookie, ip, hostname, userAgent = null) {
    const validCookie = (0, import_coerce.coerceUuid)(cookie);
    if (validCookie) {
      const existing = this.byCookie.get(validCookie);
      if (existing) {
        await this.updateIpHostname(existing, ip, hostname);
        this.touchLastSeen(existing);
        return existing;
      }
    }
    if (ip) {
      const bucketKey = userAgent ? `${ip}|${import_node_crypto.default.createHash("sha256").update(userAgent).digest("hex").substring(0, 12)}` : ip;
      const pending = this.pendingByIp.get(bucketKey);
      if (pending) {
        return pending.catch((err) => {
          this.adapter.log.debug(
            `client-registry: pending createClient for ${bucketKey} rejected: ${String(err)}`
          );
          throw err;
        });
      }
      const promise = this.createClient(ip, hostname);
      this.pendingByIp.set(bucketKey, promise);
      try {
        return await promise;
      } catch (err) {
        this.adapter.log.debug(
          `client-registry: createClient failed for IP ${ip}: ${err instanceof Error ? err.message : String(err)}`
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
  getById(id) {
    var _a;
    return (_a = this.byId.get(id)) != null ? _a : null;
  }
  /**
   * Lookup by cookie value. Invalid UUIDs return null.
   *
   * @param cookie Raw cookie string.
   */
  getByCookie(cookie) {
    var _a;
    const v = (0, import_coerce.coerceUuid)(cookie);
    return v ? (_a = this.byCookie.get(v)) != null ? _a : null : null;
  }
  /**
   * Lookup by access token issued during the auth flow.
   *
   * @param token Bearer token.
   */
  getByToken(token) {
    var _a;
    return (_a = this.byToken.get(token)) != null ? _a : null;
  }
  /**
   * Lookup by refresh token issued during the auth flow.
   *
   * @param refreshToken Refresh token value.
   */
  getByRefreshToken(refreshToken) {
    var _a;
    return (_a = this.byRefreshToken.get(refreshToken)) != null ? _a : null;
  }
  /** Returns a snapshot array of all registered clients. */
  listAll() {
    return [...this.byId.values()];
  }
  /**
   * Updates in-memory token and persists to channel.native. Old token is freed.
   *
   * @param id    Client id.
   * @param token New bearer token, or null to clear.
   */
  async setToken(id, token) {
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
   * Updates in-memory refresh token and persists to channel.native. Old refresh
   * token is freed. Stored plain-text in `clients.<id>.native.refreshToken` —
   * same exposure profile as the access token (see {@link ClientRecord.refreshToken}).
   *
   * @param id           Client id.
   * @param refreshToken New refresh token, or null to clear.
   */
  async setRefreshToken(id, refreshToken) {
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
    await this.adapter.extendObjectAsync(`clients.${id}`, { native: { refreshToken } });
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
  async handleModeWrite(id, rawValue) {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    const result = (0, import_coerce.parseModeWrite)(rawValue, [import_constants.MODE_GLOBAL, import_constants.MODE_MANUAL]);
    switch (result.kind) {
      case "no-choice":
        record.mode = "";
        await this.adapter.setStateAsync(`clients.${id}.mode`, { val: 0, ack: true });
        return;
      case "rejected-non-string":
        this.adapter.log.debug(`client-registry: rejected non-string mode for ${id}`);
        await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode || 0, ack: true });
        return;
      case "sentinel":
        if (result.value === import_constants.MODE_MANUAL && !record.manualUrl) {
          this.adapter.log.warn(
            `Client ${id}: mode set to "manual" but manualUrl is empty \u2014 fill clients.${id}.manualUrl to redirect`
          );
        }
        record.mode = result.value;
        await this.adapter.setStateAsync(`clients.${id}.mode`, { val: result.value, ack: true });
        return;
      case "rejected-unsafe-url":
        this.adapter.log.warn(`Client ${id}: rejected unsafe mode value "${result.raw}"`);
        await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode, ack: true });
        return;
      case "url":
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
  async handleManualUrlWrite(id, rawValue) {
    var _a, _b;
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    const result = (0, import_coerce.parseManualUrlWrite)(rawValue);
    if (!result.ok) {
      this.adapter.log.warn(`Client ${id}: rejected unsafe manualUrl value`);
      await this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: (_a = record.manualUrl) != null ? _a : "", ack: true });
      return;
    }
    record.manualUrl = result.safe;
    await this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: (_b = result.safe) != null ? _b : "", ack: true });
    if (record.mode === import_constants.MODE_MANUAL && !result.safe) {
      this.adapter.log.warn(
        `Client ${id}: manualUrl cleared while mode is "manual" \u2014 display will see the setup page`
      );
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
  async bulkSetMode(value) {
    const writes = [];
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
  async remove(id) {
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
    this.lastSeenFlushedAt.delete(id);
    try {
      await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
    } catch (err) {
      this.adapter.log.debug(`client-registry: delObject failed for ${id}: ${String(err)}`);
    }
    this.adapter.log.info(`Client forgotten: ${id}`);
  }
  /**
   * Updates the mode dropdown states (`common.states`) on every client's mode datapoint.
   * Adds the `'global'` and `'manual'` sentinels on top of the discovered URLs.
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states) {
    this.currentUrlStates = states;
    const merged = this.buildModeStates();
    await Promise.all(
      Array.from(this.byId.keys()).map(async (id) => {
        const stateId = `clients.${id}.mode`;
        const existing = await this.adapter.getObjectAsync(stateId);
        if (!existing) {
          return;
        }
        existing.common.states = merged;
        await this.adapter.setObjectAsync(stateId, existing);
      })
    );
  }
  // --- internal ---
  trackInMemory(record) {
    this.byId.set(record.id, record);
    this.byCookie.set(record.cookie, record);
    if (record.token) {
      this.byToken.set(record.token, record);
    }
    if (record.refreshToken) {
      this.byRefreshToken.set(record.refreshToken, record);
    }
  }
  async createClient(ip, hostname) {
    let id = (0, import_network.generateClientId)();
    while (this.byId.has(id)) {
      id = (0, import_network.generateClientId)();
    }
    const cookie = import_node_crypto.default.randomUUID();
    const mode = this.newClientModeProvider();
    const record = {
      id,
      cookie,
      token: null,
      refreshToken: null,
      mode,
      manualUrl: null,
      ip,
      hostname
    };
    this.trackInMemory(record);
    await this.createObjects(record);
    this.touchLastSeen(record);
    this.adapter.log.info(ip ? `New client connected: ${id} (${hostname != null ? hostname : ip})` : `New client connected: ${id}`);
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
  recordNewClientIp(ip) {
    var _a;
    const now = Date.now();
    const HOUR = 60 * 60 * 1e3;
    const entry = (_a = this.newClientBurst.get(ip)) != null ? _a : { count: 0, since: now, warnedAt: 0 };
    if (now - entry.since > HOUR) {
      entry.count = 0;
      entry.since = now;
    }
    entry.count += 1;
    if (entry.count > 3 && now - entry.warnedAt > HOUR) {
      this.adapter.log.warn(
        `IP ${ip} created ${entry.count} clients within an hour \u2014 display likely is not persisting cookies (privacy mode? refresh bug?)`
      );
      entry.warnedAt = now;
    }
    this.newClientBurst.set(ip, entry);
    if (this.newClientBurst.size > 200) {
      const oldest = this.newClientBurst.keys().next().value;
      if (oldest !== void 0) {
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
  touchLastSeen(record) {
    var _a;
    const now = Date.now();
    const last = (_a = this.lastSeenFlushedAt.get(record.id)) != null ? _a : 0;
    if (now - last < 60 * 60 * 1e3) {
      return;
    }
    this.lastSeenFlushedAt.set(record.id, now);
    this.adapter.extendObjectAsync(`clients.${record.id}`, { native: { lastSeen: now } }).catch((err) => this.adapter.log.debug(`touchLastSeen failed for ${record.id}: ${String(err)}`));
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
  async seedLastSeen(id, now = Date.now()) {
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
  buildModeStates() {
    const lang = this.adapter.systemLanguage;
    return (0, import_coerce.buildDropdownStates)(
      {
        [import_constants.MODE_GLOBAL]: (0, import_i18n_states.resolveLabel)("globalUrl", lang),
        [import_constants.MODE_MANUAL]: (0, import_i18n_states.resolveLabel)("manualUrl", lang)
      },
      this.currentUrlStates
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
  async ensureObjects(record) {
    var _a;
    const { id, cookie, ip, hostname } = record;
    const mergedStates = this.buildModeStates();
    await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
      type: "channel",
      common: { name: (_a = hostname != null ? hostname : ip) != null ? _a : id },
      native: { cookie, token: null }
    });
    const modeFullCommon = {
      name: (0, import_i18n_states.tName)("clientMode"),
      // 'mixed' future-proofs against the upcoming js-controller
      // strict-type cast (see govee-smart v1.11.0 pattern).
      type: "mixed",
      role: "value",
      read: true,
      write: true,
      def: 0,
      states: mergedStates
    };
    const ensureModeObject = async () => {
      const existing = await this.adapter.getObjectAsync(`clients.${id}.mode`);
      if (existing) {
        existing.common = { ...existing.common, ...modeFullCommon };
        existing.type = "state";
        await this.adapter.setObjectAsync(`clients.${id}.mode`, existing);
      } else {
        await this.adapter.setObjectAsync(`clients.${id}.mode`, {
          type: "state",
          common: modeFullCommon,
          native: {}
        });
      }
    };
    await Promise.all([
      ensureModeObject(),
      this.adapter.extendObjectAsync(`clients.${id}.manualUrl`, {
        type: "state",
        common: {
          name: (0, import_i18n_states.tName)("clientManualUrl"),
          type: "string",
          role: "url",
          read: true,
          write: true,
          def: ""
        },
        native: {}
      }),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.ip`, {
        type: "state",
        common: {
          name: (0, import_i18n_states.tName)("clientIp"),
          type: "string",
          role: "info.ip",
          read: true,
          write: false,
          def: ""
        },
        native: {}
      }),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.remove`, {
        type: "state",
        common: {
          name: (0, import_i18n_states.tName)("clientRemove"),
          type: "boolean",
          role: "button",
          read: false,
          write: true,
          def: false
        },
        native: {}
      })
    ]);
  }
  async createObjects(record) {
    await this.ensureObjects(record);
    const { id, mode, ip } = record;
    await Promise.all([
      this.adapter.setStateAsync(`clients.${id}.ip`, { val: ip != null ? ip : "", ack: true }),
      this.adapter.setStateAsync(`clients.${id}.mode`, { val: mode, ack: true }),
      this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: "", ack: true })
    ]);
  }
  async updateIpHostname(record, ip, hostname) {
    if (ip && ip !== record.ip) {
      record.ip = ip;
      await this.adapter.setStateAsync(`clients.${record.id}.ip`, { val: ip, ack: true });
      if (!record.hostname) {
        await this.adapter.extendObjectAsync(`clients.${record.id}`, { common: { name: ip } });
      }
    }
    if (hostname && hostname !== record.hostname) {
      record.hostname = hostname;
      await this.adapter.extendObjectAsync(`clients.${record.id}`, { common: { name: hostname } });
    }
  }
  async readState(subId) {
    var _a;
    const s = await (0, import_coerce.safeGetState)(this.adapter, `clients.${subId}`);
    return (_a = s == null ? void 0 : s.val) != null ? _a : null;
  }
}
function parseClientStateId(fullId, namespace) {
  const parts = (0, import_coerce.parseAdapterStateId)(fullId, namespace, CLIENTS_PREFIX, 2);
  if (!parts) {
    return null;
  }
  const [id, kind] = parts;
  if (!id) {
    return null;
  }
  if (kind !== "mode" && kind !== "manualUrl" && kind !== "remove") {
    return null;
  }
  return { id, kind };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ClientRegistry,
  parseClientStateId
});
//# sourceMappingURL=client-registry.js.map
