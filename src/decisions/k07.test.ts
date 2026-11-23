/**
 * Guard K7 — id: model, hyphen, four characters that hassemu assigns itself; "display" in front when the first visit
 * names no model; a counter after an id that is taken already; once assigned, it never changes. Name: the app's device
 * name as soon as the app reports it, following every change there; without the app the host name, without a host
 * name the IP; a rename in the object tree does not hold, hassemu writes its name back. Existing installations: every
 * existing display moves once — clients.61c3a1 becomes clients.display-c3a1 — with rooms, functions and aliases, and it
 * is still recognised; the update points out in the admin that scripts and visualisations on the old id are the user's
 * to adapt.
 *
 * The page, K7: "New: id — model, hyphen, four characters that hassemu assigns itself. If the display names no model
 * on its first visit, 'display' stands in front. If the id is taken already, a counter comes after it. Once assigned,
 * it never changes." "New: name — the device name from the app as soon as the app reports it; it follows every change
 * there. Without the app the host name, without a host name the IP, as today." "Existing installations: every
 * existing display moves once: clients.61c3a1 becomes clients.display-c3a1, with the last four characters of the old
 * id. Rooms, functions and aliases move along, and the display is still recognised. Scripts and visualisations that
 * point at the old id are for the user to adapt; the update points this out in the admin."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:51 ("k7 is ok"); for the
 * aliases 2026-11-12 20:02 ("Yes, aliases move along") and 20:03 ("But that is a fleet matter and decision and
 * nothing special to hassemu"); for the name 2026-11-11 22:40 ("I cannot imagine I ever approved this behaviour, but
 * it is one of the first adapters, so rather legacy. The adapter has to follow the fleet!"), confirming krobi
 * 2026-09-02 ("a USER has no business stirring in the adapter's datapoints. the adapter or its developer is the only
 * one who may").
 *
 * Path: the adapter class from main.ts, started and stopped through the ready and unload handlers its constructor
 * registers (registry restore with the move of old ids, the web server on a free port), over an adapter whose object
 * and state database lives in memory. Displays reach the running server by inject from a peer address of the host's
 * network (192.168.77.0/24): the first visit, the sign-in, the app's registration and its webhook; host names come
 * from the reverse lookup, answered from a table. For the taken id the four characters hassemu draws are held fixed,
 * so that two displays draw the same. The admin shows an update notice from the manifest's `common.messages` when its
 * condition holds for the versions of the update. The data folder is a fresh folder in the temporary directory,
 * written through the data-folder master as on a host.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DisplayId from "../lib/display-id";

const { data, db, dns, tail } = vi.hoisted(() => ({
  /** The instance data folder of the running test. */
  data: { dir: "" },
  db: {
    objects: new Map<string, ioBroker.Object>(),
    states: new Map<string, ioBroker.State>(),
    /** Every warning, error and termination of the adapter — a start that failed shows here. */
    problems: [] as string[],
  },
  dns: { names: new Map<string, string>(), asked: [] as string[] },
  /** The four characters hassemu draws, held fixed while set. */
  tail: { fixed: "" },
}));

