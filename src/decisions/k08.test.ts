/**
 * Guard K8 — the master switch moves every display, and only when it is switched.
 *
 * The page, K8: "Switch on 'apply the global URL to all displays' and hassemu sets every display to 'Global URL'.
 * Switch it off and it sets every one to '---' (landing page). That happens only on the switch; afterwards you can set
 * single displays differently again."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:39 ("k8, k9, k10, k11, k12
 * and k13 are ok, yes").
 *
 * Path: the adapter class from main.ts, its stateChange handler as the constructor registers it, over an adapter whose
 * object and state database lives in memory; the registry and the global settings are the adapter's own, built on that
 * adapter. The data folder is a map in memory, since a guard writes no file.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@iobroker/adapter-core", () => {
  const noop = (): void => undefined;
  /** The adapter base class over a database in memory. */
  class Adapter {
    namespace = "hassemu.0";
    config: Record<string, unknown> = {};
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    objects = new Map<string, ioBroker.Object>();
    states = new Map<string, ioBroker.State>();
    log = { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: "info" };
    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, handler);
      return this;
    }
    full(id: string): string {
      return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    setInterval(): object {
      return {};
    }
    clearInterval(): void {}
    setTimeout(): object {
      return {};
    }
    clearTimeout(): void {}
    getObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(this.objects.get(this.full(id)) ?? null));
    }
    getForeignObjectAsync(id: string): Promise<ioBroker.Object | null> {
      return Promise.resolve(structuredClone(this.objects.get(id) ?? null));
    }
    getForeignObjectsAsync(pattern: string, type?: string): Promise<Record<string, ioBroker.Object>> {
      const prefix = pattern.replace(/\*$/, "");
      const wanted = type ?? "state";
      const found = [...this.objects].filter(([id, obj]) => id.startsWith(prefix) && obj.type === wanted);
      return Promise.resolve(structuredClone(Object.fromEntries(found)));
    }
    getAdapterObjectsAsync(): Promise<Record<string, ioBroker.Object>> {
      const own = [...this.objects].filter(([id]) => id.startsWith(`${this.namespace}.`));
      return Promise.resolve(structuredClone(Object.fromEntries(own)));
    }
    setObjectNotExistsAsync(id: string, obj: ioBroker.Object): Promise<{ id: string }> {
      if (!this.objects.has(this.full(id))) {
        this.objects.set(this.full(id), { ...structuredClone(obj), _id: this.full(id) } as ioBroker.Object);
      }
      return Promise.resolve({ id: this.full(id) });
    }
    extendObject(id: string, patch: Record<string, unknown>): Promise<{ id: string }> {
      const before = (this.objects.get(this.full(id)) ?? {}) as unknown as Record<string, unknown>;
      const after: Record<string, unknown> = { ...before, _id: this.full(id) };
      for (const [key, value] of Object.entries(patch)) {
        const old = before[key];
        after[key] =
          typeof old === "object" && old !== null && typeof value === "object" && value !== null
            ? { ...old, ...value }
            : value;
      }
      this.objects.set(this.full(id), after as unknown as ioBroker.Object);
      return Promise.resolve({ id: this.full(id) });
    }
    getStateAsync(id: string): Promise<ioBroker.State | null> {
      return Promise.resolve(structuredClone(this.states.get(this.full(id)) ?? null));
    }
    getStatesAsync(pattern: string): Promise<Record<string, ioBroker.State | null>> {
      // js-controller 7.2.5 getStates: every state object below the pattern, with its value or null.
      const prefix = this.full(pattern.replace(/\*/g, ""));
      const found: Record<string, ioBroker.State | null> = {};
      for (const [id, obj] of this.objects) {
        if (obj.type === "state" && id.startsWith(prefix)) {
          found[id] = structuredClone(this.states.get(id) ?? null);
        }
      }
      return Promise.resolve(found);
    }
    setState(id: string, state: ioBroker.SettableState): Promise<string> {
      this.states.set(this.full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve(this.full(id));
    }
    setStateChangedAsync(id: string, state: ioBroker.SettableState): Promise<{ id: string; notChanged: boolean }> {
      const before = this.states.get(this.full(id));
      const next = state as ioBroker.State;
      if (before && before.val === next.val && before.ack === (next.ack ?? false)) {
        return Promise.resolve({ id: this.full(id), notChanged: true });
      }
      this.states.set(this.full(id), { ...next, ts: Date.now(), lc: Date.now() });
      return Promise.resolve({ id: this.full(id), notChanged: false });
    }
  }
  return {
    Adapter,
    EXIT_CODES: { UNCAUGHT_EXCEPTION: 6 },
    getAbsoluteInstanceDataDir: (): string => "/guard/hassemu.0",
    I18n: {
      init: (): Promise<void> => Promise.resolve(),
      getTranslatedObject: (key: string) => ({ en: key }),
      translate: (key: string) => key,
    },
  };
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
import { ClientRegistry } from "../lib/client-registry";
import { MODE_GLOBAL, MODE_MANUAL, NO_CHOICE } from "../lib/constants";
import { GlobalConfig } from "../lib/global-config";

