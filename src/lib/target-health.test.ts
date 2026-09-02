import { createServer, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { TARGET_HEALTH_CACHE_CAP } from "./constants";
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


/**
 * Throw-away self-signed localhost certificate for the TLS probe test (CN=localhost,
 * valid 10 years, generated once for this fixture — secures nothing, signs nothing).
 */
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCxjKACDRXNi9Yu
765r3E4TBR5Ea67tRoOveC8+pjgnF1Zmdt2lJUKuiHyFLG9fThipPZaXDmynhLDI
ee+hucn9kQuOTVCWLk34jjZkaQvFVvPSTo+fO/wy22G9RaeQ9I7CJMS0o1kKUqSy
ezs8302BdjgtUWz6C47t259cQrwasV1bbhOXHhQH1C/49fvmlq5DTpJOoIAF7kPD
bFVfJnTqi1ZIcIoBuOqtAu9WLMQU8Yicn+cgNjodqFJd1L7ffGXZ/C9wHPnuxDue
bLRmdExUxXa6J6QHRw0vXfIjElgZ4j41jhGwHfLCb+EIZUM6sJNf0VNR0h9xSr2c
PEFY3D2nAgMBAAECggEAP8p5MNN3um6cCSgXYGx6Zq4HlmikJF8Z8CD7xIQfF7h0
VAMwFmZBQ4kJSCXTbAgYpzHYGbTWiAeOJrFczhv8/UwwPTP9GMBRRlT+KOxvDLt1
heGxC3KXZcRZpRHSJywe4JUqUYaA9ssDnpbVDUVjyPhrLakcQOiHNWGbq5/UirgF
4De/Abtg3SuSMeC78hSzi8hElfrqRXW1Xr42XiSqE7v/Lh+P0rVtT8c+/hY+dSMp
SWw9+82TS/XNyx0dwY8lcpos881IxQFh2SQY7+bvbDK4GZB/ozt3wDL8Nz34FK/V
utzkWd+mGMwXfpbY+ad1q90hHr4bMn9lwy+QwFe09QKBgQDuPc2fCiIbs6pbh6l3
8xYaAIh3K06gaAEXfB9HlK4nP4Q/k7Bc3s33cwtRaf4sA64mHTbsa0KJJ0lkNcIS
4BnVPf/p243OfElYg3f2kW7ad6ONbIhy0OQhFXoir/3HI9+Z8F15MyV8hCTXb+z7
jNPK8nz61ddWaVOiesopmTj5VQKBgQC+yK0f0FPLOa3+HEehXh+WdQmg7s1W/nRk
I9Go43LAM4xDFEljZszrzzajuB+xfNougaITQAhdDRTgrQ++RY387OZUz/egzCr0
/r5WMDfGDlD6l5r+T+sco0iVtfPgMfcn/TWxPbYSW0EdD2QAuOuJy3e+0cIQ8CYd
N5l2GmdrCwKBgBp30U1XAd0UA9wxYTmLTyxKXN7od87IXz6tsofwU7zWiKnLja9z
rWxNYreD0BIxwnpHip+Pdw/nxnaUpmAUd6pCPhlMJCAJnNhxmrVRCQDKg+glY69l
18J5MV2DMe2a5a+jja72aLbBs5ofvDNiPPFyKUJw2YCnKPyHKcifVj4VAoGAcOLY
3WwtSKCWfTdKgwbodeRGkDz8ry7cu6weEGqUqXlW0xIb4n8fXaA8Wl9GEYUorD/0
IKPQzw5AfjioihMp0rByEVkE0tY7zL827FSXi89Ixx4RjczH9yf+eOcyqEOoVLcU
oA09wFrSilli+LJyXBRShEwlIlSWmM8fNKym6MUCgYAVCkAHejt/bmrdM/OstUsh
eKqVfz6WWjJc48FFJToO1eIPXlNSbhWTIUVj4cPbQtTR3GXVksAYZ/Ij5/ZhXU1V
z1DfkQxSDyEdCbKAeMe8nnbVpuglokiuK4E5m3pKqXbRzk/oEXNtBWbUFhFu6w61
EYof/DEMZLoAbyE1MXppjQ==
-----END PRIVATE KEY-----
`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUIg6vxivtmFHnZlsUEu24slqrXuIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwMTE5MTUxMFoXDTM2MDgy
OTE5MTUxMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAsYygAg0VzYvWLu+ua9xOEwUeRGuu7UaDr3gvPqY4JxdW
ZnbdpSVCroh8hSxvX04YqT2Wlw5sp4SwyHnvobnJ/ZELjk1Qli5N+I42ZGkLxVbz
0k6Pnzv8MtthvUWnkPSOwiTEtKNZClKksns7PN9NgXY4LVFs+guO7dufXEK8GrFd
W24Tlx4UB9Qv+PX75pauQ06STqCABe5Dw2xVXyZ06otWSHCKAbjqrQLvVizEFPGI
nJ/nIDY6HahSXdS+33xl2fwvcBz57sQ7nmy0ZnRMVMV2uiekB0cNL13yIxJYGeI+
NY4RsB3ywm/hCGVDOrCTX9FTUdIfcUq9nDxBWNw9pwIDAQABo1MwUTAdBgNVHQ4E
FgQUKLxGAohzVO//sw2VhwWxVi+F66EwHwYDVR0jBBgwFoAUKLxGAohzVO//sw2V
hwWxVi+F66EwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAOqr8
H+FEx4VgHsIlPAhGhJulEDGylYU4GvUvf4JRtQaJPzuyrrWRhN2EXvaqbG86sHxJ
1b1hm4ftDSgrI2kjpVBoqIsyqmSyPechqE7fdMSWUPwOz1b8yAlPIQHDPVMJMpxV
5K8/wA9iYYGMMRQl4IvN9bTdUPMSHCOMWn0e09jmWbdBfv7c8RiND64tQxGZi3UI
+1uzjQHlaHU9/TRyuWgFuO658+t4AVlip0rwqF10K3XNS+Ky9SFyecM0WIffpyWT
8CS/Y3MDcjeeT58atL0Y4SXl3/FlydK3O1HRG629vKNhlZG6sAQPh6RIJ8kLbju5
vhXcR9ejvuYP73X8wA==
-----END CERTIFICATE-----
`;

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

    it("treats a non-resolvable hostname as unreachable (DNS failure path)", async () => {
      // .invalid is reserved (RFC 2606) and guaranteed to never resolve.
      expect(await probeTarget("http://this-host.invalid/", 2000)).to.equal(false);
    });

    it("treats a self-signed https target as reachable — the probe asks reachability, not authenticity", async () => {
      const server = createTlsServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (_req, res) => {
        res.statusCode = 200;
        res.end("ok");
      });
      const port = await new Promise<number>(resolve => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
      try {
        expect(await probeTarget(`https://127.0.0.1:${port}/`, 2000)).to.equal(true);
      } finally {
        server.close();
      }
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

    it("refreshing a known target at the cap must NOT evict an unrelated entry (evict-on-insert-only)", async () => {
      const adapter = createMockAdapter();
      const health = new TargetHealth(adapter as never, async () => true, 0);
      for (let i = 0; i < TARGET_HEALTH_CACHE_CAP; i++) {
        await health.isReachable(`http://u${i}.test/`);
      }
      const cache = health["cache"];
      expect(cache.size).to.equal(TARGET_HEALTH_CACHE_CAP);
      expect(cache.has("http://u0.test/")).to.equal(true);
      // Refresh a KNOWN entry (stale via cacheMs=0) — the oldest must survive.
      await health.isReachable("http://u10.test/");
      expect(cache.has("http://u0.test/")).to.equal(true);
      // A genuinely NEW entry at the cap evicts the oldest.
      await health.isReachable("http://new.test/");
      expect(cache.has("http://u0.test/")).to.equal(false);
    });

    it("a probe settling AFTER dispose() neither repopulates the cache nor logs (late shutdown probe)", async () => {
      const adapter = createMockAdapter();
      let release: (alive: boolean) => void = () => undefined;
      let calls = 0;
      const health = new TargetHealth(adapter as never, () => {
        calls++;
        return new Promise<boolean>(resolve => {
          release = resolve;
        });
      });
      const pending = health.isReachable("http://a.test/");
      health.dispose();
      release(false);
      expect(await pending).to.equal(false);
      expect(adapter._logs).to.deep.equal([]);
      // Cache stayed empty — the next ask starts a fresh probe.
      void health.isReachable("http://a.test/");
      expect(calls).to.equal(2);
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
