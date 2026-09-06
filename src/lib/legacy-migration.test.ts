// The legacy migrations were extracted from main.ts in v1.37.0 (I10) with the stated
// reason that "the data-loss-sensitive upgrade paths are unit-testable in isolation
// instead of only through the full onReady harness". The extraction happened; this file
// did not — until v1.43.0 the only coverage ran through the main.ts orchestration
// harness, which drives them with a full adapter stub and cannot reach their edges.
//
// The edges that matter here are all about NOT losing a user's configured URL: a failed
// write must never be followed by deleting the source it came from.

import { cleanupLegacyNativeUrl, migrateVisUrlToMode, type MigrationAdapter } from "./legacy-migration";
import { MODE_MANUAL } from "./constants";
import type { ClientRegistry } from "./client-registry";
import type { GlobalConfig } from "./global-config";

interface ObjEntry {
  type?: string;
  common?: Record<string, unknown>;
  native?: Record<string, unknown>;
}

interface Store {
  objects: Map<string, ObjEntry>;
  states: Map<string, { val: unknown; ack: boolean }>;
  logs: { level: string; msg: string }[];
  deleted: string[];
}

/**
 * Minimal broker stub — objects, states, a log and a record of what was deleted. Small on
 * purpose: these functions touch four APIs, and a bigger stub would hide which one a test
 * actually exercises.
 *
 * @param namespace Adapter namespace.
 */
function createStub(namespace = "hassemu.0"): { store: Store; adapter: MigrationAdapter } {
  const store: Store = { objects: new Map(), states: new Map(), logs: [], deleted: [] };
  const adapter = {
    namespace,
    log: {
      silly: (m: string) => void store.logs.push({ level: "silly", msg: m }),
      debug: (m: string) => void store.logs.push({ level: "debug", msg: m }),
      info: (m: string) => void store.logs.push({ level: "info", msg: m }),
      warn: (m: string) => void store.logs.push({ level: "warn", msg: m }),
      error: (m: string) => void store.logs.push({ level: "error", msg: m }),
    },
    getForeignObjectAsync: (id: string): Promise<ObjEntry | null> => Promise.resolve(store.objects.get(id) ?? null),
    extendForeignObjectAsync: (id: string, obj: ObjEntry) => {
      const existing = store.objects.get(id) ?? {};
      store.objects.set(id, {
        ...existing,
        ...obj,
        common: { ...(existing.common ?? {}), ...(obj.common ?? {}) },
        native: { ...(existing.native ?? {}), ...(obj.native ?? {}) },
      });
      return Promise.resolve();
    },
    getStateAsync: (id: string) => Promise.resolve(store.states.get(`${namespace}.${id}`) ?? null),
    setState: (id: string, v: { val: unknown; ack?: boolean }) => {
      store.states.set(`${namespace}.${id}`, { val: v.val, ack: v.ack ?? false });
      return Promise.resolve();
    },
    delObjectAsync: (id: string) => {
      store.deleted.push(id);
      store.objects.delete(`${namespace}.${id}`);
      return Promise.resolve();
    },
  };
  return { store, adapter: adapter as unknown as MigrationAdapter };
}

describe("cleanupLegacyNativeUrl", () => {
  it("does nothing — and asks for no restart — when the legacy keys are absent", async () => {
    const { store, adapter } = createStub();
    store.objects.set("system.adapter.hassemu.0", { type: "instance", native: { port: 8123 } });

    expect(await cleanupLegacyNativeUrl(adapter)).to.equal(false);
    // Any write to the instance object restarts the instance — doing it unconditionally
    // would be a restart on every single start.
    expect(store.objects.get("system.adapter.hassemu.0")?.native).to.deep.equal({ port: 8123 });
  });

  it("clears both legacy keys and reports the coming restart", async () => {
    const { store, adapter } = createStub();
    store.objects.set("system.adapter.hassemu.0", {
      type: "instance",
      native: { port: 8123, defaultVisUrl: "http://old/", visUrl: "http://older/" },
    });

    expect(await cleanupLegacyNativeUrl(adapter)).to.equal(true);
    const native = store.objects.get("system.adapter.hassemu.0")!.native!;
    expect(native.defaultVisUrl).to.be.null;
    expect(native.visUrl).to.be.null;
    expect(native.port).to.equal(8123);
  });

  it("MERGES — a field added between read and write survives", async () => {
    const { store, adapter } = createStub();
    store.objects.set("system.adapter.hassemu.0", { type: "instance", native: { defaultVisUrl: "http://old/" } });
    const surface = adapter as unknown as { getForeignObjectAsync: (id: string) => Promise<ObjEntry | null> };
    const original = surface.getForeignObjectAsync.bind(adapter);
    surface.getForeignObjectAsync = async (id: string) => {
      const obj = await original(id);
      // The admin saves the config in the same second. A read-modify-write of the WHOLE
      // object would drop this silently.
      store.objects.set(id, { type: "instance", native: { ...obj!.native, password: "set meanwhile" } });
      return obj;
    };

    await cleanupLegacyNativeUrl(adapter);

    expect(store.objects.get("system.adapter.hassemu.0")!.native!.password).to.equal("set meanwhile");
  });

  it("warns instead of throwing when the objects DB is unreachable", async () => {
    const { store, adapter } = createStub();
    (adapter as unknown as { getForeignObjectAsync: () => Promise<never> }).getForeignObjectAsync = () =>
      Promise.reject(new Error("objects db down"));

    expect(await cleanupLegacyNativeUrl(adapter)).to.equal(false);
    expect(store.logs.some(l => l.level === "warn" && l.msg.includes("cleanup failed"))).to.equal(true);
  });
});

