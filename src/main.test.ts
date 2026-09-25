/**
 * Orchestration tests for main.ts — lifecycle, migrations, stale-GC, master
 * switch, state-dispatch. Uses the fleet harness pattern: `@iobroker/adapter-core`
 * is mocked with a stub Adapter class (no js-controller), the factory seams
 * (makeWebServer/makeMdnsService/makeUrlDiscovery) are overridden with fakes,
 * while ClientRegistry/GlobalConfig run for real against the stub object store.
 */

import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", async () => {
  // The factory is hoisted above the imports — the shared broker semantics come in here.
  const { brokerExtend, brokerDelObject } = await import("../test/unit/broker-stub.js");
  // The real exit codes (the value js-controller reads), not a copy that could drift.
  const { EXIT_CODES } = await import("@iobroker/adapter-core/exitCodes");
  interface ObjEntry {
    type: string;
    common?: Record<string, unknown>;
    native?: Record<string, unknown>;
  }

  class StubAdapter {
    namespace = "hassemu.0";
    adapterDir = "/stub-adapter-dir";
    config: Record<string, unknown> = {};
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    objects = new Map<string, ObjEntry>();
    states = new Map<string, { val: unknown; ack: boolean }>();
    logs: { level: string; msg: string }[] = [];
    terminations: number[] = [];
    stateSubscriptions: string[] = [];
    objectSubscriptions: string[] = [];
    stateUnsubscriptions: string[] = [];
    objectUnsubscriptions: string[] = [];
    /** Every extendObject call, so a test can assert HOW it was written, not just the result. */
    extendCalls: { id: string; common: Record<string, unknown>; options?: Record<string, unknown> }[] = [];

    log = {
      silly: (m: string): void => void this.logs.push({ level: "silly", msg: m }),
      debug: (m: string): void => void this.logs.push({ level: "debug", msg: m }),
      info: (m: string): void => void this.logs.push({ level: "info", msg: m }),
      warn: (m: string): void => void this.logs.push({ level: "warn", msg: m }),
      error: (m: string): void => void this.logs.push({ level: "error", msg: m }),
    };

    constructor(_options?: unknown) {}

    on(event: string, cb: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, cb);
      return this;
    }

    private fullId(id: string): string {
      return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }

    setState(id: string, state: { val: unknown; ack?: boolean }): Promise<void> {
      this.states.set(this.fullId(id), { val: state.val, ack: state.ack ?? false });
      return Promise.resolve();
    }

    getStateAsync(id: string): Promise<{ val: unknown; ack: boolean } | null> {
      const state = this.states.get(this.fullId(id));
      return Promise.resolve(state ? structuredClone(state) : null);
    }

    // A COPY, like the broker: only a write reaches the store (see client-registry.test.ts).
    getObjectAsync(id: string): Promise<ObjEntry | null> {
      const obj = this.objects.get(this.fullId(id));
      return Promise.resolve(obj ? structuredClone(obj) : null);
    }

    setObject(id: string, obj: ObjEntry): Promise<void> {
      this.objects.set(this.fullId(id), obj);
      return Promise.resolve();
    }

    setObjectNotExistsAsync(id: string, obj: ObjEntry): Promise<void> {
      const full = this.fullId(id);
      if (!this.objects.has(full)) {
        this.objects.set(full, obj);
      }
      return Promise.resolve();
    }

    // js-controller 7.2.2 semantics (deep merge, preserve, emptied lists) — test/unit/broker-stub.ts.
    extendObject(id: string, obj: Partial<ObjEntry>, options?: Record<string, unknown>): Promise<void> {
      const full = this.fullId(id);
      this.extendCalls.push({ id, common: obj.common ?? {}, options });
      this.objects.set(full, brokerExtend(this.objects.get(full), obj, options));
      return Promise.resolve();
    }

    // Like 7.2.2: a missing object deletes nothing, the value goes only with a state object,
    // every deleted id leaves every enum (test/unit/broker-stub.ts).
    delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
      brokerDelObject(this.objects, this.states, this.fullId(id), options?.recursive === true);
      return Promise.resolve();
    }

    delStateAsync(id: string): Promise<void> {
      this.states.delete(this.fullId(id));
      return Promise.resolve();
    }

    getForeignObjectAsync(id: string): Promise<ObjEntry | null> {
      const obj = this.objects.get(id);
      return Promise.resolve(obj ? structuredClone(obj) : null);
    }

    // Like the controller: the id is taken as given — no namespace prefixing.
    setForeignObject(fullId: string, obj: ObjEntry): Promise<void> {
      this.objects.set(fullId, structuredClone(obj));
      return Promise.resolve();
    }

    // The controller's enum view: every `enum.<group>.<name>` object, grouped by `enum.<group>`.
    getEnumsAsync(): Promise<Record<string, Record<string, ObjEntry>>> {
      const groups: Record<string, Record<string, ObjEntry>> = {};
      for (const [id, obj] of this.objects) {
        const parts = id.split(".", 3);
        if (parts[0] !== "enum" || !parts[2]) {
          continue;
        }
        const group = `${parts[0]}.${parts[1]}`;
        (groups[group] ??= {})[id] = structuredClone(obj);
      }
      return Promise.resolve(groups);
    }

    // 7.2.2 semantics: `common.members` is emptied before the merge, so the list is replaced.
    extendForeignObject(id: string, obj: Partial<ObjEntry>): Promise<void> {
      this.objects.set(id, brokerExtend(this.objects.get(id), obj, undefined, "enum"));
      return Promise.resolve();
    }

    extendForeignObjectAsync(id: string, obj: Partial<ObjEntry>): Promise<void> {
      this.objects.set(id, brokerExtend(this.objects.get(id), obj, undefined, "instance"));
      return Promise.resolve();
    }

    getForeignObjectsAsync(pattern: string, type?: string): Promise<Record<string, ObjEntry>> {
      const prefix = pattern.replace("*", "");
      const out: Record<string, ObjEntry> = {};
      // Type-faithful to js-controller: no type argument → 'state' view only
      // (never channel/device containers). A permissive mock hid the H1 regression.
      const wanted = type ?? "state";
      for (const [id, obj] of this.objects) {
        if (id.startsWith(prefix) && obj.type === wanted) {
          // A copy per object, like the broker — the stored object must not travel out.
          out[id] = structuredClone(obj);
        }
      }
      return Promise.resolve(out);
    }

    subscribeStatesAsync(pattern: string): Promise<void> {
      this.stateSubscriptions.push(pattern);
      return Promise.resolve();
    }

    subscribeForeignObjectsAsync(pattern: string): Promise<void> {
      this.objectSubscriptions.push(pattern);
      return Promise.resolve();
    }

    unsubscribeStatesAsync(pattern: string): Promise<void> {
      this.stateUnsubscriptions.push(pattern);
      return Promise.resolve();
    }

    unsubscribeForeignObjectsAsync(pattern: string): Promise<void> {
      this.objectUnsubscriptions.push(pattern);
      return Promise.resolve();
    }

    setInterval(_cb: () => void, _ms: number): object {
      return {};
    }

    clearInterval(_handle: unknown): void {}

    setTimeout(_cb: () => void, _ms: number): object {
      return {};
    }

    clearTimeout(_handle: unknown): void {}

    // adapter-core: terminate(reason?, exitCode?) — also accepts the code alone.
    terminate(reasonOrCode?: string | number, code?: number): void {
      this.terminations.push(typeof reasonOrCode === "number" ? reasonOrCode : (code ?? 0));
    }
  }

  // Read the REAL admin/i18n files (same as client-registry.test.ts). The object
  // refresh exists to land the actual user-visible text in an existing tree, so a mock
  // that echoed the key back would let a wrong key pass unnoticed.
  const i18nDir = join(__dirname, "../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
    i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
  }

  return {
    Adapter: StubAdapter,
    EXIT_CODES,
    I18n: {
      init: vi.fn(async () => {}),
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

import { HassEmu } from "./main";
import type { ClientRegistry } from "./lib/client-registry";
import type { GlobalConfig } from "./lib/global-config";
import { CLIENT_OBJECTS_VERSION, MODE_GLOBAL, MODE_MANUAL } from "./lib/constants";
import { resolveRedirect } from "./lib/redirect-resolver";
import { migrateLegacyDefaultVisUrl, migrateVisUrlToMode, type MigrationAdapter } from "./lib/legacy-migration";
import type { AdapterConfig } from "./lib/types";
import iobrokerPackage from "../io-package.json";

interface ObjEntry {
  type: string;
  common?: Record<string, unknown>;
  native?: Record<string, unknown>;
}

/** Stub surface added by the adapter-core mock (see vi.mock factory above). */
interface StubSurface {
  config: Record<string, unknown>;
  objects: Map<string, ObjEntry>;
  states: Map<string, { val: unknown; ack: boolean }>;
  logs: { level: string; msg: string }[];
  terminations: number[];
  stateSubscriptions: string[];
  objectSubscriptions: string[];
  stateUnsubscriptions: string[];
  objectUnsubscriptions: string[];
  extendCalls: { id: string; common: Record<string, unknown>; options?: Record<string, unknown> }[];
  setState: (id: string, state: { val: unknown; ack?: boolean }) => Promise<void>;
}

interface FakeWebServer {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeMdns {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isActive: () => boolean;
}

interface FakeDiscovery {
  collect: ReturnType<typeof vi.fn>;
  scheduleRefresh: ReturnType<typeof vi.fn>;
  cancelRefresh: ReturnType<typeof vi.fn>;
}

/** Typed access to HassEmu's private members the orchestration tests drive. */
interface Internal {
  onReady: () => Promise<void>;
  onStateChange: (id: string, state: { val: unknown; ack: boolean } | null | undefined) => Promise<void>;
  onObjectChange: (id: string, obj: { type?: string; common?: Record<string, unknown> } | null | undefined) => void;
  onUnload: (callback: () => void) => void;
  getOrCreateServerUuid: () => Promise<string>;
  readSystemLanguage: () => Promise<string>;
  computeNewClientMode: () => string;
  gcStaleClients: () => Promise<void>;
  applyMasterSwitch: (enabled: boolean) => Promise<void>;
  handleRefreshUrlsWrite: () => Promise<void>;
  registry: ClientRegistry | null;
  globalConfig: GlobalConfig | null;
  urlDiscovery: FakeDiscovery | null;
  webServer: FakeWebServer | null;
  mdnsService: FakeMdns | null;
  makeWebServer: (instanceUuid: string) => FakeWebServer;
  makeMdnsService: (instanceUuid: string) => FakeMdns;
  makeUrlDiscovery: (onChange: unknown) => FakeDiscovery;
  makeRegistry: () => ClientRegistry;
  makeGlobalConfig: () => GlobalConfig;
  systemLanguage: string;
  /** Inherited adapter surface the migration tests instrument. */
  delObjectAsync: (id: string, options?: unknown) => Promise<void>;
}

const BASE_CONFIG = {
  port: 8123,
  bind: "127.0.0.1",
  authRequired: false,
  username: "admin",
  password: "secret",
  mdnsEnabled: false,
  serviceName: "TestServer",
};

function makeFakeWebServer(): FakeWebServer {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
}

function makeFakeMdns(active = true): FakeMdns {
  return { start: vi.fn(), stop: vi.fn(async () => {}), isActive: () => active };
}

function makeFakeDiscovery(): FakeDiscovery {
  return { collect: vi.fn(() => Promise.resolve({})), scheduleRefresh: vi.fn(), cancelRefresh: vi.fn() };
}

interface Setup {
  adapter: HassEmu;
  internal: Internal;
  stub: StubSurface;
  webServer: FakeWebServer;
  mdns: FakeMdns;
  discovery: FakeDiscovery;
}

/**
 * Fresh adapter wired with fake webserver/mdns/discovery seams; registry and
 * globalConfig stay REAL (driven through the stub object store).
 *
 * @param config Config overrides merged onto {@link BASE_CONFIG}.
 */
function setup(config: Partial<typeof BASE_CONFIG> = {}): Setup {
  const adapter = new HassEmu();
  const stub = adapter as unknown as StubSurface;
  const internal = adapter as unknown as Internal;
  stub.config = { ...BASE_CONFIG, ...config };
  const webServer = makeFakeWebServer();
  const mdns = makeFakeMdns();
  const discovery = makeFakeDiscovery();
  internal.makeWebServer = () => webServer;
  internal.makeMdnsService = () => mdns;
  internal.makeUrlDiscovery = () => discovery;
  return { adapter, internal, stub, webServer, mdns, discovery };
}

function logsOf(stub: StubSurface, level: string): string[] {
  return stub.logs.filter(l => l.level === level).map(l => l.msg);
}

describe("HassEmu refreshInstanceObjects (v1.41.0)", () => {
  // js-controller creates instanceObjects only where they are MISSING, so a changed
  // name/description otherwise reaches fresh installs only. Measured on the live tree
  // 2026-09-03: seven of the nine objects still carried a bare English string.
  // Derived from the manifest, not typed out: a newly declared instanceObject that the
  // refresh forgets fails this suite instead of quietly reaching fresh installs only.
  const MANIFEST_IDS = (iobrokerPackage as { instanceObjects: { _id: string }[] }).instanceObjects.map(o => o._id);

  it("the manifest still declares the nine objects this suite expects", () => {
    expect(MANIFEST_IDS).to.have.members([
      "info",
      "info.connection",
      "info.serverUuid",
      "info.refreshUrls",
      "clients",
      "global",
      "global.enabled",
      "global.mode",
      "global.manualUrl",
    ]);
  });

  it("onReady REACHES the refresh — every manifest object is extended", async () => {
    // The point of this test: a refresh method nobody calls passes lint and tsc.
    const { internal, stub } = setup();
    // Seed the manifest objects well-formed, as an existing installation has them. In an
    // empty store the schema repair extends global.mode/global.manualUrl itself, and the
    // assertion below could not tell the refresh from the repair (audit 2026-09-25, T10).
    for (const o of (iobrokerPackage as { instanceObjects: (ObjEntry & { _id: string })[] }).instanceObjects) {
      stub.objects.set(`hassemu.0.${o._id}`, { type: o.type, common: structuredClone(o.common), native: {} });
    }
    await internal.onReady();
    const extended = stub.extendCalls.map(c => c.id);
    for (const id of MANIFEST_IDS) {
      expect(extended, `onReady extends ${id}`).toContain(id);
    }
  });

  it("lands the current name on an object that ALREADY exists with the old text", async () => {
    const { internal, stub } = setup();
    // The exact drift measured on the live tree: the folder still says "clients".
    stub.objects.set("hassemu.0.clients", { type: "folder", common: { name: "Known display clients" }, native: {} });
    await internal.onReady();
    const name = stub.objects.get("hassemu.0.clients")?.common?.name as Record<string, string>;
    expect(typeof name).toBe("object");
    expect(name.en).toBe("Known displays");
  });

  it("replaces a bare string name with the translation object", async () => {
    const { internal, stub } = setup();
    // common.type is correct on purpose, so the schema repair returns early and this
    // test measures the REFRESH alone. Without it the repair would write the manifest
    // name too and cover for a refresh that never happened (measured: mutation R3).
    stub.objects.set("hassemu.0.global.manualUrl", {
      type: "state",
      common: { name: "Global manual URL (used when mode='manual')", type: "string", role: "url" },
      native: {},
    });
    await internal.onReady();
    const name = stub.objects.get("hassemu.0.global.manualUrl")?.common?.name as Record<string, string>;
    expect(typeof name).toBe("object");
    expect(name.en).toBe("Global manual URL");
    expect(name.de).toBeTypeOf("string");
  });

  it("uses no `preserve` — that option is exactly what froze the old names", async () => {
    const { internal, stub } = setup();
    await internal.onReady();
    for (const call of stub.extendCalls.filter(c => MANIFEST_IDS.includes(c.id))) {
      expect(call.options?.preserve, `${call.id} is written without preserve`).toBeUndefined();
    }
  });

  it("never sends common.states — the dropdown stays with syncUrlDropdown", async () => {
    // extendObject deep-merges `states`; shipping a copy would resurrect stale URL keys.
    const { internal, stub } = setup();
    await internal.onReady();
    for (const call of stub.extendCalls.filter(c => MANIFEST_IDS.includes(c.id))) {
      expect(call.common, `${call.id} carries no states`).not.toHaveProperty("states");
    }
  });

  it("does not stamp a null description over an object that has nothing to explain", async () => {
    const { internal, stub } = setup();
    await internal.onReady();
    const infoCall = stub.extendCalls.find(c => c.id === "info");
    expect(infoCall?.common).not.toHaveProperty("desc");
  });

  it("keeps writing the rest when one object cannot be written", async () => {
    const { internal, stub, adapter } = setup();
    const real = (adapter as unknown as { extendObject: (...a: unknown[]) => Promise<void> }).extendObject.bind(
      adapter,
    );
    (adapter as unknown as { extendObject: (...a: unknown[]) => Promise<void> }).extendObject = (
      id: unknown,
      ...rest: unknown[]
    ) => (id === "global" ? Promise.reject(new Error("broker offline")) : real(id, ...rest));
    await internal.onReady();
    const extended = stub.extendCalls.map(c => c.id);
    expect(extended).toContain("global.mode");
    expect(logsOf(stub, "debug").some(m => m.includes("Could not refresh the object global"))).toBe(true);
    // A failed refresh must not take the adapter down with it.
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: true, ack: true });
  });
});

describe("HassEmu onReady", () => {
  it("happy path: I18n init, migrations, webserver started, subscriptions, connection=true", async () => {
    const { internal, stub, webServer, discovery } = setup();
    await internal.onReady();

    expect(webServer.start).toHaveBeenCalledTimes(1);
    expect(discovery.collect).toHaveBeenCalledTimes(1);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: true, ack: true });
    expect(stub.stateSubscriptions).toEqual(["clients.*", "global.*", "info.refreshUrls"]);
    expect(stub.objectSubscriptions).toEqual(["system.adapter.*"]);
    expect(logsOf(stub, "info").some(m => m.includes("HA emulation running on 127.0.0.1:8123"))).toBe(true);
    expect(stub.terminations).toEqual([]);
    expect(logsOf(stub, "error")).toEqual([]);
  });

  it("starts the web server BEFORE creating subscriptions (D11 v1.13.0)", async () => {
    const { internal, stub, webServer } = setup();
    let subscribedWhenStarted = false;
    webServer.start.mockImplementation(() => {
      subscribedWhenStarted = stub.stateSubscriptions.length > 0;
      return Promise.resolve();
    });
    await internal.onReady();
    expect(subscribedWhenStarted).toBe(false);
    expect(stub.stateSubscriptions.length).toBeGreaterThan(0);
  });

  it("deletes the renamed info.refresh_urls orphan on upgrade, keeps info.refreshUrls (L59)", async () => {
    const { internal, stub } = setup();
    stub.objects.set("hassemu.0.info.refresh_urls", { type: "state", common: {} });
    stub.objects.set("hassemu.0.info.refreshUrls", { type: "state", common: {} });
    await internal.onReady();
    expect(stub.objects.has("hassemu.0.info.refresh_urls")).toBe(false);
    expect(stub.objects.has("hassemu.0.info.refreshUrls")).toBe(true);
  });

  it("moves the room assignment of info.refresh_urls to info.refreshUrls before deleting it (v1.45.0)", async () => {
    const { internal, stub } = setup();
    stub.objects.set("hassemu.0.info.refresh_urls", { type: "state", common: {} });
    stub.objects.set("hassemu.0.info.refreshUrls", { type: "state", common: {} });
    stub.objects.set("enum.rooms.hall", {
      type: "enum",
      common: { members: ["hue.0.hall", "hassemu.0.info.refresh_urls"] },
    });
    await internal.onReady();
    expect(stub.objects.has("hassemu.0.info.refresh_urls")).toBe(false);
    expect(stub.objects.get("enum.rooms.hall")?.common?.members).toEqual(["hue.0.hall", "hassemu.0.info.refreshUrls"]);
  });

  it("info.refresh_urls cleanup is a no-op on a fresh install (state absent) (L59)", async () => {
    const { internal, stub } = setup();
    await internal.onReady();
    expect(stub.objects.has("hassemu.0.info.refresh_urls")).toBe(false);
    expect(logsOf(stub, "error")).toEqual([]);
  });

  it("webserver start failure → a restarting exit code (6, never 11), no subscriptions, no connection=true", async () => {
    const { internal, stub, webServer } = setup();
    webServer.start.mockRejectedValue(new Error("EADDRINUSE"));
    await internal.onReady();

    // 11 = ADAPTER_REQUESTED_TERMINATION: js-controller 7.2.2 never restarts it (controller
    // main.ts 4231/4305); 6 = UNCAUGHT_EXCEPTION restarts after 30 s (audit 2026-09-25, L1).
    expect(stub.terminations).toEqual([6]);
    expect(stub.stateSubscriptions).toEqual([]);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
    // I5 (v1.38.0): the raw error echo moved to debug — webServer.start() already logged
    // a friendly error, so main.ts must not print a second error line for the same failure.
    expect(logsOf(stub, "error").some(m => m.includes("Web server failed to start"))).toBe(false);
    expect(logsOf(stub, "debug").some(m => m.includes("Web server failed to start"))).toBe(true);
  });

  it("web server and mDNS get the SAME server UUID — the one stored in info.serverUuid (DD2, T5)", async () => {
    const { internal, stub, webServer, mdns } = setup({ mdnsEnabled: true });
    const stored = "12345678-1234-4234-8234-123456789abc";
    stub.states.set("hassemu.0.info.serverUuid", { val: stored, ack: true });
    const seen: { web?: string; mdns?: string } = {};
    internal.makeWebServer = uuid => {
      seen.web = uuid;
      return webServer;
    };
    internal.makeMdnsService = uuid => {
      seen.mdns = uuid;
      return mdns;
    };

    await internal.onReady();

    expect(seen.web).toBe(stored);
    expect(seen.mdns).toBe(stored);
  });

  it("mdnsEnabled=true + active mDNS → 'mDNS started' suffix in the running log", async () => {
    const { internal, stub, mdns } = setup({ mdnsEnabled: true });
    await internal.onReady();
    expect(mdns.start).toHaveBeenCalledTimes(1);
    expect(logsOf(stub, "info").some(m => m.endsWith(", mDNS started"))).toBe(true);
  });

  it("mdnsEnabled=true + failed mDNS → warn + 'mDNS FAILED' suffix", async () => {
    const { internal, stub } = setup({ mdnsEnabled: true });
    internal.makeMdnsService = () => makeFakeMdns(false);
    await internal.onReady();
    expect(logsOf(stub, "warn").some(m => m.includes("mDNS failed to start"))).toBe(true);
    expect(logsOf(stub, "info").some(m => m.endsWith(", mDNS FAILED"))).toBe(true);
  });

  it("mdnsEnabled=false → debug note, mDNS never constructed", async () => {
    const { internal, stub, mdns } = setup({ mdnsEnabled: false });
    await internal.onReady();
    expect(mdns.start).not.toHaveBeenCalled();
    expect(logsOf(stub, "debug").some(m => m.includes("mDNS disabled"))).toBe(true);
  });

  it("defensive re-run (H7 v1.14.0): leftover webserver/mdns/discovery are torn down first", async () => {
    const { internal } = setup();
    const oldWeb = makeFakeWebServer();
    const oldMdns = makeFakeMdns();
    const oldDiscovery = makeFakeDiscovery();
    internal.webServer = oldWeb;
    internal.mdnsService = oldMdns;
    internal.urlDiscovery = oldDiscovery;

    await internal.onReady();

    expect(oldWeb.stop).toHaveBeenCalledTimes(1);
    expect(oldMdns.stop).toHaveBeenCalledTimes(1);
    expect(oldDiscovery.cancelRefresh).toHaveBeenCalledTimes(1);
  });

  it("catches an unexpected onReady error, logs it and ends with a restarting exit code (M2, L1)", async () => {
    const { internal, stub } = setup();
    internal.makeGlobalConfig = () => {
      throw new Error("boom in factory");
    };
    await internal.onReady();
    expect(logsOf(stub, "error").some(m => m.includes("onReady failed"))).toBe(true);
    // M2: an error in any onReady step (not just webServer.start) must not leave a
    // zombie; the code must be one js-controller restarts (6), not 11 (L1).
    expect(stub.terminations).toEqual([6]);
  });

  it("a failed start stops the mDNS announcement too, not only the web server (L7)", async () => {
    const { internal, stub, webServer, mdns } = setup({ mdnsEnabled: true });
    const original = stub.setState.bind(stub);
    stub.setState = async (id, state) => {
      if (id === "info.connection" && state.val === true) {
        throw new Error("write refused");
      }
      return original(id, state);
    };
    await internal.onReady();

    expect(webServer.stop).toHaveBeenCalledTimes(1);
    expect(mdns.stop).toHaveBeenCalledTimes(1);
    expect(stub.terminations).toEqual([6]);
  });
});

