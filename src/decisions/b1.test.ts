/**
 * Guard B1 — clients.<id>.targetReachable ("target reachable": whether the page answers to which the display is sent)
 * does not exist and does not come.
 *
 * The page, B1: "Today: does not exist." "Stays: so. clients.<id>.targetReachable ('target reachable': whether the
 * page answers to which the display is sent) does not come. The AI takes it out of the unreleased state again."
 * "Shall this datapoint be added?"
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:17 ("b1 is the same as
 * ha02. same topic").
 *
 * Path: the adapter class from main.ts started by the ready handler its constructor registers (instanceObjects from
 * io-package.json in the database first, as js-controller puts them there), over an object and state database in
 * memory; a display is created by the web server that start built, asked by inject from a peer address, sent to a
 * dashboard by a user write to its mode through the stateChange handler the constructor registered, and polls while
 * its target answers and after it stopped answering — the moments the datapoint would carry a value; the server's own
 * probe asks a dashboard the guard runs on the loopback address, so no request leaves the host. The host carries one
 * network (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type * as Os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeState } from "../lib/adapter-fake";

const { files, db } = vi.hoisted(() => ({
  files: new Map<string, string>(),
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
  instanceObjects: (Record<string, unknown> & { _id: string })[];
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const CLIENTS = `${NS}.clients.`;
/** The datapoint the page names, and every id that would carry the target's reachability by its name. */
const NAMED = "targetReachable";
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
  if (emu.terminated.length > 0 || emu.webServer === null) {
    throw new Error(`the case needs a running adapter (${emu.terminated.join(", ")})`);
  }
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

/**
 * The display's datapoint clients.<id>.targetReachable, as object and as value — whatever of it exists.
 *
 * @param id the display id
 */
function targetReachable(id: string): string[] {
  const full = `${CLIENTS}${id}.${NAMED}`;
  return [db.objects.has(full) ? "object" : "", db.states.has(full) ? "value" : ""].filter(Boolean);
}

describe("B1: clients.<id>.targetReachable does not exist and does not come", () => {
  it("a display whose target answers and then stops answering has no clients.<id>.targetReachable at either moment", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const target = await dashboard();
    const emu = await start();
    const peer = "192.168.77.51";
    const cookie = cookieOf(await ask(emu, peer, "/"));
    const [id] = displayIds();
    if (id === undefined) {
      throw new Error("the case needs the display its first visit creates");
    }
    await userWrites(emu, `clients.${id}.mode`, target.url);
    await ask(emu, peer, "/", cookie);
    const up = await poll(emu, peer, cookie);
    const whileItAnswers = targetReachable(id);

    await closed(target.server);
    vi.setSystemTime(Date.now() + 60 * 1000);
    const down = await poll(emu, peer, cookie);
    if (up.targetReachable !== true || down.targetReachable !== false) {
      throw new Error("the case needs hassemu to have found the target answering, then silent");
    }

    expect({ whileItAnswers, afterItStopped: targetReachable(id) }).toEqual({ whileItAnswers: [], afterItStopped: [] });
  });
});
