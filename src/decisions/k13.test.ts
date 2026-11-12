/**
 * Guard K13 — the card "target not reachable": two unanswered checks in a row show it, the first answer reloads, and
 * hassemu itself checks the target.
 *
 * The page, K13: "If the target page does not answer twice in a row, the display shows a card instead of an empty
 * screen. As soon as the page answers again, it reloads. Whether the target answers is checked by hassemu itself, not
 * by the display."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:39 ("k8, k9, k10, k11, k12
 * and k13 are ok, yes").
 *
 * Path: the web server as main.ts starts it, with the production reachability probe, every display following the
 * global target — a small HTTP server on a free local port that answers or drops each connection. A display's first
 * page (GET /) is taken from the server, and its inline scripts — the decision copy embedded in the page included — run
 * in a sandbox whose fetch asks the same server; each poll tick is fired by hand with the clock moved on by the poll
 * interval. The host carries one network (192.168.77.0/24); the data folder is a map in memory, since a guard writes
 * no file.
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
import { decidePollAction } from "../lib/redirect-wrapper";
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
  state: { down: boolean; connections: number };
  server: http.Server;
}

/** A page element as the inline script touches it. */
interface FakeElement {
  style: Record<string, string>;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
}

/** A display's page running in a sandbox. */
interface Display {
  /** Fire one poll tick and wait until the page has handled the answer. */
  tick(): Promise<void>;
  /** Every URL the page fetched. */
  fetched: string[];
  /** Every answer of /api/redirect_check the page received. */
  answers: unknown[];
  cardVisible(): boolean;
  iframeHidden(): boolean;
  reloads(): number;
}

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const PEER = "192.168.77.50";
const UA = "Mozilla/5.0 (Linux; Android 13; WebView)";
/** One poll interval of the page — the clock moves on by this much before each tick. */
const POLL_STEP_MS = 30_000;
/** The clock the server reads — moved on by hand, so the probe's cache window passes between two ticks. */
const clock = { now: 0 };
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
  vi.restoreAllMocks();
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
 * The web server as main.ts starts it — the production probe, every display following the global target, the master
 * switch on.
 *
 * @param mem the adapter
 * @param target the global target
 */
async function started(mem: Memory, target: string): Promise<WebServer> {
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
  const server = new WebServer(mem.adapter as never, config, registry, global, registry.serverUuid, "en");
  servers.push(server);
  await server.start();
  return server;
}

