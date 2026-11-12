/**
 * Guard K17 — hassemu reports Home Assistant 2026.8.0 or newer and sends the app the signal "loaded" from every page.
 *
 * The page, K17: "hassemu reports itself as 2026.8.0 and additionally sends the app the signal 'finished loading': on
 * the landing page and the cards at once, on the dashboard as soon as it has loaded, at the latest after a fixed time.
 * The app keeps its own launch screen until the dashboard is there. On the iPhone the app shows edge to edge without
 * the stripe; hassemu itself keeps the distance to the clock and the camera notch." Rule: "The reported version rises
 * only as far as hassemu delivers everything the apps expect from that version on. Today that is 2026.8.0."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 20:20 ("but k17, we should of
 * course support newer home assistants, nothing against it, rather more for it").
 *
 * Path: the web server as main.ts starts it, with the production reachability probe, every display following the
 * global target — a small HTTP server on a free local port that answers or drops each connection. The version is read
 * from the routes the apps ask; each page is taken from the server by GET / and its inline scripts run in a sandbox
 * with an app bridge (V1, `externalApp.externalBus`) that records every message, held timers and a fetch that asks the
 * same server. The host carries one network (192.168.77.0/24); the data folder is a map in memory, since a guard
 * writes no file.
 */

import http from "node:http";
import type net from "node:net";
import type * as Os from "node:os";
import vm from "node:vm";
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

/** An adapter over a database in memory, with what it wrote. */
interface Memory {
  adapter: Record<string, unknown>;
  objects: Map<string, ioBroker.Object>;
  states: Map<string, ioBroker.State>;
  /** Every call that wrote, deleted or extended a foreign id, by method name. */
  foreign: string[];
  /** Every state write to an own id. */
  ownStateWrites: string[];
}

/** The redirect target: a local HTTP server that answers, or drops every connection while `down`. */
interface Target {
  url: string;
  state: { down: boolean };
  server: http.Server;
}

/** A page element as the inline script touches it. */
interface FakeElement {
  style: Record<string, string>;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
}

