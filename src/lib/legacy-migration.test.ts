// The legacy migrations were extracted from main.ts in v1.37.0 (I10) with the stated
// reason that "the data-loss-sensitive upgrade paths are unit-testable in isolation
// instead of only through the full onReady harness". The extraction happened; this file
// did not — until v1.43.0 the only coverage ran through the main.ts orchestration
// harness, which drives them with a full adapter stub and cannot reach their edges.
//
// The edges that matter here are all about NOT losing a user's configured URL: a failed
// write must never be followed by deleting the source it came from.

import { migrateLegacyDefaultVisUrl, migrateVisUrlToMode, type MigrationAdapter } from "./legacy-migration";
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
  /** Every id a delObject or delState actually removed something for. */
  deleted: string[];
  /** Enum objects (`enum.rooms.x` → members) and every `extendForeignObject` on them. */
  enums: Map<string, string[]>;
  enumWrites: { id: string; members: string[] }[];
  /**
   * The adapter's cached `this.enums` (js-controller 7.2.2): taken by {@link freezeEnumCache},
   * i.e. when the adapter started — a later write does not reach it.
   */
  enumCache: Map<string, string[]> | null;
}

/**
 * Minimal broker stub — objects, states, enums, a log and a record of what was removed.
 * Faithful where the migrations depend on it (js-controller 7.2.2): `delObject` on a
 * missing object deletes nothing (not even a value stored without one); on an existing
 * one it takes the value of a state object and strikes the id from every enum — writing
 * each enum back from the CACHED list (`removeIdFromAllEnums`).
 *
 * @param namespace Adapter namespace.
 */
