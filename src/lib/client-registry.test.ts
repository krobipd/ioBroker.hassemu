import crypto from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", async () => {
  // The factory is hoisted above the imports — the shared translation lookup comes in here.
  const { realI18n } = await import("../../test/unit/i18n-stub.js");
  return { I18n: realI18n() };
});

import { ClientRegistry, parseClientStateId } from "./client-registry";
import { readStore, STORE_FILE, type StoredClient, writeStore } from "./client-store";
import { displayIcon } from "./device-icon";
import * as displayId from "./display-id";
import { tRaw } from "./i18n";
import {
  CLIENT_OBJECTS_VERSION,
  GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
  LASTSEEN_FLUSH_INTERVAL_MS,
  MODE_GLOBAL,
  NO_CHOICE,
  MODE_MANUAL,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S,
} from "./constants";
import type { ClientRecord } from "./types";
import { brokerDelObject, brokerExtend, brokerGetStates } from "../../test/unit/broker-stub";
import { TEST_CIPHER } from "../../test/unit/cipher";
import { freshDataDir, removeDataDirs } from "../../test/unit/data-dir";

/**
 * Rewrite the displays of the data file, keeping its server id (a fresh one before the first write).
 *
 * @param dir     The instance data folder.
 * @param clients Display id → entry.
 */
function rewriteClients(dir: string, clients: ReadonlyMap<string, StoredClient>): void {
  writeStore(dir, TEST_CIPHER, readStore(dir, TEST_CIPHER).server ?? crypto.randomUUID(), clients);
}

afterAll(removeDataDirs);

/**
 * A display's entry in the data file of a stub installation, read from disk like the next start would.
 *
 * @param store The stub installation.
 * @param id    Display id.
 */
const storedEntry = (store: MockStore, id: string): StoredClient | undefined =>
  readStore(store.dataDir, TEST_CIPHER).clients.get(id);

/**
 * Resolve a `common.name` to its plain text, whichever form it carries.
 *
 * Client names are translation objects since v1.41.0 (core team, nut2 #15) — the
 * adapter writes the same display-supplied text under every language key. These
 * tests assert on that TEXT; that the form really is a translation object has its
 * own test ("writes the client name as a translation object").
 *
 * @param name `common.name` as read from the mock store.
 */
const nameOf = (name: unknown): unknown =>
  name !== null && typeof name === "object" ? (name as Record<string, string>).en : name;

interface ObjEntry {
  type: string;
  common?: Record<string, unknown>;
  native?: Record<string, unknown>;
}

interface LogEntry {
  level: string;
  msg: string;
}

interface MockStore {
  namespace: string;
  objects: Map<string, ObjEntry>;
  states: Map<string, { val: unknown; ack: boolean; q?: number; c?: string }>;
  logs: LogEntry[];
  /** The instance data folder of this stub installation (identities.json). */
  dataDir: string;
  /** Every object write, in order — a test can assert HOW an object was written. */
  writes: { method: "extendObject" | "setForeignObject"; id: string; obj: Partial<ObjEntry> }[];
}

function createMockAdapter(namespace = "hassemu.0"): {
  store: MockStore;
  adapter: ReturnType<typeof buildAdapter>;
} {
  const store: MockStore = {
    namespace,
    dataDir: freshDataDir(),
    objects: new Map(),
    states: new Map(),
    logs: [],
    writes: [],
  };

  function buildAdapter(): {
    namespace: string;
    log: {
      silly: (m: string) => void;
      debug: (m: string) => void;
      info: (m: string) => void;
      warn: (m: string) => void;
      error: (m: string) => void;
    };
    setInterval: () => undefined;
    clearInterval: () => undefined;
    setTimeout: () => undefined;
    clearTimeout: () => undefined;
    getForeignObjectsAsync: (pattern: string, type?: string) => Promise<Record<string, ObjEntry>>;
    getAdapterObjectsAsync: () => Promise<Record<string, ObjEntry>>;
    getForeignObjectAsync: (fullId: string) => Promise<ObjEntry | null>;
    getStateAsync: (id: string) => Promise<{ val: unknown; ack: boolean } | null>;
    getStatesAsync: (pattern: string) => Promise<Record<string, { val: unknown; ack: boolean } | null>>;
    getObjectAsync: (id: string) => Promise<ObjEntry | null>;
    setForeignObject: (fullId: string, obj: ObjEntry) => Promise<void>;
    setObjectNotExistsAsync: (id: string, obj: ObjEntry) => Promise<void>;
    extendObject: (id: string, obj: Partial<ObjEntry>, options?: Record<string, unknown>) => Promise<void>;
    setState: (id: string, value: { val: unknown; ack?: boolean }, _ack?: boolean) => Promise<void>;
    setStateChangedAsync: (
      id: string,
      value: { val: unknown; ack?: boolean },
    ) => Promise<{ id: string; notChanged: boolean }>;
    delObjectAsync: (id: string, options?: { recursive?: boolean }) => Promise<void>;
    encrypt: (value: string) => string;
    decrypt: (value: string) => string;
  } {
    return {
      namespace,
      encrypt: TEST_CIPHER.encrypt,
      decrypt: TEST_CIPHER.decrypt,
      log: {
        silly: (m: string) => void store.logs.push({ level: "silly", msg: m }),
        debug: (m: string) => void store.logs.push({ level: "debug", msg: m }),
        info: (m: string) => void store.logs.push({ level: "info", msg: m }),
        warn: (m: string) => void store.logs.push({ level: "warn", msg: m }),
        error: (m: string) => void store.logs.push({ level: "error", msg: m }),
      },
      setInterval: () => undefined,
      clearInterval: () => undefined,
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
      getForeignObjectsAsync: (pattern: string, type?: string) => {
        const prefix = pattern.replace("*", "");
        const out: Record<string, ObjEntry> = {};
        // Type-faithful to js-controller: a string pattern with no type argument
        // resolves to the 'state' object view (getObjectView('system', type||'state')),
        // so ONLY state objects come back — never the channel/device containers. The
        // earlier permissive mock (channel||device regardless of type) hid the H1
        // restore regression. See reference_getforeignobjects_state_default.
        const wanted = type ?? "state";
        for (const [id, obj] of store.objects) {
          if (id.startsWith(prefix) && obj.type === wanted) {
            // A copy per object, like the broker — the stored object must not travel out.
            out[id] = structuredClone(obj);
          }
        }
        return Promise.resolve(out);
      },
      // Like the controller: every object of this instance, whatever its type — a copy each.
      getAdapterObjectsAsync: () => {
        const out: Record<string, ObjEntry> = {};
        for (const [id, obj] of store.objects) {
          if (id.startsWith(`${namespace}.`)) {
            out[id] = structuredClone(obj);
          }
        }
        return Promise.resolve(out);
      },
      // Like the controller: the id is taken as given.
      getForeignObjectAsync: (fullId: string) => {
        const obj = store.objects.get(fullId);
        return Promise.resolve(obj ? structuredClone(obj) : null);
      },
      getStateAsync: (id: string) => {
        const state = store.states.get(`${namespace}.${id}`);
        return Promise.resolve(state ? structuredClone(state) : null);
      },
      // Like 7.2.5: only ids with a state object, keyed by full id (test/unit/broker-stub.ts).
      getStatesAsync: (pattern: string) =>
        Promise.resolve(brokerGetStates(store.objects, store.states, namespace, pattern)),
      // A COPY, like the broker (objects travel serialised): mutating what a read
      // returned must not reach the store — only a write does. With a shared reference
      // the repair path's write was invisible to every test (v1.45.0).
      getObjectAsync: (id: string) => {
        const fullId = id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
        const obj = store.objects.get(fullId);
        return Promise.resolve(obj ? structuredClone(obj) : null);
      },
      // Like the controller: the id is taken as given — no namespace prefixing. A caller
      // that hands over a short id writes to the wrong key, and the tests see it.
      setForeignObject: (fullId: string, obj: ObjEntry) => {
        store.writes.push({ method: "setForeignObject", id: fullId, obj: structuredClone(obj) });
        store.objects.set(fullId, structuredClone(obj));
        return Promise.resolve();
      },
      setObjectNotExistsAsync: (id: string, obj: ObjEntry) => {
        const fullId = `${namespace}.${id}`;
        if (!store.objects.has(fullId)) {
          store.objects.set(fullId, obj);
        }
        return Promise.resolve();
      },
      // js-controller 7.2.2 semantics: deep merge, preserve, emptied lists (test/unit/broker-stub.ts).
      extendObject: (id: string, obj: Partial<ObjEntry>, options?: Record<string, unknown>) => {
        const fullId = `${namespace}.${id}`;
        store.writes.push({ method: "extendObject", id: fullId, obj: structuredClone(obj) });
        store.objects.set(fullId, brokerExtend(store.objects.get(fullId), obj, options));
        return Promise.resolve();
      },
      setState: (id: string, value: { val: unknown; ack?: boolean }) => {
        store.states.set(`${namespace}.${id}`, { val: value.val, ack: value.ack ?? false });
        return Promise.resolve();
      },
      // Like the controller: compares with the stored state and writes only on a
      // difference — a test counting `setState` calls sees the no-op as no write.
      setStateChangedAsync: (id: string, value: { val: unknown; ack?: boolean }) => {
        const current = store.states.get(`${namespace}.${id}`);
        if (current && current.val === value.val && current.ack === (value.ack ?? false)) {
          return Promise.resolve({ id, notChanged: true });
        }
        store.states.set(`${namespace}.${id}`, { val: value.val, ack: value.ack ?? false });
        return Promise.resolve({ id, notChanged: false });
      },
      // Like 7.2.2: a missing object deletes nothing, the value goes only with a state object.
      delObjectAsync: (id: string, options?: { recursive?: boolean }) => {
        brokerDelObject(store.objects, store.states, `${namespace}.${id}`, options?.recursive === true);
        return Promise.resolve();
      },
    };
  }

  return { store, adapter: buildAdapter() };
}

/**
 * A registry that ran restore() first, like main.ts hands it on — restore() reads (here: generates) the server
 * id every write of the data file carries (K16). Its log lines are dropped.
 *
 * @param built The stub installation.
 */
/**
 * Seeds a datapoint value the way an installation holds it: with its state object. js-controller answers a pattern
 * read only for ids with a state object (7.2.5 `getStates`), so a bare value would never reach the restore.
 *
 * @param store The mock store.
 * @param fullId The full state id.
 * @param state The value.
 * @param state.val The stored value.
 * @param state.ack Whether it is confirmed.
 */
function seedValue(store: MockStore, fullId: string, state: { val: unknown; ack: boolean }): void {
  if (!store.objects.has(fullId)) {
    store.objects.set(fullId, { type: "state", common: { type: "string", role: "state" }, native: {} });
  }
  store.states.set(fullId, state);
}

async function startedRegistry(built: ReturnType<typeof createMockAdapter>): Promise<ClientRegistry> {
  const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
  await reg.restore();
  built.store.logs.length = 0;
  return reg;
}

