import crypto from "node:crypto";
import type { EventEmitter } from "node:events";
import type BonjourModule from "bonjour-service";

// The REAL bonjour-service runs (I23, below); the subclass only notes the options each
// instance is built with — the socket the announcement goes out on (R-20). With `wire.on` it also takes the place of
// multicast-dns's `send` before hassemu wraps it: every message an instance would put on the air lands in `wire.sent`
// instead, as hassemu's record filter left it (D17).
const { builtWith, wire } = vi.hoisted(() => ({
  builtWith: [] as unknown[],
  wire: { on: false, sent: [] as Array<{ socket: unknown; packet: unknown }> },
}));
vi.mock("bonjour-service", async importOriginal => {
  // bonjour-service is `export =`: the class is the module, vitest hands it over as `default`
  const real = await importOriginal<{ default: typeof BonjourModule }>();
  class Noting extends real.default {
    constructor(...args: ConstructorParameters<typeof real.default>) {
      builtWith.push(args[0]);
      super(...args);
      if (wire.on) {
        const socket = args[0];
        const mdns = (this as unknown as { server: { mdns: { send: unknown } } }).server.mdns;
        mdns.send = (packet: unknown, rinfo: unknown, cb?: () => void): void => {
          wire.sent.push({ socket, packet });
          (typeof rinfo === "function" ? (rinfo as () => void) : cb)?.();
        };
      }
    }
  }
  return { ...real, default: Noting };
});
import { announcements, keepInterfaceRecords, MDNSService, mdnsSocketOptions } from "./mdns";
import { HA_VERSION } from "./constants";
import { announceableNets, localNets, type LocalNet } from "./network-address";
import type { AdapterConfig } from "./types";

/**
 * One network of the host, as the fleet master `localNets` reports it.
 *
 * @param address The host's address in it.
 * @param iface   The interface name.
 */
function net(address: string, iface = "eth0"): LocalNet {
  return {
    iface,
    family: address.includes(":") ? "IPv6" : "IPv4",
    address,
    prefixLength: address.includes(":") ? 64 : 24,
  };
}

/** The loopback network as the fleet master lists it since round 182 — `internal`, no device sits in it. */
const LOOPBACK: LocalNet = { iface: "lo0", family: "IPv4", address: "127.0.0.1", prefixLength: 8, internal: true };

/**
 * One real IPv4 network of the machine the test runs on — the tests that drive the real bonjour-service judge ONE
 * announcement. Without it they announce on every network of the runner: a Windows runner of the CI holds two and
 * armed two fallback timers (measured 2026-11-15, run 43668057728).
 */
const ONE_NET = (): LocalNet[] =>
  announceableNets(localNets())
    .filter(n => n.family === "IPv4")
    .slice(0, 1);

/** The announcements on the air — `{bonjour, published}` each. */
type Internals = {
  announced: Array<{ bonjour: { destroy(): void } | null; published: unknown }>;
};

interface LogEntry {
  level: string;
  msg: string;
}

interface MockAdapter {
  log: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  _logs: LogEntry[];
  // Records managed-timer arming without scheduling (I1: assert the shutdown
  // path skips it). Returns a dummy handle; the callback is never invoked.
  setTimeout: (cb: () => void, ms: number) => unknown;
  _timerCalls: number[];
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Live interval handles with their callbacks — a test can fire one by hand. */
  _intervals: Map<object, { cb: () => void; ms: number }>;
}

// Mock adapter for testing
function createMockAdapter(): MockAdapter {
  const logs: LogEntry[] = [];
  const timerCalls: number[] = [];
  const intervals = new Map<object, { cb: () => void; ms: number }>();
  return {
    log: {
      debug: (msg: string): void => {
        logs.push({ level: "debug", msg });
      },
      info: (msg: string): void => {
        logs.push({ level: "info", msg });
      },
      warn: (msg: string): void => {
        logs.push({ level: "warn", msg });
      },
      error: (msg: string): void => {
        logs.push({ level: "error", msg });
      },
    },
    _logs: logs,
    setTimeout: (_cb: () => void, ms: number): unknown => {
      timerCalls.push(ms);
      return undefined;
    },
    _timerCalls: timerCalls,
    setInterval: (cb: () => void, ms: number): unknown => {
      const handle = {};
      intervals.set(handle, { cb, ms });
      return handle;
    },
    clearInterval: (handle: unknown): void => {
      intervals.delete(handle as object);
    },
    _intervals: intervals,
  };
}

