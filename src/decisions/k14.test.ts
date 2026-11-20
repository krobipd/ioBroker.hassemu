/**
 * Guard K14 — at start hassemu removes every display that was last seen 30 days longer ago than the most recently seen
 * one, with its settings and its assignment to room and function; the measure is the most recently seen display, not
 * the clock: if the whole installation stood still for long, none falls; the most recently seen display never falls by
 * itself.
 *
 * The page, K14: "At start, hassemu removes every display that was not seen for 30 days longer than the one seen last,
 * with its settings and its assignment to room and function. It is measured at the display seen last, not at the
 * clock: if the whole installation stood still for long, none falls. The display seen last never falls by itself."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:55 ("k14, k15 are ok").
 *
 * Path: the adapter class from main.ts, started through the ready handler its constructor registers — the registry
 * restores the displays and their last-seen stamps from the data file, then the start's clean-up runs, then the web
 * server opens on a free port — over an adapter whose object and state database lives in memory. A removal is the
 * recursive delete of the display's device; its room and function assignments leave with that delete, which takes
 * every deleted id out of every enum as js-controller does. The data folder is a fresh folder in the temporary
 * directory, written through the data-folder master as on a host.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const DAY = 24 * 60 * 60 * 1000;
/** A room and a function the user assigned the displays to. */
const ROOM = "enum.rooms.hall";
const FUNCTION = "enum.functions.screens";
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
 * device, its settings (mode on a manual URL), its entry in the data file, and its device in a room and a function.
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
      token: null,
      tokenExpiresAt: null,
      refreshToken: null,
      lastSeen: display.lastSeen,
    };
  });
  for (const id of [ROOM, FUNCTION]) {
    db.objects.set(id, {
      _id: id,
      type: "enum",
      common: { name: id, members: displays.map(display => `${NS}.clients.${display.id}`) },
      native: {},
    } as unknown as ioBroker.Object);
  }
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
 * What is left of a display: its objects, its values, its entry in the data file and the enums that list its device.
 *
 * @param id the display id
 */
function leftOf(id: string): { objects: string[]; values: string[]; fileEntry: boolean; inEnums: string[] } {
  const prefix = `${NS}.clients.${id}`;
  const file = join(data.dir, "identities.json");
  const stored = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as {
    displays?: Record<string, unknown>;
  };
  return {
    objects: [...db.objects.keys()].filter(key => key === prefix || key.startsWith(`${prefix}.`)),
    values: [...db.states.keys()].filter(key => key.startsWith(`${prefix}.`)),
    fileEntry: stored.displays?.[id] !== undefined,
    inEnums: [ROOM, FUNCTION].filter(enumId =>
      ((db.objects.get(enumId)?.common as { members?: string[] } | undefined)?.members ?? []).includes(prefix),
    ),
  };
}

describe("K14: at start hassemu removes displays long unseen, measured at the most recently seen display", () => {
  it("removes a display last seen 30 days longer ago than the most recently seen one, with its settings and its assignment to room and function", async () => {
    const newest = Date.now() - DAY;
    seedInstall([
      { id: "display-a001", lastSeen: newest },
      { id: "display-b002", lastSeen: newest - 29 * DAY },
      { id: "display-c003", lastSeen: newest - 31 * DAY },
    ]);

    await started();

    expect({ problems: db.problems, devices: devices() }).toEqual({
      problems: [],
      devices: ["display-a001", "display-b002"],
    });
    expect(leftOf("display-c003")).toEqual({ objects: [], values: [], fileEntry: false, inEnums: [] });
    expect(leftOf("display-b002").inEnums).toEqual([ROOM, FUNCTION]);
  });

  it("if the whole installation stood still for long, none falls", async () => {
    const newest = Date.now() - 60 * DAY;
    seedInstall([
      { id: "display-d004", lastSeen: newest },
      { id: "display-e005", lastSeen: newest - 20 * DAY },
    ]);

    await started();

    expect({ problems: db.problems, devices: devices() }).toEqual({
      problems: [],
      devices: ["display-d004", "display-e005"],
    });
  });

  it("the most recently seen display never falls by itself", async () => {
    seedInstall([{ id: "display-f006", lastSeen: Date.now() - 400 * DAY }]);

    await started();

    expect({ problems: db.problems, devices: devices(), fileEntry: leftOf("display-f006").fileEntry }).toEqual({
      problems: [],
      devices: ["display-f006"],
      fileEntry: true,
    });
  });
});