describe("ClientRegistry", () => {
  let store: MockStore;
  let adapter: ReturnType<typeof createMockAdapter>["adapter"];
  let registry: ClientRegistry;

  // Like main.ts: restore() runs before anything else — it reads (here: generates) the server id every write of
  // the data file carries. Its log lines are dropped, the tests count what the step under test logs.
  beforeEach(async () => {
    const built = createMockAdapter();
    store = built.store;
    adapter = built.adapter;
    registry = new ClientRegistry(adapter as never, store.dataDir);
    await registry.restore();
    store.logs.length = 0;
  });

  describe("identifyOrCreate", () => {
    it("creates a new client when cookie is missing", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5", { hostname: "tablet.local" });
      // No model in a missing User-Agent → `display` and four characters hassemu assigns (K7).
      expect(rec.id).to.match(/^display-[0-9a-f]{4}$/);
      expect(rec.cookie).to.match(/^[0-9a-f-]{36}$/);
      expect(rec.ip).to.equal("192.168.1.5");
      expect(rec.hostname).to.equal("tablet.local");
      expect(rec.mode).to.equal(MODE_GLOBAL); // Default provider returns MODE_GLOBAL
      expect(rec.manualUrl).to.be.null;
    });

    it("creates ioBroker channel + mode/manualUrl/ip/remove states on new client", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5");
      expect(store.objects.has(`hassemu.0.clients.${rec.id}`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.mode`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.manualUrl`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.ip`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.remove`)).to.be.true;
    });

    it("mode state is text — every value is a string (review 2026-11-07, R-17)", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
      expect(obj?.common?.type).to.equal("string");
      expect(obj?.common?.role).to.equal("text");
    });

    it('manualUrl state has role "url"', async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const obj = store.objects.get(`hassemu.0.clients.${rec.id}.manualUrl`);
      expect(obj?.common?.role).to.equal("url");
    });

    it("does not create a legacy hostname state", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5", { hostname: "tablet.local" });
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.hostname`)).to.be.false;
    });

    it("does not create a legacy visUrl state", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5");
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).to.be.false;
    });

    it("sets common.name to ip when hostname is unknown", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5");
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(nameOf(ch?.common?.name)).to.equal("192.168.1.5");
    });

    it("sets common.name to hostname when known at creation", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5", { hostname: "tablet.local" });
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(nameOf(ch?.common?.name)).to.equal("tablet.local");
    });

    it("updates common.name when hostname resolves after creation", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5");
      await registry.identifyOrCreate(rec.cookie, "192.168.1.5", { hostname: "tablet.local" });
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(nameOf(ch?.common?.name)).to.equal("tablet.local");
    });

    it("keeps common.name in sync with ip while hostname unknown", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(nameOf(ch?.common?.name)).to.equal("2.2.2.2");
    });

    it("a name typed in the tree gives way to the new address (K7; kept up to 1.46.1, v1.36.0 C4)", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1"); // name = "1.1.1.1"
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`)!;
      ch.common = { ...ch.common, name: "Kitchen Display" }; // a user renames in the admin UI
      // A new DHCP lease: without an app name and a host name the address names the display.
      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      expect(nameOf(store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name)).to.equal("2.2.2.2");
    });

    it("a known hostname wins over the IP even when the object carries no name", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1", { hostname: "tablet.local" });
      const key = `hassemu.0.clients.${rec.id}`;
      // An object without common.name (older layout / after an object repair)
      // counts as "auto-named" — so the IP-change path would happily stamp the
      // IP over a display that has a perfectly good hostname.
      const ch = store.objects.get(key)!;
      delete (ch.common as Record<string, unknown>).name;

      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      expect(nameOf(store.objects.get(key)?.common?.name)).to.not.equal("2.2.2.2");
    });

    it("writes ip and hostname only when they actually change", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1", { hostname: "tablet.local" });
      const ipKey = `hassemu.0.clients.${rec.id}.ip`;
      store.states.delete(ipKey);
      const namesBefore = nameOf(store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name);

      // Every page load repeats the same ip + hostname. Re-writing them turns
      // each request into two broker writes per display.
      // Mark the name so ANY re-write of the hostname is visible (writing the
      // same value back is invisible in a store-backed mock otherwise).
      const chKey = `hassemu.0.clients.${rec.id}`;
      const marked = store.objects.get(chKey)!;
      marked.common = { ...marked.common, name: "MARKER" };

      await registry.identifyOrCreate(rec.cookie, "1.1.1.1", { hostname: "tablet.local" });
      await registry.identifyOrCreate(rec.cookie, "1.1.1.1", { hostname: "tablet.local" });
      expect(store.states.has(ipKey), "no ip write for an unchanged ip").to.be.false;
      expect(nameOf(store.objects.get(chKey)?.common?.name), "no name write for an unchanged hostname").to.equal(
        "MARKER",
      );
      expect(namesBefore).to.equal("tablet.local");

      // An unchanged hostname reads nothing either: one read per request per
      // display adds up on a wall of tablets.
      let reads = 0;
      const origGetObject = adapter.getObjectAsync;
      adapter.getObjectAsync = async (id: string) => {
        reads++;
        return origGetObject(id);
      };
      await registry.identifyOrCreate(rec.cookie, "1.1.1.1", { hostname: "tablet.local" });
      expect(reads, "unchanged hostname must not trigger a name read").to.equal(0);
      adapter.getObjectAsync = origGetObject;

      // A real change still lands.
      await registry.identifyOrCreate(rec.cookie, "3.3.3.3", { hostname: "tablet.local" });
      expect(store.states.get(ipKey)?.val).to.equal("3.3.3.3");
    });

    it("keeps common.name fixed to hostname when only ip changes", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1", { hostname: "tablet.local" });
      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(nameOf(ch?.common?.name)).to.equal("tablet.local");
    });

    it("stores the cookie in the data file and nothing of it in the device object", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      expect(storedEntry(store, rec.id)?.cookie).to.equal(rec.cookie);
      expect(store.objects.get(`hassemu.0.clients.${rec.id}`)?.native).to.deep.equal({
        objectsVersion: CLIENT_OBJECTS_VERSION,
      });
    });

    it("persists IP to state", async () => {
      const rec = await registry.identifyOrCreate(null, "10.0.0.1");
      expect(store.states.get(`hassemu.0.clients.${rec.id}.ip`)?.val).to.equal("10.0.0.1");
    });

    it("persists initial mode value to state", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      expect(store.states.get(`hassemu.0.clients.${rec.id}.mode`)?.val).to.equal(rec.mode);
    });

    it("returns existing record when cookie matches", async () => {
      const rec1 = await registry.identifyOrCreate(null, "192.168.1.5");
      const rec2 = await registry.identifyOrCreate(rec1.cookie, "192.168.1.5");
      expect(rec2.id).to.equal(rec1.id);
    });

    it("creates new record when cookie is invalid UUID", async () => {
      const rec1 = await registry.identifyOrCreate("not-a-uuid", "192.168.1.5");
      const rec2 = await registry.identifyOrCreate("also-bad", "192.168.1.5");
      expect(rec1.id).to.not.equal(rec2.id);
    });

    it("creates new record when cookie is unknown UUID", async () => {
      const rec1 = await registry.identifyOrCreate(null, null);
      const stranger = crypto.randomUUID();
      const rec2 = await registry.identifyOrCreate(stranger, null);
      expect(rec2.id).to.not.equal(rec1.id);
    });

    // Regression: v1.1.2 and earlier registered a separate client for each
    // parallel cookieless request from the same display on initial connect.
    it("returns the same record for parallel cookieless requests from the same IP", async () => {
      const promises = [
        registry.identifyOrCreate(null, "192.168.77.10"),
        registry.identifyOrCreate(null, "192.168.77.10"),
        registry.identifyOrCreate(null, "192.168.77.10"),
      ];
      const results = await Promise.all(promises);
      expect(results[0].id).to.equal(results[1].id);
      expect(results[1].id).to.equal(results[2].id);
      expect(registry.listAll()).to.have.lengthOf(1);
    });

    it("still creates distinct clients for parallel requests from different IPs", async () => {
      const results = await Promise.all([
        registry.identifyOrCreate(null, "10.0.0.1"),
        registry.identifyOrCreate(null, "10.0.0.2"),
        registry.identifyOrCreate(null, "10.0.0.3"),
      ]);
      const ids = new Set(results.map(r => r.id));
      expect(ids.size).to.equal(3);
      expect(registry.listAll()).to.have.lengthOf(3);
    });

    it("clears the pending-lock after creation so sequential cookieless visits create new clients", async () => {
      const rec1 = await registry.identifyOrCreate(null, "192.168.77.20");
      const rec2 = await registry.identifyOrCreate(null, "192.168.77.20");
      expect(rec1.id).to.not.equal(rec2.id);
    });

    // v1.17.0 (C8) — different User-Agents on the same IP (NAT) get separate
    // ClientRecords instead of sharing cookie/token.
    it("parallel cookieless requests with different UAs on same IP get distinct clients (C8 v1.17.0)", async () => {
      const promises = [
        registry.identifyOrCreate(null, "10.0.0.1", { userAgent: "Display-A/1.0" }),
        registry.identifyOrCreate(null, "10.0.0.1", { userAgent: "Display-B/2.0" }),
      ];
      const results = await Promise.all(promises);
      expect(results[0].id).to.not.equal(results[1].id);
      expect(results[0].cookie).to.not.equal(results[1].cookie);
      expect(registry.listAll()).to.have.lengthOf(2);
    });

    // v1.17.0 (C8) — same UA on the same IP behaves as before: bursts collapse.
    it("parallel cookieless requests with same UA on same IP collapse to one client", async () => {
      const promises = [
        registry.identifyOrCreate(null, "10.0.0.2", { userAgent: "Display-A/1.0" }),
        registry.identifyOrCreate(null, "10.0.0.2", { userAgent: "Display-A/1.0" }),
        registry.identifyOrCreate(null, "10.0.0.2", { userAgent: "Display-A/1.0" }),
      ];
      const results = await Promise.all(promises);
      expect(results[0].id).to.equal(results[1].id);
      expect(results[1].id).to.equal(results[2].id);
      expect(registry.listAll()).to.have.lengthOf(1);
    });

    it("updates IP when it changes on subsequent visit", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      expect(rec.ip).to.equal("2.2.2.2");
      expect(store.states.get(`hassemu.0.clients.${rec.id}.ip`)?.val).to.equal("2.2.2.2");
    });

    it("updates hostname when it changes on subsequent visit", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1", { hostname: "old.local" });
      await registry.identifyOrCreate(rec.cookie, "1.1.1.1", { hostname: "new.local" });
      expect(rec.hostname).to.equal("new.local");
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(nameOf(ch?.common?.name)).to.equal("new.local");
    });

    it("does not overwrite ip with null on subsequent visit", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.identifyOrCreate(rec.cookie, null);
      expect(rec.ip).to.equal("1.1.1.1");
    });

    // L53: this is a sequential-creation uniqueness check (awaited in a loop) —
    // the real concurrency guard (parallel cookieless requests → one client) is
    // pinned separately via pendingByIp above.
    it("generates unique IDs across many sequential creations", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const rec = await registry.identifyOrCreate(null, null);
        expect(seen.has(rec.id)).to.be.false;
        seen.add(rec.id);
      }
      expect(seen.size).to.equal(20);
    });

    it("stores lastSeen in the data file on first identify", async () => {
      const before = Date.now();
      const rec = await registry.identifyOrCreate(null, "1.1.1.1");
      const lastSeen = storedEntry(store, rec.id)?.lastSeen;
      expect(typeof lastSeen).to.equal("number");
      expect(lastSeen!).to.be.at.least(before);
    });
  });

  describe("setNewClientModeProvider", () => {
    it("uses the provider value as default mode for new clients", async () => {
      registry.setNewClientModeProvider(() => "http://override.local/");
      const rec = await registry.identifyOrCreate(null, null);
      expect(rec.mode).to.equal("http://override.local/");
    });

    it("falls back to 'global' when no provider was wired", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      expect(rec.mode).to.equal(MODE_GLOBAL);
    });
  });

  describe("lookups", () => {
    let rec: ClientRecord;

    beforeEach(async () => {
      rec = await registry.identifyOrCreate(null, "10.0.0.1");
    });

    it("getById returns the record", () => {
      expect(registry.getById(rec.id)).to.equal(rec);
    });

    it("getById returns null for unknown", () => {
      expect(registry.getById("xxxxxx")).to.be.null;
    });

    it("getByCookie returns the record", () => {
      expect(registry.getByCookie(rec.cookie)).to.equal(rec);
    });

    it("getByCookie returns null for invalid cookie string", () => {
      expect(registry.getByCookie("garbage")).to.be.null;
    });

    it("getByToken returns null before token is set", () => {
      expect(registry.getByToken("anything")).to.be.null;
    });

    it("listAll returns all clients", async () => {
      await registry.identifyOrCreate(null, null);
      expect(registry.listAll().length).to.equal(2);
    });
  });

  describe("setToken", () => {
    it("sets the token and makes it findable", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setToken(rec.id, token);
      expect(rec.token).to.equal(token);
      expect(registry.getByToken(token)).to.equal(rec);
    });

    it("stores the token and its expiry in the data file, not in the device object", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setToken(rec.id, token);
      expect(storedEntry(store, rec.id)).to.include({ token, tokenExpiresAt: rec.tokenExpiresAt });
      expect(store.objects.get(`hassemu.0.clients.${rec.id}`)?.native).to.not.have.property("token");
    });

    it("clears token on null", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setToken(rec.id, token);
      await registry.setToken(rec.id, null);
      expect(rec.token).to.be.null;
      expect(registry.getByToken(token)).to.be.null;
    });

    it("replaces old token when new one is set", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await registry.setToken(rec.id, t1);
      await registry.setToken(rec.id, t2);
      expect(registry.getByToken(t1)).to.be.null;
      expect(registry.getByToken(t2)).to.equal(rec);
    });

    it("no-op when id is unknown", async () => {
      await registry.setToken("xxxxxx", "any");
      expect(registry.listAll().length).to.equal(0);
    });
  });

  describe("setTokens (v1.31.0 refresh persistence, one write since the 2026-09-15 audit)", () => {
    it("sets access + refresh token without any object write and makes both findable", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const access = crypto.randomUUID();
      const token = crypto.randomUUID();
      const writesBefore = store.writes.length;
      await registry.setTokens(rec.id, access, token);
      expect(store.writes.slice(writesBefore)).to.deep.equal([]);
      expect(rec.token).to.equal(access);
      expect(rec.refreshToken).to.equal(token);
      expect(typeof rec.tokenExpiresAt).to.equal("number");
      expect(registry.getByToken(access)).to.equal(rec);
      expect(registry.getByRefreshToken(token)).to.equal(rec);
    });

    it("stores both tokens and the expiry in the data file", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const access = crypto.randomUUID();
      const token = crypto.randomUUID();
      await registry.setTokens(rec.id, access, token);
      expect(storedEntry(store, rec.id)).to.include({
        refreshToken: token,
        token: access,
        tokenExpiresAt: rec.tokenExpiresAt,
      });
    });

    it("rejects when the data file cannot be written — the grant must not answer with a token nobody stored", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      // The data folder turns into a file: every later write fails.
      rmSync(store.dataDir, { recursive: true, force: true });
      writeFileSync(store.dataDir, "");
      try {
        await expect(registry.setTokens(rec.id, crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow();
      } finally {
        rmSync(store.dataDir, { force: true });
      }
    });

    it("clears both on null (revoke)", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const access = crypto.randomUUID();
      const token = crypto.randomUUID();
      await registry.setTokens(rec.id, access, token);
      await registry.setTokens(rec.id, null, null);
      expect(rec.token).to.be.null;
      expect(rec.tokenExpiresAt).to.be.null;
      expect(rec.refreshToken).to.be.null;
      expect(registry.getByToken(access)).to.be.null;
      expect(registry.getByRefreshToken(token)).to.be.null;
      expect(storedEntry(store, rec.id)).to.include({ token: null, tokenExpiresAt: null, refreshToken: null });
    });

    it("replaces old refresh token when new one is set (old no longer looked up)", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await registry.setTokens(rec.id, crypto.randomUUID(), t1);
      await registry.setTokens(rec.id, crypto.randomUUID(), t2);
      expect(registry.getByRefreshToken(t1)).to.be.null;
      expect(registry.getByRefreshToken(t2)).to.equal(rec);
    });

    it("no-op when id is unknown", async () => {
      await registry.setTokens("xxxxxx", "any", "any");
      expect(registry.listAll().length).to.equal(0);
    });

    it("restore() loads refreshToken from native field", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setTokens(rec.id, crypto.randomUUID(), token);

      // Fresh registry on same store (simulates adapter restart)
      const reg2 = new ClientRegistry(adapter as never, store.dataDir);
      await reg2.restore();
      const restored = reg2.getByRefreshToken(token);
      expect(restored?.id).to.equal(rec.id);
      expect(restored?.refreshToken).to.equal(token);
    });

    it("restore() handles missing native.refreshToken (legacy install) without crash", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      // Simulate legacy install: client exists but no refreshToken ever set
      expect(rec.refreshToken).to.be.null;

      const reg2 = new ClientRegistry(adapter as never, store.dataDir);
      await reg2.restore();
      const restored = reg2.getById(rec.id);
      expect(restored?.refreshToken).to.be.null;
    });

    it("restore() ignores a nested object below a client container", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      // A leftover sub-container from an older layout (or a hand-created node):
      // its id tail carries a dot, so it is NOT a client id. Restoring it would
      // mint a phantom client named "<id>.legacy" that no display ever reaches
      // and that the GC keeps alive because it has no lastSeen.
      store.objects.set(`hassemu.0.clients.${rec.id}.legacy`, {
        type: "device",
        common: { name: "legacy" },
        native: { cookie: crypto.randomUUID() },
      });

      const reg2 = new ClientRegistry(adapter as never, store.dataDir);
      await reg2.restore();
      expect(reg2.listAll().map(r => r.id)).to.deep.equal([rec.id]);
    });

    it("remove(id) clears byRefreshToken lookup", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setTokens(rec.id, crypto.randomUUID(), token);
      await registry.remove(rec.id);
      expect(registry.getByRefreshToken(token)).to.be.null;
    });
  });

  describe("handleModeWrite", () => {
    let rec: ClientRecord;

    beforeEach(async () => {
      rec = await registry.identifyOrCreate(null, null);
    });

    it("accepts 'global' sentinel", async () => {
      await registry.handleModeWrite(rec.id, MODE_GLOBAL);
      expect(rec.mode).to.equal(MODE_GLOBAL);
      expect(store.states.get(`hassemu.0.clients.${rec.id}.mode`)?.val).to.equal(MODE_GLOBAL);
    });

    it("accepts 'manual' sentinel", async () => {
      await registry.handleModeWrite(rec.id, MODE_MANUAL);
      expect(rec.mode).to.equal(MODE_MANUAL);
    });

    it("names an empty manualUrl on debug — never warn, the URL may simply come next (Z1)", async () => {
      await registry.handleModeWrite(rec.id, MODE_MANUAL);
      expect(store.logs.some(l => l.level === "debug" && l.msg.includes("manualUrl is empty"))).to.be.true;
      expect(store.logs.some(l => l.level === "warn")).to.be.false;
    });

    it("accepts a safe URL string", async () => {
      await registry.handleModeWrite(rec.id, "http://tablet.local/ui");
      expect(rec.mode).to.equal("http://tablet.local/ui");
    });

    it("accepts empty string (clears mode)", async () => {
      rec.mode = MODE_GLOBAL;
      await registry.handleModeWrite(rec.id, "");
      // "0" in memory as well as in the state since v1.43.0 — one representation for one
      // meaning. Two of them made bulkSetMode's "skip when unchanged" compare "" to "0"
      // and write anyway, once per client every time the master switch went off.
      expect(rec.mode).to.equal(NO_CHOICE);
      expect(store.states.get(`hassemu.0.clients.${rec.id}.mode`)?.val).to.equal(NO_CHOICE);
    });

    it("rejects javascript: URL and restores previous value", async () => {
      rec.mode = "http://safe.local/";
      await registry.handleModeWrite(rec.id, "javascript:alert(1)");
      expect(rec.mode).to.equal("http://safe.local/");
      const warn = store.logs.find(l => l.level === "warn" && l.msg.includes("rejected unsafe"));
      expect(warn).to.not.be.undefined;
    });

    it("rejects ftp:// URL", async () => {
      await registry.handleModeWrite(rec.id, "ftp://server/");
      // mode unchanged (was the provider default)
      expect(rec.mode).to.equal(MODE_GLOBAL);
    });

    it("rejects URLs with embedded credentials", async () => {
      await registry.handleModeWrite(rec.id, "http://user:pass@host/");
      expect(rec.mode).to.equal(MODE_GLOBAL);
    });

    it("names no part of a rejected address — a user:pass@ URL keeps its credentials out of the log", async () => {
      // Fleet rule (krobi 2026-11-11 18:17/18:20): no credentials in a log line, at any level.
      // The warning used to echo the rejected value raw — password included.
      await registry.handleModeWrite(rec.id, "http://hassuser:Secret-pw-42@10.9.8.7:8082/vis/");
      expect(store.logs.some(l => l.level === "warn" && l.msg.includes("rejected unsafe"))).to.be.true;
      const lines = store.logs.map(l => l.msg).join("\n");
      expect(lines).to.not.include("Secret-pw-42");
      expect(lines).to.not.include("hassuser");
      expect(lines).to.not.include("10.9.8.7");
    });

    it("rejects non-string values (logs debug, G7 v1.18.0)", async () => {
      await registry.handleModeWrite(rec.id, 42);
      expect(rec.mode).to.equal(MODE_GLOBAL);
      // v1.18.0 (G7): downgraded warn→debug — it was a UI echo, not a server concern.
      const debug = store.logs.find(l => l.level === "debug" && l.msg.includes("non-string"));
      expect(debug).to.not.be.undefined;
    });

    it("no-op when id is unknown", async () => {
      await registry.handleModeWrite("xxxxxx", "http://ok/");
      expect(store.states.has("hassemu.0.clients.xxxxxx.mode")).to.be.false;
    });
  });

  describe("handleManualUrlWrite", () => {
    let rec: ClientRecord;

    beforeEach(async () => {
      rec = await registry.identifyOrCreate(null, null);
    });

    it("accepts a safe URL", async () => {
      await registry.handleManualUrlWrite(rec.id, "http://manual.local/");
      expect(rec.manualUrl).to.equal("http://manual.local/");
    });

    it("accepts empty string (clears value)", async () => {
      rec.manualUrl = "http://old/";
      await registry.handleManualUrlWrite(rec.id, "");
      expect(rec.manualUrl).to.be.null;
    });

    it("rejects unsafe URL", async () => {
      await registry.handleManualUrlWrite(rec.id, "javascript:alert(1)");
      expect(rec.manualUrl).to.be.null;
    });

    it("warns when manualUrl is cleared while mode='manual'", async () => {
      rec.mode = MODE_MANUAL;
      rec.manualUrl = "http://x/";
      await registry.handleManualUrlWrite(rec.id, "");
      // debug, never warn: clearing the URL before switching the mode is a normal order (N8).
      expect(store.logs.some(l => l.level === "debug" && l.msg.includes("manualUrl cleared"))).to.be.true;
      expect(store.logs.some(l => l.level === "warn")).to.be.false;
    });

    it("no-op when id is unknown", async () => {
      await registry.handleManualUrlWrite("xxxxxx", "http://ok/");
      expect(store.states.has("hassemu.0.clients.xxxxxx.manualUrl")).to.be.false;
    });
  });

  describe("bulkSetMode", () => {
    it("sets mode on every client", async () => {
      const r1 = await registry.identifyOrCreate(null, "1.1.1.1");
      const r2 = await registry.identifyOrCreate(null, "1.1.1.2");
      await registry.bulkSetMode("http://target/");
      expect(r1.mode).to.equal("http://target/");
      expect(r2.mode).to.equal("http://target/");
    });

    it("persists each new mode value to state with ack=true", async () => {
      const r1 = await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.bulkSetMode(MODE_GLOBAL);
      const stored = store.states.get(`hassemu.0.clients.${r1.id}.mode`);
      expect(stored?.val).to.equal(MODE_GLOBAL);
      expect(stored?.ack).to.be.true;
    });

    it("skips clients whose mode already matches (no spurious writes)", async () => {
      const r1 = await registry.identifyOrCreate(null, "1.1.1.1");
      r1.mode = "same";
      store.logs.length = 0;
      // Delete the persisted value: a skipped client must not have it written
      // back. Asserting only on the absence of a log line let a full rewrite of
      // every client's mode pass unnoticed (the master switch runs this on
      // every toggle, so that is one broker write per display for nothing).
      store.states.delete(`hassemu.0.clients.${r1.id}.mode`);
      await registry.bulkSetMode("same");
      expect(store.states.has(`hassemu.0.clients.${r1.id}.mode`), "no write for an unchanged client").to.be.false;
      const info = store.logs.find(l => l.level === "info" && l.msg.includes("bulk-set"));
      expect(info).to.be.undefined;
    });

    it("logs debug with count on actual changes", async () => {
      // The bulkSetMode trigger is internal — debug since v1.27.0 (mode values
      // were not wanted in the user log). The test checks the debug output
      // with its count instead of info.
      await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.identifyOrCreate(null, "1.1.1.2");
      store.logs.length = 0;
      await registry.bulkSetMode("http://new/");
      const dbg = store.logs.find(l => l.level === "debug" && l.msg.includes("bulkSetMode"));
      expect(dbg?.msg).to.match(/2 client/);
    });

    it("is a no-op with no clients", async () => {
      await registry.bulkSetMode(MODE_GLOBAL);
      expect(store.logs.some(l => l.msg.includes("bulkSetMode applied"))).to.be.false;
      expect(store.states.size).to.equal(0);
    });
  });

  describe("remove", () => {
    it("deletes in-memory entries", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      await registry.remove(rec.id);
      expect(registry.getById(rec.id)).to.be.null;
      expect(registry.getByCookie(rec.cookie)).to.be.null;
    });

    it("deletes ioBroker channel and all child states", async () => {
      const rec = await registry.identifyOrCreate(null, "1.2.3.4");
      await registry.remove(rec.id);
      expect(store.objects.has(`hassemu.0.clients.${rec.id}`)).to.be.false;
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.mode`)).to.be.false;
      expect(store.objects.has(`hassemu.0.clients.${rec.id}.manualUrl`)).to.be.false;
    });

    it("unregisters token so it cannot be reused", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setToken(rec.id, token);
      await registry.remove(rec.id);
      expect(registry.getByToken(token)).to.be.null;
    });

    it("returning client gets new id and new cookie", async () => {
      const rec1 = await registry.identifyOrCreate(null, "1.1.1.1");
      const oldCookie = rec1.cookie;
      await registry.remove(rec1.id);
      const rec2 = await registry.identifyOrCreate(oldCookie, "1.1.1.1");
      expect(rec2.id).to.not.equal(rec1.id);
      expect(rec2.cookie).to.not.equal(oldCookie);
    });

    it("logs the removal on debug, never on info (a button gets no info line)", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      await registry.remove(rec.id);
      expect(store.logs.some(l => l.level === "debug" && l.msg === `Client forgotten: ${rec.id}`)).to.be.true;
      expect(store.logs.some(l => l.level === "info" && l.msg.includes("forgotten"))).to.be.false;
    });

    it("no-op when id is unknown", async () => {
      // A foreign object under the same id is not the registry's to delete.
      store.objects.set("hassemu.0.clients.xxxxxx", { type: "device", native: {} });
      await registry.remove("xxxxxx");
      expect(store.objects.has("hassemu.0.clients.xxxxxx")).to.be.true;
      expect(store.logs.some(l => l.msg.includes("forgotten"))).to.be.false;
    });
  });

  describe("syncUrlDropdown", () => {
    it("updates common.states on existing mode datapoints with sentinels + URLs (plain-string labels, EN fallback)", async () => {
      // v1.28.4: sentinel labels are plain strings (resolved to the system language),
      // no longer translation objects — the admin crashes on those with React error #31.
      const rec = await registry.identifyOrCreate(null, null);
      await registry.syncUrlDropdown({ "http://a.local/": "A", "http://b.local/": "B" });
      const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
      expect(obj?.common?.states).to.deep.equal({
        0: "---",
        [MODE_GLOBAL]: "Global URL",
        [MODE_MANUAL]: "Manual URL",
        "http://a.local/": "A",
        "http://b.local/": "B",
      });
    });

    it("uses synced dropdown for newly created clients", async () => {
      await registry.syncUrlDropdown({ "http://a.local/": "A" });
      const rec = await registry.identifyOrCreate(null, null);
      const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
      expect(obj?.common?.states).to.deep.equal({
        0: "---",
        [MODE_GLOBAL]: "Global URL",
        [MODE_MANUAL]: "Manual URL",
        "http://a.local/": "A",
      });
    });

    it("common.states VALUES sind alle plain-string (Regression-Test für React #31)", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      await registry.syncUrlDropdown({ "http://a.local/": "A", "http://b.local/": "B" });
      const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
      const states = obj?.common?.states as Record<string, unknown>;
      for (const [key, value] of Object.entries(states)) {
        expect(typeof value, `states[${key}] must be string`).to.equal("string");
      }
    });

    it("is a no-op when there are no clients", async () => {
      await registry.syncUrlDropdown({ "http://a/": "A" });
      expect(store.writes).to.have.length(0);
      expect(store.objects.size).to.equal(0);
    });

    it("drops a stale URL key in ONE full write — never an extendObject that would merge it back (T1)", async () => {
      // The stub merges like js-controller 7.2.2 (deeply): an `extendObject` carrying
      // `common.states` keeps every stale key, only a full write gets rid of one.
      const rec = await registry.identifyOrCreate(null, null);
      const modeId = `hassemu.0.clients.${rec.id}.mode`;
      const seeded = store.objects.get(modeId)!;
      seeded.common = {
        ...seeded.common,
        states: {
          0: "---",
          "http://old.local/vis-2.0/main/index.html#X": { en: "VIS-2: main / X", de: "VIS-2: main / X" },
        },
      };
      const before = store.writes.length;

      await registry.syncUrlDropdown({ "http://a.local/": "A" });

      const states = store.objects.get(modeId)?.common?.states as Record<string, unknown>;
      expect(states).to.not.have.property("http://old.local/vis-2.0/main/index.html#X");
      expect(states["http://a.local/"]).to.equal("A");
      const writes = store.writes.slice(before).filter(w => w.id === modeId);
      expect(writes.map(w => w.method)).to.deep.equal(["setForeignObject"]);
    });
  });

  describe("restore", () => {
    it("repairs a broken mode schema in ONE full write — no extendObject carries `states` (T1)", async () => {
      const id = "broken1";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, { type: "device", native: { cookie } });
      const modeId = `hassemu.0.clients.${id}.mode`;
      store.objects.set(modeId, {
        type: "state",
        common: { type: "string", role: "value", states: { "http://old.local/": "Old" } },
        native: {},
      });

      await registry.restore();

      const modeWrites = store.writes.filter(w => w.id === modeId);
      expect(modeWrites.filter(w => w.method === "setForeignObject")).to.have.length(1);
      const extendsWithStates = modeWrites.filter(
        w => w.method === "extendObject" && w.obj.common !== undefined && "states" in w.obj.common,
      );
      expect(extendsWithStates).to.have.length(0);
      expect(store.objects.get(modeId)?.common?.type).to.equal("string");
      expect(store.objects.get(modeId)?.common?.role).to.equal("text");
    });

    it("loads existing clients with mode + manualUrl from state", async () => {
      const id = "display-c123";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        common: { name: "tablet.local" },
        native: { cookie, token: null },
      });
      seedValue(store, `hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
      seedValue(store, `hassemu.0.clients.${id}.manualUrl`, { val: "http://saved/", ack: true });
      seedValue(store, `hassemu.0.clients.${id}.ip`, { val: "192.168.1.20", ack: true });

      await registry.restore();
      const rec = registry.getById(id);
      expect(rec).to.not.be.null;
      expect(rec!.cookie).to.equal(cookie);
      expect(rec!.mode).to.equal(MODE_MANUAL);
      expect(rec!.manualUrl).to.equal("http://saved/");
      expect(rec!.ip).to.equal("192.168.1.20");
      // Stored before K7, the name is not recorded as hassemu's own — its host name is resolved again (K7).
      expect(rec!.hostname).to.be.null;
    });

    it("restores BOTH a device and a channel container in one pass (H1 — typed device+channel queries, not the state-default view)", async () => {
      // A pattern with no type argument resolves to js-controller's `state` view and
      // returns NEITHER container type — which silently loaded zero clients in v1.37.0.
      // restore() must query `device` AND `channel` explicitly and merge, because the
      // channel→device migration is still in flight. reference_getforeignobjects_state_default.
      const deviceId = "dev01";
      const channelId = "chan01";
      const devCookie = crypto.randomUUID();
      const chanCookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${deviceId}`, { type: "device", native: { cookie: devCookie } });
      store.objects.set(`hassemu.0.clients.${channelId}`, { type: "channel", native: { cookie: chanCookie } });

      await registry.restore();

      expect(registry.getById(deviceId), "device container restored").to.not.be.null;
      expect(registry.getById(channelId), "channel container restored").to.not.be.null;
      // the legacy channel is migrated to device in place (I22)
      expect(store.objects.get(`hassemu.0.clients.${channelId}`)?.type).to.equal("device");
    });

    it("does NOT strip persisted dropdown URLs from a valid mode object on restore (L1)", async () => {
      // Restore runs before URL discovery (currentUrlStates empty), so the rebuilt
      // dropdown lacks the URL keys the persisted object already carries. ensureObjects
      // must not rewrite the mode object here — that stripped the URLs and forced a
      // second full replace once syncUrlDropdown ran. syncUrlDropdown owns common.states.
      const id = "keepurls";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, { type: "device", native: { cookie } });
      store.objects.set(`hassemu.0.clients.${id}.mode`, {
        type: "state",
        common: {
          name: "Redirect mode",
          type: "string",
          role: "text",
          read: true,
          write: true,
          states: { 0: "---", global: "Global URL", manual: "Manual URL", "http://vis/": "VIS" },
        },
        native: {},
      });
      seedValue(store, `hassemu.0.clients.${id}.mode`, { val: "http://vis/", ack: true });

      await registry.restore();

      const modeObj = store.objects.get(`hassemu.0.clients.${id}.mode`);
      expect(Object.keys(modeObj?.common?.states ?? {}), "persisted URL survives restore").to.include("http://vis/");
    });

    it("loads URL-mode (direct URL value)", async () => {
      const id = "urlmode";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        native: { cookie },
      });
      seedValue(store, `hassemu.0.clients.${id}.mode`, { val: "http://direct/", ack: true });
      await registry.restore();
      expect(registry.getById(id)?.mode).to.equal("http://direct/");
    });

    it('treats common.name = ip as "no hostname known"', async () => {
      const id = "noHost";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        common: { name: "192.168.1.20" },
        native: { cookie },
      });
      seedValue(store, `hassemu.0.clients.${id}.ip`, { val: "192.168.1.20", ack: true });
      await registry.restore();
      const rec = registry.getById(id);
      expect(rec?.hostname).to.be.null;
    });

    it("migrates legacy hostname state into common.name and drops the state", async () => {
      const id = "legacy";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        common: { name: "10.0.0.5" },
        native: { cookie },
      });
      store.objects.set(`hassemu.0.clients.${id}.hostname`, { type: "state" });
      seedValue(store, `hassemu.0.clients.${id}.ip`, { val: "10.0.0.5", ack: true });
      seedValue(store, `hassemu.0.clients.${id}.hostname`, { val: "tablet.local", ack: true });

      await registry.restore();
      const rec = registry.getById(id);
      expect(rec?.hostname).to.equal("tablet.local");
      const ch = store.objects.get(`hassemu.0.clients.${id}`);
      expect(nameOf(ch?.common?.name)).to.equal("tablet.local");
      expect(store.objects.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
      expect(store.states.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
    });

    it("drops an EMPTY legacy hostname datapoint too — 1.1.1 left it for a display without a reverse-DNS name", async () => {
      // Before, only a non-empty value was migrated; the empty datapoint stayed in the tree for good.
      const id = "legacy";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        common: { name: "10.0.0.5" },
        native: { cookie },
      });
      seedValue(store, `hassemu.0.clients.${id}.ip`, { val: "10.0.0.5", ack: true });
      seedValue(store, `hassemu.0.clients.${id}.hostname`, { val: "", ack: true });

      await registry.restore();

      const rec = registry.getById(id);
      expect(rec?.hostname).to.be.null;
      expect(nameOf(store.objects.get(`hassemu.0.clients.${id}`)?.common?.name)).to.equal("10.0.0.5");
      expect(store.objects.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
      expect(store.states.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
    });

    it("hands an EMPTY legacy visUrl over to the migration — only a missing datapoint is not handed over", async () => {
      const withEmpty = "legacy";
      const without = "fresh1";
      for (const id of [withEmpty, without]) {
        store.objects.set(`hassemu.0.clients.${id}`, {
          type: "channel",
          common: { name: "10.0.0.5" },
          native: { cookie: crypto.randomUUID() },
        });
      }
      seedValue(store, `hassemu.0.clients.${withEmpty}.visUrl`, { val: "", ack: true });

      await registry.restore();

      expect([...registry.takeLegacyVisUrls()]).to.deep.equal([[withEmpty, ""]]);
    });

    it("brings a 1.1.1 display up to date with ONE write of its device — kind, name, pictogram and stamp", async () => {
      // Three writes before (channel→device, name, stamp with the pictogram), each an objectChange, on top of the
      // move and the identity leaving `native` (inventory: "writes no object more than MAX_OBJECT_WRITES times",
      // 2026-11-12). The id of the old form moves to the K7 form within the restore.
      const deviceId = "hassemu.0.clients.a1b2c3";
      const movedId = "hassemu.0.clients.display-b2c3";
      store.objects.set(deviceId, {
        type: "channel",
        common: { name: "10.0.0.5" },
        native: { cookie: crypto.randomUUID() },
      });
      seedValue(store, `${deviceId}.ip`, { val: "10.0.0.5", ack: true });

      await registry.restore();

      const deviceWrites = store.writes.filter(w => w.id === movedId);
      expect(
        deviceWrites.map(w => w.method),
        "the move, the one update, the identity leaving native",
      ).to.deep.equal(["setForeignObject", "extendObject", "setForeignObject"]);
      const write = deviceWrites[1];
      expect(write.obj.type).to.equal("device");
      expect(nameOf(write.obj.common?.name)).to.equal("10.0.0.5");
      expect(write.obj.common?.icon).to.match(/^data:image\/svg\+xml;base64,/);
      expect((write.obj.native as Record<string, unknown>)?.objectsVersion).to.equal(CLIENT_OBJECTS_VERSION);
      expect(store.objects.get(movedId)?.native).to.deep.equal({ objectsVersion: CLIENT_OBJECTS_VERSION });
    });

    it("writes NOTHING to a device that is already current", async () => {
      const id = "current1";
      const deviceId = `hassemu.0.clients.${id}`;
      // As a start after 2.0.0 finds it: identity in the data file, name and stamp current.
      rewriteClients(
        store.dataDir,
        new Map([[id, { cookie: crypto.randomUUID(), token: null, tokenExpiresAt: null, refreshToken: null }]]),
      );
      store.objects.set(deviceId, {
        type: "device",
        common: { name: tRaw("10.0.0.5"), icon: displayIcon() },
        native: { objectsVersion: CLIENT_OBJECTS_VERSION },
      });
      seedValue(store, `${deviceId}.ip`, { val: "10.0.0.5", ack: true });

      await registry.restore();

      expect(store.writes.filter(w => w.id === deviceId)).to.deep.equal([]);
    });

    it("gives a mode object it just created or repaired no second text write", async () => {
      // The created or repaired object carries the current name and description already — a second write
      // changed nothing (inventory: "writes no object more than MAX_OBJECT_WRITES times", 2026-11-12).
      const created = "nomode1";
      const repaired = "badmode1";
      for (const id of [created, repaired]) {
        store.objects.set(`hassemu.0.clients.${id}`, { type: "device", native: { cookie: crypto.randomUUID() } });
      }
      store.objects.set(`hassemu.0.clients.${repaired}.mode`, {
        type: "state",
        common: { type: "string", role: "value", states: { "http://old.local/": "Old" } },
        native: {},
      });

      await registry.restore();

      const modeExtends = store.writes.filter(w => w.method === "extendObject" && w.id.endsWith(".mode"));
      expect(modeExtends, JSON.stringify(modeExtends)).to.deep.equal([]);
      expect(store.objects.get(`hassemu.0.clients.${created}.mode`)?.common?.role).to.equal("text");
      expect(store.objects.get(`hassemu.0.clients.${repaired}.mode`)?.common?.role).to.equal("text");
    });

    it("a text refresh behind the revision writes only the datapoints whose texts differ", async () => {
      // A revision bump for one datapoint (4: mode became text) rewrote every datapoint of a display, also those whose
      // texts were current (inventory, upgrade from 1.46.1: "rewrites no object unchanged", 2026-11-12).
      const rec = await registry.identifyOrCreate(null, "10.0.0.5");
      const base = `hassemu.0.clients.${rec.id}`;
      store.objects.get(base)!.native!.objectsVersion = CLIENT_OBJECTS_VERSION - 1;
      store.objects.get(`${base}.ip`)!.common!.name = "Client IP";
      store.writes.length = 0;

      await new ClientRegistry(adapter as never, store.dataDir).restore();

      const datapointWrites = store.writes.filter(w => w.id.startsWith(`${base}.`)).map(w => `${w.method} ${w.id}`);
      expect(datapointWrites).to.deep.equal([`extendObject ${base}.ip`]);
      expect(nameOf(store.objects.get(`${base}.ip`)?.common?.name)).to.equal("Display IP");
    });

    it("enforces a persisted access-token expiry across restart — an already-expired token is rejected (M11)", async () => {
      const id = "exp1";
      const cookie = crypto.randomUUID();
      const token = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        common: { name: "tab" },
        native: { cookie, token, tokenExpiresAt: Date.now() - 60_000 }, // expired before the restart
      });
      seedValue(store, `hassemu.0.clients.${id}.mode`, { val: MODE_GLOBAL, ack: true });
      await registry.restore();
      expect(registry.getById(id), "client itself is restored").to.not.be.null;
      expect(registry.getByToken(token), "expired token rejected after restart").to.be.null;
    });

    it("keeps a legacy token without a stored expiry valid across restart (non-breaking, M11)", async () => {
      const id = "exp2";
      const cookie = crypto.randomUUID();
      const token = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        native: { cookie, token }, // no tokenExpiresAt (pre-v1.36.0 install)
      });
      seedValue(store, `hassemu.0.clients.${id}.mode`, { val: MODE_GLOBAL, ack: true });
      await registry.restore();
      expect(registry.getByToken(token)?.id).to.equal(id);
    });

    it("removes an orphaned client channel that has no valid cookie (M5)", async () => {
      const id = "orphan1";
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        native: { lastSeen: Date.now() }, // no cookie — a ghost left by a write that raced a remove()
      });
      await registry.restore();
      expect(registry.getById(id), "orphan not tracked").to.be.null;
      expect(store.objects.has(`hassemu.0.clients.${id}`), "orphan object deleted").to.be.false;
      const warns = store.logs.filter(l => l.level === "warn" && l.msg.includes("orphaned client channel"));
      expect(warns.length).to.be.greaterThan(0);
    });

    it("skips channels without a valid cookie", async () => {
      store.objects.set("hassemu.0.clients.broken", {
        type: "channel",
        native: { cookie: "not-a-uuid" },
      });
      await registry.restore();
      expect(registry.getById("broken")).to.be.null;
    });

    it("returns cookie-identified record after restore", async () => {
      const id = "display-f456";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        native: { cookie },
      });
      await registry.restore();
      const rec = await registry.identifyOrCreate(cookie, null);
      expect(rec.id).to.equal(id);
    });

    it("re-registers persisted token so token lookups work after restart", async () => {
      const id = "ghi789";
      const cookie = crypto.randomUUID();
      const token = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        native: { cookie, token },
      });
      await registry.restore();
      expect(registry.getByToken(token)?.id).to.equal(id);
    });

    it("handles empty state", async () => {
      await registry.restore();
      expect(registry.listAll().length).to.equal(0);
    });

    it("rejects unsafe persisted manualUrl (treats as null)", async () => {
      const id = "unsafe";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, { type: "channel", native: { cookie } });
      seedValue(store, `hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
      seedValue(store, `hassemu.0.clients.${id}.manualUrl`, { val: "javascript:bad", ack: true });
      await registry.restore();
      expect(registry.getById(id)?.manualUrl).to.be.null;
    });

    it("migrates a legacy channel client object to device on restore (I22 v1.37.0)", async () => {
      const id = "legacydev";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, { type: "channel", native: { cookie } });
      await registry.restore();
      // still restored into memory (cookie/token preserved — no re-onboard)…
      expect(registry.getById(id)?.cookie).to.equal(cookie);
      // …and the object type was migrated channel → device in place.
      expect(store.objects.get(`hassemu.0.clients.${id}`)?.type).to.equal("device");
    });

    it("creates a new client object as a device (I22 v1.37.0)", async () => {
      const rec = await registry.identifyOrCreate(null, "10.9.9.9");
      expect(store.objects.get(`hassemu.0.clients.${rec.id}`)?.type).to.equal("device");
    });

    it("a display whose objects cannot be written fails the start; the next start restores every display (K16)", async () => {
      // Three clients in store. The middle one's ensureObjects throws (simulated broker hiccup
      // mid-restore). HE1 (v1.28.3) skipped that display and ran on; K16 (start-failure standard,
      // ST1: no access to ioBroker is a failed start) fails the start instead — the controller
      // restarts the instance, and nothing was moved out of the objects in the meantime.
      const cookieA = crypto.randomUUID();
      const cookieB = crypto.randomUUID();
      const cookieC = crypto.randomUUID();

      const localBuilt = createMockAdapter();
      localBuilt.store.objects.set(`hassemu.0.clients.alpha`, {
        type: "channel",
        native: { cookie: cookieA },
      });
      localBuilt.store.objects.set(`hassemu.0.clients.bravo`, {
        type: "channel",
        native: { cookie: cookieB },
      });
      localBuilt.store.objects.set(`hassemu.0.clients.charlie`, {
        type: "channel",
        native: { cookie: cookieC },
      });
      const original = localBuilt.adapter.setObjectNotExistsAsync;
      (localBuilt.adapter as { setObjectNotExistsAsync: typeof original }).setObjectNotExistsAsync = async (
        id: string,
        obj,
      ) => {
        if (id.startsWith("clients.bravo")) {
          throw new Error("simulated broker hiccup mid-restore");
        }
        return original(id, obj);
      };
      const localReg = new ClientRegistry(localBuilt.adapter as never, localBuilt.store.dataDir);
      await expect(localReg.restore()).rejects.toThrow("simulated broker hiccup mid-restore");
      expect(readStore(localBuilt.store.dataDir, TEST_CIPHER).clients.size, "no data file was written").to.equal(0);
      expect(localBuilt.store.objects.get("hassemu.0.clients.bravo")?.native?.cookie, "the cookie stays").to.equal(
        cookieB,
      );

      (localBuilt.adapter as { setObjectNotExistsAsync: typeof original }).setObjectNotExistsAsync = original;
      const restarted = new ClientRegistry(localBuilt.adapter as never, localBuilt.store.dataDir);
      await restarted.restore();
      expect(restarted.getByCookie(cookieA)?.id).to.equal("alpha");
      expect(restarted.getByCookie(cookieB)?.id).to.equal("bravo");
      expect(restarted.getByCookie(cookieC)?.id).to.equal("charlie");
    });
  });

  // --- v1.19.0 (J-Phase Test-Coverage) ---

  describe("seedLastSeen (F11 v1.19.0)", () => {
    it("stores lastSeen for the given display in the data file", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.9");
      reg.seedLastSeen(rec.id, 1234567890);
      expect(storedEntry(built.store, rec.id)?.lastSeen).to.equal(1234567890);
    });

    it("updates throttle map so next touchLastSeen does not double-write", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.9");
      const flushed = (reg as unknown as { lastSeenFlushedAt: Map<string, number> }).lastSeenFlushedAt;
      reg.seedLastSeen(rec.id, 9999);
      expect(flushed.get(rec.id)).to.equal(9999);
    });

    it("stores nothing for a display the registry does not track", () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
      reg.seedLastSeen("foo", 9999);
      expect(readStore(built.store.dataDir, TEST_CIPHER).clients.size).to.equal(0);
    });
  });

  describe("touchLastSeen (throttle + resurrection guard)", () => {
    it("writes at most once per flush interval, not on every request", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.7");
      // Mark the stored value so a second write is visible.
      rewriteClients(built.store.dataDir, new Map([[rec.id, { ...storedEntry(built.store, rec.id)!, lastSeen: 1 }]]));

      // A display polls the page every few seconds; an unthrottled stamp would
      // be one write per request, per display, forever.
      await reg.identifyOrCreate(rec.cookie, "10.0.0.7");
      await reg.identifyOrCreate(rec.cookie, "10.0.0.7");
      expect(storedEntry(built.store, rec.id)?.lastSeen).to.equal(1);
    });

    it("never re-creates the object of a client removed mid-request", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.8");
      const key = `hassemu.0.clients.${rec.id}`;
      await reg.remove(rec.id);
      expect(built.store.objects.has(key)).to.be.false;

      // The web request that was still in flight holds the record object. The
      // fire-and-forget upsert is called directly here because the real race is
      // not reproducible in a test; extendObject would resurrect the channel as
      // a cookie-less orphan that nothing ever reaps.
      (reg as unknown as { touchLastSeen(r: unknown): void }).touchLastSeen(rec);
      await new Promise(r => setImmediate(r));
      expect(built.store.objects.has(key), "removed client must stay removed").to.be.false;
      expect(storedEntry(built.store, rec.id), "and its identity stays out of the data file").to.be.undefined;
    });
  });

  describe("per-IP burst-detection for broken cookies (G5 v1.19.0)", () => {
    const buildReg = async (): Promise<{ reg: ClientRegistry; store: MockStore }> => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      return { reg, store: built.store };
    };

    type BurstAccess = {
      recordNewClientActivity: (ip: string, persistent: boolean, now?: number) => void;
      isIpThrottled: (ip: string, now?: number) => boolean;
      newClientBurst: Map<string, unknown>;
    };

    it("does not warn on first 3 client creations from same IP", async () => {
      const { reg, store } = await buildReg();
      const access = reg as unknown as BurstAccess;
      access.recordNewClientActivity("1.2.3.4", true);
      access.recordNewClientActivity("1.2.3.4", true);
      access.recordNewClientActivity("1.2.3.4", true);
      const warnings = store.logs.filter(l => l.level === "warn");
      expect(warnings).to.have.length(0);
    });

    it("emits one warn on the 4th client from same IP within the window", async () => {
      const { reg, store } = await buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 4; i++) {
        access.recordNewClientActivity("1.2.3.4", true);
      }
      const burstWarn = store.logs.filter(l => l.level === "warn" && l.msg.includes("not persisting cookies"));
      expect(burstWarn).to.have.length(1);
      expect(burstWarn[0].msg).to.include("1.2.3.4");
    });

    it("does not double-warn within the window", async () => {
      const { reg, store } = await buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 10; i++) {
        access.recordNewClientActivity("1.2.3.4", true);
      }
      const burstWarn = store.logs.filter(l => l.level === "warn" && l.msg.includes("not persisting cookies"));
      expect(burstWarn).to.have.length(1);
    });

    it("tracks bursts per IP independently", async () => {
      const { reg, store } = await buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 4; i++) {
        access.recordNewClientActivity("1.2.3.4", true);
      }
      for (let i = 0; i < 4; i++) {
        access.recordNewClientActivity("5.6.7.8", true);
      }
      const burstWarn = store.logs.filter(l => l.level === "warn" && l.msg.includes("not persisting cookies"));
      expect(burstWarn).to.have.length(2);
    });

    it("caps the burst-tracking map at 200 entries (FIFO)", async () => {
      const { reg } = await buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 250; i++) {
        access.recordNewClientActivity(`10.0.0.${i}`, true);
      }
      expect(access.newClientBurst.size).to.be.at.most(200);
      // Newest entries survive
      expect(access.newClientBurst.has("10.0.0.249")).to.be.true;
    });

    it("re-warns after a full idle window elapses (sliding cooldown, M4/M10)", async () => {
      const { reg, store } = await buildReg();
      const access = reg as unknown as BurstAccess;
      const t0 = 10 * NEW_CLIENT_WINDOW_MS; // realistic (warn cooldown compares now - warnedAt)
      for (let i = 0; i < 4; i++) {
        access.recordNewClientActivity("1.2.3.4", true, t0 + i);
      }
      // Idle a full window past the last activity (t0+3), then spray again → fresh window, warns again.
      const t1 = t0 + 3 + NEW_CLIENT_WINDOW_MS;
      for (let i = 0; i < 4; i++) {
        access.recordNewClientActivity("1.2.3.4", true, t1 + i);
      }
      const burstWarn = store.logs.filter(l => l.level === "warn" && l.msg.includes("not persisting cookies"));
      expect(burstWarn).to.have.length(2);
    });

    it("recovers from the throttle only after a full idle window; continuous spraying stays throttled (M4/M10)", async () => {
      const { reg } = await buildReg();
      const access = reg as unknown as BurstAccess;
      const ip = "7.7.7.7";
      const t0 = 5_000_000;
      // Drive the IP to the throttle threshold with persistent creates.
      for (let i = 0; i < NEW_CLIENT_THROTTLE_PER_HOUR; i++) {
        access.recordNewClientActivity(ip, true, t0 + i);
      }
      expect(access.isIpThrottled(ip, t0 + NEW_CLIENT_THROTTLE_PER_HOUR)).to.be.true;
      // Continuous spraying (throttled transient path, persistent=false) just under
      // the window keeps refreshing lastActivity → still throttled long after the
      // first burst. This is the fix for the old "fresh 30/h budget" hole (M4).
      let t = t0;
      for (let step = 0; step < 5; step++) {
        t += NEW_CLIENT_WINDOW_MS - 1;
        access.recordNewClientActivity(ip, false, t);
        expect(access.isIpThrottled(ip, t), `step ${step}`).to.be.true;
      }
      // A full idle window with no activity → recovered, persistent creates resume.
      expect(access.isIpThrottled(ip, t + NEW_CLIENT_WINDOW_MS)).to.be.false;
    });

    it("throttles cookieless new-client creation per IP, serving transient records (v1.36.0 S1)", async () => {
      const { reg } = await buildReg();
      const ip = "9.9.9.9";
      // The first NEW_CLIENT_THROTTLE_PER_HOUR cookieless requests (distinct UA so the
      // pendingByIp bucket doesn't collapse the sequential creates) are persisted.
      for (let i = 0; i < NEW_CLIENT_THROTTLE_PER_HOUR; i++) {
        await reg.identifyOrCreate(null, ip, { userAgent: `UA-${i}` });
      }
      expect(reg.listAll()).to.have.length(NEW_CLIENT_THROTTLE_PER_HOUR);
      // Beyond the threshold the IP gets a transient (non-persisted, untracked) record.
      const transient = await reg.identifyOrCreate(null, ip, { userAgent: "UA-extra" });
      expect(reg.getById(transient.id)).to.be.null;
      expect(reg.listAll()).to.have.length(NEW_CLIENT_THROTTLE_PER_HOUR); // no object growth
      // A different IP is unaffected — the throttle is per-IP.
      const other = await reg.identifyOrCreate(null, "8.8.8.8");
      expect(reg.getById(other.id)).to.not.be.null;
    });
  });

  describe("global new-client ceiling (trustProxy / spoofed X-Forwarded-For, IP-independent)", () => {
    const buildReg = async (): Promise<{ reg: ClientRegistry; store: MockStore }> => {
      const built = createMockAdapter();
      return { reg: await startedRegistry(built), store: built.store };
    };

    it("caps persistent cookieless creation across all-distinct IPs, then serves transient records + warns once", async () => {
      const { reg, store } = await buildReg();
      // One device rotating X-Forwarded-For: a fresh IP + UA every request, so the
      // per-IP throttle never trips — only the global ceiling can stop the flood.
      for (let i = 0; i < GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW; i++) {
        await reg.identifyOrCreate(null, `10.0.${(i >> 8) & 255}.${i & 255}`, { userAgent: `UA-${i}` });
      }
      expect(reg.listAll(), "every distinct-IP create below the ceiling is persisted").to.have.length(
        GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
      );
      // Three more fresh IPs are all over the global ceiling → transient (untracked,
      // no object) — and the warn is emitted once, not once per over-ceiling request.
      for (const ip of ["10.9.9.9", "10.9.9.10", "10.9.9.11"]) {
        const transient = await reg.identifyOrCreate(null, ip, { userAgent: `x-${ip}` });
        expect(reg.getById(transient.id), "over-ceiling create is not tracked").to.be.null;
      }
      expect(reg.listAll(), "no object-DB growth past the ceiling").to.have.length(
        GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
      );
      expect(
        store.logs.filter(l => l.level === "warn" && l.msg.includes("across all IPs")),
        "warns exactly ONCE per window, naming the spoofed-XFF / trustProxy cause (not once per request)",
      ).to.have.length(1);
    });

    it("recovers the global ceiling after a full idle window — and stays recovered for a burst", async () => {
      const { reg } = await buildReg();
      const spy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        for (let i = 0; i < GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW; i++) {
          await reg.identifyOrCreate(null, `10.0.${(i >> 8) & 255}.${i & 255}`, { userAgent: `UA-${i}` });
        }
        const throttled = await reg.identifyOrCreate(null, "10.9.9.9", { userAgent: "z" });
        expect(reg.getById(throttled.id), "over the ceiling within the window → transient").to.be.null;
        // Idle a full window, then onboard a small burst. All must persist: the window
        // reset must zero the COUNT (recordGlobalCreate), not merely let one create
        // through — otherwise the second create after recovery re-trips immediately.
        spy.mockReturnValue(1_000_000 + NEW_CLIENT_WINDOW_MS + 1);
        for (const ip of ["10.9.9.10", "10.9.9.11", "10.9.9.12"]) {
          const after = await reg.identifyOrCreate(null, ip, { userAgent: `y-${ip}` });
          expect(reg.getById(after.id), `after a full idle window ${ip} must persist`).to.not.be.null;
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("access-token expiry (S5 v1.36.0)", () => {
    it("getByToken rejects and drops an expired access token", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.9");
      await reg.setToken(rec.id, "tok-123");
      expect(reg.getByToken("tok-123")?.id).to.equal(rec.id); // valid immediately
      rec.tokenExpiresAt = Date.now() - 1000; // force past expiry
      expect(reg.getByToken("tok-123")).to.be.null;
      expect(rec.token).to.be.null; // also dropped from the record
    });

    it("setToken stamps an expiry ~OAUTH_ACCESS_TOKEN_TTL_S ahead; clearing the token clears it", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.10");
      const before = Date.now();
      await reg.setToken(rec.id, "tok-x");
      expect(rec.tokenExpiresAt).to.be.a("number");
      expect(rec.tokenExpiresAt!).to.be.at.least(before + OAUTH_ACCESS_TOKEN_TTL_S * 1000 - 5000);
      await reg.setToken(rec.id, null);
      expect(rec.tokenExpiresAt).to.be.null;
    });
  });

  describe("updateHostname (M5 / M1 v1.37.0)", () => {
    it("updates a known client's hostname when common.name is still the auto value", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.30"); // name = ip
      await reg.updateHostname(rec.cookie, "tablet.local");
      expect(reg.getById(rec.id)?.hostname).to.equal("tablet.local");
      expect(nameOf(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name)).to.equal("tablet.local");
    });

    it("is a no-op for an unknown cookie — never mints a ghost client (M5)", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const before = reg.listAll().length;
      await reg.updateHostname(crypto.randomUUID(), "ghost.local");
      expect(reg.listAll().length).to.equal(before);
    });

    it("a late reverse-DNS result names the display, also over a name typed in the tree (K7; kept up to 1.46.1, M1)", async () => {
      const built = createMockAdapter();
      const reg = await startedRegistry(built);
      const rec = await reg.identifyOrCreate(null, "10.0.0.31");
      // A user renames the device in the admin UI.
      built.store.objects.get(`hassemu.0.clients.${rec.id}`)!.common = { name: "Wohnzimmer" };
      await reg.updateHostname(rec.cookie, "late-dns.local");
      expect(nameOf(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name)).to.equal("late-dns.local");
      expect(reg.getById(rec.id)?.hostname).to.equal("late-dns.local");
    });
  });
});