// I23 (v1.37.0): these tests deliberately drive the REAL bonjour-service (an actual
// UDP announce/stop), not a mock. That verifies the observable mDNS behaviour rather
// than just "MDNSService called a stub", and has been green since v1.0 across
// platforms. A bonjour mock would lower fidelity for a flake risk that has not
// materialised — kept as a real-integration lifecycle test on purpose.
describe("MDNSService", () => {
  let service: MDNSService;
  let adapter: MockAdapter;
  const config: AdapterConfig = {
    port: 8123,
    bind: "0.0.0.0",
    authRequired: false,
    username: "admin",
    password: "secret",
    mdnsEnabled: true,
    serviceName: "TestService",
  };

  beforeEach(() => {
    adapter = createMockAdapter();
    service = new MDNSService(adapter as never, config, crypto.randomUUID(), undefined, ONE_NET);
  });

  afterEach(async () => {
    await service.stop();
  });

  describe("constructor", () => {
    it("should not be active initially", () => {
      expect(service.isActive()).to.be.false;
    });
  });

  describe("start/stop lifecycle", () => {
    it("should not throw on start", () => {
      expect(() => service.start()).to.not.throw();
    });

    it("should be active after start", () => {
      service.start();
      expect(service.isActive()).to.be.true;
    });

    it("should log debug on start", () => {
      service.start();
      const debugLogs = adapter._logs.filter(l => l.level === "debug");
      const broadcastLog = debugLogs.find(l => l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog).to.not.be.undefined;
      expect(broadcastLog!.msg).to.include("TestService");
    });

    it("should include port in start log", () => {
      service.start();
      const debugLogs = adapter._logs.filter(l => l.level === "debug");
      const broadcastLog = debugLogs.find(l => l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog!.msg).to.include("8123");
    });

    it("should not be active after stop", async () => {
      service.start();
      expect(service.isActive()).to.be.true;
      await service.stop();
      expect(service.isActive()).to.be.false;
    });

    it("should handle stop when not active", () => {
      expect(service.isActive()).to.be.false;
      expect(() => service.stop()).to.not.throw();
    });

    it("should handle multiple stop calls", async () => {
      service.start();
      await service.stop();
      await expect(service.stop()).resolves.toBeUndefined();
    });

    it("should handle start-stop-start cycle", async () => {
      service.start();
      expect(service.isActive()).to.be.true;
      await service.stop();
      expect(service.isActive()).to.be.false;
      service.start();
      expect(service.isActive()).to.be.true;
    });
  });

  describe("stop() fallback-timer semantics (I1)", () => {
    it("synchronous stop (onUnload) skips the managed fallback timer", async () => {
      service.start();
      expect(service.isActive()).to.be.true;
      await service.stop(true);
      expect(service.isActive()).to.be.false;
      // No managed timer armed → adapter-core cannot warn during shutdown.
      expect(adapter._timerCalls).to.have.lengthOf(0);
      expect(adapter._logs.some(l => l.level === "debug" && l.msg.includes("Service stopped"))).to.be.true;
    });

    it("runtime stop (onReady re-init) arms a single 300 ms fallback timer", async () => {
      service.start();
      await service.stop(false);
      expect(adapter._timerCalls).to.deep.equal([300]);
    });

    it("stop on a service that was never started does nothing at all", async () => {
      // Not even a log line: "Service stopped" for a service that never ran is
      // a false trail when someone reads the log after an mDNS problem.
      expect(service.isActive()).to.be.false;
      await service.stop(false);
      expect(adapter._timerCalls).to.have.lengthOf(0);
      expect(adapter._logs.some(l => l.msg.includes("Service stopped"))).to.be.false;
    });

    it("releases the mDNS sockets exactly once", async () => {
      service.start();
      let destroys = 0;
      // Both the stop-callback and the 300 ms fallback call destroy(); a second
      // destroy() on an already-closed bonjour instance throws inside the
      // library (it walks closed sockets).
      const internals = (service as unknown as Internals).announced[0];
      // The real instance start() opened is swapped for the counter — release its sockets here.
      const real = internals.bonjour;
      onTestFinished(() => real?.destroy());
      internals.bonjour = {
        destroy: () => {
          destroys++;
        },
      };
      const captured: Array<() => void> = [];
      adapter.setTimeout = (cb: () => void, ms: number): unknown => {
        adapter._timerCalls.push(ms);
        captured.push(cb);
        return undefined;
      };

      const stopped = service.stop(false);
      // The library calls the stop-callback asynchronously — let it land first,
      // then fire the fallback the way the runtime timer would.
      await new Promise(r => setTimeout(r, 50));
      captured.forEach(cb => cb());
      await stopped;
      expect(destroys).to.equal(1);
    });

    it("shutdown stop resolves only once the goodbye left and the sockets are released", async () => {
      // This promise is what keeps onUnload from reporting "done" while the goodbye
      // announcement is still in the socket — resolve too early and the host tears
      // the process down mid-farewell, which is the bug this release fixes.
      service.start();
      const internals = (service as unknown as Internals).announced[0];
      // The real instance start() opened is swapped for the fake — release its sockets here.
      const real = internals.bonjour;
      onTestFinished(() => real?.destroy());
      let destroyed = false;
      internals.bonjour = {
        destroy: () => {
          destroyed = true;
        },
      };
      let releaseGoodbye: () => void = () => {};
      internals.published = {
        stop: (cb: () => void) => {
          releaseGoodbye = cb;
        },
      };

      let resolved = false;
      const pending = service.stop(true).then(() => {
        resolved = true;
      });
      await new Promise(r => setImmediate(r));
      expect(resolved).to.be.false;
      expect(destroyed).to.be.false;
      // No fallback timer on this path — the awaited promise replaces it.
      expect(adapter._timerCalls).to.have.lengthOf(0);

      releaseGoodbye();
      await pending;
      expect(destroyed).to.be.true;
    });
  });

  describe("service name", () => {
    it("should use configured service name", () => {
      service.start();
      const debugLogs = adapter._logs.filter(l => l.level === "debug");
      const broadcastLog = debugLogs.find(l => l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog!.msg).to.include("TestService._home-assistant._tcp");
    });

    it("should use ioBroker as default service name", async () => {
      const defaultConfig: AdapterConfig = {
        ...config,
        serviceName: "",
      };
      const defaultService = new MDNSService(adapter as never, defaultConfig, crypto.randomUUID(), undefined, ONE_NET);
      defaultService.start();
      const debugLogs = adapter._logs.filter(l => l.level === "debug");
      const broadcastLog = debugLogs.find(l => l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog!.msg).to.include("ioBroker._home-assistant._tcp");
      await defaultService.stop();
    });
  });

  describe("advertised host (bind-aware base_url)", () => {
    it("advertises the configured concrete bind address (matches /api/discovery_info)", async () => {
      const boundConfig: AdapterConfig = { ...config, bind: "192.168.1.50" };
      // the host carries the chosen address — the start makes sure of that (DD 36)
      const boundService = new MDNSService(adapter as never, boundConfig, crypto.randomUUID(), null, () => [
        net("192.168.1.50"),
      ]);
      boundService.start();
      const broadcastLog = adapter._logs.find(l => l.level === "debug" && l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog!.msg).to.include("192.168.1.50:8123");
      await boundService.stop();
    });
  });
});

