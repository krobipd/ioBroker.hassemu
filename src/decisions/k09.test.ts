/**
 * Guard K9 — where a display is sent: its redirect mode decides (global, manual, a chosen dashboard, or the landing
 * page).
 *
 * The page, K9: "The 'redirect mode' of a display decides: 'Global URL' follows the global setting, 'Manual URL' takes
 * the address from the datapoint 'Manual URL', a chosen dashboard takes its address, '---' shows the landing page."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:39 ("k8, k9, k10, k11, k12
 * and k13 are ok, yes").
 *
 * Path: the adapter class from main.ts started by the ready handler its constructor registers, over an object and
 * state database in memory; a display opens its first page on the web server that start built (inject from a peer
 * address), the user's writes to global.* and clients.<id>.* go through the stateChange handler the constructor
 * registered, and the display's next GET / shows where it is sent. The server's own probe of a target asks dashboards
 * the guard runs on the loopback address, so no request leaves the host. The host carries one network
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
  instanceObjects: (Record<string, unknown> & { _id: string })[];
}

/** One display, signed in by its first page. */
interface Display {
  emu: Emu;
  peer: string;
  cookie: string;
  id: string;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const CLIENTS = `${NS}.clients.`;
const running: Emu[] = [];
const targets: Server[] = [];

afterEach(async () => {
  for (const emu of running.splice(0)) {
    await new Promise<void>(resolve => {
      emu.handlers.get("unload")?.(resolve);
    });
  }
  for (const target of targets.splice(0)) {
    target.closeAllConnections();
    await new Promise<void>(resolve => target.close(() => resolve()));
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
 * Dashboards on this host, on a free port of the loopback address: every path gets a page. The server's probe of a
 * target asks this server — no request leaves the host.
 *
 * @returns the address the dashboards' paths hang from
 */
async function dashboards(): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!DOCTYPE html><title>dashboard</title>");
  });
  targets.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * The adapter as js-controller starts it — the manifest's instanceObjects in the database, the instance settings from
 * the manifest (port 0 instead of 8123, mDNS off: a guard opens no fixed port and announces nothing), then the ready
 * handler the constructor registered — and one display that opened its first page.
 */
async function displayOfARunningAdapter(): Promise<Display> {
  const known = manifest();
  for (const obj of known.instanceObjects) {
    db.objects.set(`${NS}.${obj._id}`, {
      ...structuredClone(obj),
      _id: `${NS}.${obj._id}`,
    } as unknown as ioBroker.Object);
  }
  const emu = new HassEmu() as unknown as Emu;
  emu.config = { ...known.native, port: 0, mdnsEnabled: false };
  running.push(emu);
  await emu.handlers.get("ready")?.();
  expect({ terminated: emu.terminated, serving: emu.webServer !== null }).toEqual({ terminated: [], serving: true });
  const peer = "192.168.77.51";
  const first = await ask(emu, peer, "/");
  const raw = first.headers["set-cookie"];
  const text = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  const ids = [...db.objects]
    .filter(([id, obj]) => id.startsWith(CLIENTS) && obj.type === "device")
    .map(([id]) => id.slice(CLIENTS.length));
  expect({ status: first.statusCode, displays: ids.length }).toEqual({ status: 200, displays: 1 });
  return { emu, peer, cookie: /hassemu_client=[^;]+/.exec(text)?.[0] ?? "", id: ids[0] ?? "" };
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
 * User writes (ack false), one after the other, handed to the stateChange handler the constructor registered.
 *
 * @param emu the adapter
 * @param writes id below the namespace and value, in order
 */
async function userWrites(emu: Emu, writes: [string, ioBroker.StateValue][]): Promise<void> {
  for (const [id, val] of writes) {
    await emu.handlers.get("stateChange")?.(`${NS}.${id}`, {
      val,
      ack: false,
      ts: 0,
      lc: 0,
      from: "system.adapter.admin.0",
    });
  }
}

/**
 * Where the display's next page sends it: the address in the dashboard frame, "landing page" for the page with its
 * id and no frame, or what else it got.
 *
 * @param display the display
 */
async function sentTo(display: Display): Promise<string> {
  const page = await ask(display.emu, display.peer, "/", display.cookie);
  await new Promise(resolve => setTimeout(resolve, 0));
  const frame = /<iframe id="hassemu-iframe" src="([^"]*)"/.exec(page.body)?.[1];
  if (page.statusCode === 200 && frame !== undefined) {
    return frame.replace(/&amp;/g, "&");
  }
  if (page.statusCode === 200 && page.body.includes(`<code>${CLIENTS}${display.id}</code>`)) {
    return "landing page";
  }
  return `status ${page.statusCode}`;
}

describe("K9: the redirect mode of a display decides where GET / sends it", () => {
  it("'Global URL' follows the global setting — its address, or its manual address, and a change of it", async () => {
    const base = await dashboards();
    const display = await displayOfARunningAdapter();
    await userWrites(display.emu, [
      ["global.mode", `${base}/vis-2/index.html?global`],
      [`clients.${display.id}.mode`, "global"],
    ]);
    const globalAddress = await sentTo(display);
    await userWrites(display.emu, [
      ["global.manualUrl", `${base}/grafana/d/global`],
      ["global.mode", "manual"],
    ]);
    const globalManual = await sentTo(display);

    expect({ globalAddress, globalManual }).toEqual({
      globalAddress: `${base}/vis-2/index.html?global`,
      globalManual: `${base}/grafana/d/global`,
    });
  });

  it("'Manual URL' takes the address from the display's datapoint 'Manual URL'", async () => {
    const base = await dashboards();
    const display = await displayOfARunningAdapter();
    await userWrites(display.emu, [
      ["global.mode", `${base}/vis-2/index.html?global`],
      [`clients.${display.id}.manualUrl`, `${base}/aura/?display`],
      [`clients.${display.id}.mode`, "manual"],
    ]);

    expect(await sentTo(display)).toBe(`${base}/aura/?display`);
  });

  it("a chosen dashboard takes its address", async () => {
    const base = await dashboards();
    const display = await displayOfARunningAdapter();
    await userWrites(display.emu, [
      ["global.mode", `${base}/vis-2/index.html?global`],
      [`clients.${display.id}.manualUrl`, `${base}/aura/?display`],
      [`clients.${display.id}.mode`, `${base}/vis/index.html?kitchen`],
    ]);

    expect(await sentTo(display)).toBe(`${base}/vis/index.html?kitchen`);
  });

  it("'---' shows the landing page, whatever else is set", async () => {
    const base = await dashboards();
    const display = await displayOfARunningAdapter();
    await userWrites(display.emu, [
      ["global.mode", `${base}/vis-2/index.html?global`],
      [`clients.${display.id}.manualUrl`, `${base}/aura/?display`],
      [`clients.${display.id}.mode`, `${base}/vis/index.html?kitchen`],
    ]);
    const chosen = await sentTo(display);
    await userWrites(display.emu, [[`clients.${display.id}.mode`, "0"]]);

    expect({ chosen, cleared: await sentTo(display) }).toEqual({
      chosen: `${base}/vis/index.html?kitchen`,
      cleared: "landing page",
    });
  });
});