describe("ClientRegistry name/description reach existing clients (v1.41.0)", () => {
  // Four write paths used to freeze a client's texts for the life of the client:
  // setObjectNotExists on .ip/.remove, `preserve` on .manualUrl, and the name-preserving
  // early return in ensureModeObject. Measured on the live tree 2026-09-03: `.ip` still
  // read "Client IP" and `.remove` "Forget this client" — both renamed in admin/i18n
  // versions earlier.
  const textOf = (name: unknown): unknown =>
    name !== null && typeof name === "object" ? (name as Record<string, string>).en : name;

  /**
   * Put a client's objects into the state an installation from BEFORE the text change is
   * in: the objects exist, but their revision stamp is older than the current one. That —
   * not a freshly created client — is the situation the delivery guarantee is about.
   *
   * @param built             Mock adapter bundle.
   * @param built.store        Its object/state store.
   * @param built.store.objects The object map the stamp is aged in.
   * @param id                 Client id whose stamp should be aged.
   */
  const ageObjectsVersion = (built: { store: { objects: Map<string, ObjEntry> } }, id: string): void => {
    const container = built.store.objects.get(`hassemu.0.clients.${id}`)!;
    container.native = { ...(container.native ?? {}), objectsVersion: 1 };
  };

  it("brings the current name to an EXISTING .ip that still has the old one", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.7");
    // Simulate the tree of an installation created before the rename.
    built.store.objects.get(`hassemu.0.clients.${rec.id}.ip`)!.common = { name: "Client IP" };
    ageObjectsVersion(built, rec.id);

    const reg2 = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg2.restore();

    expect(textOf(built.store.objects.get(`hassemu.0.clients.${rec.id}.ip`)?.common?.name)).to.equal("Display IP");
  });

  it("brings the current name to an EXISTING .remove", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.8");
    built.store.objects.get(`hassemu.0.clients.${rec.id}.remove`)!.common = { name: "Forget this client" };
    ageObjectsVersion(built, rec.id);

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(textOf(built.store.objects.get(`hassemu.0.clients.${rec.id}.remove`)?.common?.name)).to.equal(
      "Forget this display",
    );
  });

  it("repairs a broken .mode schema with the CURRENT name even when the revision stamp is current", async () => {
    // Audit 2026-09-15 (E3): the schema repair used to carry the tree's name over
    // (`preservedName`) and the text refresh only runs on an older stamp — so a `.mode`
    // whose schema had been damaged from outside kept a stale name at the current stamp.
    // The name of `.mode` is the adapter's own text, not the user's.
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.10");
    const mode = built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)!;
    mode.common = { ...mode.common, name: "STALE", type: "mixed" }; // broken schema, stamp stays current

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    const repaired = built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)!;
    expect(repaired.common?.type).to.equal("string");
    expect(textOf(repaired.common?.name)).to.equal("Redirect mode");
  });

  it("no longer shields .manualUrl behind `preserve`", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.9");
    built.store.objects.get(`hassemu.0.clients.${rec.id}.manualUrl`)!.common = { name: "STALE" };
    ageObjectsVersion(built, rec.id);

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(textOf(built.store.objects.get(`hassemu.0.clients.${rec.id}.manualUrl`)?.common?.name)).to.equal(
      "Manual URL",
    );
  });

  it("brings the current name to .mode even when its schema is already fine", async () => {
    // ensureModeObject returns early on a healthy schema — the name can only arrive
    // through its own extendObject after that.
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.10");
    const modeObj = built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)!;
    modeObj.common = { ...modeObj.common, name: "STALE MODE" };
    ageObjectsVersion(built, rec.id);

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(textOf(built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)?.common?.name)).to.equal("Redirect mode");
  });

  it("re-stamps the revision so the refresh happens once, not on every start", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.12");
    ageObjectsVersion(built, rec.id);

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.native?.objectsVersion).to.equal(
      CLIENT_OBJECTS_VERSION,
    );
  });

  it("writes NOTHING for a client whose objects already carry the current revision", async () => {
    // v1.41.0 refreshed .manualUrl / .ip / .remove / .mode-name unconditionally: four
    // broker calls per display per start, each a write plus an objectChange fan-out, for
    // a text that changes about once a year. The stamp restores the adapter's own rule
    // (I4/I6/L1) without giving up delivery — see the four tests above.
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.13");
    // First restore brings the stamp up to date.
    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    const writes: string[] = [];
    const realExtend = built.adapter.extendObject;
    (built.adapter as { extendObject: typeof realExtend }).extendObject = (id, obj, options) => {
      writes.push(id);
      return realExtend(id, obj, options);
    };

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    // The registry addresses its own objects WITHOUT the namespace prefix — filtering on
    // prefixed ids would match nothing and the test would pass no matter what.
    const perClientTextWrites = writes.filter(id =>
      [
        `clients.${rec.id}.manualUrl`,
        `clients.${rec.id}.ip`,
        `clients.${rec.id}.remove`,
        `clients.${rec.id}.mode`,
        `clients.${rec.id}`,
      ].includes(id),
    );
    expect(perClientTextWrites, `unexpected writes: ${perClientTextWrites.join(", ")}`).to.deep.equal([]);
  });

  it("creates the read-only resolvedUrl datapoint for every display", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.20");
    const obj = built.store.objects.get(`hassemu.0.clients.${rec.id}.resolvedUrl`);
    expect(obj, "resolvedUrl object missing").to.not.be.undefined;
    expect(obj?.common?.role).to.equal("url");
    expect(obj?.common?.write).to.equal(false);
  });

  it("writes the resolved URL and clears it for the landing page", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.21");

    await reg.setResolvedUrl(rec.id, "http://dash.test/");
    expect(built.store.states.get(`hassemu.0.clients.${rec.id}.resolvedUrl`)?.val).to.equal("http://dash.test/");

    await reg.setResolvedUrl(rec.id, null);
    expect(built.store.states.get(`hassemu.0.clients.${rec.id}.resolvedUrl`)?.val).to.equal("");
  });

  it("writes no resolvedUrl for a transient (throttled) record — it owns no objects", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    await reg.setResolvedUrl("ghost1", "http://dash.test/");
    expect(built.store.states.has("hassemu.0.clients.ghost1.resolvedUrl")).to.equal(false);
  });

  it("still RE-CREATES a per-client object somebody deleted, current revision or not", async () => {
    // The stamp gates the text REFRESH, never the existence guarantee.
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.14");
    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore(); // stamp is current now
    built.store.objects.delete(`hassemu.0.clients.${rec.id}.ip`);

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(built.store.objects.has(`hassemu.0.clients.${rec.id}.ip`), ".ip was re-created").to.equal(true);
  });

  it("keeps the mode dropdown out of the name refresh", async () => {
    // extendObject deep-merges `states`; a refresh that carried them would resurrect
    // URL keys syncUrlDropdown had dropped (v1.27.2).
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.11");
    const modeObj = built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)!;
    modeObj.common = { ...modeObj.common, states: { 0: "---", "http://gone": "stale" } };

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    const states = built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)?.common?.states;
    expect(states).to.deep.equal({ 0: "---", "http://gone": "stale" });
  });

  it("writes a new client's name as a translation object, text unchanged", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.12", { hostname: "tablet.local" });
    const name = built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name as Record<string, string>;
    expect(name).to.be.an("object");
    expect(name.en).to.equal("tablet.local");
    expect(name.de).to.equal("tablet.local");
  });

  it("converts a pre-v1.41.0 bare-string client name on restore, keeping the text", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.13", { hostname: "ShellyWallDisplay-00A90B9CF0B7" });
    // The live tree carried exactly this: the display's own hostname as a bare string.
    built.store.objects.get(`hassemu.0.clients.${rec.id}`)!.common = { name: "ShellyWallDisplay-00A90B9CF0B7" };

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    const name = built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name as Record<string, string>;
    expect(name).to.be.an("object");
    expect(name.en).to.equal("ShellyWallDisplay-00A90B9CF0B7");
  });

  it("a bare-string name the USER typed becomes the name of the sources, as a translation object (K7)", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.14");
    built.store.objects.get(`hassemu.0.clients.${rec.id}`)!.common = { name: "Küche Display" };

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    const name = built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name as Record<string, string>;
    expect(name).to.be.an("object");
    expect(name.en).to.equal("10.0.0.14");
  });

  it("leaves an already-converted client name untouched", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.15");
    const before = built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name;

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name).to.deep.equal(before);
  });

  it("an IP change renames a display whose name is a translation object", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "1.1.1.1");
    await reg.identifyOrCreate(rec.cookie, "2.2.2.2");
    expect(textOf(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name)).to.equal("2.2.2.2");
  });

  it("writes the renamed auto-name as a translation object, not a bare string", async () => {
    // The IP-change rename must not put the form back to a bare string — otherwise the
    // tree drifts back one display at a time whenever an address changes (mutation C9).
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "1.1.1.1");
    await reg.identifyOrCreate(rec.cookie, "2.2.2.2");
    const name = built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name as Record<string, string>;
    expect(name).to.be.an("object");
    expect(name.en).to.equal("2.2.2.2");
    expect(name.de).to.equal("2.2.2.2");
  });

  it("a restart keeps the host name, and an address change does not overwrite it", async () => {
    // restore() takes the host name from the data file (K7) — without it the next IP would be stamped over the host
    // name (mutation C11, when the host name still came from the device name).
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.20", { hostname: "tablet.local" });

    const reg2 = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg2.restore();
    expect(reg2.getById(rec.id)?.hostname).to.equal("tablet.local");

    // …and an address change must not overwrite that hostname.
    await reg2.identifyOrCreate(rec.cookie, "10.0.0.99");
    const name = built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name as Record<string, string>;
    expect(name.en).to.equal("tablet.local");
  });

  it("a user rename that is already a translation object gives way to the new address too (K7)", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "1.1.1.1");
    built.store.objects.get(`hassemu.0.clients.${rec.id}`)!.common = {
      name: { en: "Kitchen Display", de: "Kitchen Display" },
    };
    await reg.identifyOrCreate(rec.cookie, "2.2.2.2");
    expect(textOf(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name)).to.equal("2.2.2.2");
  });
});