describe("migrateVisUrlToMode", () => {
  /**
   * A GlobalConfig stand-in recording what the migration asked it to persist.
   *
   * @param failing When true, `migrationSet` rejects — the data-loss edge.
   */
  const fakeGlobal = (
    failing = false,
  ): { calls: { mode: string; manualUrl: string | null }[]; config: GlobalConfig } => {
    const calls: { mode: string; manualUrl: string | null }[] = [];
    const config = {
      migrationSet: (mode: string, manualUrl: string | null): Promise<void> => {
        if (failing) {
          return Promise.reject(new Error("broker down"));
        }
        calls.push({ mode, manualUrl });
        return Promise.resolve();
      },
    };
    return { calls, config: config as unknown as GlobalConfig };
  };

  /**
   * A registry stand-in holding the legacy values the restore pass collected.
   *
   * @param legacy   Client id → raw legacy `visUrl` value.
   * @param records  The clients the registry knows.
   */
  const fakeRegistry = (
    legacy: Record<string, unknown>,
    records: { id: string; mode: string; manualUrl: string | null }[],
  ): ClientRegistry => {
    let taken = false;
    return {
      takeLegacyVisUrls: () => {
        if (taken) {
          return new Map();
        }
        taken = true;
        return new Map(Object.entries(legacy));
      },
      listAll: () => records,
    } as unknown as ClientRegistry;
  };

  it("does nothing at all when there is no legacy value anywhere", async () => {
    const { store, adapter } = createStub();
    const { calls, config } = fakeGlobal();

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    // The point of the v1.43.0 change: an already-migrated installation costs zero
    // round-trips here, instead of one getState per client on every single start.
    expect(calls).to.deep.equal([]);
    expect(store.deleted).to.deep.equal([]);
  });

  it("moves a safe per-client legacy URL to manual mode and drops the old datapoint", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();
    const record = { id: "abc123", mode: "", manualUrl: null as string | null };

    await migrateVisUrlToMode(adapter, config, fakeRegistry({ abc123: "http://old.local/" }, [record]));

    expect(record.mode).to.equal(MODE_MANUAL);
    expect(record.manualUrl).to.equal("http://old.local/");
    expect(store.states.get("hassemu.0.clients.abc123.manualUrl")?.val).to.equal("http://old.local/");
    expect(store.deleted).to.include("clients.abc123.visUrl");
  });

  it("rejects an unsafe per-client legacy URL but still clears the old datapoint", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();
    const record = { id: "abc123", mode: "", manualUrl: null as string | null };

    await migrateVisUrlToMode(adapter, config, fakeRegistry({ abc123: "javascript:alert(1)" }, [record]));

    expect(record.mode).to.equal("");
    expect(record.manualUrl).to.be.null;
    expect(store.logs.some(l => l.level === "warn" && l.msg.includes("rejected as unsafe"))).to.equal(true);
    expect(store.deleted).to.include("clients.abc123.visUrl");
  });

  it("KEEPS the legacy datapoint when the write fails — the URL must not be lost", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();
    const record = { id: "abc123", mode: "", manualUrl: null as string | null };
    (adapter as unknown as { setState: () => Promise<never> }).setState = () =>
      Promise.reject(new Error("broker down"));

    await migrateVisUrlToMode(adapter, config, fakeRegistry({ abc123: "http://precious.local/" }, [record]));

    expect(store.deleted, "the recovery anchor was deleted").to.not.include("clients.abc123.visUrl");
    expect(store.logs.some(l => l.level === "warn" && l.msg.includes("visUrl preserved"))).to.equal(true);
  });

  it("skips a legacy value whose client the registry no longer knows", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();

    await migrateVisUrlToMode(adapter, config, fakeRegistry({ ghost1: "http://old.local/" }, []));

    expect(store.deleted).to.deep.equal([]);
  });

  it("keeps global.visUrl when the global write fails", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal(true);
    store.states.set("hassemu.0.global.visUrl", { val: "http://precious.local/", ack: true });

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    expect(store.deleted, "the recovery anchor was deleted").to.not.include("global.visUrl");
    expect(store.logs.some(l => l.level === "warn" && l.msg.includes("legacy global.visUrl preserved"))).to.equal(true);
  });

  it("migrates a safe global legacy URL and drops it afterwards", async () => {
    const { store, adapter } = createStub();
    const { calls, config } = fakeGlobal();
    store.states.set("hassemu.0.global.visUrl", { val: "http://old.global/", ack: true });

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    expect(calls).to.deep.equal([{ mode: MODE_MANUAL, manualUrl: "http://old.global/" }]);
    expect(store.deleted).to.include("global.visUrl");
  });
});
