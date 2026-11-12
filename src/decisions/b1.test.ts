/**
 * Guard B1 — no datapoint clients.<id>.targetReachable: whether a display's target answers is no datapoint.
 *
 * The page, B1: "Today: does not exist." "Stays: so. clients.<id>.targetReachable ('target reachable': whether the
 * page answers to which the display is sent) does not come. The AI takes it out of the unreleased state again."
 * "Shall this datapoint be added?"
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:17 ("b1 is the same as
 * ha02. same topic").
 *
 * Path: the manifest read as data, then the adapter class from main.ts started by the ready handler its constructor
 * registers (instanceObjects from io-package.json in the database first, as js-controller puts them there), over an
 * object and state database in memory; a display is created by the web server that start built, asked by inject from
 * a peer address, sent to a dashboard by a user write to its mode through the stateChange handler the constructor
 * registered, and polls while its target answers and after it stopped answering — the server's own probe asks a
 * dashboard the guard runs on the loopback address, so no request leaves the host. The host carries one network
 * (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type * as Os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { files, db } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  db: { objects: new Map<string, ioBroker.Object>(), states: new Map<string, ioBroker.State>() },
}));

vi.mock("@iobroker/adapter-core", () => {
  const noop = (): void => undefined;
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  // Merge a patch the way js-controller's extendObject does: plain objects key by key, everything else replaced.
  const merged = (base: unknown, patch: unknown): unknown => {
    if (!plain(base) || !plain(patch)) {
      return structuredClone(patch);
    }
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = merged(base[key], value);
    }
    return out;
  };
  /** The adapter base class over the database in memory. */
  class Adapter {
    namespace = "hassemu.0";
    adapterDir = process.cwd();
    config: Record<string, unknown> = {};
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    intervals: (() => void)[] = [];
    terminated: string[] = [];
    log = { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: "info" };
    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, handler);
      return this;
    }
    full(id: string): string {
      return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    setInterval(callback: () => void): object {
      this.intervals.push(callback);
      return {};
    }
    clearInterval(): void {}
    setTimeout(): object {
      return {};
    }
    clearTimeout(): void {}
    terminate(reason: string): void {
      this.terminated.push(reason);
    }
    getObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(db.objects.get(this.full(id)) ?? null));
    }
    getForeignObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(db.objects.get(id) ?? null));
    }
    getForeignObjectsAsync(pattern: string, type?: string): Promise<Record<string, ioBroker.Object>> {
      const prefix = pattern.replace(/\*$/, "");
      const wanted = type ?? "state";
      const found = [...db.objects].filter(([id, obj]) => id.startsWith(prefix) && obj.type === wanted);
      return Promise.resolve(structuredClone(Object.fromEntries(found)));
    }
    getAdapterObjectsAsync(): Promise<Record<string, ioBroker.Object>> {
      const own = [...db.objects].filter(([id]) => id.startsWith(`${this.namespace}.`));
      return Promise.resolve(structuredClone(Object.fromEntries(own)));
    }
    setObjectNotExistsAsync(id: string, obj: ioBroker.Object): Promise<{ id: string }> {
      if (!db.objects.has(this.full(id))) {
        db.objects.set(this.full(id), { ...structuredClone(obj), _id: this.full(id) } as ioBroker.Object);
      }
      return Promise.resolve({ id: this.full(id) });
    }
    extendObject(id: string, patch: Partial<ioBroker.Object>): Promise<{ id: string }> {
      return this.extendForeignObjectAsync(this.full(id), patch);
    }
    extendForeignObjectAsync(id: string, patch: Partial<ioBroker.Object>): Promise<{ id: string }> {
      db.objects.set(id, { ...(merged(db.objects.get(id) ?? {}, patch) as object), _id: id } as ioBroker.Object);
      return Promise.resolve({ id });
    }
    setForeignObject(id: string, obj: ioBroker.Object): Promise<{ id: string }> {
      db.objects.set(id, { ...structuredClone(obj), _id: id } as ioBroker.Object);
      return Promise.resolve({ id });
    }
    delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
      const key = this.full(id);
      for (const stored of [...db.objects.keys()]) {
        if (stored === key || (options?.recursive === true && stored.startsWith(`${key}.`))) {
          db.objects.delete(stored);
          db.states.delete(stored);
        }
      }
      return Promise.resolve();
    }
    delStateAsync(id: string): Promise<void> {
      db.states.delete(this.full(id));
      return Promise.resolve();
    }
    getStateAsync(id: string): Promise<ioBroker.State | null> {
      return Promise.resolve(structuredClone(db.states.get(this.full(id)) ?? null));
    }
    getStatesAsync(pattern: string): Promise<Record<string, ioBroker.State | null>> {
      // js-controller 7.2.5 getStates: every state object below the pattern, with its value or null.
      const prefix = this.full(pattern.replace(/\*/g, ""));
      const found: Record<string, ioBroker.State | null> = {};
      for (const [id, obj] of db.objects) {
        if (obj.type === "state" && id.startsWith(prefix)) {
          found[id] = structuredClone(db.states.get(id) ?? null);
        }
      }
      return Promise.resolve(found);
    }
    setState(id: string, state: ioBroker.SettableState): Promise<string> {
      const next = state as ioBroker.State;
      db.states.set(this.full(id), { ...next, ack: next.ack ?? false, ts: Date.now(), lc: Date.now() });
      return Promise.resolve(this.full(id));
    }
    setStateChangedAsync(id: string, state: ioBroker.SettableState): Promise<{ id: string; notChanged: boolean }> {
      const before = db.states.get(this.full(id));
      const next = state as ioBroker.State;
      if (before && before.val === next.val && before.ack === (next.ack ?? false)) {
        return Promise.resolve({ id: this.full(id), notChanged: true });
      }
      db.states.set(this.full(id), { ...next, ack: next.ack ?? false, ts: Date.now(), lc: Date.now() });
      return Promise.resolve({ id: this.full(id), notChanged: false });
    }
    subscribeStatesAsync(): Promise<void> {
      return Promise.resolve();
    }
    subscribeForeignObjectsAsync(): Promise<void> {
      return Promise.resolve();
    }
    unsubscribeStatesAsync(): Promise<void> {
      return Promise.resolve();
    }
    unsubscribeForeignObjectsAsync(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    Adapter,
    EXIT_CODES: { UNCAUGHT_EXCEPTION: 6 },
    getAbsoluteInstanceDataDir: (): string => "/guard/hassemu.0",
    I18n: {
      init: (): Promise<void> => Promise.resolve(),
      getTranslatedObject: (key: string) => ({ en: key }),
      translate: (key: string) => key,
    },
  };
});
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

