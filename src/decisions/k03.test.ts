/**
 * Guard K3 — the port is configurable, the default stays 8123; for existing installations nothing changes.
 *
 * The page, K3: "The field is released, the default stays 8123. For existing installations nothing changes."
 * "hassemu already computes with the configured port everywhere internally, only the field is locked. Whoever already
 * runs something on 8123 on the same machine cannot use hassemu at all today." Until 1.46.1 the field was locked to
 * 8123 (`disabled`, `min` = `max` = 8123), so every existing installation carries port 8123 in its settings.
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:31 ("k3 and k4 absolutely
 * ok").
 *
 * Path: the settings page and the manifest read as data; the adapter class from main.ts, started through the ready
 * handler its constructor registers, over an adapter whose object and state database lives in memory — once with a
 * free port found at runtime in its settings, once as an existing installation with the settings 1.46.1 left (its
 * instance object in the database, port 8123). Its server is asked over a real socket; the mDNS announcement is
 * recorded by a stand-in for bonjour-service, so nothing goes out on the network. The host carries one network
 * (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import type * as Os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { files, announced } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  announced: [] as { port: unknown; txt: Record<string, string> }[],
}));

vi.mock("@iobroker/adapter-core", () => {
  const noop = (): void => undefined;
  /** The adapter base class over a database in memory. */
  class Adapter {
    namespace = "hassemu.0";
    adapterDir = process.cwd();
    config: Record<string, unknown> = {};
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    objects = new Map<string, ioBroker.Object>();
    states = new Map<string, ioBroker.State>();
    errors: string[] = [];
    terminations: unknown[] = [];
    log = {
      silly: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: (msg: string): void => void this.errors.push(msg),
      level: "info",
    };
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
    terminate(...args: unknown[]): void {
      this.terminations.push(args);
    }
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
    setForeignObject(id: string, obj: ioBroker.Object): Promise<{ id: string }> {
      this.objects.set(id, structuredClone(obj));
      return Promise.resolve({ id });
    }
    extendForeignObjectAsync(id: string, patch: Record<string, unknown>): Promise<{ id: string }> {
      const before = (this.objects.get(id) ?? {}) as unknown as Record<string, unknown>;
      this.objects.set(id, { ...before, ...patch } as unknown as ioBroker.Object);
      return Promise.resolve({ id });
    }
    delObjectAsync(id: string): Promise<void> {
      this.objects.delete(this.full(id));
      this.states.delete(this.full(id));
      return Promise.resolve();
    }
    delStateAsync(id: string): Promise<void> {
      this.states.delete(this.full(id));
      return Promise.resolve();
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
      return Promise.reject(new Error("no files in this guard"));
    }
    readFileAsync(): Promise<unknown> {
      return Promise.reject(new Error("no files in this guard"));
    }
    getCertificatesAsync(): Promise<unknown> {
      return Promise.reject(new Error("Not exists"));
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
vi.mock("bonjour-service", () => {
  /** A stand-in for bonjour-service: records what would be announced, sends nothing. */
  class Bonjour {
    /** Where bonjour-service 1.4.4 keeps its multicast socket — hassemu hands it the address records there (D17). */
    server = { mdns: { send: (_packet: unknown, _rinfo?: unknown, done?: () => void): void => done?.() } };
    publish(service: { port: unknown; txt: Record<string, string> }): {
      on: () => void;
      stop: (done?: () => void) => void;
    } {
      announced.push({ port: service.port, txt: { ...service.txt } });
      return { on: (): void => undefined, stop: (done?: () => void): void => done?.() };
    }
    destroy(): void {}
  }
  return { default: Bonjour, Bonjour };
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
import type { AdapterConfig } from "../lib/types";
import type { WebServer } from "../lib/webserver";

/** The adapter instance with what the guard reads from its stub base. */
interface Emu {
  namespace: string;
  objects: Map<string, ioBroker.Object>;
  config: AdapterConfig;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  states: Map<string, ioBroker.State>;
  errors: string[];
  terminations: unknown[];
  webServer: WebServer | null;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };
const started: Emu[] = [];

afterEach(async () => {
  for (const emu of started.splice(0)) {
    await new Promise<void>(resolve => {
      void emu.handlers.get("unload")?.(resolve);
    });
  }
  files.clear();
  announced.length = 0;
});

/** A port nothing listens on right now, as the operating system hands it out. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "0.0.0.0", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/** The instance settings 1.46.1 left in an installation (its io-package.json `native`, the port locked to 8123). */
const SETTINGS_1_46_1 = {
  port: 8123,
  bind: "0.0.0.0",
  authRequired: false,
  username: "admin",
  password: "",
  mdnsEnabled: true,
  serviceName: "ioBroker",
  trustProxy: false,
};
const INSTANCE = "system.adapter.hassemu.0";

/**
 * The adapter started through its ready handler, with these instance settings, its instance object holding them.
 *
 * @param settings the instance settings
 */
async function startedWith(settings: Record<string, unknown>): Promise<Emu> {
  const emu = new HassEmu() as unknown as Emu;
  emu.objects.set(INSTANCE, {
    _id: INSTANCE,
    type: "instance",
    common: { name: "hassemu" },
    native: structuredClone(settings),
  } as unknown as ioBroker.Object);
  emu.config = structuredClone(settings) as unknown as AdapterConfig;
  started.push(emu);
  await emu.handlers.get("ready")?.();
  return emu;
}

/**
 * One plain HTTP request over a real socket; a refused connection is an answer too.
 *
 * @param port the port to connect to
 */
function overSocket(port: number): Promise<{ status: number | null; error: string | null }> {
  return new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/", method: "GET" }, res => {
      res.resume();
      resolve({ status: res.statusCode ?? null, error: null });
    });
    req.on("error", (err: NodeJS.ErrnoException) => resolve({ status: null, error: err.code ?? "error" }));
    req.end();
  });
}

/**
 * A JSON file of the adapter root, read as data.
 *
 * @param name the file name
 */
function rootJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), name), "utf8")) as Record<string, unknown>;
}

describe("K3: the port", () => {
  it("is configurable: the settings offer the port field, unlocked and open to other ports, and hassemu listens on the port set there", async () => {
    const items = (rootJson(join("admin", "jsonConfig.json")) as { items: Record<string, Record<string, unknown>> })
      .items;
    const field = items.port;
    const port = await freePort();
    if (port === 8123) {
      throw new Error("the case needs a port other than the default");
    }

    const emu = await startedWith({ ...SETTINGS_1_46_1, port });
    const socket = await overSocket(port);

    expect({
      offered: field !== undefined,
      locks: (["disabled", "readOnly", "hidden"] as const).filter(
        key => field?.[key] !== undefined && field[key] !== false,
      ),
      onlyOnePort: field?.min !== undefined && field.min === field.max,
      listensOn: emu.webServer?.boundAddress?.port,
      answersThere: typeof socket.status === "number",
    }).toEqual({ offered: true, locks: [], onlyOnePort: false, listensOn: port, answersThere: true });
  });

  it("the default stays 8123", () => {
    expect((rootJson("io-package.json").native as Record<string, unknown>).port).toBe(8123);
  });

  it("for existing installations nothing changes: the settings of 1.46.1 keep port 8123, and hassemu listens on it", async () => {
    const emu = await startedWith(SETTINGS_1_46_1);

    expect({
      settings: (emu.objects.get(INSTANCE)?.native as Record<string, unknown> | undefined)?.port,
      listensOn: emu.webServer?.boundAddress?.port,
    }).toEqual({ settings: 8123, listensOn: 8123 });
  });
});
