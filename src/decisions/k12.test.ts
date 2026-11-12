/**
 * Guard K12 — unsafe addresses are rejected on every write path of a redirect target.
 *
 * The page, K12: "An address that begins with javascript:, data: or file:, contains credentials or is longer than 2048
 * characters, hassemu does not accept as a target."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:39 ("k8, k9, k10, k11, k12
 * and k13 are ok, yes").
 *
 * Path: the adapter class from main.ts, its stateChange handler as the constructor registers it, receiving user writes
 * (ack false) on the four datapoints a target is written to — clients.<id>.mode, clients.<id>.manualUrl, global.mode
 * and global.manualUrl — over an adapter whose object and state database lives in memory; the registry and the global
 * settings are the adapter's own, built on that adapter. The data folder is a map in memory, since a guard writes no
 * file.
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
import { GlobalConfig } from "../lib/global-config";

/** The adapter instance with what the guard reads from its stub base. */
interface Emu {
  namespace: string;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  states: Map<string, ioBroker.State>;
  registry: ClientRegistry | null;
  globalConfig: GlobalConfig | null;
}

/** One datapoint a target is written to: its id below the namespace and where the adapter keeps the value. */
interface WritePath {
  id: string;
  held: () => unknown;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const SAFE = "http://192.168.77.20:8082/vis-2/index.html?main";
const BASE = "http://192.168.77.20:8082/vis-2/index.html?";
/** Exactly 2048 characters — the longest address the rule still takes. */
const AT_LIMIT = `${BASE}${"a".repeat(2048 - BASE.length)}`;
const UNSAFE = {
  javascript: "javascript:alert(1)",
  data: "data:text/html,<script>alert(1)</script>",
  file: "file:///etc/passwd",
  credentials: "http://admin:secret@192.168.77.20:8082/vis-2/index.html?main",
  longerThan2048: `${AT_LIMIT}a`,
};

afterEach(() => {
  files.clear();
});

/** The adapter with its registry and global settings in place and one display. */
async function adapterWithOneDisplay(): Promise<{ emu: Emu; paths: WritePath[] }> {
  const emu = new HassEmu() as unknown as Emu;
  const registry = new ClientRegistry(emu as never, "/guard/hassemu.0");
  await registry.restore();
  emu.registry = registry;
  const globalConfig = new GlobalConfig(emu as never);
  emu.globalConfig = globalConfig;
  const { id } = await registry.identifyOrCreate(null, "192.168.77.51", {
    userAgent: "Mozilla/5.0 (Linux; Android 13)",
  });
  const paths: WritePath[] = [
    { id: `clients.${id}.mode`, held: () => registry.getById(id)?.mode },
    { id: `clients.${id}.manualUrl`, held: () => registry.getById(id)?.manualUrl },
    { id: "global.mode", held: () => globalConfig.redirect.mode },
    { id: "global.manualUrl", held: () => globalConfig.redirect.manualUrl },
  ];
  return { emu, paths };
}

/**
 * A user write (ack false), handed to the stateChange handler the constructor registered; answers what the adapter
 * holds afterwards and what the datapoint shows.
 *
 * @param emu the adapter
 * @param path the datapoint
 * @param val the value
 */
async function userWrites(
  emu: Emu,
  path: WritePath,
  val: ioBroker.StateValue,
): Promise<{ held: unknown; shown: unknown }> {
  const handler = emu.handlers.get("stateChange");
  await handler?.(`${emu.namespace}.${path.id}`, { val, ack: false, ts: 0, lc: 0, from: "system.adapter.admin.0" });
  const state = emu.states.get(`${emu.namespace}.${path.id}`);
  return { held: path.held(), shown: state?.ack === true ? state.val : undefined };
}

describe("K12: unsafe addresses are rejected on every write path of a redirect target", () => {
  it("takes a safe address and one of exactly 2048 characters, and keeps it against every unsafe one", async () => {
    const { emu, paths } = await adapterWithOneDisplay();
    const outcome: Record<string, Record<string, unknown>> = {};
    const expected: Record<string, Record<string, unknown>> = {};

    for (const path of paths) {
      const row: Record<string, unknown> = { safe: await userWrites(emu, path, SAFE) };
      for (const [kind, value] of Object.entries(UNSAFE)) {
        row[kind] = await userWrites(emu, path, value);
      }
      row.atLimit = await userWrites(emu, path, AT_LIMIT);
      outcome[path.id] = row;
      expected[path.id] = {
        safe: { held: SAFE, shown: SAFE },
        ...Object.fromEntries(Object.keys(UNSAFE).map(kind => [kind, { held: SAFE, shown: SAFE }])),
        atLimit: { held: AT_LIMIT, shown: AT_LIMIT },
      };
    }

    expect({ atLimit: AT_LIMIT.length, longer: UNSAFE.longerThan2048.length }).toEqual({ atLimit: 2048, longer: 2049 });
    expect(outcome).toEqual(expected);
  });
});