describe("a stop that arrives while onReady is still running (L4)", () => {
  // js-controller 7.2.2 marks the adapter ready right after emitting `ready` (adapter.ts
  // 11801/11805), so onUnload can run in the middle of an async onReady.
  function hold(): { promise: Promise<void>; release: () => void } {
    let release = (): void => {};
    const promise = new Promise<void>(resolve => (release = resolve));
    return { promise, release };
  }

  it("during URL discovery: nothing is started afterwards", async () => {
    const { internal, stub, webServer, discovery } = setup();
    const gate = hold();
    discovery.collect.mockImplementation(() => gate.promise.then(() => ({})));
    const ready = internal.onReady();
    await vi.waitFor(() => expect(discovery.collect).toHaveBeenCalled());
    const callback = vi.fn();
    internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    gate.release();
    await ready;

    expect(webServer.start).not.toHaveBeenCalled();
    expect(stub.stateSubscriptions).toEqual([]);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
    expect(stub.terminations).toEqual([]);
  });

  it("while the listener opens: the server is closed again once it listens", async () => {
    const { internal, stub, webServer } = setup();
    const gate = hold();
    webServer.start.mockImplementation(() => gate.promise);
    const ready = internal.onReady();
    await vi.waitFor(() => expect(webServer.start).toHaveBeenCalled());
    internal.onUnload(vi.fn());

    gate.release();
    await ready;

    // Once by onUnload (too early — not listening yet), once by the start itself.
    expect(webServer.stop).toHaveBeenCalledTimes(2);
    expect(stub.stateSubscriptions).toEqual([]);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
  });

  it("while subscribing: what started after the stop is taken back, connection stays false", async () => {
    const { internal, stub, webServer, mdns } = setup({ mdnsEnabled: true });
    const gate = hold();
    const adapter = internal as unknown as { subscribeStatesAsync: (p: string) => Promise<void> };
    const original = adapter.subscribeStatesAsync.bind(adapter);
    adapter.subscribeStatesAsync = async (pattern: string) => {
      if (pattern === "info.refreshUrls") {
        await gate.promise;
      }
      return original(pattern);
    };
    const ready = internal.onReady();
    await vi.waitFor(() => expect(stub.stateSubscriptions).toContain("global.*"));
    internal.onUnload(vi.fn());

    gate.release();
    await ready;

    expect(mdns.stop).toHaveBeenCalledWith(true);
    expect(webServer.stop).toHaveBeenCalled();
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
    expect(logsOf(stub, "info").some(m => m.startsWith("HA emulation running"))).toBe(false);
  });

  it("a start that fails BECAUSE of the stop logs no error and asks for no restart (N3)", async () => {
    const { internal, stub } = setup();
    const gate = hold();
    // The registry restore is held; onUnload nulls the collaborators meanwhile, so the start
    // then trips over a null registry — the failure is a consequence of the stop.
    const realMake = internal.makeRegistry;
    internal.makeRegistry = () => {
      const r = realMake();
      (r as unknown as { restore: () => Promise<void> }).restore = () => gate.promise;
      return r;
    };
    const ready = internal.onReady();
    await new Promise(r => setImmediate(r));
    internal.onUnload(vi.fn());

    gate.release();
    await ready;

    expect(logsOf(stub, "error")).toEqual([]);
    expect(stub.terminations).toEqual([]);
    expect(logsOf(stub, "debug").some(m => m.startsWith("Start abandoned during shutdown"))).toBe(true);
  });
});

