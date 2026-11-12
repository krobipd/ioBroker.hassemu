/**
 * Guard K18 — a bare reachability test creates no display: HEAD without a cookie and /health leave the object tree
 * alone; a display comes into being only when a device fetches a page.
 *
 * The page, K18: "A test that only asks 'are you there?' and fetches no page creates no display. For monitoring
 * programs there is the own address /health as well, which answers only 'running'. A display comes into being only
 * when a device really fetches a page."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:58 ("k18 is thus legit,
 * ok").
 *
 * Path: the web server as main.ts starts it (plugins, peer guard, auth guard, routes, listener on a free port),
 * answered by inject from a peer address of its own network without a cookie — HEAD on the page and on the poll route,
 * GET on /health, then GET on the page — over an adapter whose object and state database lives in memory. The host
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
 * The web server as main.ts starts it, no address chosen for the displays.
 *
 * @param mem the adapter
 */
async function started(mem: Memory): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
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
 * One request without a cookie from a peer address.
 *
 * @param server the server
 * @param peer the peer address on the socket
 * @param method the method
 * @param url the path
 */
function ask(server: WebServer, peer: string, method: "GET" | "HEAD", url: string): Promise<Answer> {
  return server.inject({
    method,
    url,
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" },
    remoteAddress: peer,
  });
}

/**
 * Whether an answer sets the display cookie.
 *
 * @param answer the answer
 */
function setsCookie(answer: Answer): boolean {
  const raw = answer.headers["set-cookie"];
  const text = Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
  return /hassemu_client=/.test(text);
}

/**
 * The number of devices under clients.
 *
 * @param mem the adapter
 */
function displayCount(mem: Memory): number {
  return [...mem.objects].filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device").length;
}

describe("K18: a bare reachability test creates no display; a fetched page does", () => {
  it("answers HEAD without a cookie and /health without creating a display, and creates one for GET /", async () => {
    const mem = memory();
    const server = await started(mem);
    const peer = "192.168.77.50";

    const headPage = await ask(server, peer, "HEAD", "/");
    const headPoll = await ask(server, peer, "HEAD", "/api/redirect_check");
    const health = await ask(server, peer, "GET", "/health");
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterTests = displayCount(mem);
    const page = await ask(server, peer, "GET", "/");
    await new Promise(resolve => setTimeout(resolve, 0));

    expect({
      headPage: { status: headPage.statusCode, cookie: setsCookie(headPage) },
      headPoll: { status: headPoll.statusCode, cookie: setsCookie(headPoll) },
      health: {
        status: health.statusCode,
        cookie: setsCookie(health),
        running: (JSON.parse(health.body) as { status?: unknown }).status,
      },
      afterTests,
    }).toEqual({
      headPage: { status: 200, cookie: false },
      headPoll: { status: 200, cookie: false },
      health: { status: 200, cookie: false, running: "ok" },
      afterTests: 0,
    });
    expect({ page: page.statusCode, cookie: setsCookie(page), displays: displayCount(mem) }).toEqual({
      page: 200,
      cookie: true,
      displays: 1,
    });
  });
});