vi.mock("@iobroker/adapter-core", () => {
  const noop = (): void => undefined;
  const ns = "hassemu.0";
  const full = (id: string): string => (id.startsWith(`${ns}.`) ? id : `${ns}.${id}`);
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  /**
   * Merge a patch the way js-controller's extendObject does: plain objects key by key, everything else replaced.
   *
   * @param base the stored value
   * @param patch the patch
   */
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
    namespace = ns;
    adapterDir = "/guard/adapter";
    config: Record<string, unknown> = {};
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    log = {
      silly: noop,
      debug: noop,
      info: noop,
      warn: (msg: string): void => void db.problems.push(`warn: ${msg}`),
      error: (msg: string): void => void db.problems.push(`error: ${msg}`),
      level: "info",
    };
    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, handler);
      return this;
    }
    setInterval(): object {
      return {};
    }
    clearInterval(): void {}
    setTimeout(): object {
      return {};
    }
    clearTimeout(): void {}
    terminate(reason?: unknown): void {
      db.problems.push(`terminate: ${String(reason)}`);
    }
    getObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(db.objects.get(full(id)) ?? null));
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
      const own = [...db.objects].filter(([id]) => id.startsWith(`${ns}.`));
      return Promise.resolve(structuredClone(Object.fromEntries(own)));
    }
    setObjectNotExistsAsync(id: string, obj: object): Promise<{ id: string }> {
      if (!db.objects.has(full(id))) {
        db.objects.set(full(id), { ...structuredClone(obj), _id: full(id) } as ioBroker.Object);
      }
      return Promise.resolve({ id: full(id) });
    }
    extendObject(id: string, patch: object): Promise<{ id: string }> {
      const after = merged(db.objects.get(full(id)) ?? {}, patch) as object;
      db.objects.set(full(id), { ...after, _id: full(id) } as ioBroker.Object);
      return Promise.resolve({ id: full(id) });
    }
    extendForeignObjectAsync(id: string, patch: object): Promise<{ id: string }> {
      const after = merged(db.objects.get(id) ?? {}, patch) as object;
      db.objects.set(id, { ...after, _id: id } as ioBroker.Object);
      return Promise.resolve({ id });
    }
    setForeignObject(id: string, obj: object): Promise<{ id: string }> {
      db.objects.set(id, { ...structuredClone(obj), _id: id } as ioBroker.Object);
      return Promise.resolve({ id });
    }
    delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
      const key = full(id);
      for (const stored of [...db.objects.keys()]) {
        if (stored === key || (options?.recursive === true && stored.startsWith(`${key}.`))) {
          db.objects.delete(stored);
          db.states.delete(stored);
        }
      }
      return Promise.resolve();
    }
    delStateAsync(id: string): Promise<void> {
      db.states.delete(full(id));
      return Promise.resolve();
    }
    getStateAsync(id: string): Promise<ioBroker.State | null> {
      return Promise.resolve(structuredClone(db.states.get(full(id)) ?? null));
    }
    getStatesAsync(pattern: string): Promise<Record<string, ioBroker.State | null>> {
      // js-controller 7.2.5 getStates: every state object below the pattern, with its value or null.
      const prefix = full(pattern.replace(/\*/g, ""));
      const found: Record<string, ioBroker.State | null> = {};
      for (const [id, obj] of db.objects) {
        if (obj.type === "state" && id.startsWith(prefix)) {
          found[id] = structuredClone(db.states.get(id) ?? null);
        }
      }
      return Promise.resolve(found);
    }
    setState(id: string, state: ioBroker.SettableState): Promise<string> {
      db.states.set(full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve(full(id));
    }
    setStateChangedAsync(id: string, state: ioBroker.SettableState): Promise<{ id: string; notChanged: boolean }> {
      const before = db.states.get(full(id));
      const next = state as ioBroker.State;
      if (before && before.val === next.val && before.ack === (next.ack ?? false)) {
        return Promise.resolve({ id: full(id), notChanged: true });
      }
      db.states.set(full(id), { ...next, ts: Date.now(), lc: Date.now() });
      return Promise.resolve({ id: full(id), notChanged: false });
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
    readDirAsync(): Promise<unknown[]> {
      return Promise.resolve([]);
    }
    readFileAsync(): Promise<never> {
      return Promise.reject(new Error("no such file"));
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
vi.mock("node:dns/promises", () => {
  const reverse = (ip: string): Promise<string[]> => {
    dns.asked.push(ip);
    const name = dns.names.get(ip);
    return name
      ? Promise.resolve([name])
      : Promise.reject(Object.assign(new Error(`getHostByAddr ENOTFOUND ${ip}`), { code: "ENOTFOUND" }));
  };
  return {
    default: {
      reverse,
      Resolver: class {
        setLocalAddress(): void {}
        reverse(ip: string): Promise<string[]> {
          return reverse(ip);
        }
      },
    },
  };
});
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

vi.mock("../lib/display-id", async importOriginal => {
  const real = await importOriginal<typeof DisplayId>();
  return { ...real, randomIdTail: (): string => tail.fixed || real.randomIdTail() };
});

import * as mainModule from "../main";
import type { ClientRegistry } from "../lib/client-registry";

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): unknown;
}

/** One request as the web server's inject takes it. */
interface Request {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  payload?: string;
  remoteAddress: string;
}

/** The adapter instance with what the guard reads from its stub base and its own fields. */
interface Emu {
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  registry: ClientRegistry | null;
  webServer: { inject(request: Request): Promise<Answer> } | null;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const CONFIG = {
  port: 0,
  bind: "0.0.0.0",
  authRequired: false,
  username: "admin",
  password: "",
  mdnsEnabled: false,
  serviceName: "ioBroker",
};
/** The Android app: its own part of the agent names the model (`Home Assistant/<version> (Android <n>; <model>)`). */
const UA_ANDROID_APP =
  "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.102 Safari/537.36 Home Assistant/2026.11.1-17389 (Android 14; Pixel Tablet)";
/** The iOS app: no model in its agent. */
const UA_IOS_APP =
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Home Assistant/2026.10.3 (io.robbie.HomeAssistant; build:2026.1032; iPadOS 18.1.0)";
/** The built-in page of a wall display: a plain WebView agent. */
const UA_WALL_PAGE =
  "Mozilla/5.0 (Linux; Android 11; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36";

const running: Emu[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-k07-"));
});

afterEach(async () => {
  for (const emu of [...running]) {
    await stopped(emu);
  }
  rmSync(data.dir, { recursive: true, force: true });
  data.dir = "";
  db.objects.clear();
  db.states.clear();
  db.problems.length = 0;
  dns.names.clear();
  dns.asked.length = 0;
  tail.fixed = "";
});

/** The installation js-controller sets up: the instance object and the manifest's instance objects. */
function seedInstall(): void {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
    instanceObjects: { _id: string }[];
  };
  for (const obj of manifest.instanceObjects) {
    db.objects.set(`${NS}.${obj._id}`, { ...obj, _id: `${NS}.${obj._id}` } as unknown as ioBroker.Object);
  }
  db.objects.set(`system.adapter.${NS}`, {
    _id: `system.adapter.${NS}`,
    type: "instance",
    common: { name: "hassemu", enabled: true, host: "guard" },
    native: { ...CONFIG },
  } as unknown as ioBroker.Object);
}

