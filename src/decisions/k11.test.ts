/**
 * Guard K11 — hassemu fills the target list of the redirect mode itself, from the admin start page's tiles, the VIS
 * and VIS-2 projects and Aura, in plain text; "Refresh URL discovery" searches again without a restart.
 *
 * The page, K11: "hassemu fills the list in 'redirect mode' itself: from the tiles of the admin start page, the
 * projects of VIS and VIS-2 and from Aura. 'Refresh URL discovery' searches again, without a restart."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:39 ("k8, k9, k10, k11, k12
 * and k13 are ok, yes").
 *
 * Path: the adapter class from main.ts, started through the ready handler its constructor registers — the URL
 * discovery main.ts builds (`makeUrlDiscovery`) reads the broker's instances and the VIS project folders and hands its
 * list to the dropdowns of `global.mode` and every display's `mode`; the refresh is a user write of
 * `info.refreshUrls`, handed to the stateChange handler the constructor registered. The broker (objects, states, VIS
 * folders) lives in memory; the host carries one network (192.168.77.0/24); the data folder is a map in memory, since
 * a guard writes no file. The labels come from the adapter's own admin/i18n/en.json, read as data.
 */

import { readFileSync } from "node:fs";
import type * as Os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { files, db } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  db: {
    objects: new Map<string, ioBroker.Object>(),
    states: new Map<string, ioBroker.State>(),
    /** The project folders of each VIS instance's file storage. */
    folders: new Map<string, string[]>(),
    /** Every warning, error and termination of the adapter — a start that failed shows here. */
    problems: [] as string[],
  },
}));