describe("getOrCreateServerUuid", () => {
  it("reuses an existing valid UUID from info.serverUuid", async () => {
    const { internal, stub } = setup();
    const existing = "12345678-1234-1234-1234-123456789abc";
    stub.states.set("hassemu.0.info.serverUuid", { val: existing, ack: true });
    expect(await internal.getOrCreateServerUuid()).toBe(existing);
  });

  it("generates + persists a fresh UUID when the state is empty", async () => {
    const { internal, stub } = setup();
    const uuid = await internal.getOrCreateServerUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(stub.states.get("hassemu.0.info.serverUuid")).toEqual({ val: uuid, ack: true });
    expect(logsOf(stub, "info").some(m => m.includes("Server UUID generated"))).toBe(true);
  });

  it("rejects a malformed stored value and generates a fresh one", async () => {
    const { internal, stub } = setup();
    stub.states.set("hassemu.0.info.serverUuid", { val: "not-a-uuid", ack: true });
    const uuid = await internal.getOrCreateServerUuid();
    expect(uuid).not.toBe("not-a-uuid");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("persist failure → warn, fresh UUID still returned (no crash)", async () => {
    const { internal, stub } = setup();
    const original = stub.setState.bind(stub);
    stub.setState = async (id, state) => {
      if (id.includes("serverUuid")) {
        throw new Error("write refused");
      }
      return original(id, state);
    };
    const uuid = await internal.getOrCreateServerUuid();
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(logsOf(stub, "warn").some(m => m.includes("Could not save server UUID"))).toBe(true);
    // No line claiming a save that did not happen (audit 2026-09-25, L8).
    expect(logsOf(stub, "info").some(m => m.includes("generated and saved"))).toBe(false);
  });

  it("a READ error is not a fresh install: it propagates and no new identity is written (N4)", async () => {
    const { internal, stub } = setup();
    const adapter = internal as unknown as { getStateAsync: (id: string) => Promise<unknown> };
    adapter.getStateAsync = () => Promise.reject(new Error("states db not ready"));

    await expect(internal.getOrCreateServerUuid()).rejects.toThrow("states db not ready");
    expect(stub.states.has("hassemu.0.info.serverUuid")).toBe(false);
  });
});

describe("readSystemLanguage", () => {
  it("reads system.config.common.language", async () => {
    const { internal, stub } = setup();
    stub.objects.set("system.config", { type: "config", common: { language: "de" } });
    expect(await internal.readSystemLanguage()).toBe("de");
  });

  it("falls back to en when system.config is missing or has no language", async () => {
    const { internal, stub } = setup();
    expect(await internal.readSystemLanguage()).toBe("en");
    stub.objects.set("system.config", { type: "config", common: {} });
    expect(await internal.readSystemLanguage()).toBe("en");
  });
});

describe("computeNewClientMode", () => {
  it("master switch on → 'global', off/unset → '0' (no-choice, landing page)", async () => {
    const { internal } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    expect(internal.computeNewClientMode()).toBe("0");
    await internal.globalConfig.handleEnabledWrite(true);
    expect(internal.computeNewClientMode()).toBe(MODE_GLOBAL);
  });
});

describe("migrateLegacyDefaultVisUrl", () => {
  function seedInstanceNative(stub: StubSurface, native: Record<string, unknown>): void {
    stub.objects.set("system.adapter.hassemu.0", { type: "instance", common: {}, native });
  }

  it("no legacy URL in config → no-op", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );
    expect(stub.states.has("hassemu.0.global.visUrl")).toBe(false);
  });

  it("safe legacy URL → straight to global.mode/manualUrl + master switch on + native keys dropped (L2)", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.defaultVisUrl = "http://legacy.local/vis";
    seedInstanceNative(stub, { defaultVisUrl: "http://legacy.local/vis", other: "stays" });

    await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );

    // No detour through a `global.visUrl` state: it would be a value without an object that
    // no delObject removes, migrated again on every start (audit 2026-09-25, L2).
    expect(stub.states.has("hassemu.0.global.visUrl")).toBe(false);
    expect(stub.states.get("hassemu.0.global.mode")).toEqual({ val: MODE_MANUAL, ack: true });
    expect(stub.states.get("hassemu.0.global.manualUrl")).toEqual({ val: "http://legacy.local/vis", ack: true });
    // L2b: the master switch goes on as 1.1.1 did, so new displays follow the old URL.
    expect(stub.states.get("hassemu.0.global.enabled")).toEqual({ val: true, ack: true });
    const native = stub.objects.get("system.adapter.hassemu.0")!.native!;
    // Cleared via the merge (`null`, not a whole-object rewrite) — falsy is all the
    // migration ever reads them for.
    expect(native.defaultVisUrl).toBeFalsy();
    expect(native.visUrl).toBeFalsy();
    expect(native.other).toBe("stays");
  });

  it("signals the caller to abort the start — writing the instance object restarts it", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.defaultVisUrl = "http://legacy.local/vis";
    seedInstanceNative(stub, { defaultVisUrl: "http://legacy.local/vis" });

    const restarting = await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );
    expect(restarting).toBe(true);
  });

  it("does not touch the instance object when the legacy keys are already gone", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    // config still carries the value (a stale cached config) but the object is clean.
    stub.config.defaultVisUrl = "http://legacy.local/vis";
    seedInstanceNative(stub, { other: "stays" });
    const before = stub.objects.get("system.adapter.hassemu.0");

    const restarting = await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );
    // No write, no restart — otherwise the adapter would restart on every start.
    expect(restarting).toBe(false);
    expect(stub.objects.get("system.adapter.hassemu.0")).toBe(before);
  });

  it("MERGES instead of rewriting — a concurrent change to the instance object survives", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.defaultVisUrl = "http://legacy.local/vis";
    seedInstanceNative(stub, { defaultVisUrl: "http://legacy.local/vis" });
    // Someone (the admin saving the config) changes the object after the migration
    // read it and before it writes. A read-modify-write of the WHOLE object would
    // silently drop this.
    const surface = stub as unknown as {
      getForeignObjectAsync: (id: string) => Promise<ObjEntry | null>;
    };
    const original = surface.getForeignObjectAsync.bind(stub);
    surface.getForeignObjectAsync = async (id: string) => {
      const obj = await original(id);
      if (id === "system.adapter.hassemu.0") {
        stub.objects.set(id, { type: "instance", common: {}, native: { ...obj!.native, addedMeanwhile: "keep me" } });
      }
      return obj;
    };

    await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );

    const native = stub.objects.get("system.adapter.hassemu.0")!.native!;
    expect(native.addedMeanwhile).toBe("keep me");
    expect(native.defaultVisUrl).toBeFalsy();
  });

  it("unsafe legacy URL → warn, NOT written, native still cleaned", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.defaultVisUrl = "javascript:alert(1)";
    seedInstanceNative(stub, { defaultVisUrl: "javascript:alert(1)" });

    await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );

    expect(stub.states.has("hassemu.0.global.visUrl")).toBe(false);
    expect(logsOf(stub, "warn").some(m => m.includes("rejected as unsafe"))).toBe(true);
    expect(stub.objects.get("system.adapter.hassemu.0")!.native!.defaultVisUrl).toBeFalsy();
  });

  it("the global write fails → native values preserved as recovery anchor + warn", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.visUrl = "http://precious.local/";
    seedInstanceNative(stub, { visUrl: "http://precious.local/" });
    stub.setState = () => {
      return Promise.reject(new Error("broker down"));
    };

    const restarting = await migrateLegacyDefaultVisUrl(
      internal as unknown as MigrationAdapter,
      stub.config as unknown as AdapterConfig,
      internal.globalConfig,
    );

    expect(restarting).toBe(false);
    expect(logsOf(stub, "warn").some(m => m.includes("Legacy URL preserved"))).toBe(true);
    // The recovery anchor MUST survive — this is the data-loss guard.
    expect(stub.objects.get("system.adapter.hassemu.0")!.native!.visUrl).toBe("http://precious.local/");
  });

  it("a whole 1.1.0 upgrade: first start moves the URL and restarts, the second start keeps the user's later choice (L2)", async () => {
    // First start: legacy native → global, native dropped, restart requested.
    const first = setup();
    first.stub.config.defaultVisUrl = "http://legacy.local/vis";
    seedInstanceNative(first.stub, { defaultVisUrl: "http://legacy.local/vis" });
    await first.internal.onReady();
    expect(first.webServer.start, "the start aborts for the restart").not.toHaveBeenCalled();
    expect(first.stub.states.get("hassemu.0.global.manualUrl")?.val).toBe("http://legacy.local/vis");

    // The user picks a VIS URL; the next start must not reset it.
    await first.internal.globalConfig!.handleModeWrite("http://vis.local/vis-2/index.html?main");
    const second = setup();
    second.stub.objects = first.stub.objects;
    second.stub.states = first.stub.states;
    await second.internal.onReady();

    expect(second.stub.states.get("hassemu.0.global.mode")?.val).toBe("http://vis.local/vis-2/index.html?main");
    expect(logsOf(second.stub, "info").some(m => m.startsWith("Migration: global URL"))).toBe(false);
  });
});

