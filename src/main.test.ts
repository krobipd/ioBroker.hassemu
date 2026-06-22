/**
 * Orchestration tests for main.ts — lifecycle, migrations, stale-GC, master
 * switch, state-dispatch. Uses the fleet harness pattern: @iobroker/adapter-core
 * is mocked with a stub Adapter class (no js-controller), the factory seams
 * (makeWebServer/makeMdnsService/makeUrlDiscovery) are overridden with fakes,
 * while ClientRegistry/GlobalConfig run for real against the stub object store.
 */

vi.mock("@iobroker/adapter-core", () => {
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

    log = {
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

    async setState(id: string, state: { val: unknown; ack?: boolean }): Promise<void> {
      this.states.set(this.fullId(id), { val: state.val, ack: state.ack ?? false });
    }

    async setStateAsync(id: string, state: { val: unknown; ack?: boolean }): Promise<void> {
      this.states.set(this.fullId(id), { val: state.val, ack: state.ack ?? false });
    }

    async getStateAsync(id: string): Promise<{ val: unknown; ack: boolean } | null> {
      return this.states.get(this.fullId(id)) ?? null;
    }

    async getObjectAsync(id: string): Promise<ObjEntry | null> {
      return this.objects.get(this.fullId(id)) ?? null;
    }

    async setObjectAsync(id: string, obj: ObjEntry): Promise<void> {
      this.objects.set(this.fullId(id), obj);
    }

    async setObjectNotExistsAsync(id: string, obj: ObjEntry): Promise<void> {
      const full = this.fullId(id);
      if (!this.objects.has(full)) {
        this.objects.set(full, obj);
      }
    }

    async extendObjectAsync(id: string, obj: Partial<ObjEntry>, options?: Record<string, unknown>): Promise<void> {
      const full = this.fullId(id);
      const existing = this.objects.get(full) ?? { type: "state" };
      const preserve = (options?.preserve as { common?: string[] } | undefined)?.common ?? [];
      const mergedCommon: Record<string, unknown> = { ...(existing.common ?? {}), ...(obj.common ?? {}) };
      for (const field of preserve) {
        if (existing.common?.[field] !== undefined) {
          mergedCommon[field] = existing.common[field];
        }
      }
      this.objects.set(full, {
        ...existing,
        ...obj,
        common: mergedCommon,
        native: { ...(existing.native ?? {}), ...(obj.native ?? {}) },
      });
    }

    async delObjectAsync(id: string, _options?: { recursive?: boolean }): Promise<void> {
      const full = this.fullId(id);
      this.objects.delete(full);
      for (const k of [...this.objects.keys()]) {
        if (k.startsWith(`${full}.`)) {
          this.objects.delete(k);
        }
      }
      for (const k of [...this.states.keys()]) {
        if (k === full || k.startsWith(`${full}.`)) {
          this.states.delete(k);
        }
      }
    }

    async getForeignObjectAsync(id: string): Promise<ObjEntry | null> {
      return this.objects.get(id) ?? null;
    }

    async setForeignObjectAsync(id: string, obj: ObjEntry): Promise<void> {
      this.objects.set(id, obj);
    }

    async getForeignObjectsAsync(pattern: string, type?: string): Promise<Record<string, ObjEntry>> {
      const prefix = pattern.replace("*", "");
      const out: Record<string, ObjEntry> = {};
      for (const [id, obj] of this.objects) {
        if (id.startsWith(prefix) && (!type || obj.type === type)) {
          out[id] = obj;
        }
      }
      return out;
    }

    async subscribeStatesAsync(pattern: string): Promise<void> {
      this.stateSubscriptions.push(pattern);
    }

    async subscribeForeignObjectsAsync(pattern: string): Promise<void> {
      this.objectSubscriptions.push(pattern);
    }

    async unsubscribeStatesAsync(pattern: string): Promise<void> {
      this.stateUnsubscriptions.push(pattern);
    }

    async unsubscribeForeignObjectsAsync(pattern: string): Promise<void> {
      this.objectUnsubscriptions.push(pattern);
    }

    setInterval(_cb: () => void, _ms: number): object {
      return {};
    }

    clearInterval(_handle: unknown): void {}

    setTimeout(_cb: () => void, _ms: number): object {
      return {};
    }

    clearTimeout(_handle: unknown): void {}

    terminate(code?: number): void {
      this.terminations.push(code ?? 0);
    }
  }

  return {
    Adapter: StubAdapter,
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: vi.fn((key: string) => ({ en: key })),
      translate: vi.fn((key: string) => key),
    },
  };
});

