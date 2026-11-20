/**
 * Guard HA-02 — there is no datapoint for the number of known displays; the displays stand one by one under "Known
 * displays"; the datapoint info.devicesTotal does not exist.
 *
 * The page, HA-02: "Today: there is no datapoint for the number. The displays stand one by one under 'Known
 * displays'." "Stays: so. The datapoint info.devicesTotal does not exist." "Shall hassemu keep the number of known
 * displays as a datapoint?"
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 18:59 ("ha-02 no").
 *
 * Path: the manifest read as data, then the adapter class from main.ts started by the ready handler its constructor
 * registers (instanceObjects from io-package.json in the database first, as js-controller puts them there), over an
 * object and state database in memory; displays are created and served by the web server that start built, asked by
 * inject from a peer address. The host carries one network (192.168.77.0/24); the data folder is a fresh folder in the
 * temporary directory, written through the data-folder master as on a host.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeState } from "../lib/adapter-fake";

const { data, db } = vi.hoisted(() => ({
  /** The instance data folder of the running test. */
  data: { dir: "" },
  db: { objects: new Map<string, ioBroker.Object>(), states: new Map<string, ioBroker.State>() },
}));

vi.mock("@iobroker/adapter-core", async () => {
  const { FakeAdapter } = await import("../lib/adapter-fake.js");
  const noop = (): void => undefined;
  /** The adapter base class: the fleet's fake adapter over the database in memory, plus what hassemu itself calls. */
  class Adapter extends FakeAdapter {
    override readonly objects = db.objects as unknown as Map<string, Record<string, unknown>>;
    override readonly states = db.states as unknown as Map<string, FakeState>;
    adapterDir = process.cwd();
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    intervals: (() => void)[] = [];
    terminated: string[] = [];
    log = { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: "info" };
    on(event: string, handler: (...args: never[]) => unknown): this {
      this.handlers.set(event, handler as (...args: unknown[]) => unknown);
      return this;
    }
    setInterval(callback: () => void): object {
      this.intervals.push(callback);
      return {};
    }
    clearInterval(): void {}
    override terminate(reason: string, exitCode: number): never {
      this.terminated.push(reason);
      return super.terminate(reason, exitCode);
    }
    getObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(db.objects.get(this.full(id)) ?? null));
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
    getAbsoluteInstanceDataDir: (): string => data.dir,
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
  instanceObjects: (Record<string, unknown> & { _id: string; common?: { name?: unknown } })[];
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const CLIENTS = `${NS}.clients.`;
/** The datapoint the rule names. */
const COUNT_ID = "info.devicesTotal";
const running: Emu[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-ha02-"));
});

afterEach(async () => {
  for (const emu of running.splice(0)) {
    await new Promise<void>(resolve => {
      emu.handlers.get("unload")?.(resolve);
    });
  }
  db.objects.clear();
  db.states.clear();
  rmSync(data.dir, { recursive: true, force: true });
  data.dir = "";
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

/** The displays: every device below clients, with the id of its container. */
function displays(): { id: string; parent: string }[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(CLIENTS) && obj.type === "device")
    .map(([id]) => ({ id: id.slice(CLIENTS.length), parent: id.slice(0, id.lastIndexOf(".")) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Every datapoint of the instance outside the displays whose value is the given number.
 *
 * @param count the number of known displays
 */
function holding(count: number): string[] {
  return [...db.states]
    .filter(([id, state]) => id.startsWith(`${NS}.`) && !id.startsWith(CLIENTS) && String(state.val) === String(count))
    .map(([id]) => id);
}

describe("HA-02: no datapoint for the number of known displays", () => {
  it("there is no datapoint for the number of known displays", async () => {
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");
    const one = { displays: displays().length, holding: holding(1) };
    await displayVisits(emu, "192.168.77.52");
    const two = { displays: displays().length, holding: holding(2) };

    expect({ one, two }).toEqual({ one: { displays: 1, holding: [] }, two: { displays: 2, holding: [] } });
  });

  it("the displays stand one by one under 'Known displays'", async () => {
    const folder = manifest().instanceObjects.find(obj => obj._id === "clients");
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");
    await displayVisits(emu, "192.168.77.52");
    const known = displays();

    expect({
      name: (folder?.common?.name as { en?: unknown } | undefined)?.en,
      folder: db.objects.get(`${NS}.clients`)?.type,
      displays: known.length,
      parents: [...new Set(known.map(d => d.parent))],
    }).toEqual({ name: "Known displays", folder: "folder", displays: 2, parents: [`${NS}.clients`] });
  });

  it("the datapoint info.devicesTotal does not exist", async () => {
    const known = manifest();
    const ids = [...known.instanceObjects.map(obj => obj._id), ...(known.objects ?? []).map(obj => obj._id)];
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");

    expect({
      declares: ids.length > 0,
      declared: ids.filter(id => id === COUNT_ID),
      object: db.objects.has(`${NS}.${COUNT_ID}`),
      value: db.states.has(`${NS}.${COUNT_ID}`),
    }).toEqual({ declares: true, declared: [], object: false, value: false });
  });
});
