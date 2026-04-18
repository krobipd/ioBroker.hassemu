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
var import_network = require("./network");
const CLIENTS_PREFIX = "clients.";
class ClientRegistry {
  adapter;
  byCookie = /* @__PURE__ */ new Map();
  byId = /* @__PURE__ */ new Map();
  byToken = /* @__PURE__ */ new Map();
  currentUrlStates = {};
  /** @param adapter Adapter instance used for object/state I/O. */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /** Loads existing clients from ioBroker objects into memory. Call once on adapter start. */
  async restore() {
    var _a;
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
      const visUrl = (0, import_coerce.coerceSafeUrl)(await this.readState(`${id}.visUrl`));
      const ip = (0, import_coerce.coerceString)(await this.readState(`${id}.ip`));
      const hostname = (0, import_coerce.coerceString)(await this.readState(`${id}.hostname`));
      const token = (0, import_coerce.coerceUuid)(native.token);
      const record = { id, cookie, token, visUrl, ip, hostname };
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
   * Accept an external visUrl write on `clients.<id>.visUrl`.
   * Unsafe URLs are rejected (state is reset to the current value).
   * Empty string / null clears the override — client falls back to global
   * URL or the setup page.
   *
   * @param id       Client id.
   * @param rawValue Value written to the state (any type — coerced + validated).
   */
  async handleVisUrlWrite(id, rawValue) {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    const empty = rawValue === "" || rawValue === null || rawValue === void 0;
    const safe = empty ? null : (0, import_coerce.coerceSafeUrl)(rawValue);
    if (!empty && !safe) {
      this.adapter.log.warn(`client-registry: rejected unsafe visUrl for ${id}`);
      await this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: record.visUrl, ack: true });
      return;
    }
    record.visUrl = safe;
    await this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: safe != null ? safe : "", ack: true });
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
   * Updates the visUrl dropdown states (common.states) on every client's visUrl datapoint.
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states) {
    this.currentUrlStates = states;
    for (const id of this.byId.keys()) {
      await this.adapter.extendObjectAsync(`clients.${id}.visUrl`, {
        common: { states: { ...states } }
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
    const record = { id, cookie, token: null, visUrl: null, ip, hostname };
    this.trackInMemory(record);
    await this.createObjects(record);
    this.adapter.log.info(`New client registered: ${id}${ip ? ` (${hostname != null ? hostname : ip})` : ""}`);
    return record;
  }
  async createObjects(record) {
    var _a;
    const { id, cookie, ip, hostname } = record;
    await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
      type: "channel",
      common: { name: (_a = hostname != null ? hostname : ip) != null ? _a : id },
      native: { cookie, token: null }
    });
    await this.adapter.setObjectNotExistsAsync(`clients.${id}.visUrl`, {
      type: "state",
      common: {
        name: "Redirect URL",
        type: "string",
        role: "url",
        read: true,
        write: true,
        def: "",
        states: { ...this.currentUrlStates }
      },
      native: {}
    });
    await this.adapter.setObjectNotExistsAsync(`clients.${id}.ip`, {
      type: "state",
      common: { name: "Client IP", type: "string", role: "info.ip", read: true, write: false, def: "" },
      native: {}
    });
    await this.adapter.setObjectNotExistsAsync(`clients.${id}.hostname`, {
      type: "state",
      common: {
        name: "Client hostname",
        type: "string",
        role: "info.name",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.adapter.setObjectNotExistsAsync(`clients.${id}.remove`, {
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
    });
    await this.adapter.setStateAsync(`clients.${id}.ip`, { val: ip != null ? ip : "", ack: true });
    await this.adapter.setStateAsync(`clients.${id}.hostname`, { val: hostname != null ? hostname : "", ack: true });
    await this.adapter.setStateAsync(`clients.${id}.visUrl`, { val: "", ack: true });
  }
  async updateIpHostname(record, ip, hostname) {
    if (ip && ip !== record.ip) {
      record.ip = ip;
      await this.adapter.setStateAsync(`clients.${record.id}.ip`, { val: ip, ack: true });
    }
    if (hostname && hostname !== record.hostname) {
      record.hostname = hostname;
      await this.adapter.setStateAsync(`clients.${record.id}.hostname`, {
        val: hostname,
        ack: true
      });
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
  if (kind !== "visUrl" && kind !== "remove") {
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
