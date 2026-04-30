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
var import_global_config = require("./global-config");
var import_network = require("./network");
const CLIENTS_PREFIX = "clients.";
class ClientRegistry {
  adapter;
  byCookie = /* @__PURE__ */ new Map();
  byId = /* @__PURE__ */ new Map();
  byToken = /* @__PURE__ */ new Map();
  currentUrlStates = {};
  newClientModeProvider = () => import_global_config.MODE_GLOBAL;
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
      const native = (0, import_coerce.isPlainObject)(obj.native) ? obj.native : {};
      const cookie = (0, import_coerce.coerceUuid)(native.cookie);
      if (!cookie) {
        continue;
      }
      const modeRaw = await this.readState(`${id}.mode`);
      const mode = typeof modeRaw === "string" ? modeRaw : "";
      const manualUrl = (0, import_coerce.coerceSafeUrl)(await this.readState(`${id}.manualUrl`));
      const ip = (0, import_coerce.coerceString)(await this.readState(`${id}.ip`));
      const token = (0, import_coerce.coerceUuid)(native.token);
      const legacyHostname = (0, import_coerce.coerceString)(await this.readState(`${id}.hostname`));
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
      const record = { id, cookie, token, mode, manualUrl, ip, hostname };
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
  async identifyOrCreate(cookie, ip, hostname) {
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
    if (typeof rawValue !== "string") {
      this.adapter.log.warn(`client-registry: rejected non-string mode for ${id}`);
      await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode, ack: true });
      return;
    }
    if (rawValue === "") {
      record.mode = "";
      await this.adapter.setStateAsync(`clients.${id}.mode`, { val: "", ack: true });
      return;
    }
    if (rawValue === import_global_config.MODE_GLOBAL || rawValue === import_global_config.MODE_MANUAL) {
      if (rawValue === import_global_config.MODE_MANUAL && !record.manualUrl) {
        this.adapter.log.warn(
          `client-registry: ${id} mode set to 'manual' but manualUrl is empty \u2014 fill clients.${id}.manualUrl to redirect`
        );
      }
      record.mode = rawValue;
      await this.adapter.setStateAsync(`clients.${id}.mode`, { val: rawValue, ack: true });
      return;
    }
    const safe = (0, import_coerce.coerceSafeUrl)(rawValue);
    if (!safe) {
      this.adapter.log.warn(`client-registry: rejected unsafe mode value for ${id}: '${rawValue}'`);
      await this.adapter.setStateAsync(`clients.${id}.mode`, { val: record.mode, ack: true });
      return;
    }
    record.mode = safe;
    await this.adapter.setStateAsync(`clients.${id}.mode`, { val: safe, ack: true });
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
      this.adapter.log.warn(`client-registry: rejected unsafe manualUrl for ${id}`);
      await this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: (_a = record.manualUrl) != null ? _a : "", ack: true });
      return;
    }
    record.manualUrl = result.safe;
    await this.adapter.setStateAsync(`clients.${id}.manualUrl`, { val: (_b = result.safe) != null ? _b : "", ack: true });
    if (record.mode === import_global_config.MODE_MANUAL && !result.safe) {
      this.adapter.log.warn(
        `client-registry: ${id} manualUrl cleared while mode='manual' \u2014 display will hit the setup page`
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
    let changed = 0;
    for (const record of this.byId.values()) {
      if (record.mode === value) {
        continue;
      }
      record.mode = value;
      await this.adapter.setStateAsync(`clients.${record.id}.mode`, { val: value, ack: true });
      changed++;
    }
    if (changed > 0) {
      this.adapter.log.info(`client-registry: bulk-set mode='${value}' on ${changed} client(s)`);
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
    try {
      await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
    } catch (err) {
      this.adapter.log.warn(`client-registry: delObject failed for ${id}: ${String(err)}`);
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
    const merged = {
      [import_global_config.MODE_GLOBAL]: "Global URL",
      [import_global_config.MODE_MANUAL]: "Manual URL",
      ...states
    };
    for (const id of this.byId.keys()) {
      await this.adapter.extendObjectAsync(`clients.${id}.mode`, {
        common: { states: merged }
      });
    }
  }
  // --- internal ---
  trackInMemory(record) {
    this.byId.set(record.id, record);
    this.byCookie.set(record.cookie, record);
    if (record.token) {
      this.byToken.set(record.token, record);
    }
  }
  async createClient(ip, hostname) {
    let id = (0, import_network.generateClientId)();
    while (this.byId.has(id)) {
      id = (0, import_network.generateClientId)();
    }
    const cookie = import_node_crypto.default.randomUUID();
    const mode = this.newClientModeProvider();
    const record = { id, cookie, token: null, mode, manualUrl: null, ip, hostname };
    this.trackInMemory(record);
    await this.createObjects(record);
    this.touchLastSeen(record);
    this.adapter.log.info(`New client registered: ${id}${ip ? ` (${hostname != null ? hostname : ip})` : ""}, mode='${mode}'`);
    return record;
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
  async createObjects(record) {
    var _a;
    const { id, cookie, mode, ip, hostname } = record;
    const mergedStates = {
      [import_global_config.MODE_GLOBAL]: "Global URL",
      [import_global_config.MODE_MANUAL]: "Manual URL",
      ...this.currentUrlStates
    };
    await Promise.all([
      this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
        type: "channel",
        common: { name: (_a = hostname != null ? hostname : ip) != null ? _a : id },
        native: { cookie, token: null }
      }),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.mode`, {
        type: "state",
        common: {
          name: "Redirect mode",
          // 'mixed' future-proofs against the upcoming js-controller
          // strict-type cast (see govee-smart v1.11.0 pattern). User
          // can write Number/String/Sentinel from Blockly/scripts
          // without "expects type X but received Y" warnings.
          type: "mixed",
          role: "value",
          read: true,
          write: true,
          def: "",
          states: mergedStates
        },
        native: {}
      }),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.manualUrl`, {
        type: "state",
        common: {
          name: "Manual URL",
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
        common: { name: "Client IP", type: "string", role: "info.ip", read: true, write: false, def: "" },
        native: {}
      }),
      this.adapter.setObjectNotExistsAsync(`clients.${id}.remove`, {
        type: "state",
        common: {
          name: "Forget this client",
          type: "boolean",
          role: "button",
          read: false,
          write: true,
          def: false
        },
        native: {}
      })
    ]);
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
    try {
      const s = await this.adapter.getStateAsync(`clients.${subId}`);
      return (_a = s == null ? void 0 : s.val) != null ? _a : null;
    } catch {
      return null;
    }
  }
}
function parseClientStateId(fullId, namespace) {
  const prefix = `${namespace}.${CLIENTS_PREFIX}`;
  if (!fullId.startsWith(prefix)) {
    return null;
  }
  const tail = fullId.substring(prefix.length);
  const parts = tail.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [id, kind] = parts;
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