/** The adapter instance with what the guard reads from its stub base. */
interface Emu {
  namespace: string;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  states: Map<string, ioBroker.State>;
  registry: ClientRegistry | null;
  globalConfig: GlobalConfig | null;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

afterEach(() => {
  files.clear();
});

/** The adapter with its registry and global settings in place and two displays, both on their own choice. */
async function adapterWithTwoDisplays(): Promise<{ emu: Emu; ids: string[] }> {
  const emu = new HassEmu() as unknown as Emu;
  const registry = new ClientRegistry(emu as never, "/guard/hassemu.0");
  await registry.restore();
  emu.registry = registry;
  emu.globalConfig = new GlobalConfig(emu as never);
  const ids: string[] = [];
  for (const ip of ["192.168.77.51", "192.168.77.52"]) {
    const record = await registry.identifyOrCreate(null, ip, { userAgent: "Mozilla/5.0 (Linux; Android 13)" });
    await registry.handleModeWrite(record.id, MODE_MANUAL);
    ids.push(record.id);
  }
  return { emu, ids };
}

/**
 * A user write (ack false), handed to the stateChange handler the constructor registered.
 *
 * @param emu the adapter
 * @param id the id below the namespace
 * @param val the value
 */
async function userWrites(emu: Emu, id: string, val: ioBroker.StateValue): Promise<void> {
  const handler = emu.handlers.get("stateChange");
  await handler?.(`${emu.namespace}.${id}`, { val, ack: false, ts: 0, lc: 0, from: "system.adapter.admin.0" });
}

/**
 * The mode every display stands on, in the registry and in its datapoint.
 *
 * @param emu the adapter
 * @param ids the display ids
 */
function modes(emu: Emu, ids: string[]): { record: string | undefined; state: unknown }[] {
  return ids.map(id => ({
    record: emu.registry?.getById(id)?.mode,
    state: emu.states.get(`${emu.namespace}.clients.${id}.mode`)?.val,
  }));
}

describe("K8: the master switch moves every display, and only when it is switched", () => {
  it("switching on sets every display to 'global', switching off sets every one to the landing page", async () => {
    const { emu, ids } = await adapterWithTwoDisplays();

    await userWrites(emu, "global.enabled", true);
    const on = modes(emu, ids);
    await userWrites(emu, "global.enabled", false);
    const off = modes(emu, ids);

    expect({ on, off }).toEqual({
      on: ids.map(() => ({ record: MODE_GLOBAL, state: MODE_GLOBAL })),
      off: ids.map(() => ({ record: NO_CHOICE, state: NO_CHOICE })),
    });
  });

  it("a write of the value the switch already has leaves each display's own choice alone", async () => {
    const { emu, ids } = await adapterWithTwoDisplays();

    await userWrites(emu, "global.enabled", true);
    await userWrites(emu, `clients.${ids[1]}.mode`, MODE_MANUAL);
    const afterOwnChoice = modes(emu, ids);
    await userWrites(emu, "global.enabled", true);
    const afterSameValue = modes(emu, ids);
    await userWrites(emu, "global.enabled", false);
    await userWrites(emu, `clients.${ids[0]}.mode`, MODE_MANUAL);
    await userWrites(emu, "global.enabled", false);
    const afterSameOff = modes(emu, ids);

    expect({ afterOwnChoice, afterSameValue, afterSameOff }).toEqual({
      afterOwnChoice: [
        { record: MODE_GLOBAL, state: MODE_GLOBAL },
        { record: MODE_MANUAL, state: MODE_MANUAL },
      ],
      afterSameValue: [
        { record: MODE_GLOBAL, state: MODE_GLOBAL },
        { record: MODE_MANUAL, state: MODE_MANUAL },
      ],
      afterSameOff: [
        { record: MODE_MANUAL, state: MODE_MANUAL },
        { record: NO_CHOICE, state: NO_CHOICE },
      ],
    });
  });
});