describe("MDNSService cross-platform", () => {
  it("should work without avahi (cross-platform)", async () => {
    // bonjour-service works on all platforms — no avahi needed
    const adapter = createMockAdapter();
    const service = new MDNSService(
      adapter as never,
      {
        port: 8123,
        bind: "0.0.0.0",
        authRequired: false,
        username: "",
        password: "",
        mdnsEnabled: true,
        serviceName: "CrossPlatformTest",
      },
      crypto.randomUUID(),
      undefined,
      ONE_NET,
    );

    service.start();
    expect(service.isActive()).to.be.true;

    // bonjour reports a socket failure asynchronously, as a warn — wait until the first
    // announcement went out (or failed) before judging the log.
    const published = (service as unknown as Internals).announced[0]?.published as EventEmitter | undefined;
    expect(published).to.not.equal(undefined);
    await new Promise<void>(resolve => {
      published!.once("up", () => resolve());
      published!.once("error", () => resolve());
    });
    const problems = adapter._logs.filter(l => l.level === "warn" || l.level === "error");
    expect(problems).to.deep.equal([]);
    expect(service.isActive()).to.be.true;

    await service.stop();
    expect(service.isActive()).to.be.false;
  });

  describe("async error handling (J6 v1.25.0 — D12 v1.15.0 coverage)", () => {
    it("async publish error sets active=false and warns", async () => {
      const localAdapter = createMockAdapter();
      const localService = new MDNSService(
        localAdapter as never,
        {
          port: 8123,
          bind: "0.0.0.0",
          authRequired: false,
          username: "",
          password: "",
          mdnsEnabled: true,
          serviceName: "AsyncErrorTest",
        },
        crypto.randomUUID(),
        undefined,
        ONE_NET,
      );

      localService.start();
      expect(localService.isActive()).to.be.true;

      // Fire an async 'error' event on the published service object — bonjour-
      // service's Service extends EventEmitter, so .emit() is available.
      const published = (localService as unknown as Internals).announced[0]?.published as
        { emit?: (event: string, err: Error) => void } | undefined;
      published?.emit?.("error", new Error("mock dgram bind failure"));

      expect(localService.isActive()).to.be.false;
      const warns = localAdapter._logs.filter(l => l.level === "warn" && l.msg.includes("async publish error"));
      expect(warns).to.have.length(1);
      expect(warns[0].msg).to.include("mock dgram bind failure");

      await localService.stop();
    });
  });

  /** Wildcard bind, mDNS on — the configuration the three blocks below start from. */
  const MDNS_CONFIG: AdapterConfig = {
    port: 8123,
    bind: "0.0.0.0",
    authRequired: false,
    username: "admin",
    password: "secret",
    mdnsEnabled: true,
    serviceName: "TestService",
  };

  describe("the announced record (T5)", () => {
    it("publishes _home-assistant._tcp with the shared UUID and the base URL in TXT", async () => {
      const uuid = crypto.randomUUID();
      const local = new MDNSService(
        createMockAdapter() as never,
        { ...MDNS_CONFIG, bind: "192.168.1.5" },
        uuid,
        null,
        () => [net("192.168.1.5")],
      );
      local.start();
      try {
        const published = (local as unknown as Internals).announced[0].published as {
          type: string;
          port: number;
          name: string;
          txt: unknown;
        };
        expect(published.type).to.equal("_home-assistant._tcp");
        expect(published.port).to.equal(8123);
        expect(published.name).to.equal("TestService");
        expect(published.txt).to.deep.equal({
          base_url: "http://192.168.1.5:8123",
          internal_url: "http://192.168.1.5:8123",
          version: HA_VERSION,
          uuid,
          location_name: "TestService",
          requires_api_password: "False",
        });
      } finally {
        await local.stop();
      }
    });
  });

  describe("a changed address is announced again (H10)", () => {
    it("re-publishes with the new base_url and the same UUID; an unchanged address changes nothing", async () => {
      const localAdapter = createMockAdapter();
      let nets = [net("192.168.1.5")];
      const uuid = crypto.randomUUID();
      const local = new MDNSService(localAdapter as never, MDNS_CONFIG, uuid, undefined, () => nets);
      local.start();
      try {
        expect(localAdapter._intervals.size, "address check armed for a wildcard bind").to.equal(1);
        const internal = local as unknown as Internals;
        const txtOf = (): Record<string, string> =>
          (internal.announced[0].published as { txt: Record<string, string> }).txt;
        const first = internal.announced[0].published;

        await local.refreshIfAddressChanged();
        expect(internal.announced[0].published, "unchanged address — same announcement").to.equal(first);

        nets = [net("192.168.1.77")];
        await local.refreshIfAddressChanged();
        expect(txtOf().base_url).to.equal("http://192.168.1.77:8123");
        expect(txtOf().uuid).to.equal(uuid);
        expect(local.isActive()).to.be.true;
      } finally {
        await local.stop(true);
      }
      expect(localAdapter._intervals.size, "stop ends the address check").to.equal(0);
    });

    it("two address checks at the same time announce the new address once", async () => {
      let nets = [net("192.168.1.5")];
      const local = new MDNSService(
        createMockAdapter() as never,
        MDNS_CONFIG,
        crypto.randomUUID(),
        undefined,
        () => nets,
      );
      local.start();
      try {
        nets = [net("192.168.1.77")];
        await Promise.all([local.refreshIfAddressChanged(), local.refreshIfAddressChanged()]);
        expect((local as unknown as Internals).announced).to.have.lengthOf(1);
      } finally {
        await local.stop(true);
      }
    });

    it("a concrete bind address arms no address check", async () => {
      const localAdapter = createMockAdapter();
      const local = new MDNSService(
        localAdapter as never,
        { ...MDNS_CONFIG, bind: "192.168.1.5" },
        crypto.randomUUID(),
      );
      local.start();
      try {
        expect(localAdapter._intervals.size).to.equal(0);
      } finally {
        await local.stop();
      }
    });
  });

  it("an error event that carries a string still names it (H13)", async () => {
    const localAdapter = createMockAdapter();
    const local = new MDNSService(localAdapter as never, MDNS_CONFIG, crypto.randomUUID(), undefined, ONE_NET);
    local.start();
    ((local as unknown as Internals).announced[0].published as { emit: (e: string, v: unknown) => void }).emit(
      "error",
      "bind failed",
    );
    expect(localAdapter._logs.some(l => l.level === "warn" && l.msg === "mDNS async publish error: bind failed")).to.be
      .true;
    await local.stop();
  });
});