describe("parseClientStateId", () => {
  const ns = "hassemu.0";

  it("parses mode writes", () => {
    expect(parseClientStateId("hassemu.0.clients.abc123.mode", ns)).to.deep.equal({
      id: "abc123",
      kind: "mode",
    });
  });

  it("parses manualUrl writes", () => {
    expect(parseClientStateId("hassemu.0.clients.abc123.manualUrl", ns)).to.deep.equal({
      id: "abc123",
      kind: "manualUrl",
    });
  });

  it("parses remove button presses", () => {
    expect(parseClientStateId("hassemu.0.clients.abc123.remove", ns)).to.deep.equal({
      id: "abc123",
      kind: "remove",
    });
  });

  it("returns null for foreign state IDs", () => {
    expect(parseClientStateId("other.0.clients.abc123.mode", ns)).to.be.null;
  });

  it("returns null for non-client states", () => {
    expect(parseClientStateId("hassemu.0.info.connection", ns)).to.be.null;
  });

  it("returns null for the now-removed visUrl path", () => {
    expect(parseClientStateId("hassemu.0.clients.abc123.visUrl", ns)).to.be.null;
  });

  it("returns null for read-only ip/hostname", () => {
    expect(parseClientStateId("hassemu.0.clients.abc123.ip", ns)).to.be.null;
    expect(parseClientStateId("hassemu.0.clients.abc123.hostname", ns)).to.be.null;
  });

  it("returns null for channel ID (no sub-state)", () => {
    expect(parseClientStateId("hassemu.0.clients.abc123", ns)).to.be.null;
  });

  it("returns null for too-deep IDs", () => {
    expect(parseClientStateId("hassemu.0.clients.abc.123.mode", ns)).to.be.null;
  });
});

