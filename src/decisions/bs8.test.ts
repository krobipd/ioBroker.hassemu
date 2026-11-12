/**
 * Guard BS-8 — the card "Redirect target not reachable": an orange card with the target's address, the display's id
 * and IP address and the button "Reload now", in the system language.
 *
 * The page, BS-8 (card "redirect target not reachable"): "When the target does not answer. You accepted the behaviour
 * in K13; here it is about the picture." "Shows an orange card with the address of the target, id and IP address of
 * the display and the button 'Reload now'." The screens: "the texts exist in eleven languages", shown "in German system
 * language".
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 20:19 ("so bs1 to bs9 are
 * ok").
 *
 * Path: the web server as main.ts starts it with German as the system language and a target probe that finds the
 * target silent; a display asks for / (no target yet), its mode is set to a URL through the registry's mode write, and
 * it asks for / again. The served page runs in a sandbox (node:vm) with a fake window and document, which shows which
 * card is up and what its button does. The texts come from the adapter's own admin/i18n files, read as data. The host
 * carries one network (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { MODE_GLOBAL, NO_CHOICE } from "../lib/constants";
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
 * One language file of the adapter, read as data.
 *
 * @param lang the language
 */
function language(lang: string): Record<string, string> {
  return JSON.parse(readFileSync(join(process.cwd(), "admin", "i18n", `${lang}.json`), "utf8")) as Record<
    string,
    string
  >;
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

/**
 * A display that asked for / once (no target yet), then got a URL as its mode through the registry, and asked again.
 *
 * @param server the server
 * @param registry the registry
 * @param peer the display's address
 * @param target the URL the mode is set to
 */
async function displayOnTarget(
  server: WebServer,
  registry: ClientRegistry,
  peer: string,
  target: string,
): Promise<{ id: string; cookie: string; before: Answer; page: Answer }> {
  const before = await ask(server, peer, "GET", "/");
  const raw = before.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  const cookie = /hassemu_client=[^;]+/.exec(setCookie)?.[0] ?? "";
  const id = registry.getByCookie(cookie.replace(/^hassemu_client=/, ""))?.id ?? "";
  await registry.handleModeWrite(id, target);
  const page = await ask(server, peer, "GET", "/", { cookie });
  return { id, cookie, before, page };
}

/**
 * The hue (0–360°) of a `#rrggbb` color.
 *
 * @param hex the color
 */
function hue(hex: string | undefined): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt((hex ?? "#000000").slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) {
    return -1;
  }
  const h = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (h * 60 + 360) % 360;
}

describe("BS-8: the target-down card is orange and shows the target's address, the display's id and IP and 'Reload now'", () => {
  it("shows the German card with the target, id, IP and a reload button when the target does not answer", async () => {
    const de = language("de");
    const en = language("en");
    const mem = memory();
    const { server, registry } = await started(mem, false);
    const peer = "192.168.77.50";

    const { id, page } = await displayOnTarget(server, registry, peer, TARGET);
    const shown = running(page.body, () => new Promise(() => undefined));
    const start = page.body.indexOf('<div id="hassemu-target-down"');
    const card = start < 0 ? "" : page.body.slice(start, page.body.indexOf("<script>", start));
    const rows = [
      ...card.matchAll(/<tr><th scope="row">([^<]*)<\/th><td[^>]*>(?:<code>)?([^<]*)(?:<\/code>)?<\/td><\/tr>/g),
    ].map(m => [unescaped(m[1]), unescaped(m[2])]);
    const button = /<button type="button" onclick="([^"]*)">([^<]*)<\/button>/.exec(card);
    const banner = /#hassemu-target-down \.banner\{background:(#[0-9a-fA-F]{6})/.exec(page.body)?.[1];
    const reloadsBefore = shown.reloads();
    shown.run(unescaped(button?.[1]) ?? "");

    const keys = ["pageTargetOfflineHeading", "pageTargetUrl", "pageDeviceId", "pageIpAddress", "pageReload"];
    expect({ differs: keys.filter(key => de[key] === en[key]) }).toEqual({ differs: [] });
    const orange = hue(banner);
    expect({
      status: page.statusCode,
      lang: /<html lang="([^"]+)"/.exec(page.body)?.[1],
      cardShown: shown.elements.get("hassemu-target-down")?.classes.has("visible"),
      dashboardHidden: shown.elements.get("hassemu-iframe")?.style.display === "none",
      heading: unescaped(/<h1>([^<]*)<\/h1>/.exec(card)?.[1]),
      rows,
      button: unescaped(button?.[2]),
      buttonReloads: shown.reloads() - reloadsBefore,
      orange: orange >= 20 && orange < 45,
    }).toEqual({
      status: 200,
      lang: "de",
      cardShown: true,
      dashboardHidden: true,
      heading: de.pageTargetOfflineHeading,
      rows: [
        [de.pageTargetUrl, TARGET],
        [de.pageDeviceId, id],
        [de.pageIpAddress, peer],
      ],
      button: de.pageReload,
      buttonReloads: 1,
      orange: true,
    });
  });
});
