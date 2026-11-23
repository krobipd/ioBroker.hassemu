/**
 * Guard BS-7 — the dashboard: as soon as a target is chosen and reachable, the display shows the target (VIS, VIS-2,
 * Aura, admin or an own address) over the whole screen, without a frame and without anything added by hassemu; the page
 * asks hassemu every 30 seconds and reloads only when another target is chosen.
 *
 * The page, BS-7 (dashboard): "As soon as a target is chosen and reachable." "Shows your target (VIS, VIS-2, Aura,
 * Admin or an own address) over the whole screen, without a frame and without any addition by hassemu. That is why
 * there is no picture here." "The page asks hassemu every 30 seconds. It is reloaded only when you choose another
 * target."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 20:19 ("so bs1 to bs9 are
 * ok").
 *
 * Path: the web server as main.ts starts it with a reachable target; a display asks for / once, a target is chosen for
 * it — a dashboard of the list through its mode, an own address through the mode "Manual URL" and its datapoint — and
 * it asks for / again. The served page then runs in a sandbox (node:vm) with a fake window and document; whatever it
 * fetches goes to the same server with the display's cookie. The host carries one network (192.168.77.0/24); the data
 * folder is a map in memory, since a guard writes no file.
 */

import type * as Os from "node:os";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@iobroker/adapter-core", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "admin", "i18n");
  const texts = Object.fromEntries(
    readdirSync(dir)
      .filter(file => file.endsWith(".json"))
      .map(file => [
        file.replace(/\.json$/, ""),
        JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, string>,
      ]),
  );
  return {
    I18n: {
      getTranslatedObject: (key: string): Record<string, string> => {
        const out = Object.fromEntries(
          Object.entries(texts).flatMap(([lang, all]) => (all[key] ? [[lang, all[key]]] : [])),
        );
        return Object.keys(out).length > 0 ? out : { en: key };
      },
      translate: (key: string): string => texts.en?.[key] ?? key,
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

import { ClientRegistry } from "../lib/client-registry";
import { MODE_GLOBAL, MODE_MANUAL, NO_CHOICE } from "../lib/constants";
import { GlobalConfig } from "../lib/global-config";
import type { AdapterConfig } from "../lib/types";
import { WebServer } from "../lib/webserver";

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): unknown;
}

/** One line the adapter logged. */
interface LogLine {
  level: string;
  msg: string;
}

/** An adapter over a database in memory, with what it wrote and logged. */
interface Memory {
  adapter: Record<string, unknown>;
  objects: Map<string, ioBroker.Object>;
  states: Map<string, ioBroker.State>;
  /** Every call that wrote, deleted or extended a foreign id, by method name. */
  foreign: string[];
  /** Every line the adapter logged. */
  logs: LogLine[];
}

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const TARGET = "http://192.168.77.20:8082/vis-2/index.html?main";
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

/** An adapter whose database lives in memory; every method that touches a foreign id is recorded, every log line kept. */
function memory(): Memory {
  const objects = new Map<string, ioBroker.Object>();
  const states = new Map<string, ioBroker.State>();
  const foreign: string[] = [];
  const logs: LogLine[] = [];
  const full = (id: string): string => (id.startsWith(`${NS}.`) ? id : `${NS}.${id}`);
  const noop = (): void => undefined;
  const line =
    (level: string) =>
    (msg: string): void =>
      void logs.push({ level, msg });
  const base: Record<string, unknown> = {
    namespace: NS,
    log: {
      silly: line("silly"),
      debug: line("debug"),
      info: line("info"),
      warn: line("warn"),
      error: line("error"),
      level: "debug",
    },
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
  return { adapter, objects, states, foreign, logs };
}

/**
 * The web server as main.ts starts it, German as the system language, the master switch off and no global target, so a
 * new display gets no target (main.ts: a new display follows the global target only while the master switch is on).
 *
 * @param mem the adapter
 * @param reachable what the target probe answers
 */
async function started(mem: Memory, reachable: boolean): Promise<{ server: WebServer; registry: ClientRegistry }> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  await global.handleEnabledWrite(false);
  registry.setNewClientModeProvider(() => (global.isEnabled() ? MODE_GLOBAL : NO_CHOICE));
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired: false,
    username: "admin",
    password: "",
    mdnsEnabled: false,
    serviceName: "ioBroker",
  };
  const server = new WebServer(mem.adapter as never, config, registry, global, registry.serverUuid, "de", () =>
    Promise.resolve(reachable),
  );
  servers.push(server);
  await server.start();
  return { server, registry };
}

/**
 * One request to the server from a peer address.
 *
 * @param server the server
 * @param peer the peer address on the socket
 * @param method the method
 * @param url the path
 * @param extra cookie, form body
 * @param extra.cookie the display's cookie header
 * @param extra.form a form body
 */
