/**
 * Guard Z-01 — what hassemu is for: a device that can only show a Home Assistant dashboard shows a page of the user's
 * choice instead; hassemu presents itself as a Home Assistant server, lets the display run through the sign-in and
 * forwards it to the chosen address; it switches nothing in ioBroker and writes no foreign datapoint; its port belongs
 * in the own network; at the one-time move of K7 it enters the new id into rooms, functions and aliases and writes no
 * value into a foreign datapoint then either.
 *
 * The page, Z-01: "Devices that can only show a Home Assistant dashboard show a page of your choice instead: VIS,
 * VIS-2, Aura, Grafana or any other web address." "hassemu presents itself on the network as a Home Assistant server,
 * lets the display run through the sign-in and then forwards it to the chosen address." "It switches nothing in
 * ioBroker and writes no foreign datapoint. Its port belongs in the own network, never on the internet."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 18:10 ("z01 and ha01 are ok
 * so far"); the clarification of 2026-11-12 about the one-time move stands on the same card.
 *
 * Path: the web server as main.ts starts it (plugins, peer guard, auth guard, routes, listener on a free port),
 * answered by inject from a peer address, over an adapter whose object and state database lives in memory and that
 * records every write, deletion and message that reaches an id outside its own namespace; the move runs through the
 * registry's restore as main.ts starts it, over the same adapter. The host carries one network (192.168.77.0/24); the
 * data folder is a map in memory, since a guard writes no file.
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
  json(): unknown;
}

/** An adapter over a database in memory, with what it wrote outside its own namespace. */
interface Memory {
  adapter: Record<string, unknown>;
  objects: Map<string, ioBroker.Object>;
  states: Map<string, ioBroker.State>;
  /** Every write, deletion or message to an id outside the own namespace, as `method(id)`. */
  foreign: string[];
  /** Every value written to an id outside the own namespace, as `method(id)`. */
  foreignValues: string[];
}

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const TARGET = "http://192.168.77.20:8082/vis-2/index.html?main";
/** Pages of a user's choice — a VIS-2 project, Grafana, any other web address. */
const CHOICES = [TARGET, "http://192.168.77.30:3000/d/house/overview?kiosk", "http://192.168.77.40:8080/panel.html"];
/** Home Assistant core's own answer on /api/ (homeassistant/components/api/__init__.py, APIStatusView). */
const HA_API_ANSWER = { message: "API running." };
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

