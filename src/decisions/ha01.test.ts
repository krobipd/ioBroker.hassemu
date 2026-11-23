/**
 * Guard HA-01 — a display that is not asking for anything right now is not gone: hassemu keeps no datapoint that shows
 * a display as reachable or online, not over a time window either ("seen in the last minutes"), and no sum "displays
 * online"; "connected" means the adapter runs and the server accepts connections.
 *
 * The page, HA-01: "A display that is not asking for anything right now is not gone. hassemu therefore keeps no
 * datapoint that shows a display as reachable or online, not even over a time window ('seen in the last minutes'),
 * and no sum 'displays online'. 'Connected' at hassemu means: the adapter runs and the server accepts connections."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 18:10 ("z01 and ha01 are ok
 * so far").
 *
 * Path: the adapter class from main.ts started by the ready handler its constructor registers (instanceObjects from
 * io-package.json in the database first, as js-controller puts them there), over an object and state database in
 * memory; displays are created and served by the web server that start built, asked by inject from a peer address.
 * Whether the server accepts connections is asked on its port. The host carries one network (192.168.77.0/24); the
 * data folder is a fresh folder in the temporary directory, written through the data-folder master as on a host.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { data, db } = vi.hoisted(() => ({
  /** The instance data folder of the running test. */
  data: { dir: "" },
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
    public encrypt(value: string): string {
      return `$/aes-192-cbc:${Buffer.from(value).toString("base64")}`;
    }
    public decrypt(value: string): string {
      return Buffer.from(value.replace("$/aes-192-cbc:", ""), "base64").toString();
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
  intervals: (() => void)[];
  terminated: string[];
  webServer: {
    inject(request: Record<string, unknown>): Promise<Answer>;
    readonly boundAddress: { address: string; port: number } | null;
  } | null;
}

/** The parts of io-package.json the guard reads. */
interface Manifest {
  native: Record<string, unknown>;
  instanceObjects: (Record<string, unknown> & { _id: string })[];
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const CLIENTS = `${NS}.clients.`;
/** The rule's words for a display that is there: reachable, online. */
const REACHABLE_OR_ONLINE = /reachable|online/i;
const running: Emu[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-ha01-"));
});

afterEach(async () => {
  vi.useRealTimers();
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
 * the manifest (port 0 instead of 8123 unless a port is given, mDNS off — a guard opens no fixed port and announces
 * nothing), then the ready handler the constructor registered.
 *
 * @param port the port of the settings
 */
async function launch(port = 0): Promise<Emu> {
  const known = manifest();
  for (const obj of known.instanceObjects) {
    const id = `${NS}.${obj._id}`;
    if (!db.objects.has(id)) {
      db.objects.set(id, { ...structuredClone(obj), _id: id } as unknown as ioBroker.Object);
    }
  }
  const emu = new HassEmu() as unknown as Emu;
  emu.config = { ...known.native, port, mdnsEnabled: false };
  running.push(emu);
  await emu.handlers.get("ready")?.();
  return emu;
}

/** The adapter started and serving. */
async function start(): Promise<Emu> {
  const emu = await launch();
  if (emu.terminated.length > 0 || emu.webServer === null) {
    throw new Error(`the case needs a running adapter (${emu.terminated.join(", ")})`);
  }
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
  if (emu.webServer === null) {
    throw new Error("the case needs the adapter's web server");
  }
  return emu.webServer.inject({
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
async function displayVisits(emu: Emu, peer: string): Promise<void> {
  const first = await ask(emu, peer, "/");
  await ask(emu, peer, "/api/redirect_check", cookieOf(first));
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** The display ids: the devices below clients. */
function displayIds(): string[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(CLIENTS) && obj.type === "device")
    .map(([id]) => id.slice(CLIENTS.length))
    .sort();
}

/** The one display the case needs. */
function theDisplay(): string {
  const [id] = displayIds();
  if (id === undefined) {
    throw new Error("the case needs the display its visit creates");
  }
  return id;
}

/**
 * The datapoints of one display whose id or name speaks of reachable or online, and the device's own online link.
 *
 * @param id the display id
 */
function reachableOrOnline(id: string): { datapoints: string[]; onlineLink: unknown } {
  const prefix = `${CLIENTS}${id}.`;
  const datapoints = [...db.objects]
    .filter(([key]) => key.startsWith(prefix))
    .filter(([key, obj]) => REACHABLE_OR_ONLINE.test(key) || REACHABLE_OR_ONLINE.test(JSON.stringify(obj.common?.name)))
    .map(([key]) => key.slice(prefix.length));
  const device = db.objects.get(`${CLIENTS}${id}`)?.common as { statusStates?: { onlineId?: unknown } } | undefined;
  return { datapoints, onlineLink: device?.statusStates?.onlineId };
}

/**
 * The values of one display's datapoints.
 *
 * @param id the display id
 */
function valuesOf(id: string): Record<string, unknown> {
  const prefix = `${CLIENTS}${id}.`;
  return Object.fromEntries([...db.states].filter(([key]) => key.startsWith(prefix)).map(([key, s]) => [key, s.val]));
}

/** The number values outside the displays. */
function numbersOutsideDisplays(): Record<string, number> {
  return Object.fromEntries(
    [...db.states]
      .filter(([id, state]) => !id.startsWith(CLIENTS) && typeof state.val === "number")
      .map(([id, state]) => [id, state.val as number]),
  );
}

/**
 * Whether anything accepts a connection on the port.
 *
 * @param port the port
 */
function acceptsOn(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("HA-01: a display that is not asking for anything is not gone", () => {
  it("hassemu keeps no datapoint that shows a display as reachable or online", async () => {
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");

    expect(reachableOrOnline(theDisplay())).toEqual({ datapoints: [], onlineLink: undefined });
  });

  it("not over a time window either ('seen in the last minutes'): a display that has gone quiet shows the same as time passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");
    const id = theDisplay();
    const quiet = valuesOf(id);

    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    for (const tick of emu.intervals) {
      tick();
    }
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(valuesOf(id)).toEqual(quiet);
  });

  it("no sum 'displays online': no number outside the displays follows a second display that comes", async () => {
    const emu = await start();
    await displayVisits(emu, "192.168.77.51");
    const withOne = numbersOutsideDisplays();

    await displayVisits(emu, "192.168.77.52");
    if (displayIds().length !== 2) {
      throw new Error("the case needs the second display");
    }

    expect(numbersOutsideDisplays()).toEqual(withOne);
  });

  it("'connected' means: the adapter runs and the server accepts connections", async () => {
    const emu = await start();
    const port = emu.webServer?.boundAddress?.port ?? 0;
    const runsAndAccepts = { connected: db.states.get(`${NS}.info.connection`)?.val, accepts: await acceptsOn(port) };
    await stop(emu);
    const stopped = db.states.get(`${NS}.info.connection`)?.val;

    const other = createServer();
    await new Promise<void>(resolve => other.listen({ port: 0, host: "0.0.0.0" }, resolve));
    const held = (other.address() as { port: number }).port;
    await launch(held);
    const serverCannotAccept = db.states.get(`${NS}.info.connection`)?.val;
    await new Promise<void>(resolve => other.close(() => resolve()));

    expect({ runsAndAccepts, stopped, serverCannotAccept: serverCannotAccept === true }).toEqual({
      runsAndAccepts: { connected: true, accepts: true },
      stopped: false,
      serverCannotAccept: false,
    });
  });
});