/**
 * Seed a client the way a real start sees it: a persisted `clients.<id>` device with its
 * states, then `registry.restore()`. The legacy `visUrl` reaches the migration through the
 * restore batch now (no getState of its own per client per start), so a test that only
 * writes the state without restoring would exercise a path that no longer exists.
 *
 * @param stub     The adapter stub holding objects + states.
 * @param internal The adapter under test (its `registry` must already be built).
 * @param visUrl   Legacy value to place on `clients.<id>.visUrl`, or null for none.
 * @returns The restored client record.
 */
async function seedRestoredClient(
  stub: StubSurface,
  internal: Internal,
  visUrl: string | null,
): Promise<ReturnType<ClientRegistry["listAll"]>[number]> {
  const id = "c0ffee";
  stub.objects.set(`hassemu.0.clients.${id}`, {
    type: "device",
    common: { name: { en: "Display" } },
    native: { cookie: "11111111-2222-4333-8444-555555555555" },
  });
  stub.states.set(`hassemu.0.clients.${id}.mode`, { val: "0", ack: true });
  if (visUrl !== null) {
    stub.states.set(`hassemu.0.clients.${id}.visUrl`, { val: visUrl, ack: true });
    stub.objects.set(`hassemu.0.clients.${id}.visUrl`, { type: "state" });
  }
  await internal.registry!.restore();
  const rec = internal.registry!.getById(id);
  if (!rec) {
    throw new Error("seedRestoredClient: restore did not load the client");
  }
  return rec;
}