describe("ClientRegistry data file — cookie, tokens and lastSeen out of the objects (Werkbank standard, round 173)", () => {
  // krobi 2026-11-10 14:34: generated secrets and runtime values never stand in an object's `native`,
  // they live in a file of the instance data folder (client-store.ts).
  type Bundle = ReturnType<typeof createMockAdapter>;

  /**
   * Seed a display the way an earlier version stored it: cookie, tokens and lastSeen in the device
   * object's `native`, the six leaves beside it.
   *
   * @param built Mock adapter bundle.
   * @param id    Display id.
   */
  function seedLegacyDisplay(built: Bundle, id: string): Record<string, unknown> {
    const native = {
      cookie: crypto.randomUUID(),
      token: crypto.randomUUID(),
      tokenExpiresAt: Date.now() + 60_000,
      refreshToken: crypto.randomUUID(),
      lastSeen: Date.now() - 5000,
      objectsVersion: CLIENT_OBJECTS_VERSION,
    };
    built.store.objects.set(`hassemu.0.clients.${id}`, {
      type: "device",
      common: { name: { en: "10.0.0.5" } },
      native: { ...native },
    });
    for (const leaf of ["mode", "manualUrl", "ip", "resolvedUrl", "remove"]) {
      built.store.objects.set(`hassemu.0.clients.${id}.${leaf}`, {
        type: "state",
        common: { name: { en: leaf }, type: "string", role: leaf === "mode" ? "text" : "state" },
        native: {},
      });
    }
    built.store.states.set(`hassemu.0.clients.${id}.mode`, { val: "http://dash.local/", ack: true });
    built.store.states.set(`hassemu.0.clients.${id}.ip`, { val: "10.0.0.5", ack: true });
    return native;
  }

  /**
   * Seed a display as this version stores it: its entry in the data file and a device object
   * without secrets.
   *
   * @param built Mock adapter bundle.
   * @param id    Display id.
   */
  function seedDisplay(built: Bundle, id: string): StoredClient {
    const entry: StoredClient = {
      cookie: crypto.randomUUID(),
      token: null,
      tokenExpiresAt: null,
      refreshToken: null,
      lastSeen: Date.now() - 5000,
    };
    const stored = readStore(built.store.dataDir, TEST_CIPHER).clients;
    stored.set(id, entry);
    rewriteClients(built.store.dataDir, stored);
    built.store.objects.set(`hassemu.0.clients.${id}`, {
      type: "device",
      common: { name: { en: "panel.local" } },
      native: { objectsVersion: CLIENT_OBJECTS_VERSION },
    });
    return entry;
  }

  /**
   * Run `body` while the data file cannot be written: a folder stands where the write puts its temporary
   * file (`<file>.tmp`, data-file.ts), so every write fails on every platform — a read-only folder (chmod)
   * stops no write on Windows or as root. Reading the missing file still answers "nothing yet".
   *
   * @param built Mock adapter bundle.
   * @param body  What runs meanwhile.
   */
  async function withUnwritableDataFile(built: Bundle, body: () => Promise<void>): Promise<void> {
    const blocker = join(built.store.dataDir, `${STORE_FILE}.tmp`);
    mkdirSync(blocker, { recursive: true });
    try {
      await body();
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  }

  it("after onboarding and a restart the device holds no secret, and cookie and tokens still resolve", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.20");
    const access = crypto.randomUUID();
    const refresh = crypto.randomUUID();
    await reg.setTokens(rec.id, access, refresh);

    const restarted = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await restarted.restore();

    expect(restarted.getByCookie(rec.cookie)?.id).to.equal(rec.id);
    expect(restarted.getByRefreshToken(refresh)?.id).to.equal(rec.id);
    expect(restarted.getByToken(access)?.id).to.equal(rec.id);
    expect(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.native).to.deep.equal({
      objectsVersion: CLIENT_OBJECTS_VERSION,
    });
  });

  it("an earlier version's display: its identity moves into the file, then leaves the object in ONE full write", async () => {
    const built = createMockAdapter();
    const native = seedLegacyDisplay(built, "old001");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    built.store.writes.length = 0;

    await reg.restore();

    expect(storedEntry(built.store, "old001")).to.deep.equal({
      cookie: native.cookie,
      token: native.token,
      tokenExpiresAt: native.tokenExpiresAt,
      refreshToken: native.refreshToken,
      lastSeen: native.lastSeen,
    });
    const device = built.store.objects.get("hassemu.0.clients.old001")!;
    expect(device.native).to.deep.equal({ objectsVersion: CLIENT_OBJECTS_VERSION });
    expect(nameOf(device.common?.name), "the rest of the object stays").to.equal("10.0.0.5");
    // extendObject merges — a key written as null would stay; the keys go in one full write.
    const deviceWrites = built.store.writes.filter(w => w.id === "hassemu.0.clients.old001");
    expect(deviceWrites.map(w => w.method)).to.deep.equal(["setForeignObject"]);
    expect(reg.getByCookie(native.cookie as string)?.id).to.equal("old001");

    const restarted = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await restarted.restore();
    expect(restarted.getByRefreshToken(native.refreshToken as string)?.id, "found again after the move").to.equal(
      "old001",
    );
  });

  it("the file cannot be written: the start fails, the old copies stay in the objects, the next start moves them (K16)", async () => {
    const built = createMockAdapter();
    const native = seedLegacyDisplay(built, "old002");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    // A run from memory would lose every identity at the next start — the start fails instead (K16, ST1).
    await withUnwritableDataFile(built, async () => {
      await expect(reg.restore()).rejects.toThrow(`the identities could not be stored in`);
    });

    expect(built.store.objects.get("hassemu.0.clients.old002")?.native?.cookie).to.equal(native.cookie);

    const restarted = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await restarted.restore();
    expect(storedEntry(built.store, "old002")?.cookie).to.equal(native.cookie);
    expect(built.store.objects.get("hassemu.0.clients.old002")?.native).to.deep.equal({
      objectsVersion: CLIENT_OBJECTS_VERSION,
    });
  });

  it("an unreadable data file stops the start and touches no display (design decisions 2 and 27)", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "dsp001");
    writeFileSync(join(built.store.dataDir, STORE_FILE), "{ broken");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    built.store.writes.length = 0;

    await expect(reg.restore()).rejects.toThrow(STORE_FILE);

    expect(built.store.objects.has("hassemu.0.clients.dsp001"), "no display is removed").to.be.true;
    expect(built.store.writes).to.deep.equal([]);
    expect(readFileSync(join(built.store.dataDir, STORE_FILE), "utf8"), "the file stays as it is").to.equal("{ broken");
  });

  it("an entry whose display has no object any more is dropped from the file", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "keep01");
    seedDisplay(built, "gone01");
    built.store.objects.delete("hassemu.0.clients.gone01");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);

    await reg.restore();

    expect([...readStore(built.store.dataDir, TEST_CIPHER).clients.keys()]).to.deep.equal(["keep01"]);
  });

  it("objects that cannot be listed fail the start and cost no stored identity (K16)", async () => {
    const built = createMockAdapter();
    const entry = seedDisplay(built, "dsp002");
    const before = readFileSync(join(built.store.dataDir, STORE_FILE), "utf8");
    const list = built.adapter.getForeignObjectsAsync;
    built.adapter.getForeignObjectsAsync = () => Promise.reject(new Error("broker gone"));
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);

    // Running on would re-create every known display as a new one (ST1: no access to ioBroker is a failed start).
    await expect(reg.restore()).rejects.toThrow("reading the display objects failed (broker gone)");
    expect(readFileSync(join(built.store.dataDir, STORE_FILE), "utf8"), "the file stays as it is").to.equal(before);

    built.adapter.getForeignObjectsAsync = list;
    const restarted = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await restarted.restore();
    expect(restarted.getByCookie(entry.cookie)?.id).to.equal("dsp002");
  });

  it("remove() drops the display's entry from the file", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.22");
    expect(storedEntry(built.store, rec.id), "stored on creation").to.not.be.undefined;

    await reg.remove(rec.id);

    expect(storedEntry(built.store, rec.id)).to.be.undefined;
  });

  it("remove() of a restored display drops its entry too — the restore hands the entry to the record", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "dsp003");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();

    await reg.remove("dsp003");

    expect(storedEntry(built.store, "dsp003")).to.be.undefined;
  });

  it("a new display whose identity cannot be stored is not created — no object, nothing tracked", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    await withUnwritableDataFile(built, async () => {
      await expect(reg.identifyOrCreate(null, "10.0.0.23")).rejects.toThrow();
    });

    expect(reg.listAll()).to.deep.equal([]);
    expect([...built.store.objects.keys()].filter(id => id.startsWith("hassemu.0.clients."))).to.deep.equal([]);
  });
});