function createStub(namespace = "hassemu.0"): { store: Store; adapter: MigrationAdapter; freezeEnumCache: () => void } {
  const store: Store = {
    objects: new Map(),
    states: new Map(),
    logs: [],
    deleted: [],
    enums: new Map(),
    enumWrites: [],
    enumCache: null,
  };
  const freezeEnumCache = (): void => {
    store.enumCache = new Map([...store.enums].map(([id, members]) => [id, [...members]]));
  };
  const adapter = {
    namespace,
    log: {
      silly: (m: string) => void store.logs.push({ level: "silly", msg: m }),
      debug: (m: string) => void store.logs.push({ level: "debug", msg: m }),
      info: (m: string) => void store.logs.push({ level: "info", msg: m }),
      warn: (m: string) => void store.logs.push({ level: "warn", msg: m }),
      error: (m: string) => void store.logs.push({ level: "error", msg: m }),
    },
    // Copies, like the broker: only a write reaches the store.
    getForeignObjectAsync: (id: string): Promise<ObjEntry | null> => {
      const members = store.enums.get(id);
      if (members) {
        return Promise.resolve({ type: "enum", common: { members: [...members] } });
      }
      const obj = store.objects.get(id);
      return Promise.resolve(obj ? structuredClone(obj) : null);
    },
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
    getStateAsync: (id: string) => {
      const state = store.states.get(`${namespace}.${id}`);
      return Promise.resolve(state ? structuredClone(state) : null);
    },
    setState: (id: string, v: { val: unknown; ack?: boolean }) => {
      store.states.set(`${namespace}.${id}`, { val: v.val, ack: v.ack ?? false });
      return Promise.resolve();
    },
    delObjectAsync: (id: string) => {
      const fullId = `${namespace}.${id}`;
      const obj = store.objects.get(fullId);
      if (!obj) {
        return Promise.resolve(); // 7.2.2: a missing object deletes nothing
      }
      store.deleted.push(id);
      store.objects.delete(fullId);
      if (obj.type === "state") {
        store.states.delete(fullId);
      }
      // removeIdFromAllEnums: every enum that carries the id is written back from the CACHE.
      for (const [enumId, members] of store.enumCache ?? store.enums) {
        if (members.includes(fullId)) {
          store.enums.set(
            enumId,
            members.filter(m => m !== fullId),
          );
        }
      }
      return Promise.resolve();
    },
    delStateAsync: (id: string) => {
      if (store.states.delete(`${namespace}.${id}`)) {
        store.deleted.push(id);
      }
      return Promise.resolve();
    },
    // The enum view the fleet carrier reads (getForeignObjectsAsync("enum.*", "enum")).
    getForeignObjectsAsync: (_pattern: string, type?: string) => {
      const out: Record<string, ObjEntry> = {};
      if (type === "enum") {
        for (const [enumId, members] of store.enums) {
          out[enumId] = { type: "enum", common: { members: [...members] } };
        }
      }
      return Promise.resolve(out);
    },
    // The carrier writes an enum back whole.
    setForeignObject: (id: string, obj: ObjEntry) => {
      const members = (obj.common?.members as string[] | undefined) ?? [];
      store.enumWrites.push({ id, members: [...members] });
      store.enums.set(id, [...members]);
      return Promise.resolve();
    },
    config: {},
  };
  return { store, adapter: adapter as unknown as MigrationAdapter, freezeEnumCache };
}

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
    // A 1.x installation: the legacy datapoint has its object and its value.
    store.objects.set("hassemu.0.clients.abc123.visUrl", { type: "state", common: {}, native: {} });
    store.states.set("hassemu.0.clients.abc123.visUrl", { val: "http://old.local/", ack: true });

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
    // A 1.x installation: the legacy datapoint has its object and its value.
    store.objects.set("hassemu.0.clients.abc123.visUrl", { type: "state", common: {}, native: {} });
    store.states.set("hassemu.0.clients.abc123.visUrl", { val: "http://old.local/", ack: true });

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

  it("carries the room assignment of global.visUrl to global.manualUrl before the delete (v1.45.0)", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();
    store.states.set("hassemu.0.global.visUrl", { val: "http://old.global/", ack: true });
    store.enums.set("enum.rooms.living", ["hue.0.light", "hassemu.0.global.visUrl"]);

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    expect(store.deleted).to.include("global.visUrl");
    // The successor sits where the legacy datapoint sat; the delete found nothing to strike.
    expect(store.enums.get("enum.rooms.living")).to.deep.equal(["hue.0.light", "hassemu.0.global.manualUrl"]);
    expect(store.enumWrites).to.deep.equal([
      { id: "enum.rooms.living", members: ["hue.0.light", "hassemu.0.global.manualUrl"] },
    ]);
  });

  it("carries a client's room assignment from visUrl to manualUrl before the delete (v1.45.0)", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();
    const record = { id: "abc123", mode: "", manualUrl: null as string | null };
    // A 1.x installation: the legacy datapoint has its object and its value.
    store.objects.set("hassemu.0.clients.abc123.visUrl", { type: "state", common: {}, native: {} });
    store.states.set("hassemu.0.clients.abc123.visUrl", { val: "http://old.local/", ack: true });
    store.enums.set("enum.functions.displays", ["hassemu.0.clients.abc123.visUrl"]);

    await migrateVisUrlToMode(adapter, config, fakeRegistry({ abc123: "http://old.local/" }, [record]));

    expect(store.deleted).to.include("clients.abc123.visUrl");
    expect(store.enums.get("enum.functions.displays")).to.deep.equal(["hassemu.0.clients.abc123.manualUrl"]);
  });

  it("the successor survives the delete writing the CACHED enum back (L5)", async () => {
    // js-controller 7.2.2 strikes the old id from its cached this.enums and writes that list
    // back: a successor written BEFORE the delete was overwritten.
    const { store, adapter, freezeEnumCache } = createStub();
    const { config } = fakeGlobal();
    store.objects.set("hassemu.0.global.visUrl", { type: "state", common: {}, native: {} });
    store.states.set("hassemu.0.global.visUrl", { val: "http://old.global/", ack: true });
    store.enums.set("enum.rooms.living", ["hue.0.light", "hassemu.0.global.visUrl", "sonos.0.play"]);
    freezeEnumCache();

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    // The fleet carrier (enum-carry.ts) appends the successor after the delete.
    expect(store.enums.get("enum.rooms.living")).to.deep.equal([
      "hue.0.light",
      "sonos.0.play",
      "hassemu.0.global.manualUrl",
    ]);
  });

  it("removes an object-less global.visUrl value — the migration runs once, not on every start (L2, N6)", async () => {
    // What ≤1.45.0 left on a 1.0/1.1 upgrade: setState on an id without an object stores the
    // value anyway, and delObject never removed it — so this migrated again on every start
    // and reset whatever the user had chosen meanwhile.
    const { store, adapter } = createStub();
    const { calls, config } = fakeGlobal();
    store.states.set("hassemu.0.global.visUrl", { val: "http://old.global/", ack: true });

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));
    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    expect(store.states.has("hassemu.0.global.visUrl")).to.equal(false);
    expect(calls).to.have.length(1);
  });

  it("touches no enum when the legacy datapoint was assigned nowhere (v1.45.0)", async () => {
    const { store, adapter } = createStub();
    const { config } = fakeGlobal();
    store.states.set("hassemu.0.global.visUrl", { val: "http://old.global/", ack: true });
    store.enums.set("enum.rooms.living", ["hue.0.light"]);

    await migrateVisUrlToMode(adapter, config, fakeRegistry({}, []));

    expect(store.enumWrites).to.deep.equal([]);
  });
});