/** An adapter whose database lives in memory; every write, deletion and message outside its namespace is recorded. */
function memory(): Memory {
  const objects = new Map<string, ioBroker.Object>();
  const states = new Map<string, ioBroker.State>();
  const foreign: string[] = [];
  const foreignValues: string[] = [];
  const full = (id: string): string => (id.startsWith(`${NS}.`) ? id : `${NS}.${id}`);
  const noop = (): void => undefined;
  const base: Record<string, unknown> = {
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
  };
  /**
   * Whether an id lies outside the own namespace.
   *
   * @param id the full id
   */
  const outside = (id: string): boolean => !id.startsWith(`${NS}.`);
  /** The foreign-id methods as js-controller runs them on the database. */
  const foreignMethods: Record<string, (id: string, arg?: unknown) => Promise<unknown>> = {
    setForeignObject(id, obj) {
      objects.set(id, { ...structuredClone(obj as object), _id: id } as ioBroker.Object);
      return Promise.resolve({ id });
    },
    extendForeignObjectAsync(id, patch) {
      objects.set(id, { ...(merged(objects.get(id) ?? {}, patch) as object), _id: id } as ioBroker.Object);
      return Promise.resolve({ id });
    },
    delForeignObjectAsync(id) {
      objects.delete(id);
      states.delete(id);
      return Promise.resolve();
    },
  };
  const adapter = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^((set|del|extend)Foreign|sendTo)/.test(prop)) {
        return (...args: unknown[]) => {
          const id = String(args[0]);
          if (prop.startsWith("sendTo") || outside(id)) {
            foreign.push(`${prop}(${id})`);
          }
          if (/^setForeignState/.test(prop)) {
            if (outside(id)) {
              foreignValues.push(`${prop}(${id})`);
            }
            states.set(id, { ...(args[1] as ioBroker.State), ts: Date.now(), lc: Date.now() });
            return Promise.resolve(id);
          }
          return foreignMethods[prop]?.(id, args[1]) ?? Promise.resolve();
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { adapter, objects, states, foreign, foreignValues };
}

/**
 * The web server as main.ts starts it, every display following the global address, the master switch on.
 *
 * @param mem the adapter
 * @param target the address the user chose
 */
async function started(mem: Memory, target = TARGET): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  await global.handleModeWrite(target);
  await global.handleEnabledWrite(true);
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
 * @param extra cookie, form body
 * @param extra.cookie the display's cookie header
 * @param extra.form a form body
 */
function ask(
  server: WebServer,
  peer: string,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; form?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (extra.cookie) {
    headers.cookie = extra.cookie;
  }
  if (extra.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const payload = extra.form ? new URLSearchParams(extra.form).toString() : undefined;
  return server.inject({ method, url, headers, payload, remoteAddress: peer });
}

/**
 * The devices under clients.
 *
 * @param mem the adapter
 */
function displays(mem: Memory): string[] {
  return [...mem.objects]
    .filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device")
    .map(([id]) => id);
}

/**
 * A display's whole visit: its first request, the sign-in (login flow, code, token) and its page afterwards.
 *
 * @param server the server
 * @param peer the peer address on the socket
 */
async function displayVisits(server: WebServer, peer: string): Promise<{ token: Answer; page: Answer }> {
  const first = await ask(server, peer, "GET", "/");
  const raw = first.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  const cookie = /hassemu_client=[^;]+/.exec(setCookie)?.[0] ?? "";
  const flow = (await ask(server, peer, "POST", "/auth/login_flow", { cookie, form: {} })).json() as {
    flow_id?: string;
  };
  const done = (
    await ask(server, peer, "POST", `/auth/login_flow/${flow.flow_id ?? ""}`, { cookie, form: {} })
  ).json() as { result?: string };
  const token = await ask(server, peer, "POST", "/auth/token", {
    cookie,
    form: { grant_type: "authorization_code", code: done.result ?? "" },
  });
  const page = await ask(server, peer, "GET", "/", { cookie });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { token, page };
}

/**
 * Whether an answer sends the display on to an address: a forwarding header to it, or the page carries it.
 *
 * @param answer the answer
 * @param address the address
 */
function leadsTo(answer: Answer, address: string): boolean {
  const location = answer.headers.location;
  return location === address || answer.body.replace(/&amp;/g, "&").includes(address);
}

/**
 * A display as an installation up to 1.46.1 holds it: `clients.<six hex characters>`, its cookie in the device's
 * `native`, its datapoints with their values.
 *
 * @param mem the adapter
 * @param oldId the six hex characters
 */
function seedOldDisplay(mem: Memory, oldId: string): void {
  const device = `${NS}.clients.${oldId}`;
  mem.objects.set(device, {
    _id: device,
    type: "device",
    common: { name: { en: "192.168.77.71" } },
    native: { cookie: "6f9c2d1e-0b7a-4c3e-9a51-2d8e4f7a1c01", token: null, tokenExpiresAt: null, refreshToken: null },
  } as unknown as ioBroker.Object);
  const datapoints: [string, Record<string, unknown>, ioBroker.StateValue][] = [
    ["mode", { type: "string", role: "text", read: true, write: true, def: "0", states: { 0: "---" } }, "0"],
    ["manualUrl", { type: "string", role: "url", read: true, write: true, def: "" }, ""],
    ["ip", { type: "string", role: "info.ip", read: true, write: false, def: "" }, "192.168.77.71"],
    ["resolvedUrl", { type: "string", role: "url", read: true, write: false, def: "" }, ""],
    ["remove", { type: "boolean", role: "button", read: false, write: true, def: false }, false],
  ];
  for (const [key, common, val] of datapoints) {
    const id = `${device}.${key}`;
    mem.objects.set(id, { _id: id, type: "state", common: { name: key, ...common }, native: {} } as ioBroker.Object);
    mem.states.set(id, { val, ack: true, ts: 1, lc: 1, from: `system.adapter.${NS}` });
  }
}

describe("Z-01: what hassemu is for", () => {
  it("presents itself on the network as a Home Assistant server", async () => {
    const server = await started(memory());

    const api = await ask(server, "192.168.77.50", "GET", "/api/");

    expect(api.json()).toEqual(HA_API_ANSWER);
  });

  it("lets the display run through the sign-in", async () => {
    const server = await started(memory());

    const { token } = await displayVisits(server, "192.168.77.50");

    expect(typeof (token.json() as { access_token?: unknown }).access_token).toBe("string");
  });

  it("then forwards it to the chosen address: the page of the user's choice — VIS-2, Grafana or any other web address", async () => {
    const forwarded: Record<string, boolean> = {};
    for (const choice of CHOICES) {
      const server = await started(memory(), choice);
      const { page } = await displayVisits(server, "192.168.77.50");
      forwarded[choice] = leadsTo(page, choice);
    }

    expect(forwarded).toEqual(Object.fromEntries(CHOICES.map(choice => [choice, true])));
  });

  it("switches nothing in ioBroker and writes no foreign datapoint", async () => {
    const mem = memory();
    const server = await started(mem);

    await displayVisits(server, "192.168.77.50");

    expect(mem.foreign).toEqual([]);
  });

  it("its port belongs in the own network: a request from outside it gets no page and no display", async () => {
    const mem = memory();
    const server = await started(mem);

    const stranger = await ask(server, "203.0.113.7", "GET", "/");
    await new Promise(resolve => setTimeout(resolve, 0));

    expect({ page: stranger.body, displays: displays(mem) }).toEqual({ page: "", displays: [] });
  });

  it("at the one-time move of K7 it enters the new id into rooms, functions and aliases, and writes no value into a foreign datapoint", async () => {
    const mem = memory();
    seedOldDisplay(mem, "61c3a1");
    mem.objects.set("enum.rooms.kitchen", {
      _id: "enum.rooms.kitchen",
      type: "enum",
      common: { name: "Kitchen", members: [`${NS}.clients.61c3a1`] },
      native: {},
    } as unknown as ioBroker.Object);
    mem.objects.set("enum.functions.screen", {
      _id: "enum.functions.screen",
      type: "enum",
      common: { name: "Screen", members: [`${NS}.clients.61c3a1.mode`] },
      native: {},
    } as unknown as ioBroker.Object);
    mem.objects.set("alias.0.kitchen.screen", {
      _id: "alias.0.kitchen.screen",
      type: "state",
      common: {
        name: "screen",
        type: "string",
        role: "text",
        read: true,
        write: true,
        alias: { id: `${NS}.clients.61c3a1.mode` },
      },
      native: {},
    } as unknown as ioBroker.Object);

    const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
    await registry.restore();
    const moved = registry.getByCookie("6f9c2d1e-0b7a-4c3e-9a51-2d8e4f7a1c01")?.id;
    if (moved === undefined || moved === "61c3a1") {
      throw new Error(`the display of the old id form did not move (${String(moved)})`);
    }

    expect({
      rooms: mem.objects.get("enum.rooms.kitchen")?.common.members,
      functions: mem.objects.get("enum.functions.screen")?.common.members,
      alias: (mem.objects.get("alias.0.kitchen.screen")?.common as { alias?: { id?: unknown } }).alias?.id,
      foreignValues: mem.foreignValues,
    }).toEqual({
      rooms: [`${NS}.clients.${moved}`],
      functions: [`${NS}.clients.${moved}.mode`],
      alias: `${NS}.clients.${moved}.mode`,
      foreignValues: [],
    });
  });
});