describe("ClientRegistry start cost (audit 2026-09-15 — C1, C2, D1)", () => {
  // Nothing counted broker calls at start before this suite — that is how a restart
  // silently cost every display one `lastSeen` object write, one `resolvedUrl` state
  // write and a serial round of reads. Counts are the assertion, not "it passed".
  type Counts = Record<string, number>;
  type Bundle = ReturnType<typeof createMockAdapter>;

  /**
   * Wrap the broker methods of a mock adapter with call counters. A `setStateChangedAsync`
   * that finds the stored value unchanged counts as a read, never as a write — the same
   * split the controller makes.
   *
   * @param built The mock adapter bundle to instrument.
   */
  function count(built: Bundle): Counts {
    const counts: Counts = {};
    const a = built.adapter as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const m of [
      "getStateAsync",
      "getStatesAsync",
      "getObjectAsync",
      "getForeignObjectsAsync",
      "setObjectNotExistsAsync",
      "extendObject",
      "setForeignObject",
      "setState",
      "delObjectAsync",
    ]) {
      const original = a[m];
      a[m] = (...args) => {
        counts[m] = (counts[m] ?? 0) + 1;
        return original(...args);
      };
    }
    const changed = a.setStateChangedAsync;
    a.setStateChangedAsync = async (...args) => {
      const result = (await changed(...args)) as { notChanged: boolean };
      const key = result.notChanged ? "setStateChanged:unchanged" : "setStateChanged:written";
      counts[key] = (counts[key] ?? 0) + 1;
      return result;
    };
    return counts;
  }

  /**
   * Object writes of any kind — what a restart must not cost for an unchanged installation.
   *
   * @param c The call counts collected by {@link count}.
   */
  const writes = (c: Counts): number =>
    (c.extendObject ?? 0) +
    (c.setForeignObject ?? 0) +
    (c.setState ?? 0) +
    (c.delObjectAsync ?? 0) +
    (c["setStateChanged:written"] ?? 0);

  /**
   * The data file's inode — every write replaces the file (temp file + rename), so a new
   * inode shows a write even when the content came out the same.
   *
   * @param built The mock adapter bundle.
   */
  const fileInode = (built: Bundle): number => statSync(join(built.store.dataDir, STORE_FILE)).ino;

  /**
   * Seed a display exactly as an up-to-date installation holds it: device + six leaves
   * with the current revision stamp, valid state values, its entry in the data file with
   * a persisted `lastSeen`, and a persisted `resolvedUrl`.
   *
   * @param built    Mock adapter bundle.
   * @param id       Display id.
   * @param lastSeen The persisted `lastSeen`.
   */
  function seedDisplay(built: Bundle, id: string, lastSeen: number): string {
    const cookie = crypto.randomUUID();
    const stored = readStore(built.store.dataDir, TEST_CIPHER).clients;
    stored.set(id, { cookie, token: null, tokenExpiresAt: null, refreshToken: null, lastSeen });
    rewriteClients(built.store.dataDir, stored);
    built.store.objects.set(`hassemu.0.clients.${id}`, {
      type: "device",
      common: { name: { en: "10.0.0.7" } },
      native: { objectsVersion: CLIENT_OBJECTS_VERSION },
    });
    for (const leaf of ["mode", "manualUrl", "ip", "resolvedUrl", "remove"]) {
      built.store.objects.set(`hassemu.0.clients.${id}.${leaf}`, {
        type: "state",
        common: { name: { en: leaf }, type: "string", role: leaf === "mode" ? "text" : "state" },
        native: {},
      });
    }
    built.store.states.set(`hassemu.0.clients.${id}.mode`, { val: "http://dash.local/", ack: true });
    built.store.states.set(`hassemu.0.clients.${id}.manualUrl`, { val: "", ack: true });
    built.store.states.set(`hassemu.0.clients.${id}.ip`, { val: "10.0.0.7", ack: true });
    built.store.states.set(`hassemu.0.clients.${id}.resolvedUrl`, { val: "http://dash.local/", ack: true });
    return cookie;
  }

  it("restoring N up-to-date displays writes nothing and reads every state of the instance with ONE read", async () => {
    // Before, each display cost five single reads, and the read-only resolvedUrl was read again before each write
    // (inventory suite: "read-only states read one by one", 2026-11-12).
    const built = createMockAdapter();
    const N = 10;
    for (let i = 0; i < N; i++) {
      seedDisplay(built, `display-${String(i).padStart(4, "0")}`, Date.now() - 5000);
    }
    const counts = count(built);
    const inode = fileInode(built);
    const storedBefore = readStore(built.store.dataDir, TEST_CIPHER);
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();

    expect(reg.listAll()).to.have.lengthOf(N);
    expect(writes(counts), JSON.stringify(counts)).to.equal(0);
    // The one file write of the start is its check that the identities can be stored (K16, ST1) — same content.
    expect(fileInode(built), "the start writes the data file once as its check").to.not.equal(inode);
    expect(readStore(built.store.dataDir, TEST_CIPHER), "with the same server id and identities").to.deep.equal(
      storedBefore,
    );
    expect(counts.getStateAsync ?? 0, "no single read").to.equal(0);
    expect(counts.getStatesAsync, "one read of every state").to.equal(1);
    expect(counts.getObjectAsync ?? 0).to.be.at.most(N);
    const restored = reg.getById("display-0003");
    expect(restored?.mode, "the values come from that read").to.equal("http://dash.local/");
    expect(restored?.ip).to.equal("10.0.0.7");
  });

  it("fails the start when the states cannot be read — no display is touched (K16)", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "display-0001", Date.now() - 5000);
    built.adapter.getStatesAsync = () => Promise.reject(new Error("states database down"));
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    const counts = count(built);
    let failure: unknown;
    try {
      await reg.restore();
    } catch (err) {
      failure = err;
    }
    expect(String(failure)).to.include("states database down");
    expect(writes(counts), JSON.stringify(counts)).to.equal(0);
    expect(built.store.states.get("hassemu.0.clients.display-0001.mode")?.val).to.equal("http://dash.local/");
  });

  it("first contact after a restart does NOT re-write a lastSeen that is inside the flush window (C1)", async () => {
    const built = createMockAdapter();
    const cookie = seedDisplay(built, "fresh1", Date.now() - 5000);
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    const counts = count(built);
    const before = readFileSync(join(built.store.dataDir, STORE_FILE), "utf8");

    await reg.identifyOrCreate(cookie, "10.0.0.7");

    expect(writes(counts), JSON.stringify(counts)).to.equal(0);
    expect(readFileSync(join(built.store.dataDir, STORE_FILE), "utf8")).to.equal(before);
  });

  it("first contact after a restart DOES write a lastSeen older than the flush window (the GC depends on it)", async () => {
    // The mirror image of C1: if the restored stamp ever disabled the flush entirely,
    // the stale-GC would forget a live display after 30 days without any gate going red.
    const built = createMockAdapter();
    const cookie = seedDisplay(built, "stale1", Date.now() - (LASTSEEN_FLUSH_INTERVAL_MS + 1));
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    const counts = count(built);
    const before = storedEntry(built.store, "stale1")!.lastSeen!;

    await reg.identifyOrCreate(cookie, "10.0.0.7");

    expect(writes(counts), "the stamp is no object write").to.equal(0);
    const after = storedEntry(built.store, "stale1")!.lastSeen!;
    expect(after).to.be.greaterThan(before);
    expect(reg.lastSeenOf("stale1")).to.equal(after);
  });

  it("the GC stamp comes from the restore, not from a second object read (D1)", async () => {
    const built = createMockAdapter();
    const stamp = Date.now() - 12345;
    seedDisplay(built, "gc0001", stamp);
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();

    expect(reg.lastSeenOf("gc0001")).to.equal(stamp);
    expect(reg.lastSeenOf("nobody")).to.be.undefined;
  });

  it("a NEW display is created with the current texts and stamp — no second name write, no stamp write (G2)", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const counts = count(built);

    const rec = await reg.identifyOrCreate(null, "10.0.0.9");
    await new Promise(resolve => setImmediate(resolve));

    // Device + five leaves created, three values written — and nothing else: the create
    // path used to add a name write and a stamp write, and until the data file one
    // lastSeen object write.
    expect(counts.setObjectNotExistsAsync).to.equal(6);
    expect(counts.setState).to.equal(3);
    expect(counts.extendObject ?? 0, JSON.stringify(counts)).to.equal(0);
    const device = built.store.objects.get(`hassemu.0.clients.${rec.id}`)!;
    expect(device.native).to.deep.equal({ objectsVersion: CLIENT_OBJECTS_VERSION });
    expect(typeof storedEntry(built.store, rec.id)?.lastSeen).to.equal("number");
    const mode = built.store.objects.get(`hassemu.0.clients.${rec.id}.mode`)!;
    expect((mode.common?.name as Record<string, string>).en).to.equal("Redirect mode");
    expect((mode.common?.desc as Record<string, string>).en).to.be.a("string");
  });

  it("an unchanged resolvedUrl after a restart is not written again; a changed one is (C2)", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "url001", Date.now() - 5000);
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    const counts = count(built);

    await reg.setResolvedUrl("url001", "http://dash.local/");
    expect(writes(counts), JSON.stringify(counts)).to.equal(0);
    expect(counts.getStateAsync ?? 0, "compared in memory, not read from the database").to.equal(0);

    await reg.setResolvedUrl("url001", null);
    expect(counts.setState).to.equal(1);
    expect(built.store.states.get("hassemu.0.clients.url001.resolvedUrl")?.val).to.equal("");
    await reg.setResolvedUrl("url001", null);
    expect(counts.setState, "the same answer again writes nothing").to.equal(1);
  });

  it("replaces the default js-controller put into a new resolvedUrl with the first answer, even when equal", async () => {
    // 7.2.5 writes `def` with the quality "initial value" (0x20); setStateChangedAsync compared q and wrote — so does
    // the comparison in memory: only what a write of hassemu leaves behind counts as written.
    const built = createMockAdapter();
    seedDisplay(built, "url002", Date.now() - 5000);
    built.store.states.set("hassemu.0.clients.url002.resolvedUrl", { val: "", ack: true, q: 0x20 });
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    const counts = count(built);
    await reg.setResolvedUrl("url002", null);
    expect(counts.setState).to.equal(1);
    await reg.setResolvedUrl("url002", null);
    expect(counts.setState).to.equal(1);
  });

  it("two answers arriving together write the new resolvedUrl once", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "url003", Date.now() - 5000);
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    const counts = count(built);
    await Promise.all([
      reg.setResolvedUrl("url003", "http://other.local/"),
      reg.setResolvedUrl("url003", "http://other.local/"),
    ]);
    expect(counts.setState).to.equal(1);
  });

  it("a failed resolvedUrl write is a debug line, and the next answer writes it", async () => {
    const built = createMockAdapter();
    seedDisplay(built, "url004", Date.now() - 5000);
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    const real = built.adapter.setState;
    built.adapter.setState = () => Promise.reject(new Error("broker down"));
    await reg.setResolvedUrl("url004", "http://other.local/");
    expect(built.store.logs.some(l => l.level === "debug" && l.msg.includes("broker down"))).to.be.true;
    built.adapter.setState = real;
    await reg.setResolvedUrl("url004", "http://other.local/");
    expect(built.store.states.get("hassemu.0.clients.url004.resolvedUrl")?.val).to.equal("http://other.local/");
  });
});

