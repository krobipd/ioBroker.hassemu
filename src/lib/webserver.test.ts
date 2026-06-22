import crypto from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

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
          if (data[key]) result[lang] = data[key];
        }
        return Object.keys(result).length > 0 ? result : { en: key };
      }),
      translate: vi.fn((key: string) => i18nData.en?.[key] ?? key),
    },
  };
});

import { CLIENT_COOKIE, WebServer } from "./webserver";
import { ClientRegistry } from "./client-registry";
import { GlobalConfig, MODE_GLOBAL, MODE_MANUAL } from "./global-config";
import { HA_VERSION } from "./constants";
import type { AdapterConfig, ClientRecord } from "./types";

interface ObjEntry {
  type: string;
  common?: Record<string, unknown>;
  native?: Record<string, unknown>;
}

interface MockStore {
  namespace: string;
  objects: Map<string, ObjEntry>;
  states: Map<string, { val: unknown; ack: boolean }>;
  logs: { level: string; msg: string }[];
}

function createMockAdapter(namespace = "hassemu.0"): {
  store: MockStore;
  adapter: ReturnType<typeof build>;
} {
  const store: MockStore = {
    namespace,
    objects: new Map(),
    states: new Map(),
    logs: [],
  };

  function build() {
    return {
      namespace,
      log: {
        debug: (m: string) => store.logs.push({ level: "debug", msg: m }),
        info: (m: string) => store.logs.push({ level: "info", msg: m }),
        warn: (m: string) => store.logs.push({ level: "warn", msg: m }),
        error: (m: string) => store.logs.push({ level: "error", msg: m }),
      },
      setInterval: (_cb: () => void, _ms: number) => undefined,
      clearInterval: () => undefined,
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
      getForeignObjectsAsync: async (pattern: string) => {
        const prefix = pattern.replace("*", "");
        const out: Record<string, ObjEntry> = {};
        for (const [id, obj] of store.objects) {
          if (id.startsWith(prefix) && obj.type === "channel") {
            out[id] = obj;
          }
        }
        return out;
      },
      getStateAsync: async (id: string) => store.states.get(`${namespace}.${id}`) ?? null,
      setObjectNotExistsAsync: async (id: string, obj: ObjEntry) => {
        const full = `${namespace}.${id}`;
        if (!store.objects.has(full)) {
          store.objects.set(full, obj);
        }
      },
      extendObjectAsync: async (id: string, obj: Partial<ObjEntry>) => {
        const full = `${namespace}.${id}`;
        const ex = store.objects.get(full) ?? { type: "state" };
        store.objects.set(full, {
          ...ex,
          ...obj,
          common: { ...(ex.common ?? {}), ...(obj.common ?? {}) },
          native: { ...(ex.native ?? {}), ...(obj.native ?? {}) },
        });
      },
      getObjectAsync: async (id: string): Promise<ObjEntry | null> => {
        return store.objects.get(`${namespace}.${id}`) ?? null;
      },
      setObjectAsync: async (id: string, obj: ObjEntry) => {
        store.objects.set(`${namespace}.${id}`, obj);
      },
      setStateAsync: async (id: string, val: { val: unknown; ack?: boolean }) => {
        store.states.set(`${namespace}.${id}`, { val: val.val, ack: val.ack ?? false });
      },
      delObjectAsync: async (id: string) => {
        const full = `${namespace}.${id}`;
        store.objects.delete(full);
        for (const k of [...store.objects.keys()]) {
          if (k.startsWith(`${full}.`)) store.objects.delete(k);
        }
        for (const k of [...store.states.keys()]) {
          if (k === full || k.startsWith(`${full}.`)) store.states.delete(k);
        }
      },
    };
  }

  return { store, adapter: build() };
}

const baseConfig: AdapterConfig = {
  port: 0,
  bindAddress: "127.0.0.1",
  authRequired: false,
  username: "admin",
  password: "secret",
  mdnsEnabled: false,
  serviceName: "TestServer",
};

/**
 * Build a GlobalConfig with optional `global.mode` (sentinel or URL) and
 * `global.manualUrl` set up via the migration helper. `enabled` flag is
 * persisted but does NOT bulk-sync clients here — that lives in main.ts.
 */