import { HassEmu } from "./main";
import type { ClientRegistry } from "./lib/client-registry";
import type { GlobalConfig } from "./lib/global-config";
import { MODE_GLOBAL, MODE_MANUAL } from "./lib/constants";

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
  setStateAsync: (id: string, state: { val: unknown; ack?: boolean }) => Promise<void>;
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
  migrateLegacyDefaultVisUrl: () => Promise<void>;
  migrateVisUrlToMode: () => Promise<void>;
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
}

const BASE_CONFIG = {
  port: 8123,
  bindAddress: "127.0.0.1",
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
  return { start: vi.fn(), stop: vi.fn(), isActive: () => active };
}

function makeFakeDiscovery(): FakeDiscovery {
  return { collect: vi.fn(async () => ({})), scheduleRefresh: vi.fn(), cancelRefresh: vi.fn() };
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

describe("HassEmu onReady", () => {
  it("happy path: I18n init, migrations, webserver started, subscriptions, connection=true", async () => {
    const { internal, stub, webServer, discovery } = setup();
    await internal.onReady();

    expect(webServer.start).toHaveBeenCalledTimes(1);
    expect(discovery.collect).toHaveBeenCalledTimes(1);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: true, ack: true });
    expect(stub.stateSubscriptions).toEqual(["clients.*", "global.*", "info.refresh_urls"]);
    expect(stub.objectSubscriptions).toEqual(["system.adapter.*"]);
    expect(logsOf(stub, "info").some(m => m.includes("HA emulation running on 127.0.0.1:8123"))).toBe(true);
    expect(stub.terminations).toEqual([]);
    expect(logsOf(stub, "error")).toEqual([]);
  });

  it("starts the web server BEFORE creating subscriptions (D11 v1.13.0)", async () => {
    const { internal, stub, webServer } = setup();
    let subscribedWhenStarted = false;
    webServer.start.mockImplementation(async () => {
      subscribedWhenStarted = stub.stateSubscriptions.length > 0;
    });
    await internal.onReady();
    expect(subscribedWhenStarted).toBe(false);
    expect(stub.stateSubscriptions.length).toBeGreaterThan(0);
  });

  it("webserver start failure → terminate(11), no subscriptions, no connection=true", async () => {
    const { internal, stub, webServer } = setup();
    webServer.start.mockRejectedValue(new Error("EADDRINUSE"));
    await internal.onReady();

    expect(stub.terminations).toEqual([11]);
    expect(stub.stateSubscriptions).toEqual([]);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
    expect(logsOf(stub, "error").some(m => m.includes("Web server failed to start"))).toBe(true);
  });

  it("mdnsEnabled=true + active mDNS → 'mDNS active' suffix in the running log", async () => {
    const { internal, stub, mdns } = setup({ mdnsEnabled: true });
    await internal.onReady();
    expect(mdns.start).toHaveBeenCalledTimes(1);
    expect(logsOf(stub, "info").some(m => m.endsWith(", mDNS active"))).toBe(true);
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

  it("catches unexpected errors and logs onReady failed (no throw)", async () => {
    const { internal, stub } = setup();
    internal.makeGlobalConfig = () => {
      throw new Error("boom in factory");
    };
    await internal.onReady();
    expect(logsOf(stub, "error").some(m => m.includes("onReady failed"))).toBe(true);
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
    const original = stub.setStateAsync.bind(stub);
    stub.setStateAsync = async (id, state) => {
      if (id.includes("serverUuid")) {
        throw new Error("write refused");
      }
      return original(id, state);
    };
    const uuid = await internal.getOrCreateServerUuid();
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(logsOf(stub, "warn").some(m => m.includes("Could not save server UUID"))).toBe(true);
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
    await internal.globalConfig!.handleEnabledWrite(true);
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
    await internal.migrateLegacyDefaultVisUrl();
    expect(stub.states.has("hassemu.0.global.visUrl")).toBe(false);
  });

  it("safe legacy URL → written to global.visUrl + native keys dropped", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.defaultVisUrl = "http://legacy.local/vis";
    seedInstanceNative(stub, { defaultVisUrl: "http://legacy.local/vis", other: "stays" });

    await internal.migrateLegacyDefaultVisUrl();

    expect(stub.states.get("hassemu.0.global.visUrl")).toEqual({ val: "http://legacy.local/vis", ack: true });
    const native = stub.objects.get("system.adapter.hassemu.0")!.native!;
    expect(native.defaultVisUrl).toBeUndefined();
    expect(native.visUrl).toBeUndefined();
    expect(native.other).toBe("stays");
  });

  it("unsafe legacy URL → warn, NOT written, native still cleaned", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.defaultVisUrl = "javascript:alert(1)";
    seedInstanceNative(stub, { defaultVisUrl: "javascript:alert(1)" });

    await internal.migrateLegacyDefaultVisUrl();

    expect(stub.states.has("hassemu.0.global.visUrl")).toBe(false);
    expect(logsOf(stub, "warn").some(m => m.includes("rejected as unsafe"))).toBe(true);
    expect(stub.objects.get("system.adapter.hassemu.0")!.native!.defaultVisUrl).toBeUndefined();
  });

  it("global.visUrl write fails → falls back to globalConfig.migrationSet (URL not lost)", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.visUrl = "http://fallback.local/";
    seedInstanceNative(stub, { visUrl: "http://fallback.local/" });
    const original = stub.setStateAsync.bind(stub);
    stub.setStateAsync = async (id, state) => {
      if (id === "global.visUrl") {
        throw new Error("object gone in v1.2.0+");
      }
      return original(id, state);
    };

    await internal.migrateLegacyDefaultVisUrl();

    // Fallback wrote straight to the migration target.
    expect(stub.states.get("hassemu.0.global.mode")).toEqual({ val: MODE_MANUAL, ack: true });
    expect(stub.states.get("hassemu.0.global.manualUrl")).toEqual({ val: "http://fallback.local/", ack: true });
    // Native was cleaned because the value is safely persisted.
    expect(stub.objects.get("system.adapter.hassemu.0")!.native!.visUrl).toBeUndefined();
  });

  it("BOTH write paths fail → native values preserved as recovery anchor + warn", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    stub.config.visUrl = "http://precious.local/";
    seedInstanceNative(stub, { visUrl: "http://precious.local/" });
    stub.setStateAsync = async () => {
      throw new Error("broker down");
    };

    await internal.migrateLegacyDefaultVisUrl();

    expect(logsOf(stub, "warn").some(m => m.includes("Legacy URL preserved"))).toBe(true);
    // The recovery anchor MUST survive — this is the data-loss guard.
    expect(stub.objects.get("system.adapter.hassemu.0")!.native!.visUrl).toBe("http://precious.local/");
  });
});