describe("ClientRegistry transient records own nothing (audit 2026-09-15 — B3, D2)", () => {
  /**
   * Push the registry over the global ceiling so the next cookieless request gets a
   * transient record — the throttle's own path, not a hand-built record.
   *
   * @param reg The registry to saturate.
   */
  const overCeiling = (reg: ClientRegistry): void => {
    (reg as unknown as { globalBurst: { count: number; lastCreate: number; warnedAt: number } }).globalBurst = {
      count: GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
      lastCreate: Date.now(),
      warnedAt: 0,
    };
  };

  it("a transient record is flagged non-persistent and never gets a lastSeen or a resolvedUrl written", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    overCeiling(reg);
    const objectsBefore = built.store.objects.size;
    const statesBefore = built.store.states.size;

    const transient = await reg.identifyOrCreate(null, "10.9.9.9");
    await reg.setResolvedUrl(transient.id, "http://dash.local/");
    await new Promise(resolve => setImmediate(resolve));

    expect(transient.persistent).to.be.false;
    expect(reg.getById(transient.id)).to.be.null;
    expect(built.store.objects.size).to.equal(objectsBefore);
    expect(built.store.states.size).to.equal(statesBefore);
  });

  it("a persistent record is flagged persistent", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.1");
    expect(rec.persistent).to.be.true;
  });

  it("a transient id never collides with a live display — through the throttled path (B3, T3)", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const live = await reg.identifyOrCreate(null, "10.0.0.2");
    // Exhaust the per-IP throttle of 10.0.0.1 — the next cookieless request is transient.
    for (let i = 0; i < NEW_CLIENT_THROTTLE_PER_HOUR; i++) {
      await reg.identifyOrCreate(null, "10.0.0.1", { userAgent: `UA-${i}` });
    }
    // The generator draws the live display's four characters: the TRANSIENT path must give way
    // exactly like createClient does — with the counter (K7). Driven through identifyOrCreate, not
    // the helper — a transient path that skipped the check stayed green before.
    const offered = [live.id.slice(-4)];
    const generator = vi.spyOn(displayId, "randomIdTail").mockImplementation(() => {
      const next = offered.shift();
      if (next === undefined) {
        throw new Error("generator asked more often than expected");
      }
      return next;
    });
    try {
      const transient = await reg.identifyOrCreate(null, "10.0.0.1", { userAgent: "UA-extra" });
      expect(transient.persistent).to.be.false;
      expect(transient.id).to.equal(`${live.id}-2`);
    } finally {
      generator.mockRestore();
    }
  });

  it("writes at most one address change per minute for a known display (H4)", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const rec = await reg.identifyOrCreate(null, "10.0.0.1");
      let ipWrites = 0;
      const setState = built.adapter.setState.bind(built.adapter);
      built.adapter.setState = (id: string, value: { val: unknown; ack?: boolean }) => {
        if (id.endsWith(".ip")) {
          ipWrites++;
        }
        return setState(id, value);
      };
      for (let i = 2; i < 52; i++) {
        await reg.identifyOrCreate(rec.cookie, `10.0.0.${i}`);
      }
      expect(ipWrites, "a rotating address inside one window").to.equal(1);

      vi.setSystemTime(Date.now() + 61_000);
      await reg.identifyOrCreate(rec.cookie, "10.0.9.9");
      expect(ipWrites).to.equal(2);
      expect(reg.getById(rec.id)!.ip).to.equal("10.0.9.9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a display whose objects could not be written leaves no record behind (L6)", async () => {
    const built = createMockAdapter();
    built.adapter.setObjectNotExistsAsync = () => Promise.reject(new Error("objects db hiccup"));
    const reg = await startedRegistry(built);

    for (let i = 0; i < 3; i++) {
      await reg.identifyOrCreate(null, "10.0.0.1", { userAgent: `UA-${i}` }).catch(() => undefined);
    }

    // Before: three ghosts in the lookup maps, no object behind any of them.
    expect(reg.listAll()).to.have.length(0);
  });
});

describe("ClientRegistry pictogram (review 2026-11-07 — R-19)", () => {
  it("a new display carries the pictogram; a stored one of the previous revision gets it once with the version write, which carries no name", async () => {
    const built = createMockAdapter();
    const rec = await (await startedRegistry(built)).identifyOrCreate(null, "10.0.0.8");
    const deviceId = `hassemu.0.clients.${rec.id}`;
    const icon = displayIcon();
    expect(icon).to.be.a("string");
    expect(built.store.objects.get(deviceId)?.common?.icon).to.equal(icon);

    // The previous revision: no icon, an older stamp.
    const stored = built.store.objects.get(deviceId)!;
    delete stored.common!.icon;
    stored.native!.objectsVersion = CLIENT_OBJECTS_VERSION - 1;
    built.store.writes.length = 0;

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();
    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    const after = built.store.objects.get(deviceId)!;
    expect(after.common?.icon).to.equal(icon);
    expect(nameOf(after.common?.name)).to.equal("10.0.0.8");
    expect(after.native?.objectsVersion).to.equal(CLIENT_OBJECTS_VERSION);
    const iconWrites = built.store.writes.filter(w => w.id === deviceId && w.obj.common && "icon" in w.obj.common);
    expect(iconWrites).to.have.lengthOf(1);
    expect(iconWrites[0].obj.common, "the version write carries no name").to.not.have.property("name");
  });
});

/**
 * A display as 1.46.1 left it: `clients.<id>` with cookie, tokens and lastSeen in its `native`, and its five
 * datapoints with their values.
 *
 * @param built The stub installation.
 * @param id    The display id.
 * @param name  Its device name.
 * @returns Its cookie.
 */
function seedOldDisplay(built: ReturnType<typeof createMockAdapter>, id: string, name = "tablet.lan"): string {
  const cookie = crypto.randomUUID();
  const s = built.store;
  s.objects.set(`hassemu.0.clients.${id}`, {
    type: "device",
    common: { name: { en: name, de: name } },
    native: {
      cookie,
      token: crypto.randomUUID(),
      tokenExpiresAt: Date.now() + 60_000,
      refreshToken: crypto.randomUUID(),
      lastSeen: Date.now() - 1000,
      objectsVersion: CLIENT_OBJECTS_VERSION,
    },
  });
  s.objects.set(`hassemu.0.clients.${id}.mode`, {
    type: "state",
    common: { name: { en: "Mode" }, type: "string", role: "text", read: true, write: true, states: {} },
    native: {},
  });
  for (const leaf of ["manualUrl", "ip", "resolvedUrl", "remove"]) {
    s.objects.set(`hassemu.0.clients.${id}.${leaf}`, { type: "state", common: { name: { en: leaf } }, native: {} });
  }
  s.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
  s.states.set(`hassemu.0.clients.${id}.manualUrl`, { val: "http://dash.local/", ack: true });
  s.states.set(`hassemu.0.clients.${id}.ip`, { val: "10.0.0.9", ack: true });
  s.states.set(`hassemu.0.clients.${id}.resolvedUrl`, { val: "http://dash.local/", ack: true });
  return cookie;
}

/**
 * Every object and every value id below or at `clients.<id>`.
 *
 * @param store The stub installation.
 * @param id    The display id.
 */
const leftOf = (store: MockStore, id: string): string[] =>
  [...store.objects.keys(), ...store.states.keys()].filter(
    k => k === `hassemu.0.clients.${id}` || k.startsWith(`hassemu.0.clients.${id}.`),
  );