describe("migrateVisUrlToMode", () => {
  it("global legacy visUrl (safe) → migrationSet(manual, url) + legacy object dropped", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    stub.states.set("hassemu.0.global.visUrl", { val: "http://old.local/vis", ack: true });
    stub.objects.set("hassemu.0.global.visUrl", { type: "state" });

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    expect(stub.states.get("hassemu.0.global.mode")).toEqual({ val: MODE_MANUAL, ack: true });
    expect(stub.states.get("hassemu.0.global.manualUrl")).toEqual({ val: "http://old.local/vis", ack: true });
    expect(stub.objects.has("hassemu.0.global.visUrl")).toBe(false);
    expect(logsOf(stub, "info").some(m => m.includes("moved to global.manualUrl"))).toBe(true);
  });

  it("global legacy visUrl (unsafe) → manual mode without URL + warn", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    stub.states.set("hassemu.0.global.visUrl", { val: "javascript:alert(1)", ack: true });

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    expect(stub.states.get("hassemu.0.global.mode")).toEqual({ val: MODE_MANUAL, ack: true });
    expect(stub.states.get("hassemu.0.global.manualUrl")).toEqual({ val: "", ack: true });
    expect(logsOf(stub, "warn").some(m => m.includes("rejected as unsafe"))).toBe(true);
  });

  it("an already-migrated install performs no delete round-trips (I5)", async () => {
    const { internal } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    await internal.registry.identifyOrCreate(null, "10.0.0.9");
    // No legacy visUrl anywhere — this is the state of EVERY start after the
    // first one, so a blind delObject here is a wasted broker round-trip per
    // client on every single adapter start.
    const deleted: string[] = [];
    const origDel = internal.delObjectAsync;
    internal.delObjectAsync = async (id: string, opts?: unknown) => {
      deleted.push(id);
      return origDel(id, opts);
    };

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    expect(deleted.filter(id => id.includes("visUrl"))).toEqual([]);
    internal.delObjectAsync = origDel;
  });

  it("per-client legacy visUrl (safe) → mode='manual' + manualUrl + visUrl object dropped", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    const rec = await seedRestoredClient(stub, internal, "http://client-old.local/");

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    expect(rec.mode).toBe(MODE_MANUAL);
    expect(rec.manualUrl).toBe("http://client-old.local/");
    expect(stub.states.get(`hassemu.0.clients.${rec.id}.mode`)).toEqual({ val: MODE_MANUAL, ack: true });
    expect(stub.states.get(`hassemu.0.clients.${rec.id}.manualUrl`)).toEqual({
      val: "http://client-old.local/",
      ack: true,
    });
    expect(stub.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).toBe(false);
  });

  it("per-client legacy visUrl (unsafe) → warn, record untouched", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    const rec = await seedRestoredClient(stub, internal, "data:text/html,x");
    const modeBefore = rec.mode;

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    expect(rec.mode).toBe(modeBefore);
    expect(rec.manualUrl).toBeNull();
    expect(logsOf(stub, "warn").some(m => m.includes(`client ${rec.id} legacy URL rejected`))).toBe(true);
  });

  it("global migration write fails → legacy global.visUrl object preserved + warn (v1.36.0 C5)", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    stub.states.set("hassemu.0.global.visUrl", { val: "http://old.local/vis", ack: true });
    stub.objects.set("hassemu.0.global.visUrl", { type: "state" });
    const original = stub.setState.bind(stub);
    stub.setState = async (id, state) => {
      if (id === "global.mode" || id === "global.manualUrl") {
        throw new Error("broker down");
      }
      return original(id, state);
    };

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    // The legacy source MUST survive as a recovery anchor — never deleted on a write-fail.
    expect(stub.objects.has("hassemu.0.global.visUrl")).toBe(true);
    expect(logsOf(stub, "warn").some(m => m.includes("global.visUrl preserved"))).toBe(true);
  });

  it("per-client migration write fails → legacy clients.<id>.visUrl object preserved + warn (v1.36.0 C5)", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    const rec = await seedRestoredClient(stub, internal, "http://client-old.local/");
    const original = stub.setState.bind(stub);
    stub.setState = async (id, state) => {
      if (id === `clients.${rec.id}.mode` || id === `clients.${rec.id}.manualUrl`) {
        throw new Error("broker down");
      }
      return original(id, state);
    };

    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);

    expect(stub.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).toBe(true);
    expect(logsOf(stub, "warn").some(m => m.includes("visUrl preserved"))).toBe(true);
  });

  it("idempotent: nothing to migrate → no state writes, no logs above debug", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    await migrateVisUrlToMode(internal as unknown as MigrationAdapter, internal.globalConfig, internal.registry);
    expect(stub.states.has("hassemu.0.global.mode")).toBe(false);
    expect(logsOf(stub, "warn")).toEqual([]);
    expect(logsOf(stub, "info")).toEqual([]);
  });
});