describe("migrateVisUrlToMode", () => {
  it("global legacy visUrl (safe) → migrationSet(manual, url) + legacy object dropped", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    stub.states.set("hassemu.0.global.visUrl", { val: "http://old.local/vis", ack: true });
    stub.objects.set("hassemu.0.global.visUrl", { type: "state" });

    await internal.migrateVisUrlToMode();

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

    await internal.migrateVisUrlToMode();

    expect(stub.states.get("hassemu.0.global.mode")).toEqual({ val: MODE_MANUAL, ack: true });
    expect(stub.states.get("hassemu.0.global.manualUrl")).toEqual({ val: "", ack: true });
    expect(logsOf(stub, "warn").some(m => m.includes("rejected as unsafe"))).toBe(true);
  });

  it("per-client legacy visUrl (safe) → mode='manual' + manualUrl + visUrl object dropped", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    const rec = await internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    stub.states.set(`hassemu.0.clients.${rec.id}.visUrl`, { val: "http://client-old.local/", ack: true });
    stub.objects.set(`hassemu.0.clients.${rec.id}.visUrl`, { type: "state" });

    await internal.migrateVisUrlToMode();

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
    const rec = await internal.registry!.identifyOrCreate(null, "10.0.0.2", null);
    const modeBefore = rec.mode;
    stub.states.set(`hassemu.0.clients.${rec.id}.visUrl`, { val: "data:text/html,x", ack: true });

    await internal.migrateVisUrlToMode();

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
    const original = stub.setStateAsync.bind(stub);
    stub.setStateAsync = async (id, state) => {
      if (id === "global.mode" || id === "global.manualUrl") {
        throw new Error("broker down");
      }
      return original(id, state);
    };

    await internal.migrateVisUrlToMode();

    // The legacy source MUST survive as a recovery anchor — never deleted on a write-fail.
    expect(stub.objects.has("hassemu.0.global.visUrl")).toBe(true);
    expect(logsOf(stub, "warn").some(m => m.includes("global.visUrl preserved"))).toBe(true);
  });

  it("per-client migration write fails → legacy clients.<id>.visUrl object preserved + warn (v1.36.0 C5)", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    const rec = await internal.registry!.identifyOrCreate(null, "10.0.0.3", null);
    stub.states.set(`hassemu.0.clients.${rec.id}.visUrl`, { val: "http://client-old.local/", ack: true });
    stub.objects.set(`hassemu.0.clients.${rec.id}.visUrl`, { type: "state" });
    const original = stub.setStateAsync.bind(stub);
    stub.setStateAsync = async (id, state) => {
      if (id === `clients.${rec.id}.mode` || id === `clients.${rec.id}.manualUrl`) {
        throw new Error("broker down");
      }
      return original(id, state);
    };

    await internal.migrateVisUrlToMode();

    expect(stub.objects.has(`hassemu.0.clients.${rec.id}.visUrl`)).toBe(true);
    expect(logsOf(stub, "warn").some(m => m.includes("visUrl preserved"))).toBe(true);
  });

  it("idempotent: nothing to migrate → no state writes, no logs above debug", async () => {
    const { internal, stub } = setup();
    internal.globalConfig = internal.makeGlobalConfig();
    internal.registry = internal.makeRegistry();
    await internal.migrateVisUrlToMode();
    expect(stub.states.has("hassemu.0.global.mode")).toBe(false);
    expect(logsOf(stub, "warn")).toEqual([]);
    expect(logsOf(stub, "info")).toEqual([]);
  });
});