describe("ClientRegistry display ids move once (K7, krobi 2026-11-11 19:51)", () => {
  it("moves a display of the old form: device, datapoints, values, identity, rooms, recordings", async () => {
    const built = createMockAdapter();
    const s = built.store;
    const cookie = seedOldDisplay(built, "61c3a1");
    s.objects.get("hassemu.0.clients.61c3a1.mode")!.common!.custom = {
      "influxdb.0": { enabled: true },
      "history.0": { enabled: true, aliasId: "my.series" },
      "sql.0": { enabled: false },
    };
    s.objects.set("enum.rooms.kitchen", { type: "enum", common: { members: ["hassemu.0.clients.61c3a1", "x.0.y"] } });
    s.objects.set("enum.functions.screen", { type: "enum", common: { members: ["hassemu.0.clients.61c3a1.mode"] } });
    const reg = new ClientRegistry(built.adapter as never, s.dataDir);

    await reg.restore();

    expect(leftOf(s, "61c3a1"), "nothing stays under the old id").to.deep.equal([]);
    const device = s.objects.get("hassemu.0.clients.display-c3a1");
    expect(device?.type).to.equal("device");
    // The name of the sources: a display of 1.x has no host name stored yet, it resolves at the first contact.
    expect(nameOf(device?.common?.name)).to.equal("10.0.0.9");
    expect(device?.native).to.not.have.property("movingTo");
    expect(device?.native, "the identity moved on into the data file").to.not.have.property("cookie");
    expect(s.states.get("hassemu.0.clients.display-c3a1.mode")?.val).to.equal(MODE_MANUAL);
    expect(s.states.get("hassemu.0.clients.display-c3a1.manualUrl")?.val).to.equal("http://dash.local/");
    expect(s.states.get("hassemu.0.clients.display-c3a1.ip")?.val).to.equal("10.0.0.9");
    expect(reg.getByCookie(cookie)?.id, "the display is still recognised").to.equal("display-c3a1");
    expect(reg.getByCookie(cookie)?.mode).to.equal(MODE_MANUAL);
    expect(reg.listAll()).to.have.lengthOf(1);
    expect(storedEntry(s, "display-c3a1")?.cookie).to.equal(cookie);
    expect(storedEntry(s, "61c3a1")).to.equal(undefined);
    expect(s.objects.get("enum.rooms.kitchen")?.common?.members).to.deep.equal([
      "x.0.y",
      "hassemu.0.clients.display-c3a1",
    ]);
    expect(s.objects.get("enum.functions.screen")?.common?.members).to.deep.equal([
      "hassemu.0.clients.display-c3a1.mode",
    ]);
    expect(s.objects.get("hassemu.0.clients.display-c3a1.mode")?.common?.custom).to.deep.equal({
      "influxdb.0": { enabled: true, aliasId: "hassemu.0.clients.61c3a1.mode" },
      "history.0": { enabled: true, aliasId: "my.series" },
      "sql.0": { enabled: false },
    });
    const moved = s.logs.filter(l => l.level === "info" && l.msg.includes("61c3a1"));
    expect(moved).to.have.lengthOf(1);
    expect(moved[0].msg).to.include("display-c3a1");
  });

  it("points every alias of the moved display at the new id, in both target forms, and no other alias", async () => {
    const built = createMockAdapter();
    const s = built.store;
    seedOldDisplay(built, "61c3a1");
    s.objects.set("alias.0.wall.mode", {
      type: "state",
      common: { name: "Wall mode", alias: { id: "hassemu.0.clients.61c3a1.mode" } },
      native: {},
    });
    s.objects.set("alias.0.wall.url", {
      type: "state",
      common: {
        name: "Wall URL",
        alias: { id: { read: "hassemu.0.clients.61c3a1.resolvedUrl", write: "hassemu.0.clients.61c3a1.manualUrl" } },
      },
      native: {},
    });
    s.objects.set("alias.0.half", {
      type: "state",
      common: { name: "Half", alias: { id: { read: "hassemu.0.clients.61c3a1.ip", write: "other.0.x" } } },
      native: {},
    });
    s.objects.set("alias.0.other", {
      type: "state",
      common: { name: "Other", alias: { id: "hassemu.0.clients.61c3a10.mode" } },
      native: {},
    });
    s.objects.set("alias.0.plain", { type: "state", common: { name: "Plain" }, native: {} });

    await new ClientRegistry(built.adapter as never, s.dataDir).restore();

    const target = (id: string): unknown => (s.objects.get(id)?.common as { alias?: { id?: unknown } }).alias?.id;
    expect(target("alias.0.wall.mode")).to.equal("hassemu.0.clients.display-c3a1.mode");
    expect(target("alias.0.wall.url")).to.deep.equal({
      read: "hassemu.0.clients.display-c3a1.resolvedUrl",
      write: "hassemu.0.clients.display-c3a1.manualUrl",
    });
    expect(target("alias.0.half")).to.deep.equal({ read: "hassemu.0.clients.display-c3a1.ip", write: "other.0.x" });
    expect(target("alias.0.other"), "a different display whose id starts alike").to.equal(
      "hassemu.0.clients.61c3a10.mode",
    );
    expect(s.objects.get("alias.0.plain")?.common).to.deep.equal({ name: "Plain" });
    expect(nameOf(s.objects.get("alias.0.wall.mode")?.common?.name)).to.equal("Wall mode");
    const moved = s.logs.filter(l => l.level === "info" && l.msg.includes("61c3a1"));
    expect(moved.map(l => l.msg)).to.deep.equal([
      "Display 61c3a1 is now display-c3a1 — scripts and visualisations that use clients.61c3a1 need the new id",
    ]);
  });

  it("an alias read that fails fails the start before the old display is touched", async () => {
    const built = createMockAdapter();
    const s = built.store;
    const cookie = seedOldDisplay(built, "61c3a1");
    s.objects.set("alias.0.wall.mode", {
      type: "state",
      common: { name: "Wall mode", alias: { id: "hassemu.0.clients.61c3a1.mode" } },
      native: {},
    });
    const a = built.adapter as unknown as {
      getForeignObjectsAsync: (pattern: string, type?: string) => Promise<Record<string, ObjEntry>>;
    };
    const list = a.getForeignObjectsAsync;
    a.getForeignObjectsAsync = (pattern: string, type?: string) =>
      pattern === "alias.*" ? Promise.reject(new Error("broker down")) : list(pattern, type);

    let failed: unknown;
    await new ClientRegistry(built.adapter as never, s.dataDir).restore().catch((err: unknown) => (failed = err));

    expect(failed).to.be.instanceOf(Error);
    expect(s.objects.get("hassemu.0.clients.61c3a1")?.native?.movingTo).to.equal("display-c3a1");
    expect(s.objects.has("hassemu.0.clients.61c3a1.mode")).to.be.true;

    a.getForeignObjectsAsync = list;
    const reg = new ClientRegistry(built.adapter as never, s.dataDir);
    await reg.restore();
    expect(reg.getByCookie(cookie)?.id).to.equal("display-c3a1");
    expect((s.objects.get("alias.0.wall.mode")?.common as { alias?: { id?: unknown } }).alias?.id).to.equal(
      "hassemu.0.clients.display-c3a1.mode",
    );
  });

  it("a second start moves nothing and writes nothing", async () => {
    const built = createMockAdapter();
    seedOldDisplay(built, "61c3a1");
    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();
    built.store.writes.length = 0;
    built.store.logs.length = 0;

    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();

    expect(built.store.writes).to.deep.equal([]);
    expect(reg.listAll().map(r => r.id)).to.deep.equal(["display-c3a1"]);
    expect(built.store.logs.filter(l => l.level === "info")).to.deep.equal([]);
  });

  it("lists the objects for a move only when a display moves", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    await reg.identifyOrCreate(null, "10.0.0.3");
    const a = built.adapter as unknown as { getAdapterObjectsAsync: () => Promise<unknown> };
    let listings = 0;
    const list = a.getAdapterObjectsAsync;
    a.getAdapterObjectsAsync = () => {
      listings++;
      return list();
    };

    await new ClientRegistry(built.adapter as never, built.store.dataDir).restore();

    expect(listings).to.equal(0);
  });

  it("finishes a move an earlier start began — the journal, a partial copy", async () => {
    const built = createMockAdapter();
    const s = built.store;
    const cookie = seedOldDisplay(built, "61c3a1");
    const old = s.objects.get("hassemu.0.clients.61c3a1")!;
    old.native!.movingTo = "display-c3a1";
    // The copy reached the device and the mode, then the process ended.
    s.objects.set(
      "hassemu.0.clients.display-c3a1",
      structuredClone({ ...old, native: { ...old.native, movingTo: undefined } }),
    );
    s.objects.set(
      "hassemu.0.clients.display-c3a1.mode",
      structuredClone(s.objects.get("hassemu.0.clients.61c3a1.mode")!),
    );
    s.states.set("hassemu.0.clients.display-c3a1.mode", { val: MODE_MANUAL, ack: true });
    const reg = new ClientRegistry(built.adapter as never, s.dataDir);

    await reg.restore();

    expect(leftOf(s, "61c3a1")).to.deep.equal([]);
    expect(reg.listAll().map(r => r.id)).to.deep.equal(["display-c3a1"]);
    expect(reg.getByCookie(cookie)?.ip).to.equal("10.0.0.9");
    expect(s.states.get("hassemu.0.clients.display-c3a1.manualUrl")?.val).to.equal("http://dash.local/");
  });

  it("finishes a move whose datapoints are gone already — only the old device with its journal is left", async () => {
    const built = createMockAdapter();
    const s = built.store;
    const cookie = seedOldDisplay(built, "display-c3a1");
    s.objects.set("hassemu.0.clients.61c3a1", {
      type: "device",
      common: { name: { en: "tablet.lan" } },
      native: { cookie, movingTo: "display-c3a1" },
    });
    const reg = new ClientRegistry(built.adapter as never, s.dataDir);

    await reg.restore();

    expect(leftOf(s, "61c3a1")).to.deep.equal([]);
    expect(reg.listAll().map(r => r.id)).to.deep.equal(["display-c3a1"]);
    expect(reg.getByCookie(cookie)?.id).to.equal("display-c3a1");
  });

  it("a write that fails fails the start — the journal stays, the old display is whole, the next start moves it", async () => {
    const built = createMockAdapter();
    const s = built.store;
    const cookie = seedOldDisplay(built, "61c3a1");
    const a = built.adapter as unknown as { setForeignObject: (id: string, obj: ObjEntry) => Promise<void> };
    const write = a.setForeignObject;
    a.setForeignObject = (id: string, obj: ObjEntry) =>
      id === "hassemu.0.clients.display-c3a1.ip" ? Promise.reject(new Error("broker down")) : write(id, obj);

    let failed: unknown;
    await new ClientRegistry(built.adapter as never, s.dataDir).restore().catch((err: unknown) => (failed = err));

    expect(failed).to.be.instanceOf(Error);
    expect(s.objects.get("hassemu.0.clients.61c3a1")?.native?.movingTo).to.equal("display-c3a1");
    for (const leaf of ["mode", "manualUrl", "ip", "resolvedUrl", "remove"]) {
      expect(s.objects.has(`hassemu.0.clients.61c3a1.${leaf}`), leaf).to.be.true;
    }
    expect(s.states.get("hassemu.0.clients.61c3a1.ip")?.val).to.equal("10.0.0.9");

    a.setForeignObject = write;
    const reg = new ClientRegistry(built.adapter as never, s.dataDir);
    await reg.restore();
    expect(leftOf(s, "61c3a1")).to.deep.equal([]);
    expect(reg.getByCookie(cookie)?.id).to.equal("display-c3a1");
    expect(s.states.get("hassemu.0.clients.display-c3a1.ip")?.val).to.equal("10.0.0.9");
  });

  it("two old ids that end alike get display-c3a1 and display-c3a1-2, by id", async () => {
    const built = createMockAdapter();
    const second = seedOldDisplay(built, "bbc3a1");
    const first = seedOldDisplay(built, "aac3a1");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);

    await reg.restore();

    expect(reg.getByCookie(first)?.id).to.equal("display-c3a1");
    expect(reg.getByCookie(second)?.id).to.equal("display-c3a1-2");
  });

  it("a display without an identity does not move — the restore removes it as before", async () => {
    const built = createMockAdapter();
    built.store.objects.set("hassemu.0.clients.abcdef", { type: "device", common: { name: "x" }, native: {} });
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);

    await reg.restore();

    expect(built.store.objects.has("hassemu.0.clients.abcdef")).to.be.false;
    expect(built.store.objects.has("hassemu.0.clients.display-cdef")).to.be.false;
    expect(reg.listAll()).to.deep.equal([]);
  });

  it("a new display from the Android app starts its id with its model", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.4", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; K) Home Assistant/2026.11.1-full (Android 14; Pixel Tablet)",
    });
    expect(rec.id).to.match(/^pixel-tablet-[0-9a-f]{4}$/);
    expect(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.type).to.equal("device");
  });
});

describe("ClientRegistry device names (K7)", () => {
  /**
   * Rename a display in the object tree, as a user does in the admin.
   *
   * @param store The stub installation.
   * @param id    The display id.
   * @param name  The new name.
   */
  const rename = (store: MockStore, id: string, name: string): void => {
    store.objects.get(`hassemu.0.clients.${id}`)!.common!.name = { en: name, de: name };
  };
  const nameIn = (store: MockStore, id: string): unknown =>
    nameOf(store.objects.get(`hassemu.0.clients.${id}`)?.common?.name);
  /**
   * The name writes on a display's device object so far.
   *
   * @param store The stub installation.
   * @param id    The display id.
   */
  const nameWrites = (store: MockStore, id: string): number =>
    store.writes.filter(w => w.id === `hassemu.0.clients.${id}` && w.obj.common?.name !== undefined).length;
  /**
   * Count the reads of a display's device object from now on.
   *
   * @param built The stub adapter.
   * @param id    The display id.
   * @returns the running count
   */
  const countDeviceReads = (built: ReturnType<typeof createMockAdapter>, id: string): { reads: number } => {
    const counter = { reads: 0 };
    const real = built.adapter.getObjectAsync;
    built.adapter.getObjectAsync = (oid: string) => {
      if (oid === `clients.${id}`) {
        counter.reads++;
      }
      return real(oid);
    };
    return counter;
  };

  it("the app's device name becomes the name, follows every change and is stored for the next start", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.5", { hostname: "tablet.lan" });
    expect(nameIn(built.store, rec.id)).to.equal("tablet.lan");
    expect(storedEntry(built.store, rec.id)?.hostname).to.equal("tablet.lan");

    await reg.setAppName(rec.id, "Kitchen Tablet");
    expect(nameIn(built.store, rec.id)).to.equal("Kitchen Tablet");
    await reg.setAppName(rec.id, "Hall Tablet");
    expect(nameIn(built.store, rec.id)).to.equal("Hall Tablet");
    expect(storedEntry(built.store, rec.id)).to.include({ appName: "Hall Tablet", hostname: "tablet.lan" });

    const next = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await next.restore();
    await next.updateHostname(rec.cookie, "other.lan");
    expect(nameIn(built.store, rec.id), "the app's name outranks the host name").to.equal("Hall Tablet");
    expect(storedEntry(built.store, rec.id)?.hostname, "the new host name is stored").to.equal("other.lan");
  });

  // krobi 2026-09-02 (fleet rule): a user has no business in an adapter's datapoints; 2026-11-11 22:40: „Adapter hat
  // sich an die Flotte zu halten!“ — up to 1.46.1 hassemu kept a name typed in the object tree.
  it("a name typed in the object tree does not stay — the start and every source change name the display", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.6", { hostname: "tablet.lan" });

    rename(built.store, rec.id, "My Display");
    const next = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await next.restore();
    expect(nameIn(built.store, rec.id), "the start writes the name of the sources").to.equal("tablet.lan");

    rename(built.store, rec.id, "My Display");
    const counter = countDeviceReads(built, rec.id);
    await next.updateHostname(rec.cookie, "other.lan");
    expect(nameIn(built.store, rec.id)).to.equal("other.lan");
    rename(built.store, rec.id, "My Display");
    await next.setAppName(rec.id, "Kitchen Tablet");
    expect(nameIn(built.store, rec.id)).to.equal("Kitchen Tablet");
    expect(counter.reads, "a source change writes without reading the tree").to.equal(0);
  });

  it("a source change that leaves the name as it is writes nothing", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.7", { hostname: "tablet.lan" });
    await reg.setAppName(rec.id, "Kitchen Tablet");
    const before = nameWrites(built.store, rec.id);

    await reg.setAppName(rec.id, "Kitchen Tablet");
    await reg.updateHostname(rec.cookie, "tablet.lan");
    await reg.updateHostname(rec.cookie, "other.lan");
    await reg.identifyOrCreate(rec.cookie, "10.0.0.77");

    expect(nameWrites(built.store, rec.id), "the app's name outranks host name and address").to.equal(before);

    const next = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await next.restore();
    expect(nameWrites(built.store, rec.id), "a current name costs the start no write").to.equal(before);
  });

  it("stored before K7: named by its address at the first start, by its host name at the first contact", async () => {
    const built = createMockAdapter();
    const own = seedOldDisplay(built, "display-0001", "tablet.lan");
    seedOldDisplay(built, "display-0002", "Küche");
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();
    expect(reg.getByCookie(own)?.hostname, "the name in the tree is no source").to.be.null;
    expect(nameIn(built.store, "display-0001")).to.equal("10.0.0.9");
    expect(nameIn(built.store, "display-0002")).to.equal("10.0.0.9");

    await reg.updateHostname(own, "tablet.lan");
    expect(nameIn(built.store, "display-0001")).to.equal("tablet.lan");
    expect(storedEntry(built.store, "display-0001")?.hostname).to.equal("tablet.lan");
  });

  it("the host name of a datapoint up to 1.1.1 is hassemu's own and names the display", async () => {
    const built = createMockAdapter();
    const cookie = seedOldDisplay(built, "display-0003", "10.0.0.9");
    built.store.objects.set("hassemu.0.clients.display-0003.hostname", { type: "state" });
    built.store.states.set("hassemu.0.clients.display-0003.hostname", { val: "old.lan", ack: true });
    const reg = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await reg.restore();

    expect(reg.getByCookie(cookie)?.hostname).to.equal("old.lan");
    expect(nameIn(built.store, "display-0003")).to.equal("old.lan");
    expect(storedEntry(built.store, "display-0003")?.hostname).to.equal("old.lan");
  });

  it("takes a host name as one line of at most 253 characters, the form it stores and reads back", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.10");
    await reg.updateHostname(rec.cookie, "   ");
    expect(nameIn(built.store, rec.id)).to.equal("10.0.0.10");

    await reg.updateHostname(rec.cookie, "tablet\nlan");
    expect(nameIn(built.store, rec.id)).to.equal("tablet lan");
    await reg.updateHostname(rec.cookie, `${"h".repeat(300)}`);
    expect(nameIn(built.store, rec.id)).to.equal("h".repeat(253));

    const next = new ClientRegistry(built.adapter as never, built.store.dataDir);
    await next.restore();
    expect(next.getByCookie(rec.cookie)?.hostname).to.equal("h".repeat(253));
  });

  it("takes only a usable app name: text, one line, at most 64 characters", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.7");
    for (const bad of [42, "", "   ", null, { name: "x" }]) {
      await reg.setAppName(rec.id, bad);
    }
    expect(nameIn(built.store, rec.id)).to.equal("10.0.0.7");
    expect(storedEntry(built.store, rec.id)).to.not.have.property("appName");

    await reg.setAppName(rec.id, "Kitchen\nTablet");
    expect(nameIn(built.store, rec.id)).to.equal("Kitchen Tablet");
    await reg.setAppName(rec.id, "x".repeat(100));
    expect(nameIn(built.store, rec.id)).to.equal("x".repeat(64));
    await reg.setAppName("display-none", "Ghost");
    expect(built.store.objects.has("hassemu.0.clients.display-none")).to.be.false;
  });

  it("never rejects — a failed name write is a debug line, and the next source change tries again", async () => {
    const built = createMockAdapter();
    const reg = await startedRegistry(built);
    const rec = await reg.identifyOrCreate(null, "10.0.0.8");
    const real = built.adapter.extendObject;
    built.adapter.extendObject = () => Promise.reject(new Error("broker down"));

    await reg.setAppName(rec.id, "Kitchen Tablet");
    expect(built.store.logs.some(l => l.level === "debug" && l.msg.includes("broker down"))).to.be.true;

    built.adapter.extendObject = real;
    await reg.updateHostname(rec.cookie, "tablet.lan");
    expect(nameIn(built.store, rec.id), "the name not written is written now").to.equal("Kitchen Tablet");
  });
});
