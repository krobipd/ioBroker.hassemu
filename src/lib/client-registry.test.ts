import crypto from "node:crypto";

vi.mock("@iobroker/adapter-core", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const i18nDir = join(__dirname, "../../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
    i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
  }
  return {
    I18n: {
      getTranslatedObject: vi.fn((key: string) => {
        const result: Record<string, string> = {};
        for (const [lang, data] of Object.entries(i18nData)) {
          if (data[key]) {
            result[lang] = data[key];
          }
        }
        return Object.keys(result).length > 0 ? result : { en: key };
      }),
      translate: vi.fn((key: string) => i18nData.en?.[key] ?? key),
    },
  };
});

import { ClientRegistry, parseClientStateId } from "./client-registry";
import {
  GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
  MODE_GLOBAL,
  MODE_MANUAL,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S,
} from "./constants";
import type { ClientRecord } from "./types";

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
  states: Map<string, { val: unknown; ack: boolean }>;
  logs: LogEntry[];
}

function createMockAdapter(namespace = "hassemu.0"): {
  store: MockStore;
  adapter: ReturnType<typeof buildAdapter>;
} {
  const store: MockStore = {
    namespace,
    objects: new Map(),
    states: new Map(),
    logs: [],
  };

  function buildAdapter(): {
    namespace: string;
    log: {
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
    getStateAsync: (id: string) => Promise<{ val: unknown; ack: boolean } | null>;
    getObjectAsync: (id: string) => Promise<ObjEntry | null>;
    setObject: (id: string, obj: ObjEntry) => Promise<void>;
    setObjectNotExistsAsync: (id: string, obj: ObjEntry) => Promise<void>;
    extendObject: (id: string, obj: Partial<ObjEntry>, options?: Record<string, unknown>) => Promise<void>;
    setState: (id: string, value: { val: unknown; ack?: boolean }, _ack?: boolean) => Promise<void>;
    delObjectAsync: (id: string, options?: { recursive?: boolean }) => Promise<void>;
  } {
    return {
      namespace,
      log: {
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
            out[id] = obj;
          }
        }
        return Promise.resolve(out);
      },
      getStateAsync: (id: string) => Promise.resolve(store.states.get(`${namespace}.${id}`) ?? null),
      getObjectAsync: (id: string) => {
        const fullId = id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
        return Promise.resolve(store.objects.get(fullId) ?? null);
      },
      setObject: (id: string, obj: ObjEntry) => {
        const fullId = id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
        store.objects.set(fullId, obj);
        return Promise.resolve();
      },
      setObjectNotExistsAsync: (id: string, obj: ObjEntry) => {
        const fullId = `${namespace}.${id}`;
        if (!store.objects.has(fullId)) {
          store.objects.set(fullId, obj);
        }
        return Promise.resolve();
      },
      extendObject: (id: string, obj: Partial<ObjEntry>, options?: Record<string, unknown>) => {
        const fullId = `${namespace}.${id}`;
        const existing = store.objects.get(fullId) ?? { type: "state" };
        const preserve = (options?.preserve as { common?: string[] })?.common ?? [];
        const mergedCommon = { ...(existing.common ?? {}), ...(obj.common ?? {}) };
        for (const field of preserve) {
          if ((existing.common as Record<string, unknown>)?.[field] !== undefined) {
            (mergedCommon as Record<string, unknown>)[field] = (existing.common as Record<string, unknown>)[field];
          }
        }
        store.objects.set(fullId, {
          ...existing,
          ...obj,
          common: mergedCommon,
          native: { ...(existing.native ?? {}), ...(obj.native ?? {}) },
        });
        return Promise.resolve();
      },
      setState: (id: string, value: { val: unknown; ack?: boolean }) => {
        store.states.set(`${namespace}.${id}`, { val: value.val, ack: value.ack ?? false });
        return Promise.resolve();
      },
      delObjectAsync: (id: string) => {
        const fullId = `${namespace}.${id}`;
        store.objects.delete(fullId);
        for (const k of [...store.states.keys()]) {
          if (k === fullId || k.startsWith(`${fullId}.`)) {
            store.states.delete(k);
          }
        }
        for (const k of [...store.objects.keys()]) {
          if (k.startsWith(`${fullId}.`)) {
            store.objects.delete(k);
          }
        }
        return Promise.resolve();
      },
    };
  }

  return { store, adapter: buildAdapter() };
}