import * as mainModule from "../main";

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): unknown;
}

/** The adapter instance with what the guard reads from its base class and its own fields. */
interface Emu {
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  terminated: string[];
  webServer: { inject(request: Record<string, unknown>): Promise<Answer> } | null;
}

/** The parts of io-package.json the guard reads. */
interface Manifest {
  native: Record<string, unknown>;
  objects?: { _id: string }[];
  instanceObjects: (Record<string, unknown> & { _id: string })[];
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const CLIENTS = `${NS}.clients.`;
/** The datapoint the page names, and every id that would carry the target's reachability by its name. */
const NAMED = "targetReachable";
const REACHABLE = /reachable/i;
const running: Emu[] = [];
const targets: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const emu of running.splice(0)) {
    await new Promise<void>(resolve => {
      emu.handlers.get("unload")?.(resolve);
    });
  }
  for (const target of targets.splice(0)) {
    await closed(target);
  }
  db.objects.clear();
  db.states.clear();
  files.clear();
});

/** io-package.json, read as data. */
function manifest(): Manifest {
  return JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as Manifest;
}

/**
 * A dashboard on this host, on a free port of the loopback address: every request gets a page. The probe of the
 * target asks this server — no request leaves the host.
 */
async function dashboard(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!DOCTYPE html><title>dashboard</title>");
  });
  targets.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/vis-2/index.html?main` };
}

/**
 * Close a dashboard server, its open connections first.
 *
 * @param server the server
 */
async function closed(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/**
 * The adapter as js-controller starts it: the manifest's instanceObjects in the database, the instance settings from
 * the manifest (port 0 instead of 8123, mDNS off — a guard opens no fixed port and announces nothing), then the ready
 * handler the constructor registered.
 */
async function start(): Promise<Emu> {
  const known = manifest();
  for (const obj of known.instanceObjects) {
    const id = `${NS}.${obj._id}`;
    if (!db.objects.has(id)) {
      db.objects.set(id, { ...structuredClone(obj), _id: id } as unknown as ioBroker.Object);
    }
  }
  const emu = new HassEmu() as unknown as Emu;
  emu.config = { ...known.native, port: 0, mdnsEnabled: false };
  running.push(emu);
  await emu.handlers.get("ready")?.();
  expect({ terminated: emu.terminated, serving: emu.webServer !== null }).toEqual({ terminated: [], serving: true });
  return emu;
}

/**
 * One GET to the running server from a peer address.
 *
 * @param emu the adapter
 * @param peer the peer address on the socket
 * @param url the path
 * @param cookie the display's cookie header, if it has one
 */
function ask(emu: Emu, peer: string, url: string, cookie = ""): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (cookie) {
    headers.cookie = cookie;
  }
  expect(emu.webServer).not.toBeNull();
  return (emu.webServer as NonNullable<Emu["webServer"]>).inject({
    method: "GET",
    url,
    headers,
    remoteAddress: peer,
  });
}

/**
 * The display cookie a first answer set.
 *
 * @param answer the answer
 */
function cookieOf(answer: Answer): string {
  const raw = answer.headers["set-cookie"];
  const text = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  return /hassemu_client=[^;]+/.exec(text)?.[0] ?? "";
}

/**
 * A user write (ack false), handed to the stateChange handler the constructor registered.
 *
 * @param emu the adapter
 * @param id the id below the namespace
 * @param val the value
 */
async function userWrites(emu: Emu, id: string, val: ioBroker.StateValue): Promise<void> {
  await emu.handlers.get("stateChange")?.(`${NS}.${id}`, {
    val,
    ack: false,
    ts: 0,
    lc: 0,
    from: "system.adapter.admin.0",
  });
}

/**
 * The display's poll, as its dashboard page sends it every 30 s.
 *
 * @param emu the adapter
 * @param peer the display's address
 * @param cookie the display's cookie header
 */
async function poll(emu: Emu, peer: string, cookie: string): Promise<{ target?: unknown; targetReachable?: unknown }> {
  const answer = await ask(emu, peer, "/api/redirect_check", cookie);
  await new Promise(resolve => setTimeout(resolve, 0));
  return answer.json() as { target?: unknown; targetReachable?: unknown };
}

/** The display ids: the devices below clients. */
function displayIds(): string[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(CLIENTS) && obj.type === "device")
    .map(([id]) => id.slice(CLIENTS.length))
    .sort();
}

/** Every id in the database (objects and values) that is the named datapoint or speaks of reachability. */
function reachabilityIds(): string[] {
  return [...new Set([...db.objects.keys(), ...db.states.keys()])].filter(
    id => id.split(".").pop() === NAMED || REACHABLE.test(id.slice(NS.length)),
  );
}

/** The whole database as ids and values. */
function wholeTree(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, obj] of db.objects) {
    out[`object ${id}`] = JSON.stringify(obj);
  }
  for (const [id, state] of db.states) {
    out[`value ${id}`] = JSON.stringify(state.val);
  }
  return out;
}

describe("B1: no datapoint 'target reachable' per display", () => {
  it("the manifest declares no targetReachable and no id that speaks of reachability", () => {
    const known = manifest();
    const ids = [...known.instanceObjects.map(obj => obj._id), ...(known.objects ?? []).map(obj => obj._id)];

    expect({
      declares: ids.length > 0,
      named: ids.filter(id => id.split(".").pop() === NAMED),
      reachability: ids.filter(id => REACHABLE.test(id)),
    }).toEqual({ declares: true, named: [], reachability: [] });
  });

  it("a display sent to a target that answers and then stops answering gets no such datapoint", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const target = await dashboard();
    const emu = await start();
    const peer = "192.168.77.51";
    const first = await ask(emu, peer, "/");
    const cookie = cookieOf(first);
    const [id] = displayIds();
    await userWrites(emu, `clients.${id ?? ""}.mode`, target.url);
    const page = await ask(emu, peer, "/", cookie);
    const up = await poll(emu, peer, cookie);
    const whileUp = { ids: reachabilityIds(), tree: wholeTree() };

    await closed(target.server);
    vi.setSystemTime(Date.now() + 60 * 1000);
    const down = await poll(emu, peer, cookie);

    expect({
      displays: displayIds().length,
      page: page.statusCode,
      up,
      down,
    }).toEqual({
      displays: 1,
      page: 200,
      up: { target: target.url, targetReachable: true },
      down: { target: target.url, targetReachable: false },
    });
    expect({ whileUp: whileUp.ids, whileDown: reachabilityIds() }).toEqual({ whileUp: [], whileDown: [] });
    expect(wholeTree()).toEqual(whileUp.tree);
  });
});