// The chosen address is the only one the adapter sends on (review 2026-11-07, R-20): the
// group is joined and the announcement sent on that interface; every address keeps
// bonjour's default (all interfaces).
describe("mdnsSocketOptions", () => {
  it("the announcement goes out on the socket of the effective bind", async () => {
    builtWith.length = 0;
    const local = new MDNSService(
      createMockAdapter() as never,
      {
        port: 8123,
        bind: "192.0.2.10",
        authRequired: false,
        username: "admin",
        password: "",
        mdnsEnabled: true,
        serviceName: "TestService",
      },
      crypto.randomUUID(),
      null,
      () => [net("192.0.2.10"), net("198.51.100.10", "eth1")],
    );
    local.start();
    await local.stop();
    expect(builtWith).to.deep.equal([{ interface: "192.0.2.10", bind: "0.0.0.0" }]);
  });

  it("sends on the chosen interface, the socket on every address", () => {
    expect(mdnsSocketOptions("192.0.2.10")).to.deep.equal({ interface: "192.0.2.10", bind: "0.0.0.0" });
  });

  it("every address keeps bonjour's default", () => {
    for (const bind of [undefined, "", "0.0.0.0", "::"]) {
      expect(mdnsSocketOptions(bind), `bind=${JSON.stringify(bind)}`).to.deep.equal({});
    }
  });
});

