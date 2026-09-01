import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TargetHealth, probeTarget } from "./target-health";

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
}

function createMockAdapter(): MockAdapter {
  const logs: LogEntry[] = [];
  const push =
    (level: string) =>
    (msg: string): void => {
      logs.push({ level, msg });
    };
  return {
    log: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") },
    _logs: logs,
  };
}

/** Starts a local http server and resolves once it listens. */
function listen(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

describe("target-health", () => {
  describe("probeTarget", () => {
    it("treats ANY http response as reachable — status codes are not judged", async () => {
      const server = createServer((_req, res) => {
        res.statusCode = 500;
        res.end("boom");
      });
      const port = await listen(server);
      try {
        expect(await probeTarget(`http://127.0.0.1:${port}/`, 2000)).to.equal(true);
      } finally {
        server.close();
      }
    });

    it("treats connection-refused as unreachable", async () => {
      // Grab a port that WAS free a moment ago, then close it again.
      const server = createServer();
      const port = await listen(server);
      await new Promise(resolve => server.close(resolve));
      expect(await probeTarget(`http://127.0.0.1:${port}/`, 2000)).to.equal(false);
    });

    it("treats a never-answering server as unreachable after the timeout", async () => {
      // Accepts the TCP connection but never writes response headers.
      const server = createServer(() => {
        /* hold the request open */
      });
      const port = await listen(server);
      try {
        expect(await probeTarget(`http://127.0.0.1:${port}/`, 200)).to.equal(false);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    it("resolves true for URLs it cannot assess (unparseable, non-http)", async () => {
      expect(await probeTarget("not a url", 200)).to.equal(true);
      expect(await probeTarget("ftp://example.test/file", 200)).to.equal(true);
    });
  });

  describe("TargetHealth", () => {
    it("caches the probe verdict — repeated asks within the window cost one probe", async () => {
      const adapter = createMockAdapter();
      let calls = 0;
      const health = new TargetHealth(adapter as never, async () => {
        calls++;
        return true;
      });
      expect(await health.isReachable("http://a.test/")).to.equal(true);
      expect(await health.isReachable("http://a.test/")).to.equal(true);
      expect(calls).to.equal(1);
      // A different URL is its own cache entry.
      await health.isReachable("http://b.test/");
      expect(calls).to.equal(2);
    });

    it("shares ONE in-flight probe between concurrent askers of the same URL", async () => {
      const adapter = createMockAdapter();
      let calls = 0;
      let release: (alive: boolean) => void = () => undefined;
      const health = new TargetHealth(adapter as never, () => {
        calls++;
        return new Promise<boolean>(resolve => {
          release = resolve;
        });
      });
      const p1 = health.isReachable("http://a.test/");
      const p2 = health.isReachable("http://a.test/");
      release(false);
      expect(await p1).to.equal(false);
      expect(await p2).to.equal(false);
      expect(calls).to.equal(1);
    });

    it("re-probes once the cache window has lapsed (cacheMs=0 seam)", async () => {
      const adapter = createMockAdapter();
      let calls = 0;
      const health = new TargetHealth(
        adapter as never,
        async () => {
          calls++;
          return true;
        },
        0,
      );
      await health.isReachable("http://a.test/");
      await health.isReachable("http://a.test/");
      expect(calls).to.equal(2);
    });

    it("logs reachability TRANSITIONS at info — once per flip, silent in steady state", async () => {
      const adapter = createMockAdapter();
      const verdicts = [false, false, true, true];
      const health = new TargetHealth(adapter as never, async () => verdicts.shift() ?? true, 0);
      await health.isReachable("http://a.test/");
      await health.isReachable("http://a.test/");
      await health.isReachable("http://a.test/");
      await health.isReachable("http://a.test/");
      const infos = adapter._logs.filter(l => l.level === "info").map(l => l.msg);
      expect(infos).to.deep.equal([
        "Redirect target not reachable: http://a.test/",
        "Redirect target reachable again: http://a.test/",
      ]);
    });

    it("fails OPEN when the probe itself throws — no card, no log", async () => {
      const adapter = createMockAdapter();
      const health = new TargetHealth(adapter as never, async () => {
        throw new Error("prober bug");
      });
      expect(await health.isReachable("http://a.test/")).to.equal(true);
      expect(adapter._logs).to.deep.equal([]);
    });

    it("dispose() drops the cache so the next ask probes fresh", async () => {
      const adapter = createMockAdapter();
      let calls = 0;
      const health = new TargetHealth(adapter as never, async () => {
        calls++;
        return true;
      });
      await health.isReachable("http://a.test/");
      health.dispose();
      await health.isReachable("http://a.test/");
      expect(calls).to.equal(2);
    });
  });
});
