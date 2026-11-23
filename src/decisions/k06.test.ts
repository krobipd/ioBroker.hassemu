/**
 * Guard K6 — on its first visit the display gets a cookie, valid for ten years; hassemu recognises it by that, also
 * after a restart, with a new IP or a new name; if the display deletes its data, it appears as a new display; the old
 * device of a display that deleted its data stays in the object tree until it has not been there for 30 days or the
 * user removes it; for the apps their sign-in counts in addition: if an app deletes only the storage of its page, the
 * page appears as a new display, the app itself keeps running under the old one.
 *
 * The page, K6: "On its first visit the display gets a cookie, valid for ten years. By it hassemu recognises it again,
 * also after a restart, with a new IP or a new name. If the display deletes its data, it shows up as a new display."
 * Measured: "All four sentences hold. The old device of a display that deleted its data stays in the object tree
 * until it was not there for 30 days or you remove it. For the apps their sign-in counts as well: if an app deletes
 * only the storage of its page, the page shows up as a new display, the app itself carries on under the old one."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:35 ("k6 yes, if that is
 * so, then it is so").
 *
 * Path: the adapter class from main.ts, started through the ready handler its constructor registers, over the fleet's
 * fake adapter with its object and state database in memory (the manifest's instance objects and the instance object
 * as js-controller creates them); displays are asked by inject from peer addresses of its own network on the web server
 * that start opened; a restart is the unload handler and a new start over the same database and data folder; the
 * user's "Remove this display" is a write handed to the stateChange handler; the app's device name arrives through the
 * Companion registration route after its sign-in. The host carries one network (192.168.77.0/24); the data folder is a
 * fresh folder in the temporary directory, written through the data-folder master as on a host.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeState } from "../lib/adapter-fake";

const { data, db } = vi.hoisted(() => ({
  /** The instance data folder of the running test. */
  data: { dir: "" },
  db: {
    objects: new Map<string, ioBroker.Object>(),
    states: new Map<string, ioBroker.State>(),
    /** Every warning, error and termination of the adapter — a start that failed shows here. */
    problems: [] as string[],
  },
}));

