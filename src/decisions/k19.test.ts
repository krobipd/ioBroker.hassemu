/**
 * Guard K19 — a foreign address that wants the access code gets a page with a "Continue" button first; only the Home
 * Assistant app and the address the request came from get it without asking.
 *
 * The page, K19: "If at sign-in a foreign address wants the access code, hassemu first shows a page with the button
 * 'Continue'. Without asking, only the Home Assistant app and the address the request came from get it."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:56 ("k19 sounds ok").
 *
 * Path: the web server as main.ts starts it (plugins, peer guard, auth guard, routes, listener on a free port), asked
 * for /auth/authorize by inject from a peer address of its own network on the Host the display reaches hassemu by —
 * GET without sign-in, POST with sign-in — over an adapter whose object and state database lives in memory. The host
 * carries one network (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import type * as Os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));
vi.mock("node:dns/promises", () => ({
  default: {
    reverse: (): Promise<string[]> => Promise.resolve([]),
    Resolver: class {
      setLocalAddress(): void {}
      reverse(): Promise<string[]> {
        return Promise.resolve([]);
      }
    },
  },
}));
vi.mock("node:os", async importOriginal => {
  const real = await importOriginal<typeof Os>();
  const networkInterfaces = (): ReturnType<typeof real.networkInterfaces> => ({
    eth0: [
      {
        address: "192.168.77.10",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "02:00:00:00:00:01",
        internal: false,
        cidr: "192.168.77.10/24",
      },
    ],
  });
  return { ...real, networkInterfaces, default: { ...real, networkInterfaces } };
});
vi.mock("../lib/data-file", () => ({
  readDataFile: (dir: string, file: string): { value?: unknown } => {
    const raw = files.get(`${dir}/${file}`);
    return raw === undefined ? {} : { value: JSON.parse(raw) as unknown };
  },
  writeDataFile: (dir: string, file: string, value: unknown): void => {
    files.set(`${dir}/${file}`, JSON.stringify(value));
  },
}));

import { ClientRegistry } from "../lib/client-registry";
import { GlobalConfig } from "../lib/global-config";
import type { AdapterConfig } from "../lib/types";
import { WebServer } from "../lib/webserver";

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}

/** An adapter over a database in memory. */
interface Memory {
  adapter: Record<string, unknown>;
  objects: Map<string, ioBroker.Object>;
}

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const PEER = "192.168.77.50";
const HOST = "192.168.77.10:8123";
const PASSWORD = "guard-secret";
const FOREIGN_CLIENT = "http://192.168.77.99:8080/";
const FOREIGN_TARGET = "http://192.168.77.99:8080/callback";
const OWN_CLIENT = "http://192.168.77.10:8123/";
const OWN_TARGET = "http://192.168.77.10:8123/auth-done";
const APP_TARGET = "homeassistant://auth-callback";
const servers: WebServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  files.clear();
});

/**
 * Merge a patch into an object the way js-controller's extendObject does: plain objects key by key, everything else
 * replaced.
 *
 * @param base the stored value
 * @param patch the patch
 */
function merged(base: unknown, patch: unknown): unknown {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(base) || !plain(patch)) {
    return structuredClone(patch);
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = merged(base[key], value);
  }
  return out;
}

/** An adapter whose database lives in memory. */
function memory(): Memory {
  const objects = new Map<string, ioBroker.Object>();
  const states = new Map<string, ioBroker.State>();
  const full = (id: string): string => (id.startsWith(`${NS}.`) ? id : `${NS}.${id}`);
  const noop = (): void => undefined;
  const adapter: Record<string, unknown> = {
    namespace: NS,
    log: { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: "info" },
    setInterval: () => ({}),
    clearInterval: noop,
    setTimeout: () => undefined,
    clearTimeout: noop,
    getForeignObjectsAsync(pattern: string, type?: string) {
      const prefix = pattern.replace(/\*$/, "");
      const wanted = type ?? "state";
      const found = [...objects].filter(([id, obj]) => id.startsWith(prefix) && obj.type === wanted);
      return Promise.resolve(structuredClone(Object.fromEntries(found)));
    },
    getForeignObjectAsync: (id: string) => Promise.resolve(structuredClone(objects.get(id) ?? null)),
    getAdapterObjectsAsync: () =>
      Promise.resolve(structuredClone(Object.fromEntries([...objects].filter(([id]) => id.startsWith(`${NS}.`))))),
    getObjectAsync: (id: string) => Promise.resolve(structuredClone(objects.get(full(id)) ?? null)),
    getStateAsync: (id: string) => Promise.resolve(structuredClone(states.get(full(id)) ?? null)),
    setObjectNotExistsAsync(id: string, obj: ioBroker.Object) {
      if (!objects.has(full(id))) {
        objects.set(full(id), { ...structuredClone(obj), _id: full(id) } as ioBroker.Object);
      }
      return Promise.resolve({ id: full(id) });
    },
    extendObject(id: string, patch: Partial<ioBroker.Object>) {
      objects.set(full(id), {
        ...(merged(objects.get(full(id)) ?? {}, patch) as object),
        _id: full(id),
      } as ioBroker.Object);
      return Promise.resolve({ id: full(id) });
    },
    setState(id: string, state: ioBroker.SettableState) {
      states.set(full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve(full(id));
    },
    setStateChangedAsync(id: string, state: ioBroker.SettableState) {
      const before = states.get(full(id));
      const value = (state as ioBroker.State).val;
      if (before && before.val === value && before.ack === ((state as ioBroker.State).ack ?? false)) {
        return Promise.resolve({ id: full(id), notChanged: true });
      }
      states.set(full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve({ id: full(id), notChanged: false });
    },
  };
  return { adapter, objects };
}

/**
 * The web server as main.ts starts it.
 *
 * @param mem the adapter
 * @param authRequired whether the display signs in with user name and password
 */
async function started(mem: Memory, authRequired: boolean): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired,
    username: "admin",
    password: PASSWORD,
    mdnsEnabled: false,
    serviceName: "ioBroker",
  };
  const server = new WebServer(mem.adapter as never, config, registry, global, registry.serverUuid, "en", () =>
    Promise.resolve(true),
  );
  servers.push(server);
  await server.start();
  return server;
}

