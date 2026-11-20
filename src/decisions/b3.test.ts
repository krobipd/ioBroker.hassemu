/**
 * Guard B3 — the datapoint info.serverUuid no longer exists; the identifier by which the displays recognise hassemu
 * stands in the file in the instance's data folder; at the update hassemu moves it once, no display has to be set up
 * again.
 *
 * The page, B3: "The datapoint no longer exists. The id stands in the file in the data folder of the instance; on the
 * update hassemu moves it once, no display has to be set up again." Why: "If the datapoint stayed beside it, the id
 * would exist twice, and a script could overwrite the copy."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:31 ("b3 as your research
 * found").
 *
 * Path: the adapter class from main.ts, started through the ready handler its constructor registers — the registry
 * reads the server id from the data file (or, while the file holds none, once from the datapoint of 1.46.1), the start
 * drops the old datapoint, the web server opens on a free port and announces the id — over an adapter whose object and
 * state database lives in memory; the announcement is asked by inject from a peer address of the host's network
 * (192.168.77.0/24). The manifest is read as data. The data folder is a fresh folder in the temporary directory,
 * written through the data-folder master as on a host.
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

import * as mainModule from "../main";

/** What a route answers. */
interface Answer {
  statusCode: number;
  json(): unknown;
}

/** The adapter instance with what the guard reads from its stub base and its own fields. */
interface Emu {
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  webServer: {
    inject(request: {
      method: "GET";
      url: string;
      headers: Record<string, string>;
      remoteAddress: string;
    }): Promise<Answer>;
  } | null;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const OLD_ID = "info.serverUuid";
/** The server id an installation of 1.46.1 holds as the value of info.serverUuid. */
const LEGACY_SERVER_ID = "5e0f3c9a-1b2d-4c6e-8f7a-9b0c1d2e3f4a";
/** Another id a script or a restored backup puts into the old datapoint after the move. */
const STRAY_SERVER_ID = "8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a";
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
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-b3-"));
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
});

/** The manifest, read as data. */
function manifest(): { instanceObjects: { _id: string }[] } {
  return JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
    instanceObjects: { _id: string }[];
  };
}

/** The installation js-controller sets up: the instance object and the manifest's instance objects. */
function seedInstall(): void {
  for (const obj of manifest().instanceObjects) {
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
 * The datapoint of 1.46.1 with a server id as its value.
 *
 * @param serverId the value
 */
function seedOldDatapoint(serverId: string): void {
  db.objects.set(`${NS}.${OLD_ID}`, {
    _id: `${NS}.${OLD_ID}`,
    type: "state",
    common: { name: "Server UUID", type: "string", role: "text", read: true, write: false },
    native: {},
  } as unknown as ioBroker.Object);
  db.states.set(`${NS}.${OLD_ID}`, { val: serverId, ack: true, ts: 1, lc: 1, from: `system.adapter.${NS}` });
}

/** The adapter, started through the ready handler its constructor registered. */
async function started(): Promise<Emu> {
  const emu = new HassEmu() as unknown as Emu;
  emu.config = { ...CONFIG };
  running.push(emu);
  await emu.handlers.get("ready")?.();
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

/**
 * The server id the running web server announces to a display of the host's network.
 *
 * @param emu the adapter
 */
async function announced(emu: Emu): Promise<unknown> {
  const answer = await emu.webServer?.inject({
    method: "GET",
    url: "/api/discovery_info",
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" },
    remoteAddress: "192.168.77.50",
  });
  return (answer?.json() as { uuid?: unknown } | undefined)?.uuid;
}

/** The server id in the data file. */
function inFile(): unknown {
  const file = join(data.dir, "identities.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { server?: unknown }).server : undefined;
}

/** What is left of the old datapoint: its object and its value. */
function oldDatapoint(): { object: boolean; value: boolean } {
  return { object: db.objects.has(`${NS}.${OLD_ID}`), value: db.states.has(`${NS}.${OLD_ID}`) };
}

describe("B3: info.serverUuid no longer exists, the id stands in the data file", () => {
  it("the datapoint info.serverUuid does not exist, and the id the displays recognise hassemu by stands in the data file", async () => {
    seedInstall();
    const ids = manifest().instanceObjects.map(obj => obj._id);

    const emu = await started();
    const uuid = await announced(emu);

    expect({ declares: ids.length > 0, serverUuid: ids.includes(OLD_ID) }).toEqual({
      declares: true,
      serverUuid: false,
    });
    expect({ problems: db.problems, old: oldDatapoint(), announces: typeof uuid === "string" && uuid !== "" }).toEqual({
      problems: [],
      old: { object: false, value: false },
      announces: true,
    });
    expect(inFile()).toEqual(uuid);
  });

  it("at the update hassemu moves the id once into the data file, so no display has to be set up again", async () => {
    seedInstall();
    seedOldDatapoint(LEGACY_SERVER_ID);

    const first = await started();
    const afterUpdate = {
      problems: [...db.problems],
      old: oldDatapoint(),
      inFile: inFile(),
      uuid: await announced(first),
    };
    await stopped(first);
    seedOldDatapoint(STRAY_SERVER_ID);
    const second = await started();
    const laterStart = {
      problems: [...db.problems],
      old: oldDatapoint(),
      inFile: inFile(),
      uuid: await announced(second),
    };

    expect(afterUpdate).toEqual({
      problems: [],
      old: { object: false, value: false },
      inFile: LEGACY_SERVER_ID,
      uuid: LEGACY_SERVER_ID,
    });
    expect(laterStart).toEqual({
      problems: [],
      old: { object: false, value: false },
      inFile: LEGACY_SERVER_ID,
      uuid: LEGACY_SERVER_ID,
    });
  });
});