function ask(
  server: WebServer,
  peer: string,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; form?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (extra.cookie) {
    headers.cookie = extra.cookie;
  }
  if (extra.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const payload = extra.form ? new URLSearchParams(extra.form).toString() : undefined;
  return server.inject({ method, url, headers, payload, remoteAddress: peer });
}

/**
 * The text of an HTML fragment with its entities resolved.
 *
 * @param html the escaped text
 */
function unescaped(html: string | undefined): string | undefined {
  return html
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One element of the page, faked: its classes and inline style. */
interface FakeElement {
  classes: Set<string>;
  style: Record<string, string>;
  classList: { contains(c: string): boolean; add(c: string): void; remove(c: string): void };
}

/** The served page, running in a sandbox. */
interface Running {
  /** The page's elements with an id. */
  elements: Map<string, FakeElement>;
  /** Every `window.setInterval` of the page, held. */
  intervals: { cb: () => void; ms: number }[];
  /** Every address the page fetched. */
  fetched: string[];
  /** How often the page called `location.reload()`. */
  reloads(): number;
  /** Let every held interval fire once and wait until the page has handled the answers. */
  tick(): Promise<void>;
  /** Run code inside the page, e.g. a button's `onclick`. */
  run(code: string): void;
}

/**
 * Run the inline scripts of a served page in one sandbox, with a fake window and document; the page's `fetch` goes to
 * `answer`.
 *
 * @param html the page
 * @param answer what a fetch of the page gets
 */
function running(html: string, answer: (url: string) => Promise<unknown>): Running {
  const elements = new Map<string, FakeElement>();
  for (const m of html.matchAll(/<(?:div|iframe)\s+id="([^"]+)"([^>]*)>/g)) {
    const classes = new Set((/class="([^"]*)"/.exec(m[2])?.[1] ?? "").split(/\s+/).filter(Boolean));
    const style: Record<string, string> = /style="display:none"/.test(m[2]) ? { display: "none" } : {};
    elements.set(m[1], {
      classes,
      style,
      classList: {
        contains: (c: string): boolean => classes.has(c),
        add: (c: string): void => void classes.add(c),
        remove: (c: string): void => void classes.delete(c),
      },
    });
  }
  const intervals: { cb: () => void; ms: number }[] = [];
  const fetched: string[] = [];
  const pending: Promise<unknown>[] = [];
  let reloads = 0;
  const context = createContext({
    window: {
      setTimeout: (): number => 0,
      setInterval: (cb: () => void, ms: number): number => intervals.push({ cb, ms }),
    },
    document: { getElementById: (id: string): FakeElement | null => elements.get(id) ?? null },
    location: {
      reload: (): void => {
        reloads++;
      },
    },
    fetch: (url: string): Promise<unknown> => {
      fetched.push(url);
      const reply = answer(url);
      pending.push(reply.catch(() => undefined));
      return reply;
    },
    JSON,
    Promise,
  });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    runInContext(m[1], context);
  }
  return {
    elements,
    intervals,
    fetched,
    reloads: () => reloads,
    tick: async (): Promise<void> => {
      for (const interval of intervals) {
        interval.cb();
      }
      await Promise.all(pending.splice(0));
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    run: (code: string): void => void runInContext(code, context),
  };
}

/** A choice of target for one display. */
type Choice = (registry: ClientRegistry, id: string) => Promise<void>;

/**
 * A display that asked for / once, then got its target chosen, and asked again.
 *
 * @param server the server
 * @param registry the registry
 * @param peer the display's address
 * @param choose how its target is chosen
 */
async function displayOnTarget(
  server: WebServer,
  registry: ClientRegistry,
  peer: string,
  choose: Choice,
): Promise<{ id: string; cookie: string; page: Answer }> {
  const before = await ask(server, peer, "GET", "/");
  const raw = before.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  const cookie = /hassemu_client=[^;]+/.exec(setCookie)?.[0] ?? "";
  const id = registry.getByCookie(cookie.replace(/^hassemu_client=/, ""))?.id;
  if (id === undefined) {
    throw new Error("the case needs the display its first visit creates");
  }
  await choose(registry, id);
  const page = await ask(server, peer, "GET", "/", { cookie });
  return { id, cookie, page };
}

/**
 * What the display's fetch gets: the same server, with the display's cookie.
 *
 * @param server the server
 * @param peer the display's address
 * @param cookie the display's cookie
 */
function servedBy(
  server: WebServer,
  peer: string,
  cookie: string,
): (url: string) => Promise<{ json(): Promise<unknown> }> {
  return async url => {
    const reply = await ask(server, peer, "GET", url, { cookie });
    const body = reply.json();
    return { json: () => Promise.resolve(body) };
  };
}

/**
 * The elements the body shows at its top level once the page's scripts ran — scripts aside, an element is hidden when
 * its own style or the page's stylesheet hides it and no class of it shows it again.
 *
 * @param html the page
 * @param shown the page, running
 */
function shownOnScreen(html: string, shown: Running): string[] {
  const body = (/<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "").replace(/<script>[\s\S]*?<\/script>/g, "");
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
  const visible: string[] = [];
  let depth = 0;
  let last = 0;
  for (const m of body.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/gi)) {
    if (depth === 0 && body.slice(last, m.index).trim() !== "") {
      visible.push("text");
    }
    last = (m.index ?? 0) + m[0].length;
    if (m[1] === "/") {
      depth--;
      continue;
    }
    if (depth === 0) {
      const id = /\bid="([^"]+)"/.exec(m[3])?.[1];
      const element = id === undefined ? undefined : shown.elements.get(id);
      const hiddenByStyle = element?.style.display === "none";
      const hiddenBySheet = id !== undefined && css.includes(`#${id}{display:none`);
      const shownByClass = [...(element?.classes ?? [])].some(c => css.includes(`#${id}.${c}{display:`));
      if (!hiddenByStyle && (!hiddenBySheet || shownByClass)) {
        visible.push(id ?? m[2]);
      }
    }
    depth++;
  }
  if (body.slice(last).trim() !== "") {
    visible.push("text");
  }
  return visible;
}