/** The redirect target on a free local port; it answers until `down` is set, then drops every connection. */
async function targetServer(): Promise<Target> {
  const state = { down: false, connections: 0 };
  const server = http.createServer((_req, res) => {
    res.end("dashboard");
  });
  server.on("connection", (socket: net.Socket) => {
    state.connections++;
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
 * @param style the inline style it starts with
 */
function element(classes: string[], style: Record<string, string>): FakeElement {
  const set = new Set(classes);
  return {
    style,
    classList: {
      add: (name: string): void => void set.add(name),
      remove: (name: string): void => void set.delete(name),
      contains: (name: string): boolean => set.has(name),
    },
  };
}

/**
 * A display loads its first page from the server and runs the page's inline scripts in a sandbox: its fetch asks the
 * same server with the display's cookie, its timers are held, each poll tick is fired by hand.
 *
 * @param server the server
 */
async function openPage(server: WebServer): Promise<Display> {
  const first = await server.inject({ method: "GET", url: "/", headers: { "user-agent": UA }, remoteAddress: PEER });
  const raw = first.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  const cookie = /hassemu_client=[^;]+/.exec(setCookie)?.[0] ?? "";
  const html = first.body;
  const iframe = element(
    [],
    /<iframe id="hassemu-iframe"[^>]*style="display:none"/.test(html) ? { display: "none" } : {},
  );
  const card = element(/<div id="hassemu-target-down" class="visible"/.test(html) ? ["visible"] : [], {});
  const down = element([], {});
  const byId: Record<string, FakeElement> = {
    "hassemu-iframe": iframe,
    "hassemu-target-down": card,
    "hassemu-down": down,
  };
  const intervals: (() => void)[] = [];
  const fetched: string[] = [];
  const answers: unknown[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  let reloads = 0;
  const window: Record<string, unknown> = {
    setTimeout: (): number => 0,
    setInterval: (callback: () => void): number => intervals.push(callback),
  };
  const sandbox = vm.createContext({
    window,
    document: { getElementById: (id: string): FakeElement | null => byId[id] ?? null },
    location: { reload: (): void => void reloads++ },
    fetch: (url: string): Promise<{ json: () => Promise<unknown> }> => {
      fetched.push(url);
      const answer = server
        .inject({ method: "GET", url, headers: { cookie, "user-agent": UA }, remoteAddress: PEER })
        .then(res => {
          const body: unknown = res.json();
          answers.push(body);
          return { json: (): Promise<unknown> => Promise.resolve(body) };
        });
      pending = answer;
      return answer;
    },
  });
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], sandbox);
  }
  return {
    tick: async (): Promise<void> => {
      clock.now += POLL_STEP_MS;
      for (const callback of intervals) {
        callback();
      }
      await pending;
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    fetched,
    answers,
    cardVisible: (): boolean => card.classList.contains("visible"),
    iframeHidden: (): boolean => iframe.style.display === "none",
    reloads: (): number => reloads,
  };
}

/**
 * The decision copy a page carries, taken out of the served page and evaluated in an empty context, the way the
 * display's browser runs it.
 *
 * @param html the served page
 */
function embeddedDecision(html: string): typeof decidePollAction | null {
  const text = /var decide=([\s\S]*?);\n\s*window\.setInterval\(/.exec(html)?.[1];
  return text ? (vm.runInNewContext(`(${text})`) as typeof decidePollAction) : null;
}

describe("K13: two unanswered checks show the card, the first answer reloads, and hassemu checks the target", () => {
  it("shows the card after the second unanswered check in a row and reloads as soon as the target answers", async () => {
    clock.now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const target = await targetServer();
    const server = await started(memory(), target.url);
    const display = await openPage(server);
    const atStart = { card: display.cardVisible(), hidden: display.iframeHidden(), reloads: display.reloads() };

    target.state.down = true;
    await display.tick();
    const afterFirst = { card: display.cardVisible(), hidden: display.iframeHidden(), reloads: display.reloads() };
    await display.tick();
    const afterSecond = { card: display.cardVisible(), hidden: display.iframeHidden(), reloads: display.reloads() };
    target.state.down = false;
    await display.tick();
    const afterAnswer = { reloads: display.reloads() };

    expect({ atStart, afterFirst, afterSecond, afterAnswer }).toEqual({
      atStart: { card: false, hidden: false, reloads: 0 },
      afterFirst: { card: false, hidden: false, reloads: 0 },
      afterSecond: { card: true, hidden: true, reloads: 0 },
      afterAnswer: { reloads: 1 },
    });
    expect(display.answers).toEqual([
      { target: target.url, targetReachable: false },
      { target: target.url, targetReachable: false },
      { target: target.url, targetReachable: true },
    ]);
  });

  it("checks the target from the server: the page only ever asks hassemu, the target sees hassemu's probes", async () => {
    clock.now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const target = await targetServer();
    const server = await started(memory(), target.url);
    const display = await openPage(server);
    const beforeTicks = target.state.connections;

    target.state.down = true;
    await display.tick();
    await display.tick();

    expect({
      firstPageProbed: beforeTicks,
      pageFetched: display.fetched,
      probesDuringTicks: target.state.connections - beforeTicks,
      answers: display.answers.length,
    }).toEqual({
      firstPageProbed: 1,
      pageFetched: ["/api/redirect_check", "/api/redirect_check"],
      probesDuringTicks: 2,
      answers: 2,
    });
  });

  it("runs the same decision in the page as in the adapter, for unanswered, answered and recovered checks", async () => {
    const target = await targetServer();
    const server = await started(memory(), target.url);
    const page = await server.inject({ method: "GET", url: "/", headers: { "user-agent": UA }, remoteAddress: PEER });
    const copy = embeddedDecision(page.body);
    const current = target.url;
    const inputs = [
      {
        current,
        body: { target: current, targetReachable: false },
        targetFails: 0,
        targetThreshold: 2,
        targetDownVisible: false,
      },
      {
        current,
        body: { target: current, targetReachable: false },
        targetFails: 1,
        targetThreshold: 2,
        targetDownVisible: false,
      },
      {
        current,
        body: { target: current, targetReachable: true },
        targetFails: 1,
        targetThreshold: 2,
        targetDownVisible: false,
      },
      {
        current,
        body: { target: current, targetReachable: true },
        targetFails: 2,
        targetThreshold: 2,
        targetDownVisible: true,
      },
    ];

    expect({ embedded: copy !== null }).toEqual({ embedded: true });
    expect(inputs.map(input => copy?.(input))).toEqual(inputs.map(input => decidePollAction(input)));
    expect(inputs.map(input => decidePollAction(input).action)).toEqual(["none", "show-target-down", "none", "reload"]);
  });
});