describe("gcStaleClients", () => {
  /**
   * Seeds a display the way an existing installation holds it — a device object with
   * the given `lastSeen` (or none) — and restores the registry from it. The GC reads
   * the stamps the restore loaded, not the objects (audit 2026-09-15, D1), so a test
   * that patched the stored object AFTER the restore would test nothing.
   *
   * @param stub Object store of the stub adapter
   * @param id Display id
   * @param lastSeen Persisted stamp, or undefined for a pre-1.2.0 display without one
   * @param extraNative Further native fields (tokens) for the display
   */
  function seedDisplay(
    stub: StubSurface,
    id: string,
    lastSeen: number | undefined,
    extraNative: Record<string, unknown> = {},
  ): void {
    stub.objects.set(`hassemu.0.clients.${id}`, {
      type: "device",
      common: { name: { en: `10.0.0.${id.length}` } },
      native: {
        cookie: crypto.randomUUID(),
        token: null,
        objectsVersion: CLIENT_OBJECTS_VERSION,
        ...(lastSeen === undefined ? {} : { lastSeen }),
        ...extraNative,
      },
    });
    for (const leaf of ["mode", "manualUrl", "ip", "resolvedUrl", "remove"]) {
      stub.objects.set(`hassemu.0.clients.${id}.${leaf}`, { type: "state", common: { name: leaf }, native: {} });
    }
    stub.states.set(`hassemu.0.clients.${id}.mode`, { val: "0", ack: true });
  }

  it("client without lastSeen gets seeded, not removed", async () => {
    const { internal, stub } = setup();
    seedDisplay(stub, "a1", undefined);
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();

    await internal.gcStaleClients();

    expect(internal.registry.getById("a1")).not.toBeNull();
    expect(typeof stub.objects.get("hassemu.0.clients.a1")!.native!.lastSeen).toBe("number");
  });

  it("stale client (30d behind the most recently seen display) is removed with an info log", async () => {
    const { internal, stub } = setup();
    seedDisplay(stub, "b2", Date.now() - 31 * 24 * 60 * 60 * 1000);
    seedDisplay(stub, "f0", Date.now() - 1000);
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();

    await internal.gcStaleClients();

    expect(internal.registry.getById("b2")).toBeNull();
    expect(stub.objects.has("hassemu.0.clients.b2")).toBe(false);
    expect(logsOf(stub, "info").some(m => m.includes("Removed 1 inactive client"))).toBe(true);
  });

  it("fresh client is kept — and the GC reads no object for it", async () => {
    const { internal, stub } = setup();
    seedDisplay(stub, "c3", Date.now() - 1000);
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();
    const adapter = internal as unknown as { getObjectAsync: (id: string) => Promise<unknown> };
    const reads: string[] = [];
    const original = adapter.getObjectAsync.bind(adapter);
    adapter.getObjectAsync = async (id: string) => {
      reads.push(id);
      return original(id);
    };

    await internal.gcStaleClients();

    expect(internal.registry.getById("c3")).not.toBeNull();
    expect(logsOf(stub, "info").some(m => m.includes("Removed"))).toBe(false);
    // The restore already read every client object; the GC decides on those stamps.
    expect(reads).toEqual([]);
  });

  it("a broker failure for one client does not abort the GC pass", async () => {
    const { internal, stub } = setup();
    seedDisplay(stub, "d4", Date.now() - 31 * 24 * 60 * 60 * 1000);
    seedDisplay(stub, "e5", Date.now() - 31 * 24 * 60 * 60 * 1000);
    seedDisplay(stub, "f0", Date.now() - 1000);
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();
    const adapter = internal as unknown as { delObjectAsync: (id: string, o?: unknown) => Promise<unknown> };
    const original = adapter.delObjectAsync.bind(adapter);
    adapter.delObjectAsync = async (id: string, o?: unknown) => {
      if (id.includes("d4")) {
        throw new Error("broker hiccup");
      }
      return original(id, o);
    };

    await internal.gcStaleClients();

    expect(stub.objects.has("hassemu.0.clients.e5")).toBe(false);
    expect(internal.registry.getById("e5")).toBeNull();
  });

  it("an adapter that was OFF for 40 days keeps every display (L3)", async () => {
    // Nobody could be seen while the adapter was off — measured against the clock, one
    // start removed the whole installation with its settings, rooms and tokens.
    const { internal, stub } = setup();
    const day = 24 * 60 * 60 * 1000;
    seedDisplay(stub, "m1", Date.now() - 39 * day, { refreshToken: crypto.randomUUID() });
    seedDisplay(stub, "m2", Date.now() - 40 * day, { refreshToken: crypto.randomUUID() });
    seedDisplay(stub, "m3", Date.now() - 41 * day, { refreshToken: crypto.randomUUID() });
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();

    await internal.gcStaleClients();

    for (const id of ["m1", "m2", "m3"]) {
      expect(internal.registry.getById(id), id).not.toBeNull();
    }
    expect(logsOf(stub, "info").some(m => m.includes("Removed"))).toBe(false);
  });

  it("a stamp from a clock that ran ahead does not age every other display (L3)", async () => {
    const { internal, stub } = setup();
    const day = 24 * 60 * 60 * 1000;
    seedDisplay(stub, "ahead", Date.now() + 365 * day);
    seedDisplay(stub, "today", Date.now() - day);
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();

    await internal.gcStaleClients();

    expect(internal.registry.getById("ahead")).not.toBeNull();
    expect(internal.registry.getById("today")).not.toBeNull();
  });

  it("a stale display is removed even though it holds a token and a refresh token (DD14, T4)", async () => {
    const { internal, stub } = setup();
    const day = 24 * 60 * 60 * 1000;
    const refreshToken = crypto.randomUUID();
    seedDisplay(stub, "tok", Date.now() - 31 * day, {
      token: crypto.randomUUID(),
      refreshToken,
      tokenExpiresAt: Date.now() + 60_000,
    });
    seedDisplay(stub, "f0", Date.now() - 1000);
    internal.registry = internal.makeRegistry();
    await internal.registry.restore();
    expect(internal.registry.getByRefreshToken(refreshToken), "restored with its token").not.toBeNull();

    await internal.gcStaleClients();

    expect(internal.registry.getById("tok")).toBeNull();
    expect(internal.registry.getByRefreshToken(refreshToken)).toBeNull();
  });
});

describe("applyMasterSwitch", () => {
  it("enabled=true → every client follows 'global'", async () => {
    const { internal } = setup();
    internal.registry = internal.makeRegistry();
    const a = await internal.registry.identifyOrCreate(null, "10.0.0.1");
    const b = await internal.registry.identifyOrCreate(null, "10.0.0.2");
    a.mode = "http://somewhere/";
    b.mode = "";

    await internal.applyMasterSwitch(true);

    expect(a.mode).toBe(MODE_GLOBAL);
    expect(b.mode).toBe(MODE_GLOBAL);
  });

  it("enabled=false → every client drops to '0' (no-choice → landing page)", async () => {
    const { internal } = setup();
    internal.registry = internal.makeRegistry();
    const a = await internal.registry.identifyOrCreate(null, "10.0.0.1");
    a.mode = MODE_GLOBAL;

    await internal.applyMasterSwitch(false);

    expect(a.mode).toBe("0");
  });

  it("is a safe no-op without a registry", async () => {
    const { internal, stub } = setup();
    internal.registry = null;
    await expect(internal.applyMasterSwitch(true)).resolves.toBeUndefined();
    expect(logsOf(stub, "debug").some(m => m.startsWith("applyMasterSwitch"))).toBe(false);
  });
});