/**
 * A display as an installation up to 1.46.1 holds it: `clients.<six hex characters>`, its cookie in the device's
 * `native`, its datapoints with their values.
 *
 * @param oldId the six hex characters
 * @param cookie the display's cookie
 * @param ip its address
 * @param mode its mode
 * @param manualUrl its manual URL
 */
function seedOldDisplay(oldId: string, cookie: string, ip: string, mode = "0", manualUrl = ""): void {
  const device = `${NS}.clients.${oldId}`;
  db.objects.set(device, {
    _id: device,
    type: "device",
    common: { name: { en: ip } },
    native: { cookie, token: null, tokenExpiresAt: null, refreshToken: null, lastSeen: Date.now() - 3_600_000 },
  } as unknown as ioBroker.Object);
  const datapoints: [string, Record<string, unknown>, ioBroker.StateValue][] = [
    ["mode", { type: "string", role: "text", read: true, write: true, def: "0", states: { 0: "---" } }, mode],
    ["manualUrl", { type: "string", role: "url", read: true, write: true, def: "" }, manualUrl],
    ["ip", { type: "string", role: "info.ip", read: true, write: false, def: "" }, ip],
    ["resolvedUrl", { type: "string", role: "url", read: true, write: false, def: "" }, ""],
    ["remove", { type: "boolean", role: "button", read: false, write: true, def: false }, false],
  ];
  for (const [key, common, val] of datapoints) {
    const id = `${device}.${key}`;
    db.objects.set(id, { _id: id, type: "state", common: { name: key, ...common }, native: {} } as ioBroker.Object);
    db.states.set(id, { val, ack: true, ts: 1, lc: 1, from: `system.adapter.${NS}` });
  }
}

