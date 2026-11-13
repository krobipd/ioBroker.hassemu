/**
 * Guard K6 — a display is recognised by its cookie: ten years valid, the same display after a restart, a new address
 * or a new name, a new display once it deleted its data.
 *
 * The page, K6: "On its first visit the display gets a cookie, valid for ten years. By it hassemu recognises it again,
 * also after a restart, with a new IP or a new name. If the display deletes its data, it shows up as a new display."
 * Measured: "All four sentences hold. The old device of a display that deleted its data stays in the object tree
 * until it was not there for 30 days or you remove it. For the apps their sign-in counts as well: if an app deletes
 * only the storage of its page, the page shows up as a new display, the app itself carries on under the old one."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:35 ("k6 yes, if that is
 * so, then it is so").
 *
 * Path: the web server as main.ts starts it (plugins, peer guard, auth guard, routes, listener on a free port),
 * answered by inject from peer addresses of its own network, over an adapter whose object and state database lives in
 * memory; a restart is a new registry and a new web server over the same database and the same data file. The app's
 * device name arrives through the Companion registration route. The host carries one network (192.168.77.0/24); the
 * the data folder is a fresh folder in the temporary directory, written through the data-folder master as on a host.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The instance data folder of the running test. */
const data = vi.hoisted(() => ({ dir: "" }));

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

import { ClientRegistry } from "../lib/client-registry";
import { GlobalConfig } from "../lib/global-config";
import type { AdapterConfig } from "../lib/types";
import { WebServer } from "../lib/webserver";

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): unknown;
}

/** An adapter over a database in memory. */
interface Memory {
  adapter: Record<string, unknown>;
  objects: Map<string, ioBroker.Object>;
  states: Map<string, ioBroker.State>;
}

const NS = "hassemu.0";
const servers: WebServer[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-k06-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  rmSync(data.dir, { recursive: true, force: true });
  data.dir = "";
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
    getStatesAsync: (pattern: string) => {
      // js-controller 7.2.5 getStates: every state object below the pattern, with its value or null.
      const prefix = full(pattern.replace(/\*/g, ""));
      const found: Record<string, ioBroker.State | null> = {};
      for (const [id, obj] of objects) {
        if (obj.type === "state" && id.startsWith(prefix)) {
          found[id] = structuredClone(states.get(id) ?? null);
        }
      }
      return Promise.resolve(found);
    },
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
    delObjectAsync(id: string, options?: { recursive?: boolean }) {
      const key = full(id);
      for (const stored of [...objects.keys()]) {
        if (stored === key || (options?.recursive === true && stored.startsWith(`${key}.`))) {
          objects.delete(stored);
          states.delete(stored);
        }
      }
      return Promise.resolve();
    },
    encrypt(value: string): string {
      return `$/aes-192-cbc:${Buffer.from(value).toString("base64")}`;
    },
    decrypt(value: string): string {
      return Buffer.from(value.replace("$/aes-192-cbc:", ""), "base64").toString();
    },
  };
  return { adapter, objects, states };
}

/**
 * The web server as main.ts starts it over the adapter's database and data file — no address chosen for the displays,
 * so a display's page names it (the landing page).
 *
 * @param mem the adapter
 */
async function started(mem: Memory): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, data.dir);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired: false,
    username: "admin",
    password: "",
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
 * One request to the server from a peer address.
 *
 * @param server the server
 * @param peer the peer address on the socket
 * @param method the method
 * @param url the path
 * @param extra cookie, Bearer token, form or JSON body
 * @param extra.cookie the display's cookie header
 * @param extra.bearer an access token for the Authorization header
 * @param extra.form a form body
 * @param extra.json a JSON body
 */
function ask(
  server: WebServer,
  peer: string,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; bearer?: string; form?: Record<string, string>; json?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (extra.cookie) {
    headers.cookie = extra.cookie;
  }
  if (extra.bearer) {
    headers.authorization = `Bearer ${extra.bearer}`;
  }
  let payload: string | undefined;
  if (extra.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(extra.form).toString();
  } else if (extra.json) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(extra.json);
  }
  return server.inject({ method, url, headers, payload, remoteAddress: peer });
}

/**
 * The Set-Cookie header of an answer as one string, empty when there is none.
 *
 * @param answer the answer
 */
function setCookieOf(answer: Answer): string {
  const raw = answer.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
}

/**
 * The display cookie an answer sets, as a Cookie header, empty when it sets none.
 *
 * @param answer the answer
 */
function cookieOf(answer: Answer): string {
  return /hassemu_client=[^;]+/.exec(setCookieOf(answer))?.[0] ?? "";
}

/**
 * The ids of the devices under clients.
 *
 * @param mem the adapter
 */
function displays(mem: Memory): string[] {
  return [...mem.objects]
    .filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device")
    .map(([id]) => id.slice(`${NS}.clients.`.length));
}

/**
 * The name a device carries, as text over every language.
 *
 * @param mem the adapter
 * @param id the display id
 */