const PEER = "192.168.77.50";
/** The targets the rule names, each as the user chooses it. */
const TARGETS: { kind: string; url: string; choose: Choice }[] = [
  ["VIS", "http://192.168.77.20:8082/vis/index.html?main"],
  ["VIS-2", TARGET],
  ["Aura", "http://192.168.77.21:8099/aura/"],
  ["admin", "http://192.168.77.20:8081/"],
].map(([kind, url]) => ({ kind, url, choose: (registry, id) => registry.handleModeWrite(id, url) }));
TARGETS.push({
  kind: "an own address",
  url: "http://192.168.77.30/wall.html",
  choose: async (registry, id) => {
    await registry.handleModeWrite(id, MODE_MANUAL);
    await registry.handleManualUrlWrite(id, "http://192.168.77.30/wall.html");
  },
});

describe("BS-7: the dashboard", () => {
  it("as soon as a target is chosen and reachable: the target over the whole screen, without a frame and without anything added by hassemu", async () => {
    const seen: Record<string, unknown>[] = [];
    for (const target of TARGETS) {
      const { server, registry } = await started(memory(), true);
      const { page } = await displayOnTarget(server, registry, PEER, target.choose);
      const shown = running(page.body, () => new Promise(() => undefined));
      const iframeRule = (/\niframe\{([^}]*)\}/.exec(page.body)?.[1] ?? "").split(";");
      const bodyRule = (/html,body\{([^}]*)\}/.exec(page.body)?.[1] ?? "").split(";");
      seen.push({
        kind: target.kind,
        shows: unescaped(/<iframe id="hassemu-iframe" src="([^"]*)"/.exec(page.body)?.[1]),
        wholeScreen: ["position:fixed", "top:0", "left:0", "width:100vw", "height:100vh"].every(d =>
          iframeRule.includes(d),
        ),
        noFrame: iframeRule.includes("border:0") && bodyRule.includes("margin:0"),
        onScreen: shownOnScreen(page.body, shown),
      });
    }

    expect(seen).toEqual(
      TARGETS.map(target => ({
        kind: target.kind,
        shows: target.url,
        wholeScreen: true,
        noFrame: true,
        onScreen: ["hassemu-iframe"],
      })),
    );
  });

  it("the page asks hassemu every 30 seconds", async () => {
    const { server, registry } = await started(memory(), true);
    const { cookie, page } = await displayOnTarget(server, registry, PEER, TARGETS[1].choose);
    const shown = running(page.body, servedBy(server, PEER, cookie));

    await shown.tick();
    await shown.tick();
    await shown.tick();

    expect({
      every: shown.intervals.map(i => i.ms),
      asked: shown.fetched.length,
      ofHassemu: shown.fetched.every(url => url.startsWith("/") && !url.startsWith("//")),
    }).toEqual({ every: [30_000], asked: 3, ofHassemu: true });
  });

  it("it reloads only when another target is chosen", async () => {
    const { server, registry } = await started(memory(), true);
    const { id, cookie, page } = await displayOnTarget(server, registry, PEER, TARGETS[1].choose);
    const shown = running(page.body, servedBy(server, PEER, cookie));

    await shown.tick();
    await shown.tick();
    await shown.tick();
    const sameTarget = shown.reloads();
    await registry.handleModeWrite(id, TARGETS[2].url);
    await shown.tick();

    expect({ sameTarget, anotherTarget: shown.reloads() }).toEqual({ sameTarget: 0, anotherTarget: 1 });
  });
});