async function buildGlobalConfig(
  adapter: ReturnType<typeof createMockAdapter>["adapter"],
  mode: string | null = null,
  manualUrl: string | null = null,
  enabled = false,
): Promise<GlobalConfig> {
  const g = new GlobalConfig(adapter as never);
  if (mode !== null) {
    await g.migrationSet(mode, manualUrl);
  }
  if (enabled) {
    await g.handleEnabledWrite(true);
  }
  return g;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const match = header.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

interface ServerOpts {
  /** Overrides merged onto {@link baseConfig}. */
  config?: Partial<AdapterConfig>;
  /** `global.mode` seed (sentinel or URL); `null` leaves global unconfigured. Default: direct URL. */
  globalMode?: string | null;
  /** `global.enabled` master switch. Default: true (matches the historical beforeEach). */
  globalEnabled?: boolean;
  /** Install the Bearer pre-handler (prod `start()` always does; tests opt in). */
  authGuard?: boolean;
  /** ioBroker system language passed to the WebServer (landing-page rendering). */
  systemLanguage?: string;
}

/**
 * Builds a fully-wired WebServer on a fresh mock adapter: cookie + formbody
 * plugins registered, error handler + routes installed, app ready. This block
 * was hand-rolled 17x across this file before v1.35.2 - every inject-based
 * test now goes through this single helper. Tests that exercise the real
 * listener (`start()`/`stop()`, WebSocket, restart-simulation) stay manual
 * because `start()` registers the plugins itself.
 */
async function buildServer(opts: ServerOpts = {}): Promise<{
  s: WebServer;
  reg: ClientRegistry;
  g: GlobalConfig;
  store: MockStore;
}> {
  const built = createMockAdapter();
  const reg = new ClientRegistry(built.adapter as never);
  const g = await buildGlobalConfig(
    built.adapter,
    opts.globalMode === undefined ? "http://example.com/vis" : opts.globalMode,
    null,
    opts.globalEnabled ?? true,
  );
  const s = new WebServer(
    built.adapter as never,
    { ...baseConfig, ...(opts.config ?? {}) },
    reg,
    g,
    crypto.randomUUID(),
    opts.systemLanguage ?? "en",
  );
  await s["app"].register((await import("@fastify/cookie")).default);
  await s["app"].register((await import("@fastify/formbody")).default);
  if (opts.authGuard) {
    s["setupAuthGuard"]();
  }
  s["setupErrorHandler"]();
  s["setupRoutes"]();
  await s["app"].ready();
  return { s, reg, g, store: built.store };
}

describe("WebServer", () => {
  let server: WebServer;
  let registry: ClientRegistry;
  let globalConfig: GlobalConfig;
  let store: MockStore;

  beforeEach(async () => {
    // global.mode = direct URL; new client default mode='global' delegates here
    ({ s: server, reg: registry, g: globalConfig, store } = await buildServer());
  });

  afterEach(async () => {
    await server["app"].close();
  });

  describe("constructor", () => {
    it("generates a valid UUID", () => {
      expect(server.instanceUuid).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("uses configured service name", () => {
      expect(server.serviceName).to.equal("TestServer");
    });

    it("falls back to ioBroker when service name is empty", async () => {
      const { s } = await buildServer({ config: { serviceName: "" }, globalMode: null, globalEnabled: false });
      expect(s.serviceName).to.equal("ioBroker");
    });
  });

  describe("API endpoints", () => {
    it("GET /api/ returns API status", async () => {
      const res = await server.inject({ method: "GET", url: "/api/" });
      expect(res.statusCode).to.equal(200);
      expect(res.json()).to.deep.equal({ message: "API running." });
    });

    it("GET /api/config returns HA config with version + service name", async () => {
      const res = await server.inject({ method: "GET", url: "/api/config" });
      const body = res.json() as Record<string, unknown>;
      expect(body.version).to.equal(HA_VERSION);
      expect(body.location_name).to.equal("TestServer");
      expect(body.components).to.include("homeassistant");
    });

    it("GET /api/discovery_info returns discovery info with uuid", async () => {
      const res = await server.inject({ method: "GET", url: "/api/discovery_info" });
      const body = res.json() as Record<string, unknown>;
      expect(body.uuid).to.equal(server.instanceUuid);
      expect(body.location_name).to.equal("TestServer");
      expect(body.version).to.equal(HA_VERSION);
    });

    it("GET /api/states returns empty array", async () => {
      const res = await server.inject({ method: "GET", url: "/api/states" });
      expect(res.json()).to.deep.equal([]);
    });

    it("GET /api/services returns empty array", async () => {
      const res = await server.inject({ method: "GET", url: "/api/services" });
      expect(res.json()).to.deep.equal([]);
    });

    it("GET /api/events returns empty array", async () => {
      const res = await server.inject({ method: "GET", url: "/api/events" });
      expect(res.json()).to.deep.equal([]);
    });

    it("GET /api/error_log returns empty string", async () => {
      const res = await server.inject({ method: "GET", url: "/api/error_log" });
      expect(res.body).to.equal("");
    });
  });

  describe("auth flow", () => {
    it("GET /auth/providers returns homeassistant provider", async () => {
      const res = await server.inject({ method: "GET", url: "/auth/providers" });
      const body = res.json() as Array<Record<string, unknown>>;
      expect(body).to.have.lengthOf(1);
      expect(body[0].type).to.equal("homeassistant");
    });

    it("POST /auth/login_flow creates a flow and sets cookie on first visit", async () => {
      const res = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const body = res.json() as Record<string, unknown>;
      expect(body.type).to.equal("form");
      expect(body.flow_id).to.match(/^[0-9a-f-]{36}$/);
      expect(extractCookie(res.headers["set-cookie"])).to.match(/^[0-9a-f-]{36}$/);
    });

    it("POST /auth/login_flow binds flow to the client cookie", async () => {
      const res1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const cookie = extractCookie(res1.headers["set-cookie"]);
      expect(cookie).to.not.be.null;
      const client = registry.getByCookie(cookie!);
      expect(client).to.not.be.null;
    });

    it("POST /auth/login_flow/:flowId with unknown flow returns 400", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/auth/login_flow/00000000-0000-0000-0000-000000000000",
        payload: { username: "admin", password: "secret" },
      });
      expect(res.statusCode).to.equal(400);
      expect((res.json() as { reason: string }).reason).to.equal("unknown_flow");
    });

    it("completes full auth flow end-to-end and stores refresh token", async () => {
      const r1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const flowId = (r1.json() as { flow_id: string }).flow_id;

      const r2 = await server.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { username: "admin", password: "secret" },
      });
      const code = (r2.json() as { result: string }).result;
      expect(code).to.match(/^[0-9a-f-]{36}$/);

      const r3 = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { grant_type: "authorization_code", code },
      });
      const tokens = r3.json() as { access_token: string; refresh_token: string };
      expect(tokens.access_token).to.match(/^[0-9a-f-]{36}$/);
      expect(tokens.refresh_token).to.match(/^[0-9a-f-]{36}$/);

      const client = registry.getByCookie(cookie);
      expect(client?.token).to.equal(tokens.access_token);

      // Refresh token must be stored via registry — persisted in clients.<id>.native.refreshToken
      expect(client?.refreshToken).to.equal(tokens.refresh_token);
      expect(registry.getByRefreshToken(tokens.refresh_token)?.id).to.equal(client!.id);
    });

    it("POST /auth/token with VALID refresh_token issues a new access token", async () => {
      // First do a real login to get a valid refresh token
      const r1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await server.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { username: "admin", password: "secret" },
      });
      const code = (r2.json() as { result: string }).result;
      const r3 = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "authorization_code", code },
      });
      const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;

      // Use the valid refresh token to mint a new access token
      const r4 = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "refresh_token", refresh_token: refreshToken },
      });
      expect(r4.statusCode).to.equal(200);
      expect((r4.json() as { access_token: string }).access_token).to.match(/^[0-9a-f-]{36}$/);
    });

    it("POST /auth/token with UNKNOWN refresh_token returns 400 (security fix v1.2.0)", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "refresh_token", refresh_token: crypto.randomUUID() },
      });
      expect(res.statusCode).to.equal(400);
      expect((res.json() as { error: string }).error).to.equal("invalid_grant");
    });

    it("POST /auth/token with missing refresh_token returns 400", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "refresh_token" },
      });
      expect(res.statusCode).to.equal(400);
    });

    it("POST /auth/token rejects unknown code", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "authorization_code", code: "bogus" },
      });
      expect(res.statusCode).to.equal(400);
    });

    it("POST /auth/token accepts application/x-www-form-urlencoded body (OAuth2-Spec, v1.4.0)", async () => {
      // Real HA-Reference-Clients (Wall Display, frontend) senden urlencoded —
      // ohne @fastify/formbody würde Fastify mit 415 antworten und Auth wäre tot.
      // Tests via inject({payload:{}}) serialisieren zu JSON und maskieren das.
      const r1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await server.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { username: "admin", password: "secret" },
      });
      const code = (r2.json() as { result: string }).result;

      const r3 = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
      });
      expect(r3.statusCode).to.equal(200);
      const body = r3.json() as { access_token: string; refresh_token: string };
      expect(body.access_token).to.match(/^[0-9a-f-]{36}$/);
      expect(body.refresh_token).to.match(/^[0-9a-f-]{36}$/);
    });

    it("POST /auth/token with form-urlencoded refresh_token also works", async () => {
      const r1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await server.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { username: "admin", password: "secret" },
      });
      const code = (r2.json() as { result: string }).result;
      const r3 = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "authorization_code", code },
      });
      const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;

      const r4 = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      });
      expect(r4.statusCode).to.equal(200);
    });

    it("rejects invalid credentials when authRequired is true", async () => {
      const { s } = await buildServer({ config: { authRequired: true } });

      const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await s.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        payload: { username: "wrong", password: "wrong" },
      });
      expect(r2.statusCode).to.equal(400);
      expect((r2.json() as { errors: { base: string } }).errors.base).to.equal("invalid_auth");

      await s["app"].close();
    });

    it("accepts correct credentials via timing-safe compare (security fix v1.2.0)", async () => {
      const { s } = await buildServer({ config: { authRequired: true } });

      const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await s.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        payload: { username: "admin", password: "secret" },
      });
      expect((r2.json() as { result?: string }).result).to.match(/^[0-9a-f-]{36}$/);
      await s["app"].close();
    });

    it("rejects username with mismatched length (timing-safe handles both branches)", async () => {
      const { s } = await buildServer({ config: { authRequired: true } });

      const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await s.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        payload: { username: "short", password: "doesnotmatter" },
      });
      expect((r2.json() as { errors: { base: string } }).errors.base).to.equal("invalid_auth");
      await s["app"].close();
    });

    it("rejects a blank password even when the configured password is blank (v1.36.0 C6)", async () => {
      // Default config.password is "" — an empty submission used to match
      // (safeStringEqual("","")) and authenticate. A blank password must never auth.
      const { s } = await buildServer({ config: { authRequired: true, password: "" } });

      const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await s.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        payload: { username: "admin", password: "" },
      });
      expect(r2.statusCode).to.equal(400);
      expect((r2.json() as { errors: { base: string } }).errors.base).to.equal("invalid_auth");
      await s["app"].close();
    });
  });

  describe("OAuth2 browser flow (v1.29.0 — Shelly FW 2.6+, HA Companion)", () => {
    // Sources verified before coding:
    //   home-assistant/android UrlUtil.kt:buildAuthenticationUrl
    //   home-assistant/core indieauth.py:verify_redirect_uri
    //   home-assistant/frontend src/data/auth.ts:redirectWithAuthCode
    // Detail in Ressourcen/hassemu/oauth2-browser-flow-shelly-fw26.md.

    const SHELLY_QUERY =
      "response_type=code" +
      "&client_id=" +
      encodeURIComponent("https://home-assistant.io/android") +
      "&redirect_uri=" +
      encodeURIComponent("homeassistant://auth-callback") +
      "&state=xyz123";

    it("GET /auth/authorize: rejects missing response_type", async () => {
      const res = await server.inject({ method: "GET", url: "/auth/authorize" });
      expect(res.statusCode).to.equal(400);
      expect(res.headers["content-type"]).to.include("text/html");
      expect(res.body).to.include("unsupported_response_type");
    });

    it("GET /auth/authorize: rejects response_type other than `code`", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/auth/authorize?response_type=token&client_id=x&redirect_uri=x",
      });
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.include("unsupported_response_type");
    });

    it("GET /auth/authorize: rejects javascript: redirect_uri (open-redirect guard)", async () => {
      const res = await server.inject({
        method: "GET",
        url:
          "/auth/authorize?response_type=code&client_id=" +
          encodeURIComponent("https://home-assistant.io/android") +
          "&redirect_uri=" +
          encodeURIComponent("javascript:alert(1)"),
      });
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.include("invalid_redirect_uri");
      // Hard requirement: NEVER 302 on validation failure (would leak code).
      expect(res.headers.location).to.equal(undefined);
    });

    it("GET /auth/authorize: rejects mismatched http(s) host (open-redirect guard)", async () => {
      const res = await server.inject({
        method: "GET",
        url:
          "/auth/authorize?response_type=code&client_id=" +
          encodeURIComponent("http://10.0.0.1:8123/") +
          "&redirect_uri=" +
          encodeURIComponent("http://attacker.example.com/cb"),
      });
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.include("invalid_redirect_uri");
    });

    it("GET /auth/authorize (authRequired=false): renders auto-redirect HTML with code + state", async () => {
      const res = await server.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      expect(res.statusCode).to.equal(200);
      expect(res.headers["content-type"]).to.include("text/html");
      // The auto-submit page contains the target URL twice:
      //   - meta refresh `URL=…` with HTML-encoded ampersands
      //   - inline JS `document.location.assign(jsonString)` with raw URL
      expect(res.body).to.match(/document\.location\.assign/);
      expect(res.body).to.include("homeassistant://auth-callback?code=");
      expect(res.body).to.include("state=xyz123");
      // Same code is in the codeSessions map (S2: separate from flow-ids) so
      // /auth/token can consume it.
      const codeMatch = res.body.match(/code=([a-f0-9-]+)/);
      expect(codeMatch, "auth code not in body").to.not.be.null;
      expect(server.codeSessions.has(codeMatch![1])).to.be.true;
    });

    it("GET /auth/authorize (authRequired=true): renders login form with hidden OAuth2 params", async () => {
      const { s } = await buildServer({ config: { authRequired: true } });
      const res = await s.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      expect(res.statusCode).to.equal(200);
      expect(res.headers["content-type"]).to.include("text/html");
      expect(res.body).to.include('<form method="POST" action="/auth/authorize"');
      expect(res.body).to.include('name="response_type" value="code"');
      expect(res.body).to.include('name="client_id" value="https://home-assistant.io/android"');
      expect(res.body).to.include('name="redirect_uri" value="homeassistant://auth-callback"');
      expect(res.body).to.include('name="state" value="xyz123"');
      expect(res.body).to.include('name="username"');
      expect(res.body).to.include('name="password"');
      await s["app"].close();
    });

    it("POST /auth/authorize: valid creds → auto-redirect HTML with code + state", async () => {
      const { s } = await buildServer({ config: { authRequired: true } });
      const res = await s.inject({
        method: "POST",
        url: "/auth/authorize",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload:
          "response_type=code" +
          "&client_id=" +
          encodeURIComponent("https://home-assistant.io/android") +
          "&redirect_uri=" +
          encodeURIComponent("homeassistant://auth-callback") +
          "&state=abc" +
          "&username=admin&password=secret",
      });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.match(/document\.location\.assign/);
      expect(res.body).to.include("homeassistant://auth-callback?code=");
      expect(res.body).to.include("state=abc");
      await s["app"].close();
    });

    it("POST /auth/authorize: invalid creds → form re-rendered with error banner, 401", async () => {
      const { s } = await buildServer({ config: { authRequired: true } });
      const res = await s.inject({
        method: "POST",
        url: "/auth/authorize",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload:
          "response_type=code" +
          "&client_id=" +
          encodeURIComponent("https://home-assistant.io/android") +
          "&redirect_uri=" +
          encodeURIComponent("homeassistant://auth-callback") +
          "&state=abc" +
          "&username=admin&password=wrong",
      });
      expect(res.statusCode).to.equal(401);
      expect(res.body).to.include("Invalid username or password");
      expect(res.body).to.include("<form");
      // No code issued on failure.
      expect(res.body).to.not.include("document.location.assign");
      await s["app"].close();
    });

    it("GET /auth/authorize → POST /auth/token: full end-to-end flow yields access_token (authRequired=false)", async () => {
      const r1 = await server.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      const codeMatch = r1.body.match(/code=([a-f0-9-]+)/);
      expect(codeMatch).to.not.be.null;
      const r2 = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=authorization_code&code=${codeMatch![1]}&client_id=${encodeURIComponent("https://home-assistant.io/android")}`,
      });
      expect(r2.statusCode).to.equal(200);
      const body = r2.json() as { access_token: string; refresh_token: string; token_type: string };
      expect(body.token_type).to.equal("Bearer");
      expect(body.access_token).to.be.a("string").and.have.lengthOf.at.least(16);
      expect(body.refresh_token).to.be.a("string").and.have.lengthOf.at.least(16);
    });

    it("POST /api/mobile_app/registrations: end-to-end after OAuth2 token → returns webhook_id (v1.29.1)", async () => {
      // Source: home-assistant/android IntegrationRepositoryImpl.kt:120
      // — calls POST /api/mobile_app/registrations with Bearer token
      // after registerAuthorizationCode finishes. A 404 here surfaces
      // as „Mobile-App-Integration nicht verfügbar" and blocks onboarding.

      // 1. OAuth2: GET /auth/authorize → auth_code
      const r1 = await server.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      const codeMatch = r1.body.match(/code=([a-f0-9-]+)/);
      expect(codeMatch, "auth code not in body").to.not.be.null;

      // 2. POST /auth/token → access_token
      const r2 = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=authorization_code&code=${codeMatch![1]}`,
      });
      const tok = (r2.json() as { access_token: string }).access_token;
      expect(tok).to.be.a("string");

      // 3. POST /api/mobile_app/registrations → webhook_id
      const r3 = await server.inject({
        method: "POST",
        url: "/api/mobile_app/registrations",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tok}`,
        },
        payload: {
          app_id: "io.homeassistant.companion.android",
          app_name: "Home Assistant",
          device_name: "Shelly Wall Display XL",
          device_id: "shelly-test-123",
        },
      });
      expect(r3.statusCode).to.equal(201);
      const reg = r3.json() as {
        webhook_id: string;
        cloudhook_url: string | null;
        remote_ui_url: string | null;
        secret: string | null;
      };
      expect(reg.webhook_id).to.be.a("string").and.have.lengthOf.at.least(16);
      expect(reg.cloudhook_url).to.equal(null);
      expect(reg.remote_ui_url).to.equal(null);
      expect(reg.secret).to.equal(null);
      expect(server.webhookRegistrations.has(reg.webhook_id)).to.be.true;
    });

    it("POST /api/mobile_app/registrations without Bearer → 401 (authRequired=true)", async () => {
      // The pre-handler is a no-op when authRequired=false (Shelly's
      // zero-config default). Switch to authRequired=true to verify it
      // protects the new mobile_app route too. start()-flow installs the
      // guard in front of the routes in prod.
      const { s } = await buildServer({ config: { authRequired: true }, authGuard: true });
      const res = await s.inject({
        method: "POST",
        url: "/api/mobile_app/registrations",
        payload: {},
      });
      expect(res.statusCode).to.equal(401);
      await s["app"].close();
    });

    it("POST /api/webhook/<id> is public (URL secret) and routes by `type` (v1.29.1)", async () => {
      // Seed a webhook registration manually
      server.webhookRegistrations.set("test-webhook-abc", "test-client");

      // get_config returns hassemu-shaped config (must include 'mobile_app')
      const r1 = await server.inject({
        method: "POST",
        url: "/api/webhook/test-webhook-abc",
        headers: { "content-type": "application/json" },
        payload: { type: "get_config" },
      });
      expect(r1.statusCode).to.equal(200);
      const cfg = r1.json() as { components: string[] };
      expect(cfg.components).to.include("mobile_app");

      // get_zones returns []
      const r2 = await server.inject({
        method: "POST",
        url: "/api/webhook/test-webhook-abc",
        headers: { "content-type": "application/json" },
        payload: { type: "get_zones" },
      });
      expect(r2.statusCode).to.equal(200);
      expect(r2.json()).to.deep.equal([]);

      // Unknown type → generic {}
      const r3 = await server.inject({
        method: "POST",
        url: "/api/webhook/test-webhook-abc",
        headers: { "content-type": "application/json" },
        payload: { type: "fire_event", event_type: "doorbell" },
      });
      expect(r3.statusCode).to.equal(200);
      expect(r3.json()).to.deep.equal({});
    });

    it("PUT /api/mobile_app/registrations/<id>: 200 for known, 404 for unknown (valid token)", async () => {
      const { s } = await buildServer();

      // OAuth2 → access_token to satisfy the pre-handler
      const r1 = await s.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      const codeMatch = r1.body.match(/code=([a-f0-9-]+)/);
      const r2 = await s.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=authorization_code&code=${codeMatch![1]}`,
      });
      const tok = (r2.json() as { access_token: string }).access_token;

      // Register → known webhook_id
      const r3 = await s.inject({
        method: "POST",
        url: "/api/mobile_app/registrations",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        payload: { app_id: "x", device_id: "y" },
      });
      const id = (r3.json() as { webhook_id: string }).webhook_id;

      // Known id → 200, echoes the registration
      const rKnown = await s.inject({
        method: "PUT",
        url: `/api/mobile_app/registrations/${id}`,
        headers: { authorization: `Bearer ${tok}` },
        payload: {},
      });
      expect(rKnown.statusCode).to.equal(200);
      expect((rKnown.json() as { webhook_id: string }).webhook_id).to.equal(id);

      // Unknown id → 404 so a stale pre-restart token re-registers
      const rUnknown = await s.inject({
        method: "PUT",
        url: "/api/mobile_app/registrations/does-not-exist",
        headers: { authorization: `Bearer ${tok}` },
        payload: {},
      });
      expect(rUnknown.statusCode).to.equal(404);
      expect((rUnknown.json() as { error: string }).error).to.equal("unknown_registration");
      await s["app"].close();
    });

    it("DELETE /api/mobile_app/registrations/<id>: removes from map", async () => {
      const { s } = await buildServer();

      // OAuth2 → access_token to satisfy pre-handler
      const r1 = await s.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      const codeMatch = r1.body.match(/code=([a-f0-9-]+)/);
      const r2 = await s.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=authorization_code&code=${codeMatch![1]}`,
      });
      const tok = (r2.json() as { access_token: string }).access_token;

      // Register, then delete
      const r3 = await s.inject({
        method: "POST",
        url: "/api/mobile_app/registrations",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        payload: { app_id: "x", device_id: "y" },
      });
      const id = (r3.json() as { webhook_id: string }).webhook_id;
      expect(s.webhookRegistrations.has(id)).to.be.true;

      const r4 = await s.inject({
        method: "DELETE",
        url: `/api/mobile_app/registrations/${id}`,
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(r4.statusCode).to.equal(204);
      expect(s.webhookRegistrations.has(id)).to.be.false;
      await s["app"].close();
    });

    it("GET /api/config advertises `mobile_app` component (HA Companion onboarding probe, v1.29.1)", async () => {
      const { s } = await buildServer();

      // Auth flow to get a bearer
      const r1 = await s.inject({ method: "GET", url: "/auth/authorize?" + SHELLY_QUERY });
      const codeMatch = r1.body.match(/code=([a-f0-9-]+)/);
      const r2 = await s.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `grant_type=authorization_code&code=${codeMatch![1]}`,
      });
      const tok = (r2.json() as { access_token: string }).access_token;

      const r3 = await s.inject({
        method: "GET",
        url: "/api/config",
        headers: { authorization: `Bearer ${tok}` },
      });
      const body = r3.json() as { components: string[] };
      expect(body.components).to.include("mobile_app");
      await s["app"].close();
    });

    it("state parameter round-trips verbatim when value contains URL-special characters", async () => {
      // OAuth2 state is opaque — must be returned by the server identical bytes.
      const exoticState = "a%26b%3Dc"; // pre-encoded a&b=c
      const res = await server.inject({
        method: "GET",
        url:
          "/auth/authorize?response_type=code" +
          "&client_id=" +
          encodeURIComponent("https://home-assistant.io/android") +
          "&redirect_uri=" +
          encodeURIComponent("homeassistant://auth-callback") +
          "&state=" +
          exoticState,
      });
      expect(res.statusCode).to.equal(200);
      // Fastify URL-decodes the query, so the raw state on server is `a&b=c`,
      // and the redirect re-encodes it for the URL.
      expect(res.body).to.include("state=a%26b%3Dc");
    });
  });

  describe("logout / revoke + shared get_config + no-WS fallback (v1.34.0)", () => {
    // Run the no-auth login flow and return the issued tokens + cookie.
    async function loginAndGetTokens(): Promise<{ cookie: string; access_token: string; refresh_token: string }> {
      const r1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await server.inject({
        method: "POST",
        url: `/auth/login_flow/${flowId}`,
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { username: "admin", password: "secret" },
      });
      const code = (r2.json() as { result: string }).result;
      const r3 = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
        payload: { grant_type: "authorization_code", code },
      });
      const tokens = r3.json() as { access_token: string; refresh_token: string };
      return { cookie, ...tokens };
    }

    it("POST /auth/revoke invalidates the refresh + access token and returns 200", async () => {
      const { cookie, access_token, refresh_token } = await loginAndGetTokens();
      expect(registry.getByRefreshToken(refresh_token)).to.not.be.null;

      const rev = await server.inject({
        method: "POST",
        url: "/auth/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `token=${refresh_token}`,
      });
      expect(rev.statusCode).to.equal(200);
      expect(registry.getByRefreshToken(refresh_token)).to.be.null;
      expect(registry.getByToken(access_token)).to.be.null;
      const after = registry.getByCookie(cookie)!;
      expect(after.token).to.be.null;
      expect(after.refreshToken).to.be.null;
    });

    it("POST /auth/revoke with an unknown token still returns 200 (no existence leak)", async () => {
      const rev = await server.inject({
        method: "POST",
        url: "/auth/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "token=does-not-exist",
      });
      expect(rev.statusCode).to.equal(200);
    });

    it("POST /auth/token with action=revoke invalidates the token and returns 200 (legacy logout)", async () => {
      const { refresh_token } = await loginAndGetTokens();
      const res = await server.inject({
        method: "POST",
        url: "/auth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `action=revoke&token=${refresh_token}`,
      });
      expect(res.statusCode).to.equal(200);
      expect(registry.getByRefreshToken(refresh_token)).to.be.null;
    });

    it("webhook get_config returns the same object as /api/config (shared buildHaConfig)", async () => {
      const reg1 = await server.inject({ method: "POST", url: "/api/mobile_app/registrations", payload: {} });
      const webhookId = (reg1.json() as { webhook_id: string }).webhook_id;
      const apiConfig = (await server.inject({ method: "GET", url: "/api/config" })).json();
      const whConfig = (
        await server.inject({ method: "POST", url: `/api/webhook/${webhookId}`, payload: { type: "get_config" } })
      ).json();
      expect(whConfig).to.deep.equal(apiConfig);
    });

    it("io-package info.refresh_urls is a button with read:false (W1134)", () => {
      const iopkg = JSON.parse(readFileSync(join(__dirname, "../../io-package.json"), "utf8")) as {
        instanceObjects: Array<{ _id: string; common: { role?: string; read?: boolean; write?: boolean } }>;
      };
      const obj = iopkg.instanceObjects.find(o => o._id === "info.refresh_urls");
      expect(obj, "info.refresh_urls present").to.not.be.undefined;
      expect(obj!.common.role).to.equal("button");
      expect(obj!.common.read).to.equal(false);
      expect(obj!.common.write).to.equal(true);
    });

    it("Companion registration completes and the display loads without any WebSocket (no-WS fallback)", async () => {
      // registerDevice persists the registration via REST BEFORE the best-effort
      // WS auth/current_user call (home-assistant/android @2026.4.4 line 142 vs 154).
      // The WS is never opened in this inject-based path — registration must still succeed.
      const reg1 = await server.inject({
        method: "POST",
        url: "/api/mobile_app/registrations",
        payload: { device_name: "Shelly Wall Display", app_id: "io.homeassistant.companion.android" },
      });
      expect(reg1.statusCode).to.equal(201);
      expect((reg1.json() as { webhook_id: string }).webhook_id).to.match(/^[0-9a-f]{32}$/);
      // The display page (iframe wrapper, since global.mode is a direct URL) is served 200.
      const display = await server.inject({ method: "GET", url: "/" });
      expect(display.statusCode).to.equal(200);
      expect(display.body).to.include('<iframe id="hassemu-iframe"');
    });
  });

  describe("misc endpoints", () => {
    it("GET /health returns liveness without any config leak (security fix v1.5.0)", async () => {
      const res = await server.inject({ method: "GET", url: "/health" });
      const body = res.json() as Record<string, unknown>;
      expect(body.status).to.equal("ok");
      expect(body.version).to.equal(HA_VERSION);
      // v1.5.0: complete config-block removed (was previously exposing `mdns` + `auth` flags
      // unauthenticated — Reconnaissance vector for network attackers).
      expect(body).to.not.have.property("config");
    });

    it('GET /manifest.json returns name="Home Assistant" — required by HA Companion verification (v1.29.0)', async () => {
      // home-assistant/android DefaultConnectivityChecker.kt:isHomeAssistant
      // checks `manifest.name === "Home Assistant"` exactly. Any other
      // value (e.g. the user-configured serviceName) fails onboarding.
      const res = await server.inject({ method: "GET", url: "/manifest.json" });
      const body = res.json() as { name: string; short_name: string };
      expect(body.name).to.equal("Home Assistant");
      expect(body.short_name).to.equal("Home Assistant");
    });

    it("GET / serves wrapper HTML pointing at global URL when client default mode='global' (v1.7.0)", async () => {
      const res = await server.inject({ method: "GET", url: "/" });
      expect(res.statusCode).to.equal(200);
      expect(res.headers["content-type"]).to.include("text/html");
      expect(res.body).to.include('<iframe id="hassemu-iframe" src="http://example.com/vis"');
      expect(res.body).to.include("/api/redirect_check");
    });

    it("GET / wrapper notifies HA Companion App via externalApp / externalAppV2 bridge (v1.29.2)", async () => {
      // Source: home-assistant/android FrontendMessageHandler.kt expects a
      // `{type:"connection-status",payload:{event:"connected"}}` envelope.
      // Without it the WebView shows „Verbindung zu Home Assistant nicht
      // möglich" after CONNECTION_TIMEOUT=10s. The wrapper now emits this
      // message at load through both V1 (externalApp) and V2 (externalAppV2)
      // bridges so the WebView's timeout is preempted.
      const res = await server.inject({ method: "GET", url: "/" });
      expect(res.statusCode).to.equal(200);
      // V1 bridge
      expect(res.body).to.include("window.externalApp");
      expect(res.body).to.include("externalBus");
      // V2 bridge
      expect(res.body).to.include("window.externalAppV2");
      expect(res.body).to.include("postMessage");
      // Exact payload shape (JS source literal form — JSON.stringify happens client-side)
      expect(res.body).to.include('type:"connection-status"');
      expect(res.body).to.include('event:"connected"');
      // Retry pattern (slow bridge attach in some companion builds)
      expect(res.body).to.match(/setTimeout\(notifyConnected,\s*\d+\)/);
    });

    it("GET / sets cookie for new clients", async () => {
      const res = await server.inject({ method: "GET", url: "/" });
      expect(extractCookie(res.headers["set-cookie"])).to.match(/^[0-9a-f-]{36}$/);
    });

    it("GET / reuses existing cookie for returning clients", async () => {
      const r1 = await server.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const r2 = await server.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(r2.headers["set-cookie"]).to.be.undefined;
      expect(registry.getByCookie(cookie)).to.not.be.null;
    });

    it("GET / wrapper for client.mode='manual' uses manualUrl in iframe", async () => {
      const r1 = await server.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const client = registry.getByCookie(cookie)!;
      client.mode = MODE_MANUAL;
      client.manualUrl = "http://override.local/ui";
      const r2 = await server.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(r2.statusCode).to.equal(200);
      expect(r2.body).to.include('<iframe id="hassemu-iframe" src="http://override.local/ui"');
    });

    it("GET / wrapper uses direct-URL mode in iframe", async () => {
      const r1 = await server.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const client = registry.getByCookie(cookie)!;
      client.mode = "http://direct.local/ui";
      const r2 = await server.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(r2.statusCode).to.equal(200);
      expect(r2.body).to.include('<iframe id="hassemu-iframe" src="http://direct.local/ui"');
    });

    it("GET /api/redirect_check returns current target (v1.7.0)", async () => {
      const r1 = await server.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const r2 = await server.inject({
        method: "GET",
        url: "/api/redirect_check",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(r2.statusCode).to.equal(200);
      expect(r2.json()).to.deep.equal({ target: "http://example.com/vis" });
    });

    it("GET /api/redirect_check reflects mode-changes for the same client", async () => {
      const r1 = await server.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r1.headers["set-cookie"])!;
      const client = registry.getByCookie(cookie)!;
      client.mode = MODE_MANUAL;
      client.manualUrl = "http://newurl.local/dashboard";
      const r2 = await server.inject({
        method: "GET",
        url: "/api/redirect_check",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(r2.json()).to.deep.equal({ target: "http://newurl.local/dashboard" });
    });

    it("GET / serves the landing page when nothing is configured", async () => {
      // global empty + no client mode set after creation
      const { s, reg } = await buildServer({ globalMode: null, globalEnabled: false });

      // First clear the default 'global' mode so the resolver returns null
      const r0 = await s.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r0.headers["set-cookie"])!;
      const client = reg.getByCookie(cookie)!;
      client.mode = ""; // user has not picked anything
      const res = await s.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers["content-type"]).to.match(/^text\/html/);
      expect(res.body).to.include("Device ID");
      expect(res.body).to.include("clients.");
      expect(res.body).to.include("banner");
      expect(res.body).to.include("✓");
      await s["app"].close();
    });

    it("GET / landing page honours the ioBroker system language (de)", async () => {
      const { s, reg } = await buildServer({ globalMode: null, globalEnabled: false, systemLanguage: "de" });

      // Force an empty-mode client so the landing page is served
      const r0 = await s.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r0.headers["set-cookie"])!;
      reg.getByCookie(cookie)!.mode = "";
      const res = await s.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(res.body).to.include("Display verbunden");
      expect(res.body).to.include('lang="de"');
      await s["app"].close();
    });

    it("GET / landing page falls back to English for unknown language", async () => {
      const { s, reg } = await buildServer({ globalMode: null, globalEnabled: false, systemLanguage: "eo" });

      const r0 = await s.inject({ method: "GET", url: "/" });
      const cookie = extractCookie(r0.headers["set-cookie"])!;
      reg.getByCookie(cookie)!.mode = "";
      const res = await s.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
      });
      expect(res.body).to.include("Display connected");
      await s["app"].close();
    });

    it("GET /unknown returns 404", async () => {
      const res = await server.inject({ method: "GET", url: "/unknown" });
      expect(res.statusCode).to.equal(404);
      expect((res.json() as { error: string }).error).to.equal("Not Found");
    });
  });

  describe("multi-client", () => {
    it("creates separate records for distinct cookie-less visits", async () => {
      await server.inject({ method: "GET", url: "/" });
      await server.inject({ method: "GET", url: "/" });
      expect(registry.listAll().length).to.equal(2);
    });

    it("creates client state objects in ioBroker (mode + manualUrl)", async () => {
      await server.inject({ method: "GET", url: "/" });
      const clientIds = registry.listAll().map(c => c.id);
      expect(clientIds.length).to.equal(1);
      expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.mode`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.manualUrl`)).to.be.true;
      expect(store.objects.has(`hassemu.0.clients.${clientIds[0]}.visUrl`)).to.be.false;
    });

    it("unknown cookie from another adapter instance creates a new client", async () => {
      const stranger = crypto.randomUUID();
      const res = await server.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=${stranger}` },
      });
      const cookie = extractCookie(res.headers["set-cookie"]);
      expect(cookie).to.match(/^[0-9a-f-]{36}$/);
      expect(cookie).to.not.equal(stranger);
    });

    it("garbage cookie is replaced with a fresh UUID", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/",
        headers: { cookie: `${CLIENT_COOKIE}=not-a-uuid` },
      });
      expect(extractCookie(res.headers["set-cookie"])).to.match(/^[0-9a-f-]{36}$/);
    });
  });

  describe("validation / error handling", () => {
    it("returns 400 for malformed JSON", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/auth/login_flow",
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode).to.equal(400);
    });
  });

  describe("session cleanup", () => {
    it("removes expired sessions", () => {
      server.sessions.set("old", {
        created: Date.now() - 1_000_000_000,
        clientId: null,
      });
      server.sessions.set("fresh", { created: Date.now(), clientId: null });
      server.cleanupSessions();
      expect(server.sessions.has("old")).to.be.false;
      expect(server.sessions.has("fresh")).to.be.true;
    });

    it("is a no-op when nothing has expired", () => {
      server.sessions.set("a", { created: Date.now(), clientId: null });
      server.cleanupSessions();
      expect(server.sessions.size).to.equal(1);
    });

    it("prunes webhook registrations of removed clients, keeps active + unowned ones (v1.35.2)", async () => {
      // Active client: webhook stays. Removed client: webhook pruned.
      // Unowned ("" — authRequired=false registration without Bearer): stays.
      const active = await registry.identifyOrCreate(null, "10.0.0.1", null);
      const removed = await registry.identifyOrCreate(null, "10.0.0.2", null);
      server.webhookRegistrations.set("wh-active", active.id);
      server.webhookRegistrations.set("wh-removed", removed.id);
      server.webhookRegistrations.set("wh-unowned", "");
      await registry.remove(removed.id);

      server.cleanupSessions();

      expect(server.webhookRegistrations.has("wh-active")).to.be.true;
      expect(server.webhookRegistrations.has("wh-unowned")).to.be.true;
      expect(server.webhookRegistrations.has("wh-removed")).to.be.false;
    });

    it("a pruned webhook id falls back to the 200-empty re-registration branch", async () => {
      // End-to-end consequence of the prune: the orphaned display POSTs to its
      // old webhook and must hit the stale-id branch (200 empty body) so the
      // Companion App re-registers — not the typed success responses.
      const removed = await registry.identifyOrCreate(null, "10.0.0.3", null);
      server.webhookRegistrations.set("wh-orphan", removed.id);
      await registry.remove(removed.id);
      server.cleanupSessions();

      const res = await server.inject({
        method: "POST",
        url: "/api/webhook/wh-orphan",
        headers: { "content-type": "application/json" },
        payload: { type: "get_config" },
      });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.equal("");
    });
  });

  describe("sessions cap (security fix v1.2.0)", () => {
    it("drops the oldest session when cap is exceeded", async () => {
      // Fire 105 login_flow calls — cap is 100
      for (let i = 0; i < 105; i++) {
        await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      }
      expect(server.sessions.size).to.be.at.most(100);
    });

    it("a login_flow flood does not evict an in-flight auth code (v1.36.0 S2)", async () => {
      const r1 = await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      const flowId = (r1.json() as { flow_id: string }).flow_id;
      const r2 = await server.inject({ method: "POST", url: `/auth/login_flow/${flowId}`, payload: {} });
      const code = (r2.json() as { result: string }).result;
      expect(server.codeSessions.has(code)).to.be.true;
      // Flood the flow-id map well past its cap — the auth code lives in a separate map.
      for (let i = 0; i < 150; i++) {
        await server.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
      }
      expect(server.codeSessions.has(code)).to.be.true;
      // ...and exchanging the survived code still works.
      const r3 = await server.inject({
        method: "POST",
        url: "/auth/token",
        payload: { grant_type: "authorization_code", code },
      });
      expect(r3.statusCode).to.equal(200);
    });
  });

  describe("auth-required setup tests", () => {
    async function buildAuthServer(): Promise<WebServer> {
      const { s } = await buildServer({ config: { authRequired: true }, authGuard: true });
      return s;
    }

    it("GET /api/redirect_check is whitelisted under authRequired (no Bearer) → 200, not 401 (v1.36.0 C7)", async () => {
      const s = await buildAuthServer();
      try {
        const res = await s.inject({ method: "GET", url: "/api/redirect_check" });
        expect(res.statusCode).to.equal(200);
      } finally {
        await s["app"].close();
      }
    });

    it("POST /auth/token with valid refresh_token returns 200 (C7 v1.11.0)", async () => {
      const s = await buildAuthServer();
      try {
        // Real login first to obtain a valid refresh_token
        const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
        const cookie = extractCookie(r1.headers["set-cookie"])!;
        const flowId = (r1.json() as { flow_id: string }).flow_id;
        const r2 = await s.inject({
          method: "POST",
          url: `/auth/login_flow/${flowId}`,
          headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
          payload: { username: "admin", password: "secret" },
        });
        const code = (r2.json() as { result: string }).result;
        const r3 = await s.inject({
          method: "POST",
          url: "/auth/token",
          payload: { grant_type: "authorization_code", code },
        });
        // v1.31.0: refresh_token stays valid across grants — same token can
        // be used repeatedly until the client logs out / is removed.
        const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;
        for (let i = 0; i < 10; i++) {
          const res = await s.inject({
            method: "POST",
            url: "/auth/token",
            payload: { grant_type: "refresh_token", refresh_token: refreshToken },
          });
          expect(res.statusCode).to.equal(200);
          const body = res.json() as { access_token: string; refresh_token: string };
          expect(body.access_token).to.match(/^[0-9a-f-]{36}$/);
          expect(body.refresh_token).to.equal(refreshToken);
        }
      } finally {
        await s["app"].close();
      }
    });

    it("refresh_token stays valid across multiple grants (v1.31.0 — HA Companion compat)", async () => {
      // v1.31.0: HA Companion (AuthenticationRepositoryImpl.kt:147) stores the
      // refresh_token it SENT, not the one in the response. HA Core itself
      // (auth/__init__.py:334-348) never returns a new refresh_token. v1.28.3
      // (HW5) rotation was RFC 6819 §5.2.2.3 best-practice but broke Companion
      // auth on the first refresh cycle. Token now stays valid until revoked.
      const s = await buildAuthServer();
      try {
        const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
        const cookie = extractCookie(r1.headers["set-cookie"])!;
        const flowId = (r1.json() as { flow_id: string }).flow_id;
        const r2 = await s.inject({
          method: "POST",
          url: `/auth/login_flow/${flowId}`,
          headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
          payload: { username: "admin", password: "secret" },
        });
        const code = (r2.json() as { result: string }).result;
        const r3 = await s.inject({
          method: "POST",
          url: "/auth/token",
          payload: { grant_type: "authorization_code", code },
        });
        const initialRefresh = (r3.json() as { refresh_token: string }).refresh_token;
        const initialAccess = (r3.json() as { access_token: string }).access_token;

        // First refresh: same refresh_token is returned, new access_token is issued
        const r4 = await s.inject({
          method: "POST",
          url: "/auth/token",
          payload: { grant_type: "refresh_token", refresh_token: initialRefresh },
        });
        expect(r4.statusCode).to.equal(200);
        const tokens4 = r4.json() as { access_token: string; refresh_token: string };
        expect(tokens4.access_token).to.match(/^[0-9a-f-]{36}$/);
        expect(tokens4.access_token).to.not.equal(initialAccess);
        expect(tokens4.refresh_token).to.equal(initialRefresh);

        // Same refresh_token still works on a second refresh
        const r5 = await s.inject({
          method: "POST",
          url: "/auth/token",
          payload: { grant_type: "refresh_token", refresh_token: initialRefresh },
        });
        expect(r5.statusCode).to.equal(200);
        const tokens5 = r5.json() as { access_token: string; refresh_token: string };
        expect(tokens5.access_token).to.not.equal(tokens4.access_token);
        expect(tokens5.refresh_token).to.equal(initialRefresh);
      } finally {
        await s["app"].close();
      }
    });

    it("refresh_token persists across adapter restart (v1.31.0)", async () => {
      // End-to-end: token lives in clients.<id>.native.refreshToken — a fresh
      // WebServer + ClientRegistry sharing the SAME ioBroker mock-store finds
      // the token via registry.restore() and accepts the refresh-grant.
      const built = createMockAdapter();
      const reg = new ClientRegistry(built.adapter as never);
      const g = await buildGlobalConfig(built.adapter, "http://example.com/vis", null, true);
      const s1 = new WebServer(
        built.adapter as never,
        { ...baseConfig, authRequired: true },
        reg,
        g,
        crypto.randomUUID(),
      );
      await s1["app"].register((await import("@fastify/cookie")).default);
      await s1["app"].register((await import("@fastify/formbody")).default);
      s1["setupAuthGuard"]();
      s1["setupErrorHandler"]();
      s1["setupRoutes"]();
      await s1["app"].ready();
      try {
        // Initial OAuth → obtain refresh_token persisted to native.refreshToken
        const r1 = await s1.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
        const cookie = extractCookie(r1.headers["set-cookie"])!;
        const flowId = (r1.json() as { flow_id: string }).flow_id;
        const r2 = await s1.inject({
          method: "POST",
          url: `/auth/login_flow/${flowId}`,
          headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
          payload: { username: "admin", password: "secret" },
        });
        const code = (r2.json() as { result: string }).result;
        const r3 = await s1.inject({
          method: "POST",
          url: "/auth/token",
          payload: { grant_type: "authorization_code", code },
        });
        const refreshToken = (r3.json() as { refresh_token: string }).refresh_token;
        await s1["app"].close();

        // Simulate adapter restart: new WebServer + new Registry on same mock store
        const reg2 = new ClientRegistry(built.adapter as never);
        await reg2.restore();
        const s2 = new WebServer(
          built.adapter as never,
          { ...baseConfig, authRequired: true },
          reg2,
          g,
          crypto.randomUUID(),
        );
        await s2["app"].register((await import("@fastify/cookie")).default);
        await s2["app"].register((await import("@fastify/formbody")).default);
        s2["setupAuthGuard"]();
        s2["setupErrorHandler"]();
        s2["setupRoutes"]();
        await s2["app"].ready();
        try {
          // The previously issued refresh_token still works after restart
          const r4 = await s2.inject({
            method: "POST",
            url: "/auth/token",
            payload: { grant_type: "refresh_token", refresh_token: refreshToken },
          });
          expect(r4.statusCode).to.equal(200);
          const body = r4.json() as { access_token: string; refresh_token: string };
          expect(body.access_token).to.match(/^[0-9a-f-]{36}$/);
          expect(body.refresh_token).to.equal(refreshToken);
        } finally {
          await s2["app"].close();
        }
      } finally {
        if (s1["app"].server.listening) {
          await s1["app"].close();
        }
      }
    });

    it("GET /health does not leak adapter config (v1.5.0)", async () => {
      const s = await buildAuthServer();
      try {
        const res = await s.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).to.equal(200);
        const body = res.json() as Record<string, unknown>;
        expect(body).to.have.keys(["status", "adapter", "version"]);
        expect(body).to.not.have.property("config");
      } finally {
        await s["app"].close();
      }
    });

    it("GET /api/discovery_info reports requires_api_password from config (v1.5.0)", async () => {
      const s = await buildAuthServer();
      try {
        const res = await s.inject({ method: "GET", url: "/api/discovery_info" });
        expect(res.statusCode).to.equal(200);
        const body = res.json() as { requires_api_password: boolean };
        // buildAuthServer sets authRequired=true, so discovery_info must mirror that
        expect(body.requires_api_password).to.equal(true);
      } finally {
        await s["app"].close();
      }
    });

    // --- C3: auth pre-handler-guard für /api/* (v1.6.0) ---

    it("GET /api/states without Bearer returns 401 when authRequired=true (v1.6.0)", async () => {
      const s = await buildAuthServer();
      try {
        const res = await s.inject({ method: "GET", url: "/api/states" });
        expect(res.statusCode).to.equal(401);
        const body = res.json() as { error: string };
        expect(body.error).to.equal("unauthorized");
      } finally {
        await s["app"].close();
      }
    });

    it("GET /api/states with invalid Bearer returns 401 (v1.6.0)", async () => {
      const s = await buildAuthServer();
      try {
        const res = await s.inject({
          method: "GET",
          url: "/api/states",
          headers: { authorization: "Bearer invalid-token-12345" },
        });
        expect(res.statusCode).to.equal(401);
        const body = res.json() as { error: string };
        expect(body.error).to.equal("invalid_token");
      } finally {
        await s["app"].close();
      }
    });

    it("GET /api/states with valid Bearer returns 200 (v1.6.0)", async () => {
      const s = await buildAuthServer();
      try {
        // Run a real login to get a valid access token
        const r1 = await s.inject({ method: "POST", url: "/auth/login_flow", payload: {} });
        const cookie = extractCookie(r1.headers["set-cookie"])!;
        const flowId = (r1.json() as { flow_id: string }).flow_id;
        const r2 = await s.inject({
          method: "POST",
          url: `/auth/login_flow/${flowId}`,
          headers: { cookie: `${CLIENT_COOKIE}=${cookie}` },
          payload: { username: "admin", password: "secret" },
        });
        const code = (r2.json() as { result: string }).result;
        const r3 = await s.inject({
          method: "POST",
          url: "/auth/token",
          payload: { grant_type: "authorization_code", code },
        });
        const accessToken = (r3.json() as { access_token: string }).access_token;

        // Now access protected endpoint with the bearer
        const res = await s.inject({
          method: "GET",
          url: "/api/states",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(res.statusCode).to.equal(200);
        expect(res.json()).to.deep.equal([]);
      } finally {
        await s["app"].close();
      }
    });

    it("Whitelisted endpoints stay open without auth even when authRequired=true (v1.6.0)", async () => {
      const s = await buildAuthServer();
      try {
        // /api/ heartbeat
        const r1 = await s.inject({ method: "GET", url: "/api/" });
        expect(r1.statusCode).to.equal(200);
        // /health
        const r2 = await s.inject({ method: "GET", url: "/health" });
        expect(r2.statusCode).to.equal(200);
        // /manifest.json
        const r3 = await s.inject({ method: "GET", url: "/manifest.json" });
        expect(r3.statusCode).to.equal(200);
        // /api/discovery_info — pre-auth probe used by HA-Clients
        const r4 = await s.inject({ method: "GET", url: "/api/discovery_info" });
        expect(r4.statusCode).to.equal(200);
      } finally {
        await s["app"].close();
      }
    });

    it("Auth guard is no-op when authRequired=false (v1.6.0)", async () => {
      // server (top-level beforeEach) uses authRequired=false
      const res = await server.inject({ method: "GET", url: "/api/states" });
      // No 401 — open access since auth is disabled
      expect(res.statusCode).to.equal(200);
    });
  });
});