// The fleet rule (krobi 2026-11-11 19:34, master `ownAddressFor`): a display gets the host's address in its own network.
// An mDNS announcement reaches only the link it is sent on, so each own network gets its own, carrying its address.
describe("announcements — the address of the display's own network", () => {
  it("a chosen address: one announcement on its interface, with its address", () => {
    expect(announcements("192.0.2.10", 8123, null, [net("192.0.2.10"), net("198.51.100.10", "eth1")])).to.deep.equal([
      {
        socket: { interface: "192.0.2.10", bind: "0.0.0.0" },
        baseUrl: "http://192.0.2.10:8123",
        addresses: ["192.0.2.10"],
        probe: true,
      },
    ]);
  });

  it("every address with one network: one announcement from its interface naming its addresses, probed first", () => {
    expect(announcements("0.0.0.0", 8123, null, [net("fe80::1"), net("192.0.2.10")])).to.deep.equal([
      {
        socket: { interface: "192.0.2.10", bind: "0.0.0.0" },
        baseUrl: "http://192.0.2.10:8123",
        addresses: ["fe80::1", "192.0.2.10"],
        probe: true,
      },
    ]);
  });

  it("every address with several networks: one per IPv4 network from its interface, without the probe", () => {
    expect(
      announcements("", 8123, null, [net("fd00::5"), net("192.0.2.10"), net("198.51.100.10", "docker0")]),
    ).to.deep.equal([
      {
        socket: { interface: "192.0.2.10", bind: "0.0.0.0" },
        baseUrl: "http://192.0.2.10:8123",
        addresses: ["fd00::5", "192.0.2.10"],
        probe: false,
      },
      {
        socket: { interface: "198.51.100.10", bind: "0.0.0.0" },
        baseUrl: "http://198.51.100.10:8123",
        addresses: ["198.51.100.10"],
        probe: false,
      },
    ]);
  });

  it("without a chosen address what the fleet master leaves out neither sends nor is named (master `blockedAddress`)", () => {
    // IPv4 link-local beside another IPv4 of its interface, a 6to4 address, loopback
    expect(
      announcements("", 8123, null, [LOOPBACK, net("169.254.3.4"), net("192.0.2.10"), net("2002:c000:204::1")]),
    ).to.deep.equal([
      {
        socket: { interface: "192.0.2.10", bind: "0.0.0.0" },
        baseUrl: "http://192.0.2.10:8123",
        addresses: ["192.0.2.10"],
        probe: true,
      },
    ]);
  });

  it("a chosen address the host carries is the one announced, link-local and loopback included (round 182)", () => {
    expect(announcements("169.254.3.4", 8123, null, [net("169.254.3.4"), net("192.0.2.10")])).to.deep.equal([
      {
        socket: { interface: "169.254.3.4", bind: "0.0.0.0" },
        baseUrl: "http://169.254.3.4:8123",
        addresses: ["169.254.3.4", "192.0.2.10"],
        probe: true,
      },
    ]);
    expect(announcements("127.0.0.1", 8123, null, [LOOPBACK, net("192.0.2.10")])).to.deep.equal([
      {
        socket: { interface: "127.0.0.1", bind: "0.0.0.0" },
        baseUrl: "http://127.0.0.1:8123",
        addresses: ["127.0.0.1"],
        probe: true,
      },
    ]);
  });

  it("HTTPS with a certificate name: every network's announcement names the name (K4)", () => {
    expect(
      announcements(undefined, 8123, { name: "hassemu.example" }, [net("192.0.2.10"), net("198.51.100.10", "eth1")]),
    ).to.deep.equal([
      {
        socket: { interface: "192.0.2.10", bind: "0.0.0.0" },
        baseUrl: "https://hassemu.example:8123",
        addresses: ["192.0.2.10"],
        probe: false,
      },
      {
        socket: { interface: "198.51.100.10", bind: "0.0.0.0" },
        baseUrl: "https://hassemu.example:8123",
        addresses: ["198.51.100.10"],
        probe: false,
      },
    ]);
  });

  it("a host without an IPv4 network announces nothing — the mDNS socket is IPv4", () => {
    expect(announcements("::", 8123, null, [net("fe80::1"), net("2001:db8::5")])).to.deep.equal([]);
    expect(announcements("0.0.0.0", 8123, null, [])).to.deep.equal([]);
  });

  it("each network's announcement goes out on its own socket and carries its own address", async () => {
    builtWith.length = 0;
    const local = new MDNSService(
      createMockAdapter() as never,
      {
        port: 8123,
        bind: "0.0.0.0",
        authRequired: false,
        username: "admin",
        password: "",
        mdnsEnabled: true,
        serviceName: "TestService",
      },
      crypto.randomUUID(),
      null,
      () => [net("192.0.2.10"), net("198.51.100.10", "docker0")],
    );
    local.start();
    const bases = (local as unknown as Internals).announced.map(
      a => (a.published as { txt: Record<string, string> }).txt.base_url,
    );
    await local.stop();
    expect(builtWith).to.deep.equal([
      { interface: "192.0.2.10", bind: "0.0.0.0" },
      { interface: "198.51.100.10", bind: "0.0.0.0" },
    ]);
    expect(bases).to.deep.equal(["http://192.0.2.10:8123", "http://198.51.100.10:8123"]);
  });

  it("a socket error ends only its own announcement", async () => {
    const adapter = createMockAdapter();
    const local = new MDNSService(
      adapter as never,
      {
        port: 8123,
        bind: "0.0.0.0",
        authRequired: false,
        username: "",
        password: "",
        mdnsEnabled: true,
        serviceName: "TestService",
      },
      crypto.randomUUID(),
      null,
      () => [net("192.0.2.10"), net("198.51.100.10", "docker0")],
    );
    local.start();
    try {
      const internal = local as unknown as Internals;
      (internal.announced[0].published as { emit: (e: string, v: unknown) => void }).emit("error", "bind failed");
      expect(internal.announced).to.have.length(1);
      expect(local.isActive()).to.be.true;
    } finally {
      await local.stop();
    }
  });

  it("without a network nothing goes on the air, and the address check stays armed for one that comes", async () => {
    const adapter = createMockAdapter();
    let nets: LocalNet[] = [];
    const local = new MDNSService(
      adapter as never,
      {
        port: 8123,
        bind: "0.0.0.0",
        authRequired: false,
        username: "",
        password: "",
        mdnsEnabled: true,
        serviceName: "TestService",
      },
      crypto.randomUUID(),
      null,
      () => nets,
    );
    local.start();
    try {
      expect(local.isActive()).to.be.false;
      expect(adapter._logs.some(l => l.msg === "mDNS: this host sits in no IPv4 network — nothing to announce")).to.be
        .true;
      expect(adapter._intervals.size).to.equal(1);
      nets = [net("192.0.2.10")];
      await local.refreshIfAddressChanged();
      expect(local.isActive()).to.be.true;
    } finally {
      await local.stop();
    }
  });

  it("a stop during the goodbye of a refresh puts nothing back on the air", async () => {
    let nets = [net("192.0.2.10")];
    const local = new MDNSService(
      createMockAdapter() as never,
      {
        port: 8123,
        bind: "0.0.0.0",
        authRequired: false,
        username: "",
        password: "",
        mdnsEnabled: true,
        serviceName: "TestService",
      },
      crypto.randomUUID(),
      null,
      () => nets,
    );
    local.start();
    nets = [net("198.51.100.10")];
    const refresh = local.refreshIfAddressChanged();
    await local.stop();
    await refresh;
    expect(local.isActive()).to.be.false;
  });
});