/** The adapter, started through the ready handler its constructor registered; a start that ended throws. */
async function started(): Promise<Emu> {
  const emu = new HassEmu() as unknown as Emu;
  emu.config = { ...CONFIG };
  running.push(emu);
  await emu.handlers.get("ready")?.();
  const ended = db.problems.filter(line => line.startsWith("terminate:"));
  if (ended.length > 0 || emu.webServer === null) {
    throw new Error(`the adapter did not start: ${ended.join(", ")}`);
  }
  return emu;
}

/**
 * Stop the adapter through the unload handler its constructor registered.
 *
 * @param emu the adapter
 */
async function stopped(emu: Emu): Promise<void> {
  running.splice(running.indexOf(emu), 1);
  await new Promise<void>(resolve => {
    emu.handlers.get("unload")?.(resolve);
  });
}

/** Let fire-and-forget work (reverse lookup, the app's name) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * One request to the running web server from a peer address.
 *
 * @param emu the adapter
 * @param peer the peer address on the socket
 * @param method the method
 * @param url the path
 * @param extra cookie, agent, form or JSON body, Bearer token
 * @param extra.cookie the display's cookie value
 * @param extra.userAgent the User-Agent header
 * @param extra.form a form body
 * @param extra.json a JSON body
 * @param extra.bearer an access token
 */
function ask(
  emu: Emu,
  peer: string,
  method: "GET" | "POST",
  url: string,
  extra: {
    cookie?: string;
    userAgent?: string;
    form?: Record<string, string>;
    json?: Record<string, unknown>;
    bearer?: string;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": extra.userAgent ?? UA_WALL_PAGE };
  if (extra.cookie) {
    headers.cookie = `hassemu_client=${extra.cookie}`;
  }
  if (extra.bearer) {
    headers.authorization = `Bearer ${extra.bearer}`;
  }
  let payload: string | undefined;
  if (extra.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(extra.form).toString();
  } else if (extra.json) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(extra.json);
  }
  const server = emu.webServer;
  if (!server) {
    throw new Error("the case needs the adapter's web server");
  }
  return server.inject({ method, url, headers, payload, remoteAddress: peer });
}

/**
 * The cookie value a first visit set.
 *
 * @param answer the answer
 */
function cookieOf(answer: Answer): string {
  const raw = answer.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "";
  return /hassemu_client=([^;]+)/.exec(header)?.[1] ?? "";
}

/**
 * A display's first visit; returns its cookie and the id the adapter gave it.
 *
 * @param emu the adapter
 * @param peer its address
 * @param userAgent its agent
 */
async function firstVisit(emu: Emu, peer: string, userAgent: string): Promise<{ cookie: string; id: string }> {
  const cookie = cookieOf(await ask(emu, peer, "GET", "/", { userAgent }));
  const id = emu.registry?.getByCookie(cookie)?.id;
  if (id === undefined) {
    throw new Error("the case needs the display its first visit creates");
  }
  return { cookie, id };
}

/**
 * Sign the display in (login flow, code, token) and return its access token.
 *
 * @param emu the adapter
 * @param peer its address
 * @param cookie its cookie
 * @param userAgent its agent
 */
async function signedIn(emu: Emu, peer: string, cookie: string, userAgent: string): Promise<string> {
  const flow = (await ask(emu, peer, "POST", "/auth/login_flow", { cookie, userAgent, form: {} })).json() as {
    flow_id?: string;
  };
  const done = (
    await ask(emu, peer, "POST", `/auth/login_flow/${flow.flow_id ?? ""}`, { cookie, userAgent, form: {} })
  ).json() as { result?: string };
  const token = (
    await ask(emu, peer, "POST", "/auth/token", {
      cookie,
      userAgent,
      form: { grant_type: "authorization_code", code: done.result ?? "" },
    })
  ).json() as { access_token?: string };
  return token.access_token ?? "";
}

/**
 * Register the app the way the Android app does after its sign-in; returns the webhook id.
 *
 * @param emu the adapter
 * @param peer its address
 * @param token its access token
 * @param deviceName the device name the user gave in the app
 */
