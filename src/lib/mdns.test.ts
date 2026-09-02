import crypto from "node:crypto";
import { MDNSService } from "./mdns";
import type { AdapterConfig } from "./types";

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
}

// Mock adapter for testing
function createMockAdapter(): MockAdapter {
  const logs: LogEntry[] = [];
  const timerCalls: number[] = [];
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
    bindAddress: "0.0.0.0",
    authRequired: false,
    username: "admin",
    password: "secret",
    mdnsEnabled: true,
    serviceName: "TestService",
  };

  beforeEach(() => {
    adapter = createMockAdapter();
    service = new MDNSService(adapter as never, config, crypto.randomUUID());
  });

  afterEach(() => {
    service.stop();
  });

  describe("constructor", () => {
    it("should use the provided UUID", () => {
      expect(service.uuid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("should not be active initially", () => {
      expect(service.isActive()).to.be.false;
    });

    it("should use different UUIDs when different UUIDs are provided", () => {
      const service2 = new MDNSService(adapter as never, config, crypto.randomUUID());
      expect(service.uuid).to.not.equal(service2.uuid);
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

    it("should not be active after stop", () => {
      service.start();
      expect(service.isActive()).to.be.true;
      service.stop();
      expect(service.isActive()).to.be.false;
    });

    it("should handle stop when not active", () => {
      expect(service.isActive()).to.be.false;
      expect(() => service.stop()).to.not.throw();
    });

    it("should handle multiple stop calls", () => {
      service.start();
      service.stop();
      expect(() => service.stop()).to.not.throw();
    });

    it("should handle start-stop-start cycle", () => {
      service.start();
      expect(service.isActive()).to.be.true;
      service.stop();
      expect(service.isActive()).to.be.false;
      service.start();
      expect(service.isActive()).to.be.true;
    });
  });

  describe("stop() fallback-timer semantics (I1)", () => {
    it("synchronous stop (onUnload) skips the managed fallback timer", () => {
      service.start();
      expect(service.isActive()).to.be.true;
      service.stop(true);
      expect(service.isActive()).to.be.false;
      // No managed timer armed → adapter-core cannot warn during shutdown.
      expect(adapter._timerCalls).to.have.lengthOf(0);
      expect(adapter._logs.some(l => l.level === "debug" && l.msg.includes("Service stopped"))).to.be.true;
    });

    it("runtime stop (onReady re-init) arms a single 300 ms fallback timer", () => {
      service.start();
      service.stop(false);
      expect(adapter._timerCalls).to.deep.equal([300]);
    });

    it("stop on a service that was never started does nothing at all", () => {
      // Not even a log line: "Service stopped" for a service that never ran is
      // a false trail when someone reads the log after an mDNS problem.
      expect(service.isActive()).to.be.false;
      service.stop(false);
      expect(adapter._timerCalls).to.have.lengthOf(0);
      expect(adapter._logs.some(l => l.msg.includes("Service stopped"))).to.be.false;
    });

    it("releases the mDNS sockets exactly once", async () => {
      service.start();
      let destroys = 0;
      // Both the stop-callback and the 300 ms fallback call destroy(); a second
      // destroy() on an already-closed bonjour instance throws inside the
      // library (it walks closed sockets).
      (service as unknown as { bonjour: { destroy(): void } | null }).bonjour = {
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

      service.stop(false);
      // The library calls the stop-callback asynchronously — let it land first,
      // then fire the fallback the way the runtime timer would.
      await new Promise(r => setTimeout(r, 50));
      captured.forEach(cb => cb());
      expect(destroys).to.equal(1);
    });

    it("shutdown stop resolves only once the goodbye left and the sockets are released", async () => {
      // This promise is what keeps onUnload from reporting "done" while the goodbye
      // announcement is still in the socket — resolve too early and the host tears
      // the process down mid-farewell, which is the bug this release fixes.
      service.start();
      const internals = service as unknown as {
        bonjour: { destroy(): void } | null;
        published: { stop(cb: () => void): void } | null;
      };
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

    it("should use ioBroker as default service name", () => {
      const defaultConfig: AdapterConfig = {
        ...config,
        serviceName: "",
      };
      const defaultService = new MDNSService(adapter as never, defaultConfig, crypto.randomUUID());
      defaultService.start();
      const debugLogs = adapter._logs.filter(l => l.level === "debug");
      const broadcastLog = debugLogs.find(l => l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog!.msg).to.include("ioBroker._home-assistant._tcp");
      defaultService.stop();
    });
  });

  describe("advertised host (bind-aware base_url)", () => {
    it("advertises the configured concrete bind address (matches /api/discovery_info)", () => {
      const boundConfig: AdapterConfig = { ...config, bindAddress: "192.168.1.50" };
      const boundService = new MDNSService(adapter as never, boundConfig, crypto.randomUUID());
      boundService.start();
      const broadcastLog = adapter._logs.find(l => l.level === "debug" && l.msg.includes("mDNS: Broadcasting"));
      expect(broadcastLog!.msg).to.include("192.168.1.50:8123");
      boundService.stop();
    });
  });
});

describe("MDNSService cross-platform", () => {
  it("should work without avahi (cross-platform)", () => {
    // bonjour-service works on all platforms — no avahi needed
    const adapter = createMockAdapter();
    const service = new MDNSService(
      adapter as never,
      {
        port: 8123,
        bindAddress: "0.0.0.0",
        authRequired: false,
        username: "",
        password: "",
        mdnsEnabled: true,
        serviceName: "CrossPlatformTest",
      },
      crypto.randomUUID(),
    );

    service.start();
    expect(service.isActive()).to.be.true;

    // No error logs — bonjour-service works everywhere
    const errorLogs = adapter._logs.filter(l => l.level === "error");
    expect(errorLogs.length).to.equal(0);

    service.stop();
    expect(service.isActive()).to.be.false;
  });

  describe("async error handling (J6 v1.25.0 — D12 v1.15.0 coverage)", () => {
    it("async publish error sets active=false and warns", () => {
      const localAdapter = createMockAdapter();
      const localService = new MDNSService(
        localAdapter as never,
        {
          port: 8123,
          bindAddress: "0.0.0.0",
          authRequired: false,
          username: "",
          password: "",
          mdnsEnabled: true,
          serviceName: "AsyncErrorTest",
        },
        crypto.randomUUID(),
      );

      localService.start();
      expect(localService.isActive()).to.be.true;

      // Fire async 'error' event auf das publish'd service-objekt — bonjour-
      // service's Service extends EventEmitter, so .emit() ist available.
      const internal = localService as unknown as {
        published: { emit?: (event: string, err: Error) => void } | null;
      };
      internal.published?.emit?.("error", new Error("mock dgram bind failure"));

      expect(localService.isActive()).to.be.false;
      const warns = localAdapter._logs.filter(l => l.level === "warn" && l.msg.includes("async publish error"));
      expect(warns).to.have.length(1);
      expect(warns[0].msg).to.include("mock dgram bind failure");

      localService.stop();
    });
  });
});