vi.mock("@iobroker/adapter-core", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const en = JSON.parse(readFileSync(join(process.cwd(), "admin", "i18n", "en.json"), "utf8")) as Record<
    string,
    string
  >;
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
    /**
     * The file storage of an adapter: the project folders of a VIS instance.
     *
     * @param adapterName the VIS instance, e.g. `vis-2.0`
     */
    readDirAsync(adapterName: string): Promise<unknown[]> {
      return Promise.resolve((db.folders.get(adapterName) ?? []).map(file => ({ file, isDir: true })));
    }
    readFileAsync(): Promise<never> {
      return Promise.reject(new Error("no such file"));
    }
  }
  return {
    Adapter,
    EXIT_CODES: { UNCAUGHT_EXCEPTION: 6 },
    getAbsoluteInstanceDataDir: (): string => "/guard/hassemu.0",
    I18n: {
      init: (): Promise<void> => Promise.resolve(),
      getTranslatedObject: (key: string) => ({ en: en[key] ?? key }),
      translate: (key: string) => en[key] ?? key,
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

import * as mainModule from "../main";

/** The adapter instance with what the guard reads from its stub base. */
interface Emu {
  namespace: string;
  config: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const DISPLAY = "display-b7e4";
const CONFIG = {
  port: 0,
  bind: "0.0.0.0",
  authRequired: false,
  username: "admin",
  password: "",
  mdnsEnabled: false,
  serviceName: "ioBroker",
};
/** What the four sources give on a host at 192.168.77.10 — the admin tile, a VIS-2 and a VIS project, Aura. */
const ADMIN_TILE = "http://192.168.77.10:8081";
const VIS2_PROJECT = "http://192.168.77.10:8082/vis-2/index.html?main";
const VIS_PROJECT = "http://192.168.77.10:8082/vis/index.html?hall";
const AURA = "http://192.168.77.10:8095/";
const VIS2_NEW_PROJECT = "http://192.168.77.10:8082/vis-2/index.html?tablet";

const running: Emu[] = [];

afterEach(async () => {
  for (const emu of [...running]) {
    running.splice(running.indexOf(emu), 1);
    await new Promise<void>(resolve => {
      emu.handlers.get("unload")?.(resolve);
    });
  }
  files.clear();
  db.objects.clear();
  db.states.clear();
  db.folders.clear();
  db.problems.length = 0;
});

/**
 * One instance object of the broker.
 *
 * @param name the instance, e.g. `web.0`
 * @param common its common part (enabled, links)
 * @param native its settings
 */
function instance(name: string, common: Record<string, unknown>, native: Record<string, unknown>): void {
  db.objects.set(`system.adapter.${name}`, {
    _id: `system.adapter.${name}`,
    type: "instance",
    common: { name: name.split(".")[0], host: "guard", ...common },
    native,
  } as unknown as ioBroker.Object);
}

/**
 * The installation: the manifest's instance objects as js-controller creates them, the broker's instances (admin with
 * its start page tile, web serving a VIS-2 and a VIS project, Aura) and one known display.
 */
function seedInstall(): void {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
    instanceObjects: { _id: string }[];
  };
  for (const obj of manifest.instanceObjects) {
    db.objects.set(`${NS}.${obj._id}`, { ...obj, _id: `${NS}.${obj._id}` } as unknown as ioBroker.Object);
  }
  instance(NS, { enabled: true }, { ...CONFIG });
  instance(
    "admin.0",
    { enabled: true, localLinks: { _default: { link: "%protocol%://%bind%:%port%", name: "Admin" } } },
    { port: 8081, bind: "0.0.0.0", secure: false },
  );
  instance("web.0", { enabled: true }, { port: 8082, bind: "0.0.0.0", secure: false });
  instance("vis-2.0", { enabled: true }, {});
  instance("vis.0", { enabled: true }, {});
  instance("aura.0", { enabled: true }, { port: 8095, secure: false, customUrl: "" });
  db.folders.set("vis-2.0", ["main"]);
  db.folders.set("vis.0", ["hall"]);
  const device = `${NS}.clients.${DISPLAY}`;
  db.objects.set(device, {
    _id: device,
    type: "device",
    common: { name: { en: "192.168.77.51" } },
    native: {},
  } as unknown as ioBroker.Object);
  files.set(
    `${DATA_DIR}/identities.json`,
    JSON.stringify({
      server: "0d5b8e2a-7c41-4f3e-9a26-5b8c1d7e3f90",
      displays: {
        [DISPLAY]: {
          cookie: "a3c1e5f7-2b4d-4e6f-8a0b-1c2d3e4f5a6b",
          token: null,
          tokenExpiresAt: null,
          refreshToken: null,
          lastSeen: Date.now() - 60_000,
        },
      },
    }),
  );
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
 * The dropdown of a mode datapoint: its target URLs (the entries besides "---", "global" and "manual") and whether
 * every label is plain text.
 *
 * @param id the datapoint below the namespace
 */
function dropdown(id: string): { urls: string[]; plainText: boolean } {
  const states = (db.objects.get(`${NS}.${id}`)?.common as { states?: Record<string, unknown> } | undefined)?.states;
  return {
    urls: Object.keys(states ?? {})
      .filter(key => /^https?:/.test(key))
      .sort(),
    plainText: Object.values(states ?? {}).every(label => typeof label === "string" && label !== ""),
  };
}

describe("K11: hassemu fills the target list itself; the refresh searches again without a restart", () => {
  it("fills global.mode and every display's mode at start from the admin tiles, VIS and VIS-2 projects and Aura", async () => {
    seedInstall();

    await started();

    const expected = { urls: [ADMIN_TILE, AURA, VIS2_PROJECT, VIS_PROJECT].sort(), plainText: true };
    expect({
      problems: db.problems,
      global: dropdown("global.mode"),
      display: dropdown(`clients.${DISPLAY}.mode`),
    }).toEqual({ problems: [], global: expected, display: expected });
  });

  it("searches again on 'Refresh URL discovery' and re-arms the button, without a restart", async () => {
    seedInstall();
    const emu = await started();
    const before = dropdown("global.mode").urls.includes(VIS2_NEW_PROJECT);
    db.folders.set("vis-2.0", ["main", "tablet"]);

    await emu.handlers.get("stateChange")?.(`${emu.namespace}.info.refreshUrls`, {
      val: true,
      ack: false,
      ts: 0,
      lc: 0,
      from: "system.adapter.admin.0",
    });

    const button = db.states.get(`${NS}.info.refreshUrls`);
    expect({
      problems: db.problems,
      before,
      global: dropdown("global.mode").urls.includes(VIS2_NEW_PROJECT),
      display: dropdown(`clients.${DISPLAY}.mode`).urls.includes(VIS2_NEW_PROJECT),
      button: { val: button?.val, ack: button?.ack },
    }).toEqual({ problems: [], before: false, global: true, display: true, button: { val: false, ack: true } });
  });
});