vi.mock("@iobroker/adapter-core", async () => {
  const { FakeAdapter } = await import("../lib/adapter-fake.js");
  const noop = (): void => undefined;
  const ns = "hassemu.0";
  const full = (id: string): string => (id.startsWith(`${ns}.`) ? id : `${ns}.${id}`);
  /** The adapter base class: the fleet's fake adapter over the database in memory, plus what hassemu itself calls. */
  class Adapter extends FakeAdapter {
    override readonly objects = db.objects as unknown as Map<string, Record<string, unknown>>;
    override readonly states = db.states as unknown as Map<string, FakeState>;
    adapterDir = "/guard/adapter";
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    log = {
      silly: noop,
      debug: noop,
      info: noop,
      warn: (msg: string): void => void db.problems.push(`warn: ${msg}`),
      error: (msg: string): void => void db.problems.push(`error: ${msg}`),
      level: "info",
    };
    on(event: string, handler: (...args: never[]) => unknown): this {
      this.handlers.set(event, handler as (...args: unknown[]) => unknown);
      return this;
    }
    setInterval(): object {
      return {};
    }
    clearInterval(): void {}
    override terminate(reason: string, exitCode: number): never {
      db.problems.push(`terminate: ${String(reason)}`);
      return super.terminate(reason, exitCode);
    }
    getObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(db.objects.get(full(id)) ?? null));
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

/** The adapter instance with what the guard reads from its stub base and its own fields. */
interface Emu {
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  webServer: { inject(request: Record<string, unknown>): Promise<Answer> } | null;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const DAY = 24 * 60 * 60 * 1000;
const CONFIG = {
  port: 0,
  bind: "0.0.0.0",
  authRequired: false,
  username: "admin",
  password: "",
  mdnsEnabled: false,
  serviceName: "ioBroker",
};
const PEER = "192.168.77.50";

const running: Emu[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-k06-"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const emu of [...running]) {
    await stopped(emu);
  }
  rmSync(data.dir, { recursive: true, force: true });
  data.dir = "";
  db.objects.clear();
  db.states.clear();
  db.problems.length = 0;
});

/** The installation as js-controller creates it: the manifest's instance objects and the instance object. */
function install(): void {
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
 * The adapter stopped through its unload handler.
 *
 * @param emu the adapter
 */
async function stopped(emu: Emu): Promise<void> {
  running.splice(running.indexOf(emu), 1);
  await new Promise<void>(resolve => {
    emu.handlers.get("unload")?.(resolve);
  });
}

/**
 * A restart: the adapter stops, and starts again over the same database and data folder.
 *
 * @param emu the running adapter
 */
async function restarted(emu: Emu): Promise<Emu> {
  await stopped(emu);
  return started();
}

/**
 * One request to the adapter's web server from a peer address.
 *
 * @param emu the adapter
 * @param peer the peer address on the socket
 * @param method the method
 * @param url the path
 * @param extra cookie, bearer token, form or JSON body
 * @param extra.cookie the display's cookie header
 * @param extra.bearer the app's access token
 * @param extra.form a form body
 * @param extra.json a JSON body
 */
async function ask(
  emu: Emu,
  peer: string,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; bearer?: string; form?: Record<string, string>; json?: Record<string, string> } = {},
): Promise<Answer> {
  if (emu.webServer === null) {
    throw new Error("the case needs the adapter's web server");
  }
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (extra.cookie) {
    headers.cookie = extra.cookie;
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
  const answer = await emu.webServer.inject({ method, url, headers, payload, remoteAddress: peer });
  await new Promise(resolve => setTimeout(resolve, 0));
  return answer;
}

/**
 * The Set-Cookie header of an answer.
 *
 * @param answer the answer
 */
function setCookieOf(answer: Answer): string {
  const raw = answer.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
}

/**
 * The cookie an answer set, as the display sends it back.
 *
 * @param answer the answer
 */
function cookieOf(answer: Answer): string {
  return /^\s*([^=;\s]+=[^;]*)/.exec(setCookieOf(answer))?.[1] ?? "";
}

/** The displays: the devices below clients. */
function displays(): string[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device")
    .map(([id]) => id.slice(`${NS}.clients.`.length));
}

/**
 * The display a visit created: the one display that was not there before it.
 *
 * @param before the displays before the visit
 */
function createdSince(before: string[]): string {
  const created = displays().filter(id => !before.includes(id));
  if (created.length !== 1) {
    throw new Error(`the case needs one display created by the visit, found ${created.length}`);
  }
  return created[0];
}

/**
 * The name of a display's device, as text.
 *
 * @param id the display id
 */
function nameOf(id: string): string {
  return JSON.stringify(db.objects.get(`${NS}.clients.${id}`)?.common.name ?? null);
}

/**
 * Whether an answer is the page for this display — the start page names the display's own path.
 *
 * @param answer the answer
 * @param id the display id
 */
function pageOf(answer: Answer, id: string): boolean {
  return answer.body.includes(`${NS}.clients.${id}`);
}

/**
 * The app's sign-in with the display's cookie: login flow, code, token.
 *
 * @param emu the adapter
 * @param cookie the display's cookie header
 */
async function signIn(emu: Emu, cookie: string): Promise<string> {
  const flow = (await ask(emu, PEER, "POST", "/auth/login_flow", { cookie, form: {} })).json() as { flow_id?: string };
  const done = (
    await ask(emu, PEER, "POST", `/auth/login_flow/${flow.flow_id ?? ""}`, { cookie, form: {} })
  ).json() as { result?: string };
  const token = (
    await ask(emu, PEER, "POST", "/auth/token", {
      cookie,
      form: { grant_type: "authorization_code", code: done.result ?? "" },
    })
  ).json() as { access_token?: string };
  if (!token.access_token) {
    throw new Error("the case needs the app signed in");
  }
  return token.access_token;
}

/**
 * The app reports its device name, with its access token.
 *
 * @param emu the adapter
 * @param token the app's access token
 * @param name the device name
 */
async function appReports(emu: Emu, token: string, name: string): Promise<void> {
  await ask(emu, PEER, "POST", "/api/mobile_app/registrations", {
    bearer: token,
    json: { app_id: "io.homeassistant.companion.android", device_name: name },
  });
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
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * A display on its first visit and the same display after it deleted its data: the old and the new id, the new page.
 *
 * @param emu the adapter
 */
async function deletedItsData(emu: Emu): Promise<{ oldId: string; newId: string; newCookie: string; page: Answer }> {
  const first = await ask(emu, PEER, "GET", "/");
  const oldId = createdSince([]);
  if (cookieOf(first) === "") {
    throw new Error("the case needs the cookie of the first visit");
  }
  const page = await ask(emu, PEER, "GET", "/");
  return { oldId, newId: createdSince([oldId]), newCookie: cookieOf(page), page };
}

describe("K6: a display is recognised by its cookie", () => {
  it("on its first visit the display gets a cookie, valid for ten years", async () => {
    install();
    const emu = await started();

    const first = await ask(emu, PEER, "GET", "/");
    const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(setCookieOf(first))?.[1] ?? Number.NaN);
    const days = maxAge / (DAY / 1000);

    expect({ getsACookie: cookieOf(first) !== "", tenYears: days >= 3650 && days <= 3653 }).toEqual({
      getsACookie: true,
      tenYears: true,
    });
  });

  it("hassemu recognises it by that, also after a restart, with a new IP and a new name", async () => {
    install();
    const before = await started();
    const cookie = cookieOf(await ask(before, PEER, "GET", "/"));
    const id = createdSince([]);
    await appReports(before, await signIn(before, cookie), "Kitchen panel");
    if (!nameOf(id).includes("Kitchen panel")) {
      throw new Error("the case needs the display under a new name");
    }

    const after = await restarted(before);
    const back = await ask(after, "192.168.77.60", "GET", "/", { cookie });

    expect({ displays: displays(), recognised: pageOf(back, id) }).toEqual({ displays: [id], recognised: true });
  });

  it("if the display deletes its data, it appears as a new display", async () => {
    install();
    const emu = await started();

    const { oldId, newId, page } = await deletedItsData(emu);

    expect({ newDisplay: newId !== oldId, itsPage: pageOf(page, newId) }).toEqual({ newDisplay: true, itsPage: true });
  });

  it("the old device of a display that deleted its data stays in the object tree until it has not been there for 30 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    install();
    let emu = await started();
    const start = Date.now();
    const { oldId, newCookie } = await deletedItsData(emu);

    vi.setSystemTime(start + 29 * DAY);
    await ask(emu, PEER, "GET", "/", { cookie: newCookie });
    emu = await restarted(emu);
    const after29Days = displays().includes(oldId);

    vi.setSystemTime(start + 31 * DAY);
    await ask(emu, PEER, "GET", "/", { cookie: newCookie });
    emu = await restarted(emu);

    expect({ after29Days, after31Days: displays().includes(oldId) }).toEqual({ after29Days: true, after31Days: false });
  });

  it("… or the user removes it", async () => {
    install();
    const emu = await started();
    const { oldId } = await deletedItsData(emu);

    await userWrites(emu, `clients.${oldId}.remove`, true);

    expect(displays().includes(oldId)).toBe(false);
  });

  it("for the apps their sign-in counts in addition: the app deletes only the storage of its page — the page appears as a new display, the app keeps running under the old one", async () => {
    install();
    const emu = await started();
    const first = await ask(emu, PEER, "GET", "/");
    const oldId = createdSince([]);
    const token = await signIn(emu, cookieOf(first));

    const page = await ask(emu, PEER, "GET", "/");
    const newId = createdSince([oldId]);
    await appReports(emu, token, "Hall app");

    expect({
      pageIsNew: pageOf(page, newId),
      appUnderTheOld: nameOf(oldId).includes("Hall app"),
      appUnderTheNew: nameOf(newId).includes("Hall app"),
    }).toEqual({ pageIsNew: true, appUnderTheOld: true, appUnderTheNew: false });
  });
});