async function registered(emu: Emu, peer: string, token: string, deviceName: string): Promise<string> {
  const answer = await ask(emu, peer, "POST", "/api/mobile_app/registrations", {
    userAgent: UA_ANDROID_APP,
    bearer: token,
    json: {
      app_id: "io.homeassistant.companion.android",
      app_name: "Home Assistant",
      device_name: deviceName,
      manufacturer: "Google",
      model: "Pixel Tablet",
      os_name: "Android",
      os_version: "14",
    },
  });
  return (answer.json() as { webhook_id?: string }).webhook_id ?? "";
}

/**
 * The app reports a changed device name through its webhook.
 *
 * @param emu the adapter
 * @param peer its address
 * @param webhookId the webhook id of its registration
 * @param deviceName the new device name
 */
async function renamedInApp(emu: Emu, peer: string, webhookId: string, deviceName: string): Promise<void> {
  await ask(emu, peer, "POST", `/api/webhook/${webhookId}`, {
    userAgent: UA_ANDROID_APP,
    json: { type: "update_registration", data: { device_name: deviceName, app_version: "2026.11.1" } },
  });
}

/** The ids of the display devices under clients. */
function devices(): string[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device")
    .map(([id]) => id.slice(`${NS}.clients.`.length))
    .sort();
}

/**
 * The text of a display device's name.
 *
 * @param id the display id
 */
function nameOf(id: string): string | undefined {
  const name = db.objects.get(`${NS}.clients.${id}`)?.common?.name;
  return typeof name === "string" ? name : name?.en;
}

/**
 * A user's rename in the object tree (the admin writes the object).
 *
 * @param id the display id
 * @param text the name the user types
 */
function userRenames(id: string, text: string): void {
  const device = db.objects.get(`${NS}.clients.${id}`);
  if (device) {
    db.objects.set(`${NS}.clients.${id}`, {
      ...device,
      common: { ...device.common, name: { en: text, de: text } },
    } as ioBroker.Object);
  }
}

/** The old display's cookie and the target of its manual URL. */
const OLD_COOKIE = "6f9c2d1e-0b7a-4c3e-9a51-2d8e4f7a1c01";
const OLD_DEVICE = `${NS}.clients.61c3a1`;
const NEW_DEVICE = `${NS}.clients.display-c3a1`;

/**
 * An installation of 1.46.1 with the display clients.61c3a1, in a room and a function and behind aliases. Its mode is
 * "global" while the global target is empty: a visit gets the start page — a redirect target would make the server
 * probe an address outside the guard.
 */
function seedOldInstallation(): void {
  seedInstall();
  seedOldDisplay("61c3a1", OLD_COOKIE, "192.168.77.71", "global", "http://192.168.77.20:8082/vis-2/index.html?kitchen");
  db.objects.set("enum.rooms.kitchen", {
    _id: "enum.rooms.kitchen",
    type: "enum",
    common: { name: "Kitchen", members: [OLD_DEVICE, "zigbee.0.lamp"] },
    native: {},
  } as unknown as ioBroker.Object);
  db.objects.set("enum.functions.screen", {
    _id: "enum.functions.screen",
    type: "enum",
    common: { name: "Screen", members: [`${OLD_DEVICE}.mode`] },
    native: {},
  } as unknown as ioBroker.Object);
  // Aliases in both forms of common.alias.id — one target, or a read and a write target.
  const aliases: [string, unknown][] = [
    ["alias.0.kitchen.screen", `${OLD_DEVICE}.mode`],
    ["alias.0.kitchen.url", { read: `${OLD_DEVICE}.resolvedUrl`, write: `${OLD_DEVICE}.manualUrl` }],
  ];
  for (const [id, target] of aliases) {
    db.objects.set(id, {
      _id: id,
      type: "state",
      common: { name: id, type: "string", role: "text", read: true, write: true, alias: { id: target } },
      native: {},
    } as unknown as ioBroker.Object);
  }
}

/**
 * The members of an enum.
 *
 * @param id the enum id
 */
function members(id: string): string[] {
  return (db.objects.get(id)?.common as { members?: string[] } | undefined)?.members ?? [];
}