/**
 * The authorize request a display's browser sends, on the Host it reaches hassemu by.
 *
 * @param server the server
 * @param method GET (no sign-in) or POST (the sign-in form)
 * @param clientId the OAuth2 client_id
 * @param redirectUri the OAuth2 redirect_uri the code goes to
 */
function authorize(server: WebServer, method: "GET" | "POST", clientId: string, redirectUri: string): Promise<Answer> {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "s1",
  };
  const headers: Record<string, string> = {
    host: HOST,
    "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)",
  };
  if (method === "GET") {
    return server.inject({
      method,
      url: `/auth/authorize?${new URLSearchParams(params).toString()}`,
      headers,
      remoteAddress: PEER,
    });
  }
  headers["content-type"] = "application/x-www-form-urlencoded";
  return server.inject({
    method,
    url: "/auth/authorize",
    headers,
    payload: new URLSearchParams({ ...params, username: "admin", password: PASSWORD }).toString(),
    remoteAddress: PEER,
  });
}

/** How an authorize answer hands the code over. */
interface Handover {
  status: number;
  /** The target of a "Continue" button, or null without such a button. */
  button: string | null;
  /** The target of a meta refresh that forwards at once, or null without one. */
  refresh: string | null;
  /** The page forwards by script. */
  script: boolean;
}

/**
 * Read from an authorize answer whether it asks with a button or forwards by itself.
 *
 * @param answer the answer
 */
function handover(answer: Answer): Handover {
  const unescape = (text: string): string => text.replace(/&amp;/g, "&");
  const button = /<a class="button" href="([^"]*)">/.exec(answer.body)?.[1];
  const refresh = /<meta http-equiv="refresh" content="0; URL=([^"]*)">/.exec(answer.body)?.[1];
  return {
    status: answer.statusCode,
    button: button === undefined ? null : unescape(button),
    refresh: refresh === undefined ? null : unescape(refresh),
    script: /document\.location\.assign\(/.test(answer.body),
  };
}

/**
 * A target with the code and the round-tripped state appended, as the pattern the answer must carry.
 *
 * @param redirectUri the redirect_uri
 */
function withCode(redirectUri: string): RegExp {
  const escaped = redirectUri.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`^${escaped}\\?code=[0-9a-f-]{36}&state=s1$`);
}

describe("K19: a foreign target gets a Continue page; only the app and the request's own host get the code at once", () => {
  it("asks with a Continue button before handing the code to a foreign address, with and without sign-in", async () => {
    const open = await started(memory(), false);
    const signIn = await started(memory(), true);

    const withoutSignIn = handover(await authorize(open, "GET", FOREIGN_CLIENT, FOREIGN_TARGET));
    const afterSignIn = handover(await authorize(signIn, "POST", FOREIGN_CLIENT, FOREIGN_TARGET));

    for (const page of [withoutSignIn, afterSignIn]) {
      expect(page).toEqual({
        status: 200,
        button: expect.stringMatching(withCode(FOREIGN_TARGET)) as unknown,
        refresh: null,
        script: false,
      });
    }
  });

  it("hands the code over at once to the Home Assistant apps and to the address of the request itself", async () => {
    const open = await started(memory(), false);
    const signIn = await started(memory(), true);

    const android = handover(await authorize(open, "GET", "https://home-assistant.io/android", APP_TARGET));
    const ios = handover(await authorize(open, "GET", "https://home-assistant.io/iOS", APP_TARGET));
    const ownHost = handover(await authorize(open, "GET", OWN_CLIENT, OWN_TARGET));
    const appAfterSignIn = handover(await authorize(signIn, "POST", "https://home-assistant.io/android", APP_TARGET));

    for (const [page, target] of [
      [android, APP_TARGET],
      [ios, APP_TARGET],
      [ownHost, OWN_TARGET],
      [appAfterSignIn, APP_TARGET],
    ] as const) {
      expect(page).toEqual({
        status: 200,
        button: null,
        refresh: expect.stringMatching(withCode(target)) as unknown,
        script: true,
      });
    }
  });
});
