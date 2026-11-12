/**
 * Guard BS-6 — the landing page without a target: "Display connected", the display's id and IP address and a guide in
 * three steps, in the system language; it reloads every 15 seconds, and id and path follow the id form of K7.
 *
 * The page, BS-6 (landing page without a target): "As long as no target is chosen for the display. You accepted the
 * behaviour in K10; here it is about the picture." "Shows 'Display connected', id and IP address of the display and a
 * guide in three steps, where in the admin you choose the target." "Reloads itself every 15 seconds. Id and path in the
 * guide follow the new id from K7." The screens: "the texts exist in eleven languages", shown "in German system
 * language".
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 20:19 ("so bs1 to bs9 are
 * ok").
 *
 * Path: the web server as main.ts starts it with German as the system language and the master switch off, so a new
 * display gets no target; a Companion app asks for / as a display does, then once more after a target was chosen for
 * it. The texts come from the adapter's own admin/i18n files, read as data. The host carries one network
 * (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as Os from "node:os";
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
 */
async function started(mem: Memory): Promise<{ server: WebServer; registry: ClientRegistry }> {
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
    Promise.resolve(true),
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
 * @param extra cookie, form body, user agent
 * @param extra.cookie the display's cookie header
 * @param extra.form a form body
 * @param extra.agent the User-Agent header
 */
function ask(
  server: WebServer,
  peer: string,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; form?: Record<string, string>; agent?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": extra.agent ?? "Mozilla/5.0 (Linux; Android 13; WebView)" };
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

/**
 * The displays under clients, by id.
 *
 * @param mem the adapter
 */
function displayIds(mem: Memory): string[] {
  return [...mem.objects]
    .filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device")
    .map(([id]) => id.slice(`${NS}.clients.`.length));
}

/**
 * What the landing page shows.
 *
 * @param page the answer
 */
function landing(page: Answer): Record<string, unknown> {
  const steps = /<ol class="steps">([\s\S]*?)<\/ol>/.exec(page.body)?.[1] ?? "";
  return {
    status: page.statusCode,
    lang: /<html lang="([^"]+)"/.exec(page.body)?.[1],
    heading: unescaped(/<h1>([^<]*)<\/h1>/.exec(page.body)?.[1]),
    idRow: [...(/<tr><th scope="row">([^<]*)<\/th><td><code>([^<]*)<\/code><\/td><\/tr>/.exec(page.body) ?? [])]
      .slice(1)
      .map(unescaped),
    ipRow: [...(/<tr><th scope="row">([^<]*)<\/th><td>([^<]*)<\/td><\/tr>/.exec(page.body) ?? [])]
      .slice(1)
      .map(unescaped),
    steps: [...steps.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m =>
      unescaped(m[1].replace(/<code>([^<]*)<\/code>/g, "[$1]")),
    ),
    reloadSeconds: /<meta http-equiv="refresh" content="([^"]*)">/.exec(page.body)?.[1],
    reloadNote: unescaped(/<footer>\s*([^<]*?)\s*</.exec(page.body)?.[1]),
  };
}

const COMPANION = "Home Assistant/2026.11.1 (Android 13; SM-T220)";

describe("BS-6: the landing page shows 'Display connected', id, IP and three steps in the system language, reloading every 15 s", () => {
  it("shows the German landing page with the K7 id in the id row and in the guide's path while no target is chosen", async () => {
    const de = language("de");
    const en = language("en");
    const mem = memory();
    const { server, registry } = await started(mem);
    const peer = "192.168.77.50";

    const first = await ask(server, peer, "GET", "/", { agent: COMPANION });
    await new Promise(resolve => setTimeout(resolve, 0));
    const raw = first.headers["set-cookie"];
    const setCookie = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
    const cookie = /hassemu_client=[^;]+/.exec(setCookie)?.[0] ?? "";
    const again = await ask(server, peer, "GET", "/", { agent: COMPANION, cookie });
    const ids = displayIds(mem);
    const id = ids[0] ?? "";
    await registry.handleModeWrite(id, TARGET);
    const chosen = await ask(server, peer, "GET", "/", { agent: COMPANION, cookie });

    const keys = [
      "pageConnectedHeading",
      "pageDeviceId",
      "pageIpAddress",
      "pageStep1",
      "pageStep2",
      "pageStep3",
      "pageAutoRefresh",
    ];
    expect({ differs: keys.filter(key => de[key] === en[key]) }).toEqual({ differs: [] });
    expect({ ids: ids.length, k7Form: /^sm-t220-[0-9a-f]{4}$/.test(id) }).toEqual({ ids: 1, k7Form: true });
    const expected = {
      status: 200,
      lang: "de",
      heading: de.pageConnectedHeading,
      idRow: [de.pageDeviceId, id],
      ipRow: [de.pageIpAddress, peer],
      steps: [de.pageStep1, `${de.pageStep2} [${NS}.clients.${id}]`, de.pageStep3],
      reloadSeconds: "15",
      reloadNote: de.pageAutoRefresh,
    };
    expect({ first: landing(first), again: landing(again) }).toEqual({ first: expected, again: expected });
    expect({
      landingAfterChoice: /<ol class="steps">/.test(chosen.body),
      showsTarget: chosen.body.includes(`<iframe id="hassemu-iframe" src="${TARGET}"`),
    }).toEqual({ landingAfterChoice: false, showsTarget: true });
  });
});
