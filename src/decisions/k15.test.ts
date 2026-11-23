/**
 * Guard K15 — per hour hassemu creates at most 30 new displays from one address and at most 100 in all; whatever comes
 * above that is served but gets no entry in the object tree.
 *
 * The page, K15: "Per hour hassemu creates at most 30 new displays from one address and at most 100 in all. Whatever
 * comes beyond that is served, but gets no entry in the object tree."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:55 ("k14, k15 are ok").
 *
 * Path: the web server as main.ts starts it (plugins, peer guard, auth guard, routes, listener on a free port),
 * answered by inject from peer addresses of its own network — first visits without a cookie, one at a time — over an
 * adapter whose object and state database lives in memory. Only the clock is faked, to let an hour pass. The host
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
const HOUR_MS = 60 * 60 * 1000;
const servers: WebServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
 * A first visit without a cookie from a peer address — what a display that is new to hassemu sends.
 *
 * @param server the server
 * @param peer the peer address on the socket
 */
function firstVisit(server: WebServer, peer: string): Promise<Answer> {
  return server.inject({
    method: "GET",
    url: "/",
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" },
    remoteAddress: peer,
  });
}

/**
 * The ids of every object the adapter holds.
 *
 * @param mem the adapter
 */
function objectIds(mem: Memory): string[] {
  return [...mem.objects.keys()].sort();
}

/**
 * The number of devices under clients.
 *
 * @param mem the adapter
 */
function displayCount(mem: Memory): number {
  return [...mem.objects].filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device").length;
}

/**
 * First visits until the given number of displays exists — the start of a case, not its claim.
 *
 * @param server the server
 * @param mem the adapter
 * @param peers the peer addresses, each visiting `each` times
 * @param each the visits per address
 */
async function filled(server: WebServer, mem: Memory, peers: string[], each: number): Promise<Answer> {
  let last: Answer | undefined;
  for (const peer of peers) {
    for (let i = 0; i < each; i++) {
      last = await firstVisit(server, peer);
    }
  }
  if (!last || displayCount(mem) !== peers.length * each) {
    throw new Error(`the case needs ${peers.length * each} displays, there are ${displayCount(mem)}`);
  }
  return last;
}

describe("K15: per hour at most 30 new displays from one address and 100 in all; beyond that served, no entry", () => {
  it("creates no 31st display from one address within the hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
    const mem = memory();
    const server = await started(mem);
    await filled(server, mem, ["192.168.77.50"], 30);

    await firstVisit(server, "192.168.77.50");

    expect(displayCount(mem)).toBe(30);
  });

  it("creates no 101st display in all within the hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
    const mem = memory();
    const server = await started(mem);
    await filled(server, mem, ["192.168.77.101", "192.168.77.102", "192.168.77.103", "192.168.77.104"], 25);

    await firstVisit(server, "192.168.77.105");

    expect(displayCount(mem)).toBe(100);
  });

  it("the limits hold per hour: in the next hour a new display is created again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
    const mem = memory();
    const server = await started(mem);
    await filled(server, mem, ["192.168.77.101", "192.168.77.102", "192.168.77.103", "192.168.77.104"], 25);

    vi.setSystemTime(Date.now() + HOUR_MS + 60_000);
    await firstVisit(server, "192.168.77.101");

    expect(displayCount(mem)).toBe(101);
  });

  it("a display above the limit from one address is served like a display with an entry, and gets no entry in the object tree", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
    const mem = memory();
    const server = await started(mem);
    const withEntry = await filled(server, mem, ["192.168.77.50"], 30);
    const before = objectIds(mem);

    const above = await firstVisit(server, "192.168.77.50");

    expect({
      served: above.statusCode === withEntry.statusCode,
      newObjects: objectIds(mem).filter(id => !before.includes(id)),
    }).toEqual({
      served: true,
      newObjects: [],
    });
  });

  it("a display above the limit in all is served like a display with an entry, and gets no entry in the object tree", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-11T12:00:00Z") });
    const mem = memory();
    const server = await started(mem);
    const withEntry = await filled(
      server,
      mem,
      ["192.168.77.101", "192.168.77.102", "192.168.77.103", "192.168.77.104"],
      25,
    );
    const before = objectIds(mem);

    const above = await firstVisit(server, "192.168.77.105");

    expect({
      served: above.statusCode === withEntry.statusCode,
      newObjects: objectIds(mem).filter(id => !before.includes(id)),
    }).toEqual({
      served: true,
      newObjects: [],
    });
  });
});