describe("onStateChange routing", () => {
  function readySetup(): Promise<Setup> {
    const s = setup();
    s.internal.registry = s.internal.makeRegistry();
    s.internal.globalConfig = s.internal.makeGlobalConfig();
    s.internal.urlDiscovery = s.discovery;
    return Promise.resolve(s);
  }

  it("ignores acked states and null states", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    rec.mode = "http://keep/";
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: MODE_MANUAL, ack: true });
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, null);
    expect(rec.mode).toBe("http://keep/");
  });

  it("routes clients.<id>.mode writes to handleModeWrite", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: "http://picked.local/", ack: false });
    expect(rec.mode).toBe("http://picked.local/");
  });

  it("names mode='global' without a resolvable global URL on debug, never warn (B4, N8)", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: MODE_GLOBAL, ack: false });
    expect(logsOf(s.stub, "debug").some(m => m.includes("global has no resolvable URL"))).toBe(true);
    expect(logsOf(s.stub, "warn")).toEqual([]);
  });

  it("no B4 warning when global resolves to a URL", async () => {
    const s = await readySetup();
    await s.internal.globalConfig!.handleModeWrite("http://global.local/");
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: MODE_GLOBAL, ack: false });
    expect(logsOf(s.stub, "debug").some(m => m.includes("global has no resolvable URL"))).toBe(false);
  });

  it("routes clients.<id>.manualUrl writes to handleManualUrlWrite", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.manualUrl`, {
      val: "http://manual.local/",
      ack: false,
    });
    expect(rec.manualUrl).toBe("http://manual.local/");
  });

  it("remove button (val=true) forgets the client", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.remove`, { val: true, ack: false });
    expect(s.internal.registry!.getById(rec.id)).toBeNull();
  });

  it("remove button with val=false does nothing", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.remove`, { val: false, ack: false });
    expect(s.internal.registry!.getById(rec.id)).not.toBeNull();
  });

  it("routes global.mode / global.manualUrl writes", async () => {
    const s = await readySetup();
    await s.internal.onStateChange("hassemu.0.global.manualUrl", { val: "http://gm.local/", ack: false });
    await s.internal.onStateChange("hassemu.0.global.mode", { val: MODE_MANUAL, ack: false });
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    rec.mode = MODE_GLOBAL;
    expect(resolveRedirect(rec, s.internal.globalConfig!.redirect)).toBe("http://gm.local/");
  });

  it("global.enabled write persists AND bulk-syncs all client modes", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    rec.mode = "";

    await s.internal.onStateChange("hassemu.0.global.enabled", { val: true, ack: false });

    expect(s.internal.globalConfig!.isEnabled()).toBe(true);
    expect(rec.mode).toBe(MODE_GLOBAL);

    await s.internal.onStateChange("hassemu.0.global.enabled", { val: false, ack: false });
    expect(rec.mode).toBe("0");
  });

  // Audit 2026-09-15 (A1): only a TRANSITION of the master switch may touch the displays.
  // bulkSetMode compares every client with the target mode, so before the fix a write of
  // the same value — a script re-asserting `true` every morning — wiped every display's own
  // choice. These two run through onStateChange on purpose: handleEnabledWrite alone was
  // always fine, the orchestration in main.ts was the defect.
  it("re-writing global.enabled with the SAME value leaves every display's own choice alone", async () => {
    const s = await readySetup();
    await s.internal.onStateChange("hassemu.0.global.enabled", { val: true, ack: false });
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    rec.mode = "http://own.local/";

    await s.internal.onStateChange("hassemu.0.global.enabled", { val: true, ack: false });

    expect(s.internal.globalConfig!.isEnabled()).toBe(true);
    expect(rec.mode).toBe("http://own.local/");
  });

  it("a rejected non-boolean write on global.enabled warns AND leaves every display's own choice alone", async () => {
    const s = await readySetup();
    await s.internal.onStateChange("hassemu.0.global.enabled", { val: true, ack: false });
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    rec.mode = "http://own.local/";

    await s.internal.onStateChange("hassemu.0.global.enabled", { val: "yes", ack: false });

    expect(logsOf(s.stub, "warn").some(m => m.includes("global.enabled rejected"))).toBe(true);
    expect(s.internal.globalConfig!.isEnabled()).toBe(true);
    expect(rec.mode).toBe("http://own.local/");
  });

  it("info.refreshUrls=true triggers an immediate collect and re-arms the button", async () => {
    const s = await readySetup();
    await s.internal.onStateChange("hassemu.0.info.refreshUrls", { val: true, ack: false });
    expect(s.discovery.collect).toHaveBeenCalledTimes(1);
    // L3 (v1.38.0): a pending debounced refresh is cancelled first so the button click
    // can't cause a second full broker scan ~2s later.
    expect(s.discovery.cancelRefresh).toHaveBeenCalledTimes(1);
    expect(s.discovery.cancelRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      s.discovery.collect.mock.invocationCallOrder[0],
    );
    expect(s.stub.states.get("hassemu.0.info.refreshUrls")).toEqual({ val: false, ack: true });
    // I3: the success line is on debug now (no "success" on info) — the visible
    // feedback is the refreshed dropdown + the re-armed button.
    expect(logsOf(s.stub, "debug").some(m => m.includes("URL list refreshed"))).toBe(true);
  });

  it("info.refreshUrls=false does NOT trigger a scan", async () => {
    const s = await readySetup();
    // The button re-arms itself by writing false with ack — but a user (or a
    // script) can also write false directly, ack=false. Treating that as a
    // press means every re-arm-by-hand costs a full broker scan.
    await s.internal.onStateChange("hassemu.0.info.refreshUrls", { val: false, ack: false });
    expect(s.discovery.collect).not.toHaveBeenCalled();
    expect(s.discovery.cancelRefresh).not.toHaveBeenCalled();
  });

  it("refresh button: collect failure warns but still re-arms the button", async () => {
    const s = await readySetup();
    s.discovery.collect.mockRejectedValue(new Error("discovery broke"));
    await s.internal.onStateChange("hassemu.0.info.refreshUrls", { val: true, ack: false });
    expect(logsOf(s.stub, "warn").some(m => m.includes("URL refresh failed"))).toBe(true);
    expect(s.stub.states.get("hassemu.0.info.refreshUrls")).toEqual({ val: false, ack: true });
  });

  it("refresh button is a no-op before urlDiscovery exists", async () => {
    const s = await readySetup();
    s.internal.urlDiscovery = null;
    await s.internal.onStateChange("hassemu.0.info.refreshUrls", { val: true, ack: false });
    expect(s.discovery.collect).not.toHaveBeenCalled();
  });

  it("handler errors are caught and logged, never thrown", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1");
    s.internal.registry!.handleModeWrite = () => {
      return Promise.reject(new Error("handler exploded"));
    };
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: "http://x/", ack: false });
    expect(logsOf(s.stub, "error").some(m => m.includes("stateChange failed"))).toBe(true);
  });
});

describe("onObjectChange filter (H4 v1.13.0 / R2 v1.30.0)", () => {
  it("URL-source adapter events schedule a refresh", () => {
    const { internal, discovery } = setup();
    internal.urlDiscovery = discovery;
    internal.onObjectChange("system.adapter.vis-2.0", { type: "instance", common: { host: "h" } });
    internal.onObjectChange("system.adapter.aura.0", { type: "instance", common: { host: "h" } });
    expect(discovery.scheduleRefresh).toHaveBeenCalledTimes(2);
  });

  it("instance delete (obj=null) schedules a refresh", () => {
    const { internal, discovery } = setup();
    internal.urlDiscovery = discovery;
    internal.onObjectChange("system.adapter.someadapter.0", null);
    expect(discovery.scheduleRefresh).toHaveBeenCalledTimes(1);
  });

  it("a deleted state BELOW a foreign instance does NOT schedule a refresh (only an instance id counts)", () => {
    // Audit 2026-09-15 (D4): uninstalling influxdb deletes dozens of
    // `system.adapter.influxdb.0.<state>` objects — each used to be an "instance removed".
    const { internal, discovery } = setup();
    internal.urlDiscovery = discovery;
    internal.onObjectChange("system.adapter.influxdb.0.memRss", null);
    internal.onObjectChange("system.adapter.influxdb.0.alive", null);
    expect(discovery.scheduleRefresh).not.toHaveBeenCalled();
    // The instance itself going away still does.
    internal.onObjectChange("system.adapter.influxdb.0", null);
    expect(discovery.scheduleRefresh).toHaveBeenCalledTimes(1);
  });

  it("unrelated adapter reconfiguration does NOT schedule a refresh", () => {
    const { internal, discovery } = setup();
    internal.urlDiscovery = discovery;
    internal.onObjectChange("system.adapter.influxdb.0", { type: "instance", common: { host: "h" } });
    expect(discovery.scheduleRefresh).not.toHaveBeenCalled();
  });

  it("non-adapter ids are ignored entirely", () => {
    const { internal, discovery } = setup();
    internal.urlDiscovery = discovery;
    internal.onObjectChange("system.host.pi", { type: "host" });
    internal.onObjectChange("hassemu.0.clients.abc", { type: "channel" });
    // A DELETED object outside system.adapter.* is the case where the prefix
    // check is the only thing standing between us and a full broker scan: the
    // "instance add/remove" branch below fires on every obj=null. Deleting our
    // own client states (or anything else in the system) must not trigger one.
    internal.onObjectChange("hassemu.0.clients.abc.mode", null);
    internal.onObjectChange("javascript.0.scriptEnabled.common", null);
    expect(discovery.scheduleRefresh).not.toHaveBeenCalled();
  });
});

describe("onUnload", () => {
  it("tears everything down and always calls the callback", async () => {
    const { internal, stub, webServer, mdns, discovery } = setup();
    internal.webServer = webServer;
    internal.mdnsService = mdns;
    internal.urlDiscovery = discovery;
    internal.registry = internal.makeRegistry();
    internal.globalConfig = internal.makeGlobalConfig();
    const callback = vi.fn();

    internal.onUnload(callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
    expect(webServer.stop).toHaveBeenCalledTimes(1);
    expect(mdns.stop).toHaveBeenCalledTimes(1);
    expect(discovery.cancelRefresh).toHaveBeenCalledTimes(1);
    expect(stub.stateUnsubscriptions).toEqual(["clients.*", "global.*", "info.refreshUrls"]);
    expect(stub.objectUnsubscriptions).toEqual(["system.adapter.*"]);
    expect(internal.webServer).toBeNull();
    expect(internal.mdnsService).toBeNull();
    expect(internal.registry).toBeNull();
    expect(internal.globalConfig).toBeNull();
  });

  it("writes info.connection=false BEFORE any other teardown step (H10)", async () => {
    // If a later step throws, the state must already be false instead of staying true.
    const { internal, stub, webServer, mdns, discovery } = setup();
    internal.webServer = webServer;
    internal.mdnsService = mdns;
    internal.urlDiscovery = discovery;
    const order: string[] = [];
    const original = stub.setState.bind(stub);
    stub.setState = async (id, state) => {
      order.push(`${id}=${String(state.val)}`);
      return original(id, state);
    };
    const adapter = internal as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
    for (const name of ["unsubscribeStatesAsync", "unsubscribeForeignObjectsAsync"]) {
      const fn = adapter[name].bind(adapter);
      adapter[name] = (...args: unknown[]) => {
        order.push(name);
        return fn(...args);
      };
    }
    discovery.cancelRefresh.mockImplementation(() => void order.push("cancelRefresh"));
    mdns.stop.mockImplementation(() => {
      order.push("mdns.stop");
      return Promise.resolve();
    });
    webServer.stop.mockImplementation(() => {
      order.push("web.stop");
      return Promise.resolve();
    });
    const callback = vi.fn();

    internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(order[0]).toBe("info.connection=false");
    expect(order).toContain("mdns.stop");
    expect(order).toContain("web.stop");
  });

  it("calls the callback even when a teardown step throws", () => {
    const { internal, mdns } = setup();
    internal.mdnsService = mdns;
    mdns.stop.mockImplementation(() => {
      throw new Error("stop exploded");
    });
    const callback = vi.fn();
    internal.onUnload(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is safe on a half-initialized adapter (everything null)", async () => {
    const { internal } = setup();
    const callback = vi.fn();
    internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });

  it("reports done only after the shutdown writes and the mDNS goodbye finished", async () => {
    const { internal, webServer, mdns } = setup();
    internal.webServer = webServer;
    internal.mdnsService = mdns;
    let releaseServer = (): void => {};
    let releaseGoodbye = (): void => {};
    webServer.stop.mockImplementation(() => new Promise<void>(resolve => (releaseServer = resolve)));
    mdns.stop.mockImplementation(() => new Promise<void>(resolve => (releaseGoodbye = resolve)));
    const callback = vi.fn();

    internal.onUnload(callback);
    await new Promise(r => setImmediate(r));
    expect(callback).not.toHaveBeenCalled();

    releaseGoodbye();
    await new Promise(r => setImmediate(r));
    expect(callback).not.toHaveBeenCalled();

    releaseServer();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });

  it("a rejected shutdown write does not call back before the goodbye and the server stop finished", async () => {
    // Audit 2026-09-15 (B4): Promise.all rejects on the first failed member, which used
    // to fire the callback while the mDNS goodbye and the server stop were still running.
    const { internal, stub, webServer, mdns } = setup();
    internal.webServer = webServer;
    internal.mdnsService = mdns;
    let releaseServer = (): void => {};
    webServer.stop.mockImplementation(() => new Promise<void>(resolve => (releaseServer = resolve)));
    mdns.stop.mockImplementation(() => Promise.resolve());
    const adapter = internal as unknown as { setState: (...args: unknown[]) => Promise<unknown> };
    adapter.setState = () => Promise.reject(new Error("broker gone"));
    const callback = vi.fn();

    internal.onUnload(callback);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(callback, "not before the server stop finished").not.toHaveBeenCalled();

    releaseServer();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(logsOf(stub, "error").some(m => m.includes("Shutdown error") && m.includes("broker gone"))).toBe(true);
  });
});

describe("listen-address migration bindAddress → bind (fleet listen-port standard, 2026-09-15)", () => {
  const INSTANCE_ID = "system.adapter.hassemu.0";

  it("carries the user's bindAddress over to bind in ONE merge, nulls the old key and aborts the start", async () => {
    const { internal, stub, webServer } = setup();
    // What an update leaves behind: js-controller added `bind` with the manifest default
    // and kept the user's old key. A read fallback `bind || bindAddress` would pick the
    // default forever — the value has to MOVE.
    stub.objects.set(INSTANCE_ID, {
      type: "instance",
      common: { name: "hassemu" },
      native: { port: 8123, bind: "0.0.0.0", bindAddress: "192.168.1.5", mdnsEnabled: true },
    });
    const writes: unknown[] = [];
    const surface = internal as unknown as { extendForeignObjectAsync: (id: string, obj: unknown) => Promise<void> };
    const original = surface.extendForeignObjectAsync.bind(internal);
    surface.extendForeignObjectAsync = (id: string, obj: unknown) => {
      writes.push(obj);
      return original(id, obj);
    };

    await internal.onReady();

    expect(writes).toEqual([{ native: { bind: "192.168.1.5", bindAddress: null } }]);
    const native = stub.objects.get(INSTANCE_ID)!.native!;
    expect(native.bind).toBe("192.168.1.5");
    expect(native.bindAddress).toBeNull();
    expect(native.mdnsEnabled, "untouched keys survive the merge").toBe(true);
    expect(webServer.start, "no port bound in a process the host is restarting").not.toHaveBeenCalled();
    expect(logsOf(stub, "info").some(m => m.includes("restarts once"))).toBe(true);
  });

  it("an empty legacy address becomes 0.0.0.0 — an empty bind is as invisible to the admin as none", async () => {
    const { internal, stub } = setup();
    stub.objects.set(INSTANCE_ID, { type: "instance", native: { port: 8123, bind: "0.0.0.0", bindAddress: "" } });

    await internal.onReady();

    expect(stub.objects.get(INSTANCE_ID)!.native!.bind).toBe("0.0.0.0");
    expect(stub.objects.get(INSTANCE_ID)!.native!.bindAddress).toBeNull();
  });

  it("recognises the migrated state (old key null) and starts without writing — no restart loop", async () => {
    // An extend with `null` stores `null`, it does not delete the key (measured on the
    // objects store): the second start after the migration sees exactly this object.
    const { internal, stub, webServer } = setup();
    stub.objects.set(INSTANCE_ID, {
      type: "instance",
      native: { port: 8123, bind: "192.168.1.5", bindAddress: null },
    });
    const before = JSON.stringify(stub.objects.get(INSTANCE_ID));

    await internal.onReady();

    expect(JSON.stringify(stub.objects.get(INSTANCE_ID))).toBe(before);
    expect(webServer.start).toHaveBeenCalledTimes(1);
    expect(logsOf(stub, "info").some(m => m.includes("restarts once"))).toBe(false);
  });
});

describe("stopInstance self-correction", () => {
  const INSTANCE_ID = "system.adapter.hassemu.0";

  it("deletes the leftover key and aborts the start (the host restarts us)", async () => {
    const { internal, stub, webServer } = setup();
    stub.objects.set(INSTANCE_ID, { type: "instance", common: { supportedMessages: { stopInstance: true } } });

    await internal.onReady();

    // The whole key goes, not just the entry: `supportedMessages` is a positive list, so an
    // object with nothing but `false` in it would switch the messagebox off for good.
    expect(stub.objects.get(INSTANCE_ID)?.common?.supportedMessages).toBeNull();
    expect(webServer.start).not.toHaveBeenCalled();
    expect(stub.stateSubscriptions).toEqual([]);
    expect(logsOf(stub, "info").some(m => m.includes("restarts once"))).toBe(true);
  });

  it("still corrects an instance that an earlier version half-corrected", async () => {
    const { internal, stub, webServer } = setup();
    // What 1.38.2–1.41.0 left behind. A guard that looks at `stopInstance` never sees its own
    // result again, so this installation would keep the key forever.
    stub.objects.set(INSTANCE_ID, { type: "instance", common: { supportedMessages: { stopInstance: false } } });

    await internal.onReady();

    expect(stub.objects.get(INSTANCE_ID)?.common?.supportedMessages).toBeNull();
    expect(webServer.start).not.toHaveBeenCalled();
  });

  it("leaves the key alone once it has been cleared (no restart loop)", async () => {
    const { internal, stub, webServer } = setup();
    stub.objects.set(INSTANCE_ID, { type: "instance", common: { supportedMessages: null } });

    await internal.onReady();

    expect(webServer.start).toHaveBeenCalledTimes(1);
    expect(logsOf(stub, "info").some(m => m.includes("restarts once"))).toBe(false);
  });

  it("leaves a healthy instance object alone and starts normally", async () => {
    const { internal, stub, webServer } = setup();
    stub.objects.set(INSTANCE_ID, { type: "instance", common: { name: "hassemu" } });

    await internal.onReady();

    expect(stub.objects.get(INSTANCE_ID)?.common).toEqual({ name: "hassemu" });
    expect(webServer.start).toHaveBeenCalledTimes(1);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: true, ack: true });
  });
});