describe("ClientRegistry", () => {
  let store: MockStore;
  let adapter: ReturnType<typeof createMockAdapter>["adapter"];
  let registry: ClientRegistry;

  beforeEach(() => {
    const built = createMockAdapter();
    store = built.store;
    adapter = built.adapter;
    registry = new ClientRegistry(adapter as never);
  });

  describe("identifyOrCreate", () => {
    it("creates a new client when cookie is missing", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5", { hostname: "tablet.local" });
      expect(rec.id).to.match(/^[0-9a-f]{6}$/);
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

    it('mode state has type "mixed" (future-proof against strict-type cast)', async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const obj = store.objects.get(`hassemu.0.clients.${rec.id}.mode`);
      expect(obj?.common?.type).to.equal("mixed");
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
      expect(ch?.common?.name).to.equal("192.168.1.5");
    });

    it("sets common.name to hostname when known at creation", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5", { hostname: "tablet.local" });
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(ch?.common?.name).to.equal("tablet.local");
    });

    it("updates common.name when hostname resolves after creation", async () => {
      const rec = await registry.identifyOrCreate(null, "192.168.1.5");
      await registry.identifyOrCreate(rec.cookie, "192.168.1.5", { hostname: "tablet.local" });
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(ch?.common?.name).to.equal("tablet.local");
    });

    it("keeps common.name in sync with ip while hostname unknown", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(ch?.common?.name).to.equal("2.2.2.2");
    });

    it("preserves a user-renamed common.name across an IP change (v1.36.0 C4)", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1"); // auto name = "1.1.1.1"
      const ch = store.objects.get(`hassemu.0.clients.${rec.id}`)!;
      ch.common = { ...ch.common, name: "Kitchen Display" }; // user renames in the admin UI
      // Reconnect from a new DHCP lease — the IP change must NOT clobber the user
      // name (record.hostname is still null; the old guard overwrote it with the IP).
      await registry.identifyOrCreate(rec.cookie, "2.2.2.2");
      expect(store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name).to.equal("Kitchen Display");
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
      expect(store.objects.get(key)?.common?.name).to.not.equal("2.2.2.2");
    });

    it("writes ip and hostname only when they actually change", async () => {
      const rec = await registry.identifyOrCreate(null, "1.1.1.1", { hostname: "tablet.local" });
      const ipKey = `hassemu.0.clients.${rec.id}.ip`;
      store.states.delete(ipKey);
      const namesBefore = store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name;

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
      expect(store.objects.get(chKey)?.common?.name, "no name write for an unchanged hostname").to.equal("MARKER");
      expect(namesBefore).to.equal("tablet.local");

      // The name itself is protected by a read-before-overwrite inside
      // applyAutoName — but that read is a broker round-trip. An unchanged
      // hostname must not even reach it: one extra read per request per
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
      expect(ch?.common?.name).to.equal("tablet.local");
    });

    it("persists cookie in channel.native", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(channel?.native?.cookie).to.equal(rec.cookie);
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
    // ClientRecords statt cookie/token zu teilen.
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

    // v1.17.0 (C8) — same UA on same IP behaves wie vorher: Bursts kollabieren.
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
      expect(ch?.common?.name).to.equal("new.local");
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

    it("writes lastSeen native on first identify", async () => {
      const before = Date.now();
      const rec = await registry.identifyOrCreate(null, "1.1.1.1");
      const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
      const lastSeen = (channel?.native as { lastSeen?: number })?.lastSeen;
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

    it("persists token to channel.native", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setToken(rec.id, token);
      const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(channel?.native?.token).to.equal(token);
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

  describe("setRefreshToken (v1.31.0)", () => {
    it("sets the refresh token and makes it findable", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setRefreshToken(rec.id, token);
      expect(rec.refreshToken).to.equal(token);
      expect(registry.getByRefreshToken(token)).to.equal(rec);
    });

    it("persists refresh token to channel.native.refreshToken", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setRefreshToken(rec.id, token);
      const channel = store.objects.get(`hassemu.0.clients.${rec.id}`);
      expect(channel?.native?.refreshToken).to.equal(token);
    });

    it("clears refresh token on null", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setRefreshToken(rec.id, token);
      await registry.setRefreshToken(rec.id, null);
      expect(rec.refreshToken).to.be.null;
      expect(registry.getByRefreshToken(token)).to.be.null;
    });

    it("replaces old refresh token when new one is set (old no longer looked up)", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await registry.setRefreshToken(rec.id, t1);
      await registry.setRefreshToken(rec.id, t2);
      expect(registry.getByRefreshToken(t1)).to.be.null;
      expect(registry.getByRefreshToken(t2)).to.equal(rec);
    });

    it("no-op when id is unknown", async () => {
      await registry.setRefreshToken("xxxxxx", "any");
      expect(registry.listAll().length).to.equal(0);
    });

    it("restore() loads refreshToken from native field", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setRefreshToken(rec.id, token);

      // Fresh registry on same store (simulates adapter restart)
      const reg2 = new ClientRegistry(adapter as never);
      await reg2.restore();
      const restored = reg2.getByRefreshToken(token);
      expect(restored?.id).to.equal(rec.id);
      expect(restored?.refreshToken).to.equal(token);
    });

    it("restore() handles missing native.refreshToken (legacy install) without crash", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      // Simulate legacy install: client exists but no refreshToken ever set
      expect(rec.refreshToken).to.be.null;

      const reg2 = new ClientRegistry(adapter as never);
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

      const reg2 = new ClientRegistry(adapter as never);
      await reg2.restore();
      expect(reg2.listAll().map(r => r.id)).to.deep.equal([rec.id]);
    });

    it("remove(id) clears byRefreshToken lookup", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      const token = crypto.randomUUID();
      await registry.setRefreshToken(rec.id, token);
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

    it("warns when 'manual' is set but manualUrl is empty", async () => {
      await registry.handleModeWrite(rec.id, MODE_MANUAL);
      const warn = store.logs.find(l => l.level === "warn" && l.msg.includes("manualUrl is empty"));
      expect(warn).to.not.be.undefined;
    });

    it("accepts a safe URL string", async () => {
      await registry.handleModeWrite(rec.id, "http://tablet.local/ui");
      expect(rec.mode).to.equal("http://tablet.local/ui");
    });

    it("accepts empty string (clears mode)", async () => {
      rec.mode = MODE_GLOBAL;
      await registry.handleModeWrite(rec.id, "");
      expect(rec.mode).to.equal("");
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

    it("rejects non-string values (logs debug, G7 v1.18.0)", async () => {
      await registry.handleModeWrite(rec.id, 42);
      expect(rec.mode).to.equal(MODE_GLOBAL);
      // v1.18.0 (G7): downgrade warn→debug — das war UI-echo, kein Server-Concern.
      const debug = store.logs.find(l => l.level === "debug" && l.msg.includes("non-string"));
      expect(debug).to.not.be.undefined;
    });

    it("no-op when id is unknown", async () => {
      await registry.handleModeWrite("xxxxxx", "http://ok/");
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
      const warn = store.logs.find(l => l.level === "warn" && l.msg.includes("manualUrl cleared"));
      expect(warn).to.not.be.undefined;
    });

    it("no-op when id is unknown", async () => {
      await registry.handleManualUrlWrite("xxxxxx", "http://ok/");
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
      // bulkSetMode-Trigger ist Tech-Internal — auf debug seit v1.27.0
      // (User wollte mode-Werte aus dem User-Log raus). Test prüft den
      // debug-Output mit Count statt info.
      await registry.identifyOrCreate(null, "1.1.1.1");
      await registry.identifyOrCreate(null, "1.1.1.2");
      store.logs.length = 0;
      await registry.bulkSetMode("http://new/");
      const dbg = store.logs.find(l => l.level === "debug" && l.msg.includes("bulkSetMode"));
      expect(dbg?.msg).to.match(/2 client/);
    });

    it("is a no-op with no clients", async () => {
      await registry.bulkSetMode(MODE_GLOBAL);
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

    it("logs info on removal", async () => {
      const rec = await registry.identifyOrCreate(null, null);
      await registry.remove(rec.id);
      const info = store.logs.find(l => l.level === "info" && l.msg.includes("forgotten"));
      expect(info).to.not.be.undefined;
    });

    it("no-op when id is unknown", async () => {
      await registry.remove("xxxxxx");
    });
  });

  describe("syncUrlDropdown", () => {
    it("updates common.states on existing mode datapoints with sentinels + URLs (plain-string labels, EN fallback)", async () => {
      // v1.28.4: Sentinel-labels sind plain-strings (system-language resolved),
      // nicht mehr Translation-Objects. Admin crasht sonst mit React Error #31.
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
    });
  });

  describe("restore", () => {
    it("loads existing clients with mode + manualUrl from state", async () => {
      const id = "abc123";
      const cookie = crypto.randomUUID();
      store.objects.set(`hassemu.0.clients.${id}`, {
        type: "channel",
        common: { name: "tablet.local" },
        native: { cookie, token: null },
      });
      store.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
      store.states.set(`hassemu.0.clients.${id}.manualUrl`, { val: "http://saved/", ack: true });
      store.states.set(`hassemu.0.clients.${id}.ip`, { val: "192.168.1.20", ack: true });

      await registry.restore();
      const rec = registry.getById(id);
      expect(rec).to.not.be.null;
      expect(rec!.cookie).to.equal(cookie);
      expect(rec!.mode).to.equal(MODE_MANUAL);
      expect(rec!.manualUrl).to.equal("http://saved/");
      expect(rec!.ip).to.equal("192.168.1.20");
      expect(rec!.hostname).to.equal("tablet.local");
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
          type: "mixed",
          role: "state",
          read: true,
          write: true,
          states: { 0: "---", global: "Global URL", manual: "Manual URL", "http://vis/": "VIS" },
        },
        native: {},
      });
      store.states.set(`hassemu.0.clients.${id}.mode`, { val: "http://vis/", ack: true });

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
      store.states.set(`hassemu.0.clients.${id}.mode`, { val: "http://direct/", ack: true });
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
      store.states.set(`hassemu.0.clients.${id}.ip`, { val: "192.168.1.20", ack: true });
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
      store.states.set(`hassemu.0.clients.${id}.ip`, { val: "10.0.0.5", ack: true });
      store.states.set(`hassemu.0.clients.${id}.hostname`, { val: "tablet.local", ack: true });

      await registry.restore();
      const rec = registry.getById(id);
      expect(rec?.hostname).to.equal("tablet.local");
      const ch = store.objects.get(`hassemu.0.clients.${id}`);
      expect(ch?.common?.name).to.equal("tablet.local");
      expect(store.objects.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
      expect(store.states.has(`hassemu.0.clients.${id}.hostname`)).to.be.false;
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
      store.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_GLOBAL, ack: true });
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
      store.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_GLOBAL, ack: true });
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
      const id = "def456";
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
      store.states.set(`hassemu.0.clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
      store.states.set(`hassemu.0.clients.${id}.manualUrl`, { val: "javascript:bad", ack: true });
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

    it("a single broken client does not abort restore for the rest (HE1 v1.28.3)", async () => {
      // Three clients in store. The middle one's ensureObjects throws
      // (simulated broker hiccup mid-restore). Before HE1 the rejection
      // in the per-client body aborted the surrounding for-loop and
      // charlie never got restored.
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
      const localReg = new ClientRegistry(localBuilt.adapter as never);
      await localReg.restore();
      expect(localReg.getById("alpha"), "alpha must restore").to.not.be.null;
      expect(localReg.getById("charlie"), "charlie must restore").to.not.be.null;
      // bravo's trackInMemory ran before the failing ensureObjects.
      // Per-client try/catch ensures the other two still made it through.
    });
  });

  // --- v1.19.0 (J-Phase Test-Coverage) ---

  describe("seedLastSeen (F11 v1.19.0)", () => {
    it("writes native.lastSeen for the given id", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      built.store.objects.set("hassemu.0.clients.foo", { type: "channel", native: {} });
      await reg.seedLastSeen("foo", 1234567890);
      const obj = built.store.objects.get("hassemu.0.clients.foo");
      expect(obj?.native?.lastSeen).to.equal(1234567890);
    });

    it("updates throttle map so next touchLastSeen does not double-write", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      built.store.objects.set("hassemu.0.clients.foo", { type: "channel", native: {} });
      const flushed = (reg as unknown as { lastSeenFlushedAt: Map<string, number> }).lastSeenFlushedAt;
      expect(flushed.has("foo")).to.be.false;
      await reg.seedLastSeen("foo", 9999);
      expect(flushed.get("foo")).to.equal(9999);
    });
  });

  describe("touchLastSeen (throttle + resurrection guard)", () => {
    it("writes at most once per flush interval, not on every request", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      const rec = await reg.identifyOrCreate(null, "10.0.0.7");
      const key = `hassemu.0.clients.${rec.id}`;
      // Mark the stored value so a second write is visible.
      built.store.objects.set(key, {
        ...built.store.objects.get(key)!,
        native: { ...(built.store.objects.get(key)!.native ?? {}), lastSeen: 1 },
      });

      // A display polls the page every few seconds; an unthrottled upsert would
      // be one object write per request, per display, forever.
      await reg.identifyOrCreate(rec.cookie, "10.0.0.7");
      await reg.identifyOrCreate(rec.cookie, "10.0.0.7");
      expect((built.store.objects.get(key)!.native as { lastSeen: number }).lastSeen).to.equal(1);
    });

    it("never re-creates the object of a client removed mid-request", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
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
    });
  });

  describe("per-IP burst-detection for broken cookies (G5 v1.19.0)", () => {
    const buildReg = (): { reg: ClientRegistry; store: MockStore } => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      return { reg, store: built.store };
    };

    type BurstAccess = {
      recordNewClientActivity: (ip: string, persistent: boolean, now?: number) => void;
      isIpThrottled: (ip: string, now?: number) => boolean;
      newClientBurst: Map<string, unknown>;
    };

    it("does not warn on first 3 client creations from same IP", () => {
      const { reg, store } = buildReg();
      const access = reg as unknown as BurstAccess;
      access.recordNewClientActivity("1.2.3.4", true);
      access.recordNewClientActivity("1.2.3.4", true);
      access.recordNewClientActivity("1.2.3.4", true);
      const warnings = store.logs.filter(l => l.level === "warn");
      expect(warnings).to.have.length(0);
    });

    it("emits one warn on the 4th client from same IP within the window", () => {
      const { reg, store } = buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 4; i++) {
        access.recordNewClientActivity("1.2.3.4", true);
      }
      const burstWarn = store.logs.filter(l => l.level === "warn" && l.msg.includes("not persisting cookies"));
      expect(burstWarn).to.have.length(1);
      expect(burstWarn[0].msg).to.include("1.2.3.4");
    });

    it("does not double-warn within the window", () => {
      const { reg, store } = buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 10; i++) {
        access.recordNewClientActivity("1.2.3.4", true);
      }
      const burstWarn = store.logs.filter(l => l.level === "warn" && l.msg.includes("not persisting cookies"));
      expect(burstWarn).to.have.length(1);
    });

    it("tracks bursts per IP independently", () => {
      const { reg, store } = buildReg();
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

    it("caps the burst-tracking map at 200 entries (FIFO)", () => {
      const { reg } = buildReg();
      const access = reg as unknown as BurstAccess;
      for (let i = 0; i < 250; i++) {
        access.recordNewClientActivity(`10.0.0.${i}`, true);
      }
      expect(access.newClientBurst.size).to.be.at.most(200);
      // Newest entries survive
      expect(access.newClientBurst.has("10.0.0.249")).to.be.true;
    });

    it("re-warns after a full idle window elapses (sliding cooldown, M4/M10)", () => {
      const { reg, store } = buildReg();
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

    it("recovers from the throttle only after a full idle window; continuous spraying stays throttled (M4/M10)", () => {
      const { reg } = buildReg();
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
      const { reg } = buildReg();
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
    const buildReg = (): { reg: ClientRegistry; store: MockStore } => {
      const built = createMockAdapter();
      return { reg: new ClientRegistry(built.adapter as never), store: built.store };
    };

    it("caps persistent cookieless creation across all-distinct IPs, then serves transient records + warns once", async () => {
      const { reg, store } = buildReg();
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
      const { reg } = buildReg();
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
      const reg = new ClientRegistry(built.adapter as never);
      const rec = await reg.identifyOrCreate(null, "10.0.0.9");
      await reg.setToken(rec.id, "tok-123");
      expect(reg.getByToken("tok-123")?.id).to.equal(rec.id); // valid immediately
      rec.tokenExpiresAt = Date.now() - 1000; // force past expiry
      expect(reg.getByToken("tok-123")).to.be.null;
      expect(rec.token).to.be.null; // also dropped from the record
    });

    it("setToken stamps an expiry ~OAUTH_ACCESS_TOKEN_TTL_S ahead; clearing the token clears it", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
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
      const reg = new ClientRegistry(built.adapter as never);
      const rec = await reg.identifyOrCreate(null, "10.0.0.30"); // name = ip
      await reg.updateHostname(rec.cookie, "tablet.local");
      expect(reg.getById(rec.id)?.hostname).to.equal("tablet.local");
      expect(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name).to.equal("tablet.local");
    });

    it("is a no-op for an unknown cookie — never mints a ghost client (M5)", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      const before = reg.listAll().length;
      await reg.updateHostname(crypto.randomUUID(), "ghost.local");
      expect(reg.listAll().length).to.equal(before);
    });

    it("does not overwrite a user-set channel name across a late reverse-DNS result (M1)", async () => {
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      const rec = await reg.identifyOrCreate(null, "10.0.0.31");
      // User renames the channel in the admin UI.
      built.store.objects.get(`hassemu.0.clients.${rec.id}`)!.common = { name: "Wohnzimmer" };
      await reg.updateHostname(rec.cookie, "late-dns.local");
      // The user's name survives; the resolved hostname is still tracked in memory.
      expect(built.store.objects.get(`hassemu.0.clients.${rec.id}`)?.common?.name).to.equal("Wohnzimmer");
      expect(reg.getById(rec.id)?.hostname).to.equal("late-dns.local");
    });
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