/**
 * The target of an alias.
 *
 * @param id the alias id
 */
function aliasTarget(id: string): unknown {
  return (db.objects.get(id)?.common as { alias?: { id?: unknown } } | undefined)?.alias?.id;
}

/**
 * Whether a version rule of an update notice (`oldVersion<2.0.0`, `newVersion>=2.0.0`) holds for these versions.
 *
 * @param rule the rule
 * @param versions the versions of the update
 * @param versions.oldVersion the installed version
 * @param versions.newVersion the version updated to
 */
function holds(rule: string, versions: { oldVersion: string; newVersion: string }): boolean {
  const m = /^(oldVersion|newVersion)(<=|>=|<|>|==|=)(.+)$/.exec(rule);
  if (!m) {
    return false;
  }
  const parts = (v: string): number[] => v.split(".").map(Number);
  const [a, b] = [parts(versions[m[1] as "oldVersion" | "newVersion"]), parts(m[3])];
  const cmp = a.map((n, i) => n - (b[i] ?? 0)).find(d => d !== 0) ?? 0;
  return { "<": cmp < 0, "<=": cmp <= 0, ">": cmp > 0, ">=": cmp >= 0, "==": cmp === 0, "=": cmp === 0 }[m[2]] === true;
}

/**
 * The model part of an id, letters and digits only, in lower case — to compare it with the model the display named.
 *
 * @param text the text
 */
