/**
 * Guard HA-01 — no datapoint "reachable" or "online" per display, no time window, no sum of online displays;
 * "connected" means the adapter runs and its server accepts connections.
 *
 * The page, HA-01: "A display that is not asking for anything right now is not gone. hassemu therefore keeps no
 * datapoint that shows a display as reachable or online, not even over a time window ('seen in the last minutes'),
 * and no sum 'displays online'. 'Connected' at hassemu means: the adapter runs and the server accepts connections."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 18:10 ("z01 and ha01 are ok
 * so far").
 *
 * Path: the manifest read as data, then the adapter class from main.ts started by the ready handler its constructor
 * registers (instanceObjects from io-package.json in the database first, as js-controller puts them there), over an
 * object and state database in memory; displays are created and served by the web server that start built, asked by
 * inject from a peer address, and the adapter is started a second time over the same database. The host carries one
 * network (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import { readFileSync } from "node:fs";
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
  intervals: (() => void)[];
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
/** Every word for "this display is there right now" a datapoint id could carry. */
const PRESENCE = /reachable|online|seen|alive/i;
const running: Emu[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const emu of running.splice(0)) {
    await new Promise<void>(resolve => {
      emu.handlers.get("unload")?.(resolve);
    });
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
 * Stop the adapter through the unload handler and wait for its callback.
 *
 * @param emu the adapter
 */
async function stop(emu: Emu): Promise<void> {
  running.splice(running.indexOf(emu), 1);
  await new Promise<void>(resolve => {
    emu.handlers.get("unload")?.(resolve);
  });
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
 * A display comes in from a peer address: its first page, then one poll with its cookie, as the landing page and the
 * wrapper do.
 *
 * @param emu the adapter
 * @param peer the display's address
 */
async function displayVisits(emu: Emu, peer: string): Promise<{ page: number; poll: number }> {
  const first = await ask(emu, peer, "/");
  const poll = await ask(emu, peer, "/api/redirect_check", cookieOf(first));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { page: first.statusCode, poll: poll.statusCode };
}

/** The display ids: the devices below clients. */
function displayIds(): string[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(CLIENTS) && obj.type === "device")
    .map(([id]) => id.slice(CLIENTS.length))
    .sort();
}

/**
 * Below one display: the objects, the ids that hold a value, and the device's status links.
 *
 * @param id the display id
 */
function display(id: string): { objects: string[]; states: string[]; statusStates: unknown } {
  const prefix = `${CLIENTS}${id}.`;
  const below = (ids: Iterable<string>): string[] =>
    [...ids]
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length))
      .sort();
  const device = db.objects.get(`${CLIENTS}${id}`)?.common as Record<string, unknown> | undefined;
  return { objects: below(db.objects.keys()), states: below(db.states.keys()), statusStates: device?.statusStates };
}

/** Every id outside the displays (objects and values) whose name speaks of presence. */
function presenceIdsOutsideDisplays(): string[] {
  return [...new Set([...db.objects.keys(), ...db.states.keys()])].filter(
    id => !id.startsWith(CLIENTS) && PRESENCE.test(id),
  );
}

/** Everything in the database outside the displays: each object and each value, as text. */
function outsideDisplays(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, obj] of db.objects) {
    if (!id.startsWith(CLIENTS)) {
      out[`object ${id}`] = JSON.stringify(obj);
    }
  }
  for (const [id, state] of db.states) {
    if (!id.startsWith(CLIENTS)) {
      out[`value ${id}`] = JSON.stringify(state.val);
    }
  }
  return out;
}

/** The whole database as ids and values — what a time window would change. */
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

const FIVE = ["ip", "manualUrl", "mode", "remove", "resolvedUrl"];

describe("HA-01: no datapoint 'reachable' or 'online' per display, no window, no sum; connected = adapter and server", () => {
  it("the manifest declares no datapoint that speaks of reachable, online or seen", () => {
    const known = manifest();
    const ids = [...known.instanceObjects.map(obj => obj._id), ...(known.objects ?? []).map(obj => obj._id)];

    expect({
      declares: ids.length > 0,
      presence: ids.filter(id => PRESENCE.test(id)),
    }).toEqual({ declares: true, presence: [] });
  });

  it("a display created and served carries mode, manualUrl, resolvedUrl, ip and remove — no online mark, also after a restart", async () => {
    const first = await start();
    const visit = await displayVisits(first, "192.168.77.51");
    const [id] = displayIds();
    const served = display(id ?? "");
    const outsideServed = presenceIdsOutsideDisplays();
    await stop(first);
    await start();
    const restored = display(id ?? "");

    expect({ visit, displays: displayIds().length }).toEqual({ visit: { page: 200, poll: 200 }, displays: 1 });
    expect({ objects: served.objects, statusStates: served.statusStates }).toEqual({
      objects: FIVE,
      statusStates: undefined,
    });
    expect({
      valuesOutsideTheFive: served.states.filter(child => !FIVE.includes(child)),
      valuesWritten: served.states.length > 0,
    }).toEqual({ valuesOutsideTheFive: [], valuesWritten: true });
    expect({ objects: restored.objects, statusStates: restored.statusStates }).toEqual({
      objects: FIVE,
      statusStates: undefined,
    });
    expect({ outsideServed, outsideRestored: presenceIdsOutsideDisplays() }).toEqual({
      outsideServed: [],
      outsideRestored: [],
    });
  });

  it("a display that has gone quiet changes nothing when time passes — no 'seen in the last minutes'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");
    const afterVisit = wholeTree();

    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    for (const tick of emu.intervals) {
      tick();
    }
    await new Promise(resolve => setTimeout(resolve, 0));

    expect({ timers: emu.intervals.length > 0, displays: displayIds().length }).toEqual({ timers: true, displays: 1 });
    expect(wholeTree()).toEqual(afterVisit);
  });

  it("a second display seen changes nothing outside the displays — no sum 'displays online'", async () => {
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");
    const withOne = { displays: displayIds().length, outside: outsideDisplays() };
    await displayVisits(emu, "192.168.77.52");
    const withTwo = { displays: displayIds().length, outside: outsideDisplays() };

    expect({ before: withOne.displays, after: withTwo.displays }).toEqual({ before: 1, after: 2 });
    expect(withTwo.outside).toEqual(withOne.outside);
    expect(presenceIdsOutsideDisplays()).toEqual([]);
  });

  it("'connected' is the adapter running with a server that answers — before any display, and false once it stops", async () => {
    const before = db.states.get(`${NS}.info.connection`)?.val;
    const emu = await start();
    const whileRunning = db.states.get(`${NS}.info.connection`)?.val;
    const health = await ask(emu, "192.168.77.50", "/health");
    const displaysWhileConnected = displayIds().length;
    await stop(emu);

    expect({
      before,
      whileRunning,
      health: health.statusCode,
      healthBody: (health.json() as { status?: unknown }).status,
      displaysWhileConnected,
      stopped: db.states.get(`${NS}.info.connection`)?.val,
    }).toEqual({
      before: undefined,
      whileRunning: true,
      health: 200,
      healthBody: "ok",
      displaysWhileConnected: 0,
      stopped: false,
    });
  });
});