describe("gcStaleClients", () => {
  /** Creates a client; tests then overwrite the lastSeen that touchLastSeen just seeded. */
  async function seedClient(internal: Internal, ip: string): Promise<string> {
    const rec = await internal.registry!.identifyOrCreate(null, ip, null);
    return rec.id;
  }

  it("client without lastSeen gets seeded, not removed", async () => {
    const { internal, stub } = setup();
    internal.registry = internal.makeRegistry();
    const id = await seedClient(internal, "10.0.0.1");
    // Wipe the lastSeen that identifyOrCreate just seeded.
    const channel = stub.objects.get(`hassemu.0.clients.${id}`)!;
    delete channel.native!.lastSeen;

    await internal.gcStaleClients();

    expect(internal.registry!.getById(id)).not.toBeNull();
    expect(typeof stub.objects.get(`hassemu.0.clients.${id}`)!.native!.lastSeen).toBe("number");
  });

  it("stale client (lastSeen older than 30d) is removed with an info log", async () => {
    const { internal, stub } = setup();
    internal.registry = internal.makeRegistry();
    const id = await seedClient(internal, "10.0.0.2");
    stub.objects.get(`hassemu.0.clients.${id}`)!.native!.lastSeen = Date.now() - 31 * 24 * 60 * 60 * 1000;

    await internal.gcStaleClients();

    expect(internal.registry!.getById(id)).toBeNull();
    expect(stub.objects.has(`hassemu.0.clients.${id}`)).toBe(false);
    expect(logsOf(stub, "info").some(m => m.includes("Removed 1 inactive client"))).toBe(true);
  });

  it("fresh client is kept", async () => {
    const { internal, stub } = setup();
    internal.registry = internal.makeRegistry();
    const id = await seedClient(internal, "10.0.0.3");
    stub.objects.get(`hassemu.0.clients.${id}`)!.native!.lastSeen = Date.now() - 1000;

    await internal.gcStaleClients();

    expect(internal.registry!.getById(id)).not.toBeNull();
    expect(logsOf(stub, "info").some(m => m.includes("Removed"))).toBe(false);
  });

  it("a getObject failure for one client does not abort the GC pass", async () => {
    const { internal, stub } = setup();
    internal.registry = internal.makeRegistry();
    const idBroken = await seedClient(internal, "10.0.0.4");
    const idStale = await seedClient(internal, "10.0.0.5");
    stub.objects.get(`hassemu.0.clients.${idStale}`)!.native!.lastSeen = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const adapter = internal as unknown as { getObjectAsync: (id: string) => Promise<unknown> };
    const original = adapter.getObjectAsync.bind(adapter);
    adapter.getObjectAsync = async (id: string) => {
      if (id.includes(idBroken)) {
        throw new Error("broker hiccup");
      }
      return original(id);
    };

    await internal.gcStaleClients();

    expect(internal.registry!.getById(idBroken)).not.toBeNull();
    expect(internal.registry!.getById(idStale)).toBeNull();
  });
});