function letters(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

describe("K7: display ids and names", () => {
  it("id: model, hyphen, four characters that hassemu assigns itself", async () => {
    seedInstall();
    const emu = await started();

    const { id } = await firstVisit(emu, "192.168.77.51", UA_ANDROID_APP);
    const hyphen = id.lastIndexOf("-");

    expect({ model: letters(id.slice(0, hyphen)), fourCharacters: id.slice(hyphen + 1).length }).toEqual({
      model: letters("Pixel Tablet"),
      fourCharacters: 4,
    });
  });

  it("if the display names no model on its first visit, 'display' stands in front", async () => {
    seedInstall();
    const emu = await started();

    const ios = await firstVisit(emu, "192.168.77.52", UA_IOS_APP);
    const wall = await firstVisit(emu, "192.168.77.53", UA_WALL_PAGE);

    expect({ ios: ios.id.startsWith("display-"), wall: wall.id.startsWith("display-") }).toEqual({
      ios: true,
      wall: true,
    });
  });

  it("if the id is taken already, a counter comes after it", async () => {
    seedInstall();
    const emu = await started();
    tail.fixed = "0a1b";

    const first = await firstVisit(emu, "192.168.77.54", UA_WALL_PAGE);
    const second = await firstVisit(emu, "192.168.77.55", UA_WALL_PAGE);
    const after = second.id.slice(first.id.length);

    expect({ sameIdAfterIt: second.id.startsWith(first.id), counter: /\d/.test(after) }).toEqual({
      sameIdAfterIt: true,
      counter: true,
    });
  });

  it("once assigned, it never changes: not on a new address, another agent, a host name or a restart", async () => {
    seedInstall();
    dns.names.set("192.168.77.65", "hall-panel.lan");
    const first = await started();

    const { cookie, id } = await firstVisit(first, "192.168.77.64", UA_ANDROID_APP);
    await ask(first, "192.168.77.65", "GET", "/", { cookie, userAgent: UA_WALL_PAGE });
    await settle();
    const afterVisit = first.registry?.getByCookie(cookie)?.id;
    await stopped(first);
    const second = await started();

    expect({ afterVisit, afterRestart: second.registry?.getByCookie(cookie)?.id }).toEqual({
      afterVisit: id,
      afterRestart: id,
    });
  });

  it("name: the device name from the app as soon as the app reports it; it follows every change there", async () => {
    seedInstall();
    const emu = await started();
    const app = await firstVisit(emu, "192.168.77.63", UA_ANDROID_APP);
    const token = await signedIn(emu, "192.168.77.63", app.cookie, UA_ANDROID_APP);

    const webhookId = await registered(emu, "192.168.77.63", token, "Kitchen Tablet");
    await settle();
    const reported = nameOf(app.id);
    await renamedInApp(emu, "192.168.77.63", webhookId, "Hall Tablet");
    await settle();

    expect({ reported, followed: nameOf(app.id) }).toEqual({ reported: "Kitchen Tablet", followed: "Hall Tablet" });
  });

  it("without the app the host name, without a host name the IP", async () => {
    seedInstall();
    dns.names.set("192.168.77.62", "kitchen-panel.lan");
    const emu = await started();

    const named = await firstVisit(emu, "192.168.77.62", UA_WALL_PAGE);
    const bare = await firstVisit(emu, "192.168.77.61", UA_WALL_PAGE);
    await settle();

    expect({ hostName: nameOf(named.id), ip: nameOf(bare.id) }).toEqual({
      hostName: "kitchen-panel.lan",
      ip: "192.168.77.61",
    });
  });

  it("a rename in the object tree does not hold: hassemu writes its name back", async () => {
    seedInstall();
    const first = await started();
    const app = await firstVisit(first, "192.168.77.66", UA_ANDROID_APP);
    const token = await signedIn(first, "192.168.77.66", app.cookie, UA_ANDROID_APP);
    await registered(first, "192.168.77.66", token, "Kitchen Tablet");
    await settle();

    userRenames(app.id, "My kitchen");
    await stopped(first);
    await started();

    expect(nameOf(app.id)).toBe("Kitchen Tablet");
  });

  it("existing installations: every existing display moves once — clients.61c3a1 becomes clients.display-c3a1", async () => {
    seedOldInstallation();
    const first = await started();
    const afterTheUpdate = devices();
    const oldLeft = [...db.objects.keys()].filter(id => id === OLD_DEVICE || id.startsWith(`${OLD_DEVICE}.`));
    await stopped(first);
    await started();

    expect({ afterTheUpdate, oldLeft, afterTheNextStart: devices() }).toEqual({
      afterTheUpdate: ["display-c3a1"],
      oldLeft: [],
      afterTheNextStart: ["display-c3a1"],
    });
  });

  it("rooms, functions and aliases move along", async () => {
    seedOldInstallation();
    await started();

    expect({
      room: {
        new: members("enum.rooms.kitchen").includes(NEW_DEVICE),
        old: members("enum.rooms.kitchen").includes(OLD_DEVICE),
      },
      function: {
        new: members("enum.functions.screen").includes(`${NEW_DEVICE}.mode`),
        old: members("enum.functions.screen").includes(`${OLD_DEVICE}.mode`),
      },
      aliases: [aliasTarget("alias.0.kitchen.screen"), aliasTarget("alias.0.kitchen.url")],
    }).toEqual({
      room: { new: true, old: false },
      function: { new: true, old: false },
      aliases: [`${NEW_DEVICE}.mode`, { read: `${NEW_DEVICE}.resolvedUrl`, write: `${NEW_DEVICE}.manualUrl` }],
    });
  });

  it("and the display is still recognised", async () => {
    seedOldInstallation();
    const emu = await started();

    await ask(emu, "192.168.77.71", "GET", "/", { cookie: OLD_COOKIE });

    expect({ recognisedAs: emu.registry?.getByCookie(OLD_COOKIE)?.id, displays: devices() }).toEqual({
      recognisedAs: "display-c3a1",
      displays: ["display-c3a1"],
    });
  });

  it("the update points out in the admin that scripts and visualisations on the old id are the user's to adapt", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
      common: { messages?: { condition?: { operand?: string; rules?: string[] }; text?: Record<string, string> }[] };
    };
    const update = { oldVersion: "1.46.1", newVersion: "2.0.0" };

    const shown = (manifest.common.messages ?? []).filter(m => {
      const rules = m.condition?.rules ?? [];
      return m.condition?.operand === "or" ? rules.some(r => holds(r, update)) : rules.every(r => holds(r, update));
    });

    expect(
      shown.some(
        m => (m.text?.en ?? "").includes("clients.61c3a1") && (m.text?.en ?? "").includes("clients.display-c3a1"),
      ),
    ).toBe(true);
  });
});