/** A display's page running in a sandbox. */
interface Display {
  /** The served page. */
  html: string;
  /** Every message the app bridge received, parsed. */
  messages: unknown[];
  /** The timers the page set, in order, held until fired by hand. */
  timers: { callback: () => void; delay: unknown }[];
  /** Run the iframe's onload, as the browser does once the dashboard has loaded. */
  iframeLoads(): void;
  /** Fire one poll tick while hassemu does not answer, and wait until the page has handled it. */
  tickUnanswered(): Promise<void>;
  /** Whether a card with this id is on screen. */
  cardVisible(id: string): boolean;
}

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const PEER = "192.168.77.50";
const UA = "Mozilla/5.0 (Linux; Android 13; WebView)";
const CONNECTED = { id: 1, type: "connection-status", payload: { event: "connected" } };
const LOADED = { id: 2, type: "frontend/loaded" };
const servers: WebServer[] = [];
const targets: Target[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  for (const target of targets.splice(0)) {
    target.server.closeAllConnections();
    await new Promise<void>(resolve => target.server.close(() => resolve()));
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

/** An adapter whose database lives in memory; every method that touches a foreign id is recorded. */
function memory(): Memory {
  const objects = new Map<string, ioBroker.Object>();
  const states = new Map<string, ioBroker.State>();
  const foreign: string[] = [];
  const ownStateWrites: string[] = [];
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
      ownStateWrites.push(full(id));
      states.set(full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve(full(id));
    },
    setStateChangedAsync(id: string, state: ioBroker.SettableState) {
      const before = states.get(full(id));
      const value = (state as ioBroker.State).val;
      if (before && before.val === value && before.ack === ((state as ioBroker.State).ack ?? false)) {
        return Promise.resolve({ id: full(id), notChanged: true });
      }
      ownStateWrites.push(full(id));
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
  const adapter = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^(set|del|extend)Foreign/.test(prop)) {
        return (...args: unknown[]) => {
          foreign.push(`${prop}(${String(args[0])})`);
          return Promise.resolve();
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { adapter, objects, states, foreign, ownStateWrites };
}

/**
 * The web server as main.ts starts it — the production probe; with a target every display follows it (master switch
 * on), without one a new display has no target and gets the landing page.
 *
 * @param mem the adapter
 * @param target the global target, if any
 */
async function started(mem: Memory, target?: string): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  if (target !== undefined) {
    await global.handleModeWrite(target);
    await global.handleEnabledWrite(true);
  }
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired: false,
    username: "admin",
    password: "",
    mdnsEnabled: false,
    serviceName: "ioBroker",
  };
  const server = new WebServer(mem.adapter as never, config, registry, global, registry.serverUuid, "en");
  servers.push(server);
  await server.start();
  return server;
}

/**
 * The redirect target on a free local port; it answers unless `down`, then it drops every connection.
 *
 * @param down whether it starts out not answering
 */
async function targetServer(down: boolean): Promise<Target> {
  const state = { down };
  const server = http.createServer((_req, res) => {
    res.end("dashboard");
  });
  server.on("connection", (socket: net.Socket) => {
    if (state.down) {
      socket.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const target: Target = { url: `http://127.0.0.1:${port}/vis-2/index.html?main`, state, server };
  targets.push(target);
  return target;
}

/**
 * A fake page element.
 *
 * @param classes the classes it starts with
 */
function element(classes: string[]): FakeElement {
  const set = new Set(classes);
  return {
    style: {},
    classList: {
      add: (name: string): void => void set.add(name),
      remove: (name: string): void => void set.delete(name),
      contains: (name: string): boolean => set.has(name),
    },
  };
}

/**
 * A display loads its page from the server (GET /) and runs the page's inline scripts in a sandbox with an app bridge;
 * timers are held, poll ticks are fired by hand.
 *
 * @param server the server
 */
async function openPage(server: WebServer): Promise<Display> {
  const page = await server.inject({ method: "GET", url: "/", headers: { "user-agent": UA }, remoteAddress: PEER });
  const html = page.body;
  const cards: Record<string, FakeElement> = {
    "hassemu-iframe": element([]),
    "hassemu-down": element([]),
    "hassemu-target-down": element(/<div id="hassemu-target-down" class="visible"/.test(html) ? ["visible"] : []),
  };
  const messages: unknown[] = [];
  const timers: Display["timers"] = [];
  const intervals: (() => void)[] = [];
  const window: Record<string, unknown> = {
    externalApp: { externalBus: (msg: string): void => void messages.push(JSON.parse(msg)) },
    setTimeout: (callback: () => void, delay: unknown): number => timers.push({ callback, delay }),
    setInterval: (callback: () => void): number => intervals.push(callback),
  };
  let pending: Promise<unknown> = Promise.resolve();
  const sandbox = vm.createContext({
    window,
    document: { getElementById: (id: string): FakeElement | null => cards[id] ?? null },
    location: { reload: (): void => undefined },
    // hassemu does not answer: every poll fails like a dropped connection.
    fetch: (): Promise<never> => {
      const failed = Promise.reject(new Error("hassemu does not answer"));
      pending = failed.catch(() => undefined);
      return failed;
    },
  });
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], sandbox);
  }
  const onload = /<iframe id="hassemu-iframe"[^>]*onload="([^"]*)"/.exec(html)?.[1];
  return {
    html,
    messages,
    timers,
    iframeLoads: (): void => {
      if (onload !== undefined) {
        vm.runInContext(onload, sandbox);
      }
    },
    tickUnanswered: async (): Promise<void> => {
      for (const callback of intervals) {
        callback();
      }
      await pending;
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    cardVisible: (id: string): boolean => cards[id]?.classList.contains("visible") ?? false,
  };
}

/**
 * A version "YYYY.M.P" as a number that orders like the version.
 *
 * @param version the version text
 */
function versionRank(version: unknown): number {
  const [year, month, patch] = String(version).split(".").map(Number);
  return year * 10_000 + month * 100 + patch;
}

describe("K17: hassemu reports Home Assistant 2026.8.0 or newer and every page sends the app 'loaded'", () => {
  it("reports a Home Assistant version of at least 2026.8.0 where the apps read it", async () => {
    const server = await started(memory());
    const config = await server.inject({ method: "GET", url: "/api/config", remoteAddress: PEER });
    const info = await server.inject({ method: "GET", url: "/api/discovery_info", remoteAddress: PEER });
    const configBody: { version?: unknown } = config.json();
    const infoBody: { version?: unknown } = info.json();
    const versions = [configBody.version, infoBody.version];

    expect({
      statuses: [config.statusCode, info.statusCode],
      notBelow2026dot8: versions.map(v => versionRank(v) >= versionRank("2026.8.0")),
    }).toEqual({
      statuses: [200, 200],
      notBelow2026dot8: [true, true],
    });
  });

  it("the landing page sends 'loaded' at once", async () => {
    const server = await started(memory());
    const display = await openPage(server);

    expect({ landing: display.html.includes('<meta http-equiv="refresh"'), messages: display.messages }).toEqual({
      landing: true,
      messages: [CONNECTED, LOADED],
    });
  });

  it("the card 'target not reachable' sends 'loaded' at once", async () => {
    const target = await targetServer(true);
    const server = await started(memory(), target.url);
    const display = await openPage(server);

    expect({ card: display.cardVisible("hassemu-target-down"), messages: display.messages }).toEqual({
      card: true,
      messages: [CONNECTED, LOADED],
    });
  });

  it("the dashboard keeps the app's launch screen until its frame has loaded, then sends 'loaded'", async () => {
    const target = await targetServer(false);
    const server = await started(memory(), target.url);
    const display = await openPage(server);
    const beforeLoad = [...display.messages];

    display.iframeLoads();

    expect({
      card: display.cardVisible("hassemu-target-down"),
      showsTarget: display.html.includes(`<iframe id="hassemu-iframe" src="${target.url}"`),
      beforeLoad,
      afterLoad: display.messages,
    }).toEqual({ card: false, showsTarget: true, beforeLoad: [CONNECTED], afterLoad: [CONNECTED, LOADED] });
  });

  it("the dashboard sends 'loaded' after a fixed time when its frame never finishes loading", async () => {
    const target = await targetServer(false);
    const server = await started(memory(), target.url);
    const display = await openPage(server);
    const beforeTimers = [...display.messages];
    let sentBy: unknown = null;

    for (const timer of display.timers) {
      const before = display.messages.length;
      timer.callback();
      if (sentBy === null && display.messages.length > before) {
        sentBy = timer.delay;
      }
    }

    expect({
      beforeTimers,
      afterTimers: display.messages,
      fixedDelay: typeof sentBy === "number" && Number.isFinite(sentBy) && sentBy > 0,
    }).toEqual({ beforeTimers: [CONNECTED], afterTimers: [CONNECTED, LOADED], fixedDelay: true });
  });

  it("the card 'hassemu offline' sends 'loaded' as soon as it shows", async () => {
    const target = await targetServer(false);
    const server = await started(memory(), target.url);
    const display = await openPage(server);
    const seen: { card: boolean; messages: unknown[] }[] = [];

    for (let i = 0; i < 3; i++) {
      await display.tickUnanswered();
      seen.push({ card: display.cardVisible("hassemu-down"), messages: [...display.messages] });
    }

    expect(seen).toEqual([
      { card: false, messages: [CONNECTED] },
      { card: false, messages: [CONNECTED] },
      { card: true, messages: [CONNECTED, LOADED] },
    ]);
  });

  it("the landing page and the dashboard reach to the edge and keep the safe area themselves", async () => {
    const target = await targetServer(false);
    const landing = await openPage(await started(memory()));
    const dashboard = await openPage(await started(memory(), target.url));
    const keepsSafeArea = (html: string): Record<string, boolean> => ({
      edgeToEdge: /<meta name="viewport" content="[^"]*viewport-fit=cover/.test(html),
      ...Object.fromEntries(
        ["top", "right", "bottom", "left"].map(edge => [edge, html.includes(`env(safe-area-inset-${edge}`)]),
      ),
    });
    const all = { edgeToEdge: true, top: true, right: true, bottom: true, left: true };

    expect({ landing: keepsSafeArea(landing.html), dashboard: keepsSafeArea(dashboard.html) }).toEqual({
      landing: all,
      dashboard: all,
    });
  });
});
