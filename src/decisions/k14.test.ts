/**
 * Guard K14 — at start, a display seen 30 days less recently than the most recently seen display is removed with its
 * settings; measured at that display, never at the clock (capped at now), tokens or not; the most recently seen
 * display never falls by itself.
 *
 * The page, K14: "At start, hassemu removes every display that was not seen for 30 days longer than the one seen last,
 * with its settings and its assignment to room and function. It is measured at the display seen last, not at the
 * clock: if the whole installation stood still for long, none falls. The display seen last never falls by itself."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:55 ("k14, k15 are ok").
 *
 * Path: the adapter class from main.ts, started through the ready handler its constructor registers — the registry
 * restores the displays and their last-seen stamps from the data file, then the start's clean-up runs, then the web
 * server opens on a free port — over an adapter whose object and state database lives in memory. A removal is the
 * recursive delete of the display's device; its room and function assignments leave with that delete in js-controller.
 * The data folder is a fresh folder in the temporary directory, written through the data-folder master as on a host.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { writeDataFile } from "../lib/data-file";
import * as mainModule from "../main";

/** The adapter instance with what the guard reads from its stub base. */
interface Emu {
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

/** A display as the data file and the object tree hold it. */
interface Seed {
  /** The display id. */
  id: string;
  /** Its last-seen stamp. */
  lastSeen: number;
  /** An access token and a refresh token, as a signed-in display holds them. */
  signedIn?: boolean;
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

const running: Emu[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-k14-"));
});

afterEach(async () => {
  for (const emu of [...running]) {
    running.splice(running.indexOf(emu), 1);
    await new Promise<void>(resolve => {
      emu.handlers.get("unload")?.(resolve);
    });
  }
  rmSync(data.dir, { recursive: true, force: true });
  data.dir = "";
  db.objects.clear();
  db.states.clear();
  db.problems.length = 0;
});

/**
 * A UUID made from a number, for cookies and tokens.
 *
 * @param n the number
 */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * The installation: the manifest's instance objects as js-controller creates them, and the displays — each with its
 * device, its settings (mode on a manual URL) and its entry in the data file.
 *
 * @param displays the displays
 */
function seedInstall(displays: Seed[]): void {
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
  const entries: Record<string, unknown> = {};
  displays.forEach((display, n) => {
    const device = `${NS}.clients.${display.id}`;
    db.objects.set(device, {
      _id: device,
      type: "device",
      common: { name: { en: display.id } },
      native: {},
    } as unknown as ioBroker.Object);
    const settings: [string, ioBroker.StateValue][] = [
      ["mode", "manual"],
      ["manualUrl", `http://192.168.77.20:8082/vis-2/index.html?${display.id}`],
    ];
    for (const [key, val] of settings) {
      db.objects.set(`${device}.${key}`, {
        _id: `${device}.${key}`,
        type: "state",
        common: { name: key, type: "string", role: key === "mode" ? "text" : "url", read: true, write: true },
        native: {},
      });
      db.states.set(`${device}.${key}`, { val, ack: true, ts: 1, lc: 1, from: `system.adapter.${NS}` });
    }
    entries[display.id] = {
      cookie: uuid(100 + n),
      token: display.signedIn ? uuid(200 + n) : null,
      tokenExpiresAt: display.signedIn ? Date.now() + 1_800_000 : null,
      refreshToken: display.signedIn ? uuid(300 + n) : null,
      lastSeen: display.lastSeen,
    };
  });
  writeDataFile(data.dir, "identities.json", { server: "0d5b8e2a-7c41-4f3e-9a26-5b8c1d7e3f90", displays: entries });
}

/** The adapter, started through the ready handler its constructor registered. */
async function started(): Promise<Emu> {
  const emu = new HassEmu() as unknown as Emu;
  emu.config = { ...CONFIG };
  running.push(emu);
  await emu.handlers.get("ready")?.();
  return emu;
}

/** The ids of the display devices under clients. */
function devices(): string[] {
  return [...db.objects]
    .filter(([id, obj]) => id.startsWith(`${NS}.clients.`) && obj.type === "device")
    .map(([id]) => id.slice(`${NS}.clients.`.length))
    .sort();
}

/**
 * What is left of a display: its objects, its values and its entry in the data file.
 *
 * @param id the display id
 */
function leftOf(id: string): { objects: string[]; values: string[]; fileEntry: boolean } {
  const prefix = `${NS}.clients.${id}`;
  const file = join(data.dir, "identities.json");
  const stored = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as {
    displays?: Record<string, unknown>;
  };
  return {
    objects: [...db.objects.keys()].filter(key => key === prefix || key.startsWith(`${prefix}.`)),
    values: [...db.states.keys()].filter(key => key.startsWith(`${prefix}.`)),
    fileEntry: stored.displays?.[id] !== undefined,
  };
}

describe("K14: the start removes displays long unseen, measured at the display seen last", () => {
  it("removes a display 31 days behind the one seen last with its settings, signed in or not; keeps one 29 days behind and the one seen last, though everything stood still for 60 days", async () => {
    const newest = Date.now() - 60 * DAY;
    seedInstall([
      { id: "display-a001", lastSeen: newest },
      { id: "display-b002", lastSeen: newest - 29 * DAY },
      { id: "display-c003", lastSeen: newest - 31 * DAY, signedIn: true },
    ]);

    await started();

    expect({ problems: db.problems, devices: devices() }).toEqual({
      problems: [],
      devices: ["display-a001", "display-b002"],
    });
    expect(leftOf("display-c003")).toEqual({ objects: [], values: [], fileEntry: false });
    expect({ seenLast: leftOf("display-a001").fileEntry, behind29: leftOf("display-b002").fileEntry }).toEqual({
      seenLast: true,
      behind29: true,
    });
  });

  it("measures against now at the latest: a stamp from a clock that ran ahead ages no other display", async () => {
    seedInstall([
      { id: "display-d004", lastSeen: Date.now() + 40 * DAY },
      { id: "display-e005", lastSeen: Date.now() - 10 * DAY },
      { id: "display-f006", lastSeen: Date.now() - 45 * DAY },
    ]);

    await started();

    expect({ problems: db.problems, devices: devices(), behind45: leftOf("display-f006").fileEntry }).toEqual({
      problems: [],
      devices: ["display-d004", "display-e005"],
      behind45: false,
    });
  });
});
