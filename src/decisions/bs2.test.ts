/**
 * Guard BS-2 — a sign-in with a wrong user name or password shows the same sign-in page with a red notice above the
 * fields, in the system language; there is no lock, and the log carries only the first refusal per time window.
 *
 * The page, BS-2 (sign-in with a wrong password): "After a sign-in with a wrong user name or password." "Shows the same
 * page with a red notice above the fields." "There is no lock: you can try again as often as you like. The log shows
 * only the first refusal per time window." The screens: "the texts exist in eleven languages", shown "in German system
 * language".
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 20:19 ("so bs1 to bs9 are
 * ok").
 *
 * Path: the web server as main.ts starts it, with sign-in required and German as the system language; the sign-in form
 * the Companion app opens (GET /auth/authorize) is sent back (POST /auth/authorize) with wrong credentials, again and
 * again, and then with the right ones. The texts come from the adapter's own admin/i18n files, read as data; the log
 * lines are the adapter logger's. The host carries one network (192.168.77.0/24); the data folder is a map in memory,
 * since a guard writes no file.
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
import { REQUEST_ERROR_COOLDOWN_MS } from "../lib/constants";
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
const USER = "admin";
const PASSWORD = "geheim-77";
const servers: WebServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  files.clear();
  vi.restoreAllMocks();
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
 * The web server as main.ts starts it, sign-in required, German as the system language.
 *
 * @param mem the adapter
 */
async function started(mem: Memory): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  await global.handleModeWrite(TARGET);
  await global.handleEnabledWrite(true);
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired: true,
    username: USER,
    password: PASSWORD,
    mdnsEnabled: false,
    serviceName: "ioBroker",
  };
  const server = new WebServer(mem.adapter as never, config, registry, global, registry.serverUuid, "de", () =>
    Promise.resolve(true),
  );
  servers.push(server);
  await server.start();
  return server;
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

/**
 * Whether a hue is red.
 *
 * @param h the hue
 */
function isRed(h: number): boolean {
  return h >= 0 && (h < 15 || h >= 345);
}

const QUERY = {
  response_type: "code",
  client_id: "https://home-assistant.io/android",
  redirect_uri: "homeassistant://auth-callback",
  state: "s1",
};

describe("BS-2: a wrong sign-in shows the same page with a red notice above the fields, no lock, one log line per window", () => {
  it("shows the sign-in page again with the German notice above the fields, in red", async () => {
    const de = language("de");
    const en = language("en");
    const mem = memory();
    const server = await started(mem);
    const peer = "192.168.77.50";

    const form = await ask(server, peer, "GET", `/auth/authorize?${new URLSearchParams(QUERY).toString()}`);
    const wrongUser = await ask(server, peer, "POST", "/auth/authorize", {
      form: { ...QUERY, username: "someone", password: PASSWORD },
    });
    const wrongPassword = await ask(server, peer, "POST", "/auth/authorize", {
      form: { ...QUERY, username: USER, password: "wrong" },
    });

    expect({ differs: de.authInvalidCredentials !== en.authInvalidCredentials }).toEqual({ differs: true });
    for (const refused of [wrongUser, wrongPassword]) {
      const notice = /<div class="err">([^<]*)<\/div>/.exec(refused.body);
      const errRule = /\.err\{[^}]*\}/.exec(refused.body)?.[0] ?? "";
      expect({
        status: refused.statusCode,
        lang: /<html lang="([^"]+)"/.exec(refused.body)?.[1],
        notice: unescaped(notice?.[1]),
        noticeAboveFields:
          notice !== null &&
          refused.body.indexOf(notice[0]) < refused.body.indexOf('<input type="text" name="username"'),
        samePageOtherwise: refused.body.replace(/<div class="err">[^<]*<\/div>/, "") === form.body,
        noticeTextRed: isRed(hue(/[;{]color:(#[0-9a-fA-F]{6})/.exec(errRule)?.[1])),
        noticeBackgroundRed: isRed(hue(/background:(#[0-9a-fA-F]{6})/.exec(errRule)?.[1])),
      }).toEqual({
        status: 401,
        lang: "de",
        notice: de.authInvalidCredentials,
        noticeAboveFields: true,
        samePageOtherwise: true,
        noticeTextRed: true,
        noticeBackgroundRed: true,
      });
    }
  });

  it("has no lock: after many refusals the right credentials still sign in", async () => {
    const mem = memory();
    const server = await started(mem);
    const peer = "192.168.77.51";

    const refusals: number[] = [];
    for (let i = 0; i < 8; i++) {
      const refused = await ask(server, peer, "POST", "/auth/authorize", {
        form: { ...QUERY, username: USER, password: `wrong-${i}` },
      });
      refusals.push(refused.statusCode);
    }
    const right = await ask(server, peer, "POST", "/auth/authorize", {
      form: { ...QUERY, username: USER, password: PASSWORD },
    });

    expect({
      refusals,
      signedIn: right.statusCode,
      handover: /document\.location\.assign\("homeassistant:\/\/auth-callback\?code=[^"&]+&state=s1"\)/.test(
        right.body,
      ),
    }).toEqual({ refusals: Array.from({ length: 8 }, () => 401), signedIn: 200, handover: true });
  });

  it("logs the first refusal of a window as a warning, every further one in that window on debug only", async () => {
    const start = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const mem = memory();
    const server = await started(mem);
    const refusalLines = (level: string): number =>
      mem.logs.filter(l => l.level === level && l.msg.startsWith("Invalid credentials")).length;

    for (const peer of ["192.168.77.52", "192.168.77.53", "192.168.77.52", "192.168.77.54"]) {
      await ask(server, peer, "POST", "/auth/authorize", { form: { ...QUERY, username: USER, password: "wrong" } });
    }
    const inWindow = { warn: refusalLines("warn"), debug: refusalLines("debug") };
    now.mockReturnValue(start + REQUEST_ERROR_COOLDOWN_MS + 1);
    await ask(server, "192.168.77.52", "POST", "/auth/authorize", {
      form: { ...QUERY, username: USER, password: "wrong" },
    });
    const nextWindow = { warn: refusalLines("warn"), debug: refusalLines("debug") };

    expect({ inWindow, nextWindow }).toEqual({ inWindow: { warn: 1, debug: 3 }, nextWindow: { warn: 2, debug: 3 } });
  });
});