describe("WebServer bindAddress / start-stop", () => {
  it("defaults to 0.0.0.0 when bindAddress is falsy", async () => {
    const built = createMockAdapter();
    const reg = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://x/");
    const s = new WebServer(
      built.adapter as never,
      { ...baseConfig, port: 0, bindAddress: "" },
      reg,
      g,
      crypto.randomUUID(),
    );
    await s.start();
    const addr = s.boundAddress;
    expect(addr).to.not.be.null;
    expect(["0.0.0.0", "::", "::ffff:0.0.0.0"]).to.include(addr!.address);
    await s.stop();
  });

  it("binds to 127.0.0.1 when configured", async () => {
    const built = createMockAdapter();
    const reg = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://x/");
    const s = new WebServer(
      built.adapter as never,
      { ...baseConfig, port: 0, bindAddress: "127.0.0.1" },
      reg,
      g,
      crypto.randomUUID(),
    );
    await s.start();
    expect(s.boundAddress?.address).to.equal("127.0.0.1");
    await s.stop();
  });

  it("returns null for boundAddress when server not running", async () => {
    const built = createMockAdapter();
    const reg = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://x/");
    const s = new WebServer(built.adapter as never, baseConfig, reg, g, crypto.randomUUID());
    expect(s.boundAddress).to.be.null;
  });

  it("stop() clears the dnsInFlight set so pending lookups do not pin IPs (HW1 v1.28.3)", async () => {
    const built = createMockAdapter();
    const reg = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://x/");
    const s = new WebServer(
      built.adapter as never,
      { ...baseConfig, port: 0, bindAddress: "127.0.0.1" },
      reg,
      g,
      crypto.randomUUID(),
    );
    await s.start();
    // Inject a marker as if a long-running reverse-DNS lookup were in-flight.
    const access = s as unknown as { dnsInFlight: Set<string> };
    access.dnsInFlight.add("203.0.113.42");
    access.dnsInFlight.add("203.0.113.43");
    expect(access.dnsInFlight.size).to.equal(2);
    await s.stop();
    expect(access.dnsInFlight.size).to.equal(0);
  });

  // --- D6: Request-error log cooldown (v1.9.x) ---

  describe("shouldEmitRequestErrorWarn — 5xx log dedup (D6 v1.9.x)", () => {
    const buildCooldownServer = async (): Promise<WebServer> =>
      (await buildServer({ globalMode: "http://x/", globalEnabled: false })).s;

    it("returns true on first occurrence of a message", async () => {
      const s = await buildCooldownServer();
      expect(s.shouldEmitRequestErrorWarn("boom", 1000)).to.be.true;
    });

    it("returns false within cooldown window for same message", async () => {
      const s = await buildCooldownServer();
      s.shouldEmitRequestErrorWarn("boom", 1000);
      // 59s later — still in cooldown (< REQUEST_ERROR_COOLDOWN_MS=60000)
      expect(s.shouldEmitRequestErrorWarn("boom", 60_000)).to.be.false;
    });

    it("returns true after cooldown elapsed for same message", async () => {
      const s = await buildCooldownServer();
      s.shouldEmitRequestErrorWarn("boom", 1000);
      // 61s later — outside cooldown window
      expect(s.shouldEmitRequestErrorWarn("boom", 62_000)).to.be.true;
    });

    it("different messages have independent cooldowns", async () => {
      const s = await buildCooldownServer();
      expect(s.shouldEmitRequestErrorWarn("a", 1000)).to.be.true;
      expect(s.shouldEmitRequestErrorWarn("b", 1001)).to.be.true; // 1ms later, but different key
      expect(s.shouldEmitRequestErrorWarn("a", 1002)).to.be.false; // a is in cooldown
    });

    it("FIFO-caps the cooldown map (E9 + D6 consistency)", async () => {
      const s = await buildCooldownServer();
      for (let i = 0; i < 250; i++) {
        s.shouldEmitRequestErrorWarn(`err-${i}`, 1000 + i);
      }
      const cooldown = (s as unknown as { errorLogCooldown: Map<string, number> }).errorLogCooldown;
      expect(cooldown.size).to.equal(200); // REQUEST_ERROR_COOLDOWN_CAP
      // oldest 50 (err-0..err-49) should be evicted, newest 200 (err-50..err-249) survive
      expect(cooldown.has("err-0")).to.be.false;
      expect(cooldown.has("err-49")).to.be.false;
      expect(cooldown.has("err-50")).to.be.true;
      expect(cooldown.has("err-249")).to.be.true;
    });
  });
});