describe("migrateLegacyDefaultVisUrl — the legacy settings are dropped after the takeover (K3)", () => {
  const INSTANCE = "system.adapter.hassemu.0";
  /**
   * A GlobalConfig stand-in.
   *
   * @param failing When true, writing the global URL rejects.
   */
  const fakeGlobal = (failing = false): { writes: unknown[][]; config: GlobalConfig } => {
    const writes: unknown[][] = [];
    const config = {
      migrationSet: (mode: string, url: string | null): Promise<void> => {
        writes.push(["migrationSet", mode, url]);
        return failing ? Promise.reject(new Error("broker down")) : Promise.resolve();
      },
      handleEnabledWrite: (v: unknown): Promise<void> => {
        writes.push(["enabled", v]);
        return Promise.resolve();
      },
    };
    return { writes, config: config as unknown as GlobalConfig };
  };

  it("an empty default left by 1.0/1.1 is dropped — once, with a restart (K3)", async () => {
    const { store, adapter } = createStub();
    store.objects.set(INSTANCE, { type: "instance", common: {}, native: { visUrl: "", port: 8123 } });
    const { writes, config } = fakeGlobal();

    const restarting = await migrateLegacyDefaultVisUrl(adapter, { visUrl: "" } as never, config);

    expect(restarting).to.equal(true);
    expect(store.objects.get(INSTANCE)?.native).to.deep.equal({ visUrl: null, port: 8123 });
    expect(writes, "nothing to carry over").to.deep.equal([]);
  });

  it("a key that is gone or already nulled costs no read of the instance object", async () => {
    const { adapter } = createStub();
    let reads = 0;
    const read = adapter.getForeignObjectAsync.bind(adapter);
    (adapter as unknown as { getForeignObjectAsync: (id: string) => Promise<unknown> }).getForeignObjectAsync = id => {
      reads++;
      return read(id);
    };
    expect(await migrateLegacyDefaultVisUrl(adapter, { visUrl: null } as never, fakeGlobal().config)).to.equal(false);
    expect(await migrateLegacyDefaultVisUrl(adapter, {} as never, fakeGlobal().config)).to.equal(false);
    expect(reads).to.equal(0);
  });

  it("a real URL is taken over first and only then dropped", async () => {
    const { store, adapter } = createStub();
    store.objects.set(INSTANCE, { type: "instance", common: {}, native: { defaultVisUrl: "http://old.local/vis" } });
    const { writes, config } = fakeGlobal();

    expect(
      await migrateLegacyDefaultVisUrl(adapter, { defaultVisUrl: "http://old.local/vis" } as never, config),
    ).to.equal(true);
    expect(writes).to.deep.equal([
      ["migrationSet", MODE_MANUAL, "http://old.local/vis"],
      ["enabled", true],
    ]);
    expect(store.objects.get(INSTANCE)?.native?.defaultVisUrl).to.equal(null);
  });

  it("a failed takeover keeps the settings as the recovery anchor — no drop", async () => {
    const { store, adapter } = createStub();
    store.objects.set(INSTANCE, { type: "instance", common: {}, native: { visUrl: "http://precious.local/" } });

    expect(
      await migrateLegacyDefaultVisUrl(adapter, { visUrl: "http://precious.local/" } as never, fakeGlobal(true).config),
    ).to.equal(false);
    expect(store.objects.get(INSTANCE)?.native?.visUrl).to.equal("http://precious.local/");
  });
});