// Werkbank standard D17 (round 180; RFC 6762 §6.2): an announcement names in its A/AAAA records only the addresses of
// the interface it goes out on. bonjour-service 1.4.4 builds them from every interface of the host, so hassemu hands
// them over at multicast-dns's `send`, which every message of an instance leaves through.
describe("the address records of an announcement — only those of its interface (D17)", () => {
  /**
   * A DNS record as bonjour builds it.
   *
   * @param type The record type.
   * @param data The record data.
   */
  const record = (type: string, data: unknown): { name: string; type: string; ttl: number; data: unknown } => ({
    name: type === "A" || type === "AAAA" ? "host.local" : "TestService._home-assistant._tcp.local",
    type,
    ttl: 120,
    data,
  });

  it("a message keeps only the A/AAAA records of the given addresses; every other record and the callback pass", () => {
    const calls: unknown[][] = [];
    const fake = { server: { mdns: { send: (...args: unknown[]): void => void calls.push(args) } } };
    expect(keepInterfaceRecords(fake as never, ["192.0.2.10", "FE80::1%eth0"])).to.equal(true);
    const done = (): void => {};
    const ptr = record("PTR", "TestService._home-assistant._tcp.local");
    const srv = record("SRV", { port: 8123, target: "host.local" });
    fake.server.mdns.send(
      {
        type: "response",
        answers: [ptr, record("A", "192.0.2.10"), record("A", "198.51.100.10"), record("AAAA", "fe80::1")],
        additionals: [srv, record("AAAA", "fd00::5")],
      },
      null,
      done,
    );
    expect(calls).to.have.length(1);
    expect(calls[0][0]).to.deep.equal({
      type: "response",
      answers: [ptr, record("A", "192.0.2.10"), record("AAAA", "fe80::1")],
      additionals: [srv],
    });
    expect(calls[0].slice(1)).to.deep.equal([null, done]);
  });

  it("without bonjour's multicast socket where version 1.4.4 keeps it, nothing is wrapped — and nothing announced", () => {
    expect(keepInterfaceRecords({} as never, ["192.0.2.10"])).to.equal(false);
    expect(keepInterfaceRecords({ server: { mdns: {} } } as never, ["192.0.2.10"])).to.equal(false);
  });

  it("the real bonjour: the announcement, a query answer and the goodbye name only their interface's addresses", async () => {
    const [own] = ONE_NET();
    expect(own, "this machine carries no IPv4 network").to.not.equal(undefined);
    wire.on = true;
    wire.sent.length = 0;
    try {
      const local = new MDNSService(
        createMockAdapter() as never,
        {
          port: 8123,
          bind: "0.0.0.0",
          authRequired: false,
          username: "admin",
          password: "",
          mdnsEnabled: true,
          serviceName: "WireTest",
        },
        crypto.randomUUID(),
        null,
        // two networks: nothing probes, so bonjour announces inside `publish` — the case no later setting reaches
        () => [own, net("198.51.100.10", "docker9")],
      );
      local.start();
      const announced = (local as unknown as Internals).announced;
      expect(announced).to.have.length(2);
      const mdns = (announced[0].bonjour as unknown as { server: { mdns: EventEmitter } }).server.mdns;
      mdns.emit("query", { questions: [{ name: "_home-assistant._tcp.local", type: "PTR" }] });
      await local.stop(true);

      type Packet = Record<string, Array<{ type: string; data: unknown; ttl: number }> | undefined>;
      const on = (iface: string): Packet[] =>
        wire.sent.filter(s => (s.socket as { interface?: string }).interface === iface).map(s => s.packet as Packet);
      const named = (packets: Packet[]): unknown[] =>
        packets
          .flatMap(p => [...(p.answers ?? []), ...(p.authorities ?? []), ...(p.additionals ?? [])])
          .filter(r => r.type === "A" || r.type === "AAAA")
          .map(r => r.data);
      const ownPackets = on(own.address);
      // the announcement, the answer to the query (its records in `additionals`), the goodbye (TTL 0)
      expect(ownPackets.some(p => p.answers?.some(r => r.type === "PTR" && r.ttl > 0))).to.equal(true);
      expect(ownPackets.some(p => p.additionals?.some(r => r.type === "SRV"))).to.equal(true);
      expect(ownPackets.some(p => p.answers?.some(r => r.type === "PTR" && r.ttl === 0))).to.equal(true);
      expect(new Set(named(ownPackets))).to.deep.equal(new Set(named(ownPackets).length ? [own.address] : []));
      // the second interface carries none of this machine's addresses — none goes out on it
      expect(on("198.51.100.10").length).to.be.greaterThan(0);
      expect(named(on("198.51.100.10"))).to.deep.equal([]);
    } finally {
      wire.on = false;
    }
  });
});