describe("WebServer /api/websocket (v1.34.0)", () => {
  const TOKEN = "ws-valid-access-token";
  let s: WebServer;
  let reg: ClientRegistry;
  let wsUrl: string;

  /** Buffer all incoming JSON frames; `next()` resolves the oldest unread frame. */
  function wsCollector(ws: WebSocket): { next: () => Promise<Record<string, unknown>> } {
    const queue: Record<string, unknown>[] = [];
    const waiters: ((m: Record<string, unknown>) => void)[] = [];
    ws.on("message", data => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) {
        w(msg);
      } else {
        queue.push(msg);
      }
    });
    return {
      next: () =>
        queue.length
          ? Promise.resolve(queue.shift()!)
          : new Promise<Record<string, unknown>>(resolve => waiters.push(resolve)),
    };
  }

  beforeEach(async () => {
    const built = createMockAdapter();
    reg = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://example.com/vis", null, true);
    s = new WebServer(
      built.adapter as never,
      { ...baseConfig, port: 0, bindAddress: "127.0.0.1", username: "admin", serviceName: "TestServer" },
      reg,
      g,
      "ws-test-uuid-0001",
    );
    await s.start();
    const client = await reg.identifyOrCreate(null, "127.0.0.1", null);
    await reg.setToken(client.id, TOKEN);
    wsUrl = `ws://127.0.0.1:${s.boundAddress!.port}/api/websocket`;
  });

  afterEach(async () => {
    await s.stop();
  });

  it("sends auth_required, then auth_ok for a valid access token", async () => {
    const ws = new WebSocket(wsUrl);
    const col = wsCollector(ws);
    expect(await col.next()).to.deep.equal({ type: "auth_required", ha_version: HA_VERSION });
    ws.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
    expect(await col.next()).to.deep.equal({ type: "auth_ok", ha_version: HA_VERSION });
    ws.close();
  });

  it("rejects an unknown token with auth_invalid and closes the socket", async () => {
    const ws = new WebSocket(wsUrl);
    const col = wsCollector(ws);
    await col.next(); // auth_required
    ws.send(JSON.stringify({ type: "auth", access_token: "bogus-token" }));
    expect((await col.next()).type).to.equal("auth_invalid");
    await once(ws, "close");
  });

  it("answers read-only commands after auth (current_user snake_case, get_config==REST, states/services/ping)", async () => {
    const ws = new WebSocket(wsUrl);
    const col = wsCollector(ws);
    await col.next(); // auth_required
    ws.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
    await col.next(); // auth_ok

    ws.send(JSON.stringify({ id: 1, type: "ping" }));
    expect(await col.next()).to.deep.equal({ id: 1, type: "pong" });

    ws.send(JSON.stringify({ id: 2, type: "auth/current_user" }));
    const cu = await col.next();
    expect(cu).to.deep.include({ id: 2, type: "result", success: true });
    expect(cu.result).to.deep.equal({ id: "ws-test-uuid-0001", name: "admin", is_owner: true, is_admin: true });

    ws.send(JSON.stringify({ id: 3, type: "get_config" }));
    const apiCfg = (await s.inject({ method: "GET", url: "/api/config" })).json();
    expect((await col.next()).result).to.deep.equal(apiCfg);

    ws.send(JSON.stringify({ id: 4, type: "get_states" }));
    expect((await col.next()).result).to.deep.equal([]);

    ws.send(JSON.stringify({ id: 5, type: "get_services" }));
    expect((await col.next()).result).to.deep.equal({});

    ws.send(JSON.stringify({ id: 6, type: "subscribe_events", event_type: "state_changed" }));
    expect(await col.next()).to.deep.include({ id: 6, type: "result", success: true });

    ws.close();
  });

  it("answers the Companion command set @2026.4.4 with grounded empty-HA responses", async () => {
    const ws = new WebSocket(wsUrl);
    const col = wsCollector(ws);
    await col.next(); // auth_required
    ws.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
    await col.next(); // auth_ok

    // Registries on an entity-less emulated server → empty lists.
    for (const [n, cmd] of [
      [10, "config/area_registry/list"],
      [11, "config/device_registry/list"],
      [12, "config/entity_registry/list"],
    ] as const) {
      ws.send(JSON.stringify({ id: n, type: cmd }));
      expect((await col.next()).result, cmd).to.deep.equal([]);
    }

    // Valid subscriptions on an empty server ack (result null) but never emit.
    // Both mobile_app/* commands ack (mobile_app is an advertised component).
    for (const [n, cmd] of [
      [13, "subscribe_events"],
      [14, "subscribe_entities"],
      [15, "supported_features"],
      [16, "mobile_app/push_notification_confirm"],
      [17, "mobile_app/push_notification_channel"],
    ] as const) {
      ws.send(JSON.stringify({ id: n, type: cmd }));
      const r = await col.next();
      expect(r, cmd).to.deep.include({ id: n, type: "result", success: true });
      expect(r.result, cmd).to.equal(null);
    }

    // Commands hassemu does not implement (no services / unadvertised integrations)
    // → ERR_UNKNOWN_COMMAND (verified against HA core websocket_api/const.py), not a
    // fake success or a guessed response shape.
    for (const [n, cmd] of [
      [20, "call_service"],
      [21, "assist_pipeline/pipeline/list"],
      [22, "thread/list_datasets"],
      [23, "matter/commission"],
      [24, "conversation/process"],
      [25, "render_template"],
    ] as const) {
      ws.send(JSON.stringify({ id: n, type: cmd }));
      const r = await col.next();
      expect(r, cmd).to.deep.include({ id: n, type: "result", success: false });
      expect((r.error as { code?: string }).code, cmd).to.equal("unknown_command");
    }

    ws.close();
  });

  it("fails fast: closes the socket if no auth frame arrives within the timeout", async () => {
    // The default mock adapter setTimeout is a no-op; give it a real (clamped)
    // timer so the auth-timeout actually fires quickly in the test.
    const built = createMockAdapter();
    built.adapter.setTimeout = ((cb: () => void, ms: number) => globalThis.setTimeout(cb, Math.min(ms, 40))) as never;
    built.adapter.clearTimeout = ((h: NodeJS.Timeout) => globalThis.clearTimeout(h)) as never;
    const reg2 = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://example.com/vis", null, true);
    const s2 = new WebServer(
      built.adapter as never,
      { ...baseConfig, port: 0, bindAddress: "127.0.0.1" },
      reg2,
      g,
      "ws-timeout-uuid",
    );
    await s2.start();
    const ws = new WebSocket(`ws://127.0.0.1:${s2.boundAddress!.port}/api/websocket`);
    const col = wsCollector(ws);
    expect((await col.next()).type).to.equal("auth_required");
    // Send nothing — the auth timeout must fire, push auth_invalid and close.
    expect((await col.next()).type).to.equal("auth_invalid");
    await once(ws, "close");
    await s2.stop();
  });

  it("with authRequired=true the WS upgrade passes the auth guard (whitelisted) and auths in-band", async () => {
    // Proves the `/api/websocket` whitelist entry: the HTTP upgrade is NOT 401'd
    // by the preHandler when authRequired=true; auth happens in the handshake.
    const built = createMockAdapter();
    const reg2 = new ClientRegistry(built.adapter as never);
    const g = await buildGlobalConfig(built.adapter, "http://example.com/vis", null, true);
    const s2 = new WebServer(
      built.adapter as never,
      { ...baseConfig, port: 0, bindAddress: "127.0.0.1", authRequired: true, username: "admin", password: "secret" },
      reg2,
      g,
      "ws-authreq-uuid",
    );
    await s2.start();
    const client = await reg2.identifyOrCreate(null, "127.0.0.1", null);
    await reg2.setToken(client.id, "authreq-token");
    const ws = new WebSocket(`ws://127.0.0.1:${s2.boundAddress!.port}/api/websocket`);
    const col = wsCollector(ws);
    expect((await col.next()).type).to.equal("auth_required"); // upgrade was not blocked by the guard
    ws.send(JSON.stringify({ type: "auth", access_token: "authreq-token" }));
    expect((await col.next()).type).to.equal("auth_ok");
    ws.close();
    await s2.stop();
  });

  it("ignores a pre-auth non-object frame instead of crashing the adapter (v1.36.0 C1)", async () => {
    const ws = new WebSocket(wsUrl);
    const col = wsCollector(ws);
    expect((await col.next()).type).to.equal("auth_required");
    // JSON.parse("null") === null → dereferencing `null.access_token` in the sync
    // ws message listener would throw an uncaught TypeError and crash the adapter
    // (uncaughtException → js-controller terminate → restart-loop). Arrays and bare
    // primitives are dropped by the same isPlainObject guard.
    ws.send("null");
    ws.send("[1,2,3]");
    ws.send("42");
    // The server must still be alive: a fresh connection completes the handshake.
    const ws2 = new WebSocket(wsUrl);
    const col2 = wsCollector(ws2);
    expect((await col2.next()).type).to.equal("auth_required");
    ws2.send(JSON.stringify({ type: "auth", access_token: TOKEN }));
    expect((await col2.next()).type).to.equal("auth_ok");
    ws.close();
    ws2.close();
  });

  it("closes the connection on an oversized frame above maxPayload (v1.36.0 S3)", async () => {
    const ws = new WebSocket(wsUrl);
    const col = wsCollector(ws);
    await col.next(); // auth_required
    // > WS_MAX_PAYLOAD_BYTES (64 KiB) — ws rejects the frame and closes with 1009.
    ws.send("x".repeat(70 * 1024));
    const [code] = (await once(ws, "close")) as [number, Buffer];
    expect(code).to.equal(1009); // 1009 = message too big
  });
});