describe("applyMasterSwitch", () => {
  it("enabled=true → every client follows 'global'", async () => {
    const { internal } = setup();
    internal.registry = internal.makeRegistry();
    const a = await internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    const b = await internal.registry!.identifyOrCreate(null, "10.0.0.2", null);
    a.mode = "http://somewhere/";
    b.mode = "";

    await internal.applyMasterSwitch(true);

    expect(a.mode).toBe(MODE_GLOBAL);
    expect(b.mode).toBe(MODE_GLOBAL);
  });

  it("enabled=false → every client drops to '0' (no-choice → landing page)", async () => {
    const { internal } = setup();
    internal.registry = internal.makeRegistry();
    const a = await internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    a.mode = MODE_GLOBAL;

    await internal.applyMasterSwitch(false);

    expect(a.mode).toBe("0");
  });

  it("is a safe no-op without a registry", async () => {
    const { internal } = setup();
    internal.registry = null;
    await internal.applyMasterSwitch(true);
  });
});

describe("onStateChange routing", () => {
  async function readySetup(): Promise<Setup> {
    const s = setup();
    s.internal.registry = s.internal.makeRegistry();
    s.internal.globalConfig = s.internal.makeGlobalConfig();
    s.internal.urlDiscovery = s.discovery;
    return s;
  }

  it("ignores acked states and null states", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    rec.mode = "http://keep/";
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: MODE_MANUAL, ack: true });
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, null);
    expect(rec.mode).toBe("http://keep/");
  });

  it("routes clients.<id>.mode writes to handleModeWrite", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: "http://picked.local/", ack: false });
    expect(rec.mode).toBe("http://picked.local/");
  });

  it("warns once when mode='global' but global has no resolvable URL (B4)", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: MODE_GLOBAL, ack: false });
    expect(logsOf(s.stub, "warn").some(m => m.includes("global has no resolvable URL"))).toBe(true);
  });

  it("no B4 warning when global resolves to a URL", async () => {
    const s = await readySetup();
    await s.internal.globalConfig!.handleModeWrite("http://global.local/");
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.mode`, { val: MODE_GLOBAL, ack: false });
    expect(logsOf(s.stub, "warn").some(m => m.includes("global has no resolvable URL"))).toBe(false);
  });

  it("routes clients.<id>.manualUrl writes to handleManualUrlWrite", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.manualUrl`, { val: "http://manual.local/", ack: false });
    expect(rec.manualUrl).toBe("http://manual.local/");
  });

  it("remove button (val=true) forgets the client", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.remove`, { val: true, ack: false });
    expect(s.internal.registry!.getById(rec.id)).toBeNull();
  });

  it("remove button with val=false does nothing", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    await s.internal.onStateChange(`hassemu.0.clients.${rec.id}.remove`, { val: false, ack: false });
    expect(s.internal.registry!.getById(rec.id)).not.toBeNull();
  });

  it("routes global.mode / global.manualUrl writes", async () => {
    const s = await readySetup();
    await s.internal.onStateChange("hassemu.0.global.manualUrl", { val: "http://gm.local/", ack: false });
    await s.internal.onStateChange("hassemu.0.global.mode", { val: MODE_MANUAL, ack: false });
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    rec.mode = MODE_GLOBAL;
    expect(s.internal.globalConfig!.resolveUrlFor(rec)).toBe("http://gm.local/");
  });

  it("global.enabled write persists AND bulk-syncs all client modes", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    rec.mode = "";

    await s.internal.onStateChange("hassemu.0.global.enabled", { val: true, ack: false });

    expect(s.internal.globalConfig!.isEnabled()).toBe(true);
    expect(rec.mode).toBe(MODE_GLOBAL);

    await s.internal.onStateChange("hassemu.0.global.enabled", { val: false, ack: false });
    expect(rec.mode).toBe("0");
  });

  it("info.refresh_urls=true triggers an immediate collect and re-arms the button", async () => {
    const s = await readySetup();
    await s.internal.onStateChange("hassemu.0.info.refresh_urls", { val: true, ack: false });
    expect(s.discovery.collect).toHaveBeenCalledTimes(1);
    expect(s.stub.states.get("hassemu.0.info.refresh_urls")).toEqual({ val: false, ack: true });
    expect(logsOf(s.stub, "info").some(m => m.includes("URL list refreshed"))).toBe(true);
  });

  it("refresh button: collect failure warns but still re-arms the button", async () => {
    const s = await readySetup();
    s.discovery.collect.mockRejectedValue(new Error("discovery broke"));
    await s.internal.onStateChange("hassemu.0.info.refresh_urls", { val: true, ack: false });
    expect(logsOf(s.stub, "warn").some(m => m.includes("URL refresh failed"))).toBe(true);
    expect(s.stub.states.get("hassemu.0.info.refresh_urls")).toEqual({ val: false, ack: true });
  });

  it("refresh button is a no-op before urlDiscovery exists", async () => {
    const s = await readySetup();
    s.internal.urlDiscovery = null;
    await s.internal.onStateChange("hassemu.0.info.refresh_urls", { val: true, ack: false });
    expect(s.discovery.collect).not.toHaveBeenCalled();
  });

  it("handler errors are caught and logged, never thrown", async () => {
    const s = await readySetup();
    const rec = await s.internal.registry!.identifyOrCreate(null, "10.0.0.1", null);
    s.internal.registry!.handleModeWrite = async () => {
      throw new Error("handler exploded");
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
    expect(discovery.scheduleRefresh).not.toHaveBeenCalled();
  });
});

describe("onUnload", () => {
  it("tears everything down and always calls the callback", () => {
    const { internal, stub, webServer, mdns, discovery } = setup();
    internal.webServer = webServer;
    internal.mdnsService = mdns;
    internal.urlDiscovery = discovery;
    internal.registry = internal.makeRegistry();
    internal.globalConfig = internal.makeGlobalConfig();
    const callback = vi.fn();

    internal.onUnload(callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(stub.states.get("hassemu.0.info.connection")).toEqual({ val: false, ack: true });
    expect(webServer.stop).toHaveBeenCalledTimes(1);
    expect(mdns.stop).toHaveBeenCalledTimes(1);
    expect(discovery.cancelRefresh).toHaveBeenCalledTimes(1);
    expect(stub.stateUnsubscriptions).toEqual(["clients.*", "global.*", "info.refresh_urls"]);
    expect(stub.objectUnsubscriptions).toEqual(["system.adapter.*"]);
    expect(internal.webServer).toBeNull();
    expect(internal.mdnsService).toBeNull();
    expect(internal.registry).toBeNull();
    expect(internal.globalConfig).toBeNull();
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

  it("is safe on a half-initialized adapter (everything null)", () => {
    const { internal } = setup();
    const callback = vi.fn();
    internal.onUnload(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