function nameOf(mem: Memory, id: string): string {
  return JSON.stringify(mem.objects.get(`${NS}.clients.${id}`)?.common.name ?? null);
}

/**
 * Run the sign-in a display or app makes (login flow, code, token) and return the access token.
 *
 * @param server the server
 * @param peer the peer address
 * @param cookie the display's cookie header
 */
async function signIn(server: WebServer, peer: string, cookie: string): Promise<string> {
  const flow = (await ask(server, peer, "POST", "/auth/login_flow", { cookie, form: {} })).json() as {
    flow_id?: string;
  };
  const done = (
    await ask(server, peer, "POST", `/auth/login_flow/${flow.flow_id ?? ""}`, { cookie, form: {} })
  ).json() as { result?: string };
  const token = (
    await ask(server, peer, "POST", "/auth/token", {
      cookie,
      form: { grant_type: "authorization_code", code: done.result ?? "" },
    })
  ).json() as { access_token?: string };
  return token.access_token ?? "";
}

describe("K6: a display is recognised by its cookie", () => {
  it("gives a display on its first visit the cookie hassemu_client, valid for ten years, HttpOnly, SameSite=Lax", async () => {
    const mem = memory();
    const server = await started(mem);
    const peer = "192.168.77.50";

    const first = await ask(server, peer, "GET", "/");
    const setCookie = setCookieOf(first);
    const again = await ask(server, peer, "GET", "/", { cookie: cookieOf(first) });

    expect({
      status: first.statusCode,
      name: /^hassemu_client=/.test(setCookie),
      uuid: /^hassemu_client=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12};/i.test(setCookie),
      maxAge: /;\s*Max-Age=(\d+)/i.exec(setCookie)?.[1],
      httpOnly: /;\s*HttpOnly(;|$)/i.test(setCookie),
      sameSite: /;\s*SameSite=([A-Za-z]+)/i.exec(setCookie)?.[1],
      path: /;\s*Path=([^;]+)/i.exec(setCookie)?.[1],
    }).toEqual({
      status: 200,
      name: true,
      uuid: true,
      maxAge: "315360000",
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    expect({ displays: displays(mem).length, againSetsCookie: setCookieOf(again) }).toEqual({
      displays: 1,
      againSetsCookie: "",
    });
  });

  it("recognises the display by its cookie after a restart, from a new address and under a new name", async () => {
    const mem = memory();
    const before = await started(mem);
    const first = await ask(before, "192.168.77.50", "GET", "/");
    const cookie = cookieOf(first);
    const [id] = displays(mem);
    const token = await signIn(before, "192.168.77.50", cookie);
    const registration = await ask(before, "192.168.77.50", "POST", "/api/mobile_app/registrations", {
      bearer: token,
      json: { app_id: "io.homeassistant.companion.android", device_name: "Kitchen panel" },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const renamed = nameOf(mem, id);
    await before.stop();

    const after = await started(mem);
    const back = await ask(after, "192.168.77.60", "GET", "/", { cookie });

    expect({ registered: registration.statusCode, renamed: renamed.includes("Kitchen panel") }).toEqual({
      registered: 201,
      renamed: true,
    });
    expect({
      status: back.statusCode,
      setsCookie: setCookieOf(back),
      displays: displays(mem),
      pageNamesIt: back.body.includes(`${NS}.clients.${id}`),
    }).toEqual({
      status: 200,
      setsCookie: "",
      displays: [id],
      pageNamesIt: true,
    });
  });

  it("shows a display that deleted its data as a new display; the old device stays and the app keeps it", async () => {
    const mem = memory();
    const server = await started(mem);
    const peer = "192.168.77.50";
    const first = await ask(server, peer, "GET", "/");
    const oldCookie = cookieOf(first);
    const [oldId] = displays(mem);
    const token = await signIn(server, peer, oldCookie);

    const wiped = await ask(server, peer, "GET", "/");
    const newCookie = cookieOf(wiped);
    const newId = displays(mem).find(id => id !== oldId) ?? "";
    const newNameBefore = nameOf(mem, newId);
    const app = await ask(server, peer, "POST", "/api/mobile_app/registrations", {
      bearer: token,
      json: { app_id: "io.homeassistant.companion.android", device_name: "Hall app" },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect({
      newCookie: newCookie !== "" && newCookie !== oldCookie,
      newDisplay: newId !== "" && newId !== oldId,
      pageNamesNew: wiped.body.includes(`${NS}.clients.${newId}`),
      oldStays: displays(mem).includes(oldId),
      count: displays(mem).length,
    }).toEqual({ newCookie: true, newDisplay: true, pageNamesNew: true, oldStays: true, count: 2 });
    expect({
      registered: app.statusCode,
      appOnOld: nameOf(mem, oldId).includes("Hall app"),
      newUntouched: nameOf(mem, newId) === newNameBefore && !newNameBefore.includes("Hall app"),
    }).toEqual({ registered: 201, appOnOld: true, newUntouched: true });
  });
});
