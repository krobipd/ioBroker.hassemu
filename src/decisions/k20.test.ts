/**
 * Guard K20 — removing a display ends its access: its token and its running connection end at once, and its next
 * request shows it as a new display with the landing page.
 *
 * The page, K20: "If you remove a display (button 'Remove this display'), its running connection ends at once. On its
 * next request it shows up as a new display with the landing page."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:56 ("k20 sure").
 *
 * Path: the adapter class from main.ts, its stateChange handler as the constructor registers it (the remove button
 * and the display's mode are user writes), over an adapter whose object and state database lives in memory; the
 * registry and the global settings are the adapter's own, the new-display mode is wired as main.ts wires it, and the
 * web server as main.ts starts it runs on the same adapter and registry. HTTP requests by inject from a peer address
 * of the own network, the WebSocket over a real socket on a free port of this machine. The host carries two networks
 * in the mock — 192.168.77.0/24 and 127.0.0.0/8 — so the guard's own socket is a peer of an own network; the data
 * folder is a fresh folder in the temporary directory, written through the data-folder master as on a host.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The instance data folder of the running test. */
const data = vi.hoisted(() => ({ dir: "" }));

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
    delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
      const key = this.full(id);
      for (const stored of [...this.objects.keys()]) {
        if (stored === key || (options?.recursive === true && stored.startsWith(`${key}.`))) {
          this.objects.delete(stored);
          this.states.delete(stored);
        }
      }
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
    eth1: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "02:00:00:00:00:02",
        internal: false,
        cidr: "127.0.0.1/8",
      },
    ],
  });
  return { ...real, networkInterfaces, default: { ...real, networkInterfaces } };
});

import * as mainModule from "../main";
import { ClientRegistry } from "../lib/client-registry";
import { GlobalConfig } from "../lib/global-config";
import type { AdapterConfig } from "../lib/types";
import { WebServer } from "../lib/webserver";

/** The adapter instance with what the guard reads from its stub base. */
interface Emu {
  namespace: string;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  objects: Map<string, ioBroker.Object>;
  registry: ClientRegistry | null;
  globalConfig: GlobalConfig | null;
  computeNewClientMode(): string;
}

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): unknown;
}

/** A display that signed in: its cookie, its id and its tokens. */
interface SignedIn {
  cookie: string;
  id: string;
  access: string;
  refresh: string;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const PEER = "192.168.77.50";
const PASSWORD = "guard-secret";
const TARGET = "http://192.168.77.20:8082/vis-2/index.html?main";
const servers: WebServer[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  data.dir = mkdtempSync(join(tmpdir(), "hassemu-guard-k20-"));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  rmSync(data.dir, { recursive: true, force: true });
  data.dir = "";
});

/** The adapter with its registry and global settings in place and the web server as main.ts starts it. */
async function adapterWithServer(): Promise<{ emu: Emu; server: WebServer }> {
  const emu = new HassEmu() as unknown as Emu;
  const registry = new ClientRegistry(emu as never, data.dir);
  await registry.restore();
  emu.registry = registry;
  emu.globalConfig = new GlobalConfig(emu as never);
  registry.setNewClientModeProvider(() => emu.computeNewClientMode());
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired: true,
    username: "admin",
    password: PASSWORD,
    mdnsEnabled: false,
    serviceName: "ioBroker",
  };
  const server = new WebServer(emu as never, config, registry, emu.globalConfig, registry.serverUuid, "en", () =>
    Promise.resolve(true),
  );
  servers.push(server);
  await server.start();
  return { emu, server };
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
 * One request to the server from the display's address.
 *
 * @param server the server
 * @param method the method
 * @param url the path
 * @param extra cookie, Bearer token, form body
 * @param extra.cookie the display's cookie header
 * @param extra.bearer an access token for the Authorization header
 * @param extra.form a form body
 */
function ask(
  server: WebServer,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; bearer?: string; form?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (extra.cookie) {
    headers.cookie = extra.cookie;
  }
  if (extra.bearer) {
    headers.authorization = `Bearer ${extra.bearer}`;
  }
  if (extra.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const payload = extra.form ? new URLSearchParams(extra.form).toString() : undefined;
  return server.inject({ method, url, headers, payload, remoteAddress: PEER });
}

/**
 * The display cookie an answer sets, as a Cookie header, empty when it sets none.
 *
 * @param answer the answer
 */
function cookieOf(answer: Answer): string {
  const raw = answer.headers["set-cookie"];
  const text = Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
  return /hassemu_client=[^;]+/.exec(text)?.[0] ?? "";
}

/**
 * The ids of the devices under clients.
 *
 * @param emu the adapter
 */
function displays(emu: Emu): string[] {
  return [...emu.objects]
    .filter(([id, obj]) => id.startsWith(`${emu.namespace}.clients.`) && obj.type === "device")
    .map(([id]) => id.slice(`${emu.namespace}.clients.`.length));
}

/**
 * A display's first visit and its sign-in with user name and password (login flow, code, token).
 *
 * @param emu the adapter
 * @param server the server
 */
async function signedInDisplay(emu: Emu, server: WebServer): Promise<SignedIn> {
  const cookie = cookieOf(await ask(server, "GET", "/"));
  const [id] = displays(emu);
  const flow = (await ask(server, "POST", "/auth/login_flow", { cookie, form: {} })).json() as { flow_id?: string };
  const done = (
    await ask(server, "POST", `/auth/login_flow/${flow.flow_id ?? ""}`, {
      cookie,
      form: { username: "admin", password: PASSWORD },
    })
  ).json() as { result?: string };
  const tokens = (
    await ask(server, "POST", "/auth/token", {
      cookie,
      form: { grant_type: "authorization_code", code: done.result ?? "" },
    })
  ).json() as { access_token?: string; refresh_token?: string };
  return { cookie, id, access: tokens.access_token ?? "", refresh: tokens.refresh_token ?? "" };
}

/**
 * A WebSocket to the server's /api/websocket over a real socket, with its frames queued.
 *
 * @param server the started server
 */
async function webSocketTo(server: WebServer): Promise<{
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  afterSend: (frame: Record<string, unknown>) => Promise<"closed" | "answered" | "open">;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.boundAddress?.port ?? 0}/api/websocket`);
  sockets.push(socket);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
    } else {
      queue.push(frame);
    }
  });
  const next = (): Promise<Record<string, unknown>> => {
    const queued = queue.shift();
    return queued ? Promise.resolve(queued) : new Promise(resolve => waiters.push(resolve));
  };
  const afterSend = (frame: Record<string, unknown>): Promise<"closed" | "answered" | "open"> =>
    new Promise(resolve => {
      const timer = setTimeout(() => resolve("open"), 2000);
      const settle = (how: "closed" | "answered"): void => {
        clearTimeout(timer);
        resolve(how);
      };
      socket.addEventListener("close", () => settle("closed"));
      waiters.push(() => settle("answered"));
      socket.send(JSON.stringify(frame));
    });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("WebSocket did not open")));
  });
  return { socket, next, afterSend };
}

describe("K20: removing a display ends its access", () => {
  it("rejects the removed display's tokens and shows its next request as a new display with the landing page", async () => {
    const { emu, server } = await adapterWithServer();
    const display = await signedInDisplay(emu, server);
    await userWrites(emu, `clients.${display.id}.mode`, TARGET);
    const dashboard = await ask(server, "GET", "/", { cookie: display.cookie });
    const apiBefore = await ask(server, "GET", "/api/config", { bearer: display.access });

    await userWrites(emu, `clients.${display.id}.remove`, true);
    const apiAfter = await ask(server, "GET", "/api/config", { bearer: display.access });
    const refreshAfter = await ask(server, "POST", "/auth/token", {
      form: { grant_type: "refresh_token", refresh_token: display.refresh },
    });
    const next = await ask(server, "GET", "/", { cookie: display.cookie });
    const nextCookie = cookieOf(next);
    const now = displays(emu);

    expect({
      signedIn: display.access !== "" && display.refresh !== "",
      dashboard: dashboard.body.includes(`src="${TARGET}"`),
      api: apiBefore.statusCode,
    }).toEqual({ signedIn: true, dashboard: true, api: 200 });
    expect({ api: apiAfter.statusCode, refresh: refreshAfter.statusCode }).toEqual({ api: 401, refresh: 400 });
    expect({
      status: next.statusCode,
      newCookie: nextCookie !== "" && nextCookie !== display.cookie,
      oldGone: !now.includes(display.id),
      newDisplay: now.length === 1 && now[0] !== display.id,
      landing: next.body.includes('<meta http-equiv="refresh" content="15">') && !next.body.includes("<iframe"),
      pageNamesNew: next.body.includes(`${emu.namespace}.clients.${now[0]}`),
    }).toEqual({ status: 200, newCookie: true, oldGone: true, newDisplay: true, landing: true, pageNamesNew: true });
  });

  it("ends the removed display's running WebSocket at its next frame", async () => {
    const { emu, server } = await adapterWithServer();
    const display = await signedInDisplay(emu, server);
    const ws = await webSocketTo(server);
    const required = await ws.next();
    ws.socket.send(JSON.stringify({ type: "auth", access_token: display.access }));
    const auth = await ws.next();
    const whileKnown = await ws.afterSend({ id: 1, type: "get_config" });

    await userWrites(emu, `clients.${display.id}.remove`, true);
    const afterRemove = await ws.afterSend({ id: 2, type: "get_config" });

    expect({ required: required.type, auth: auth.type, whileKnown }).toEqual({
      required: "auth_required",
      auth: "auth_ok",
      whileKnown: "answered",
    });
    expect({ afterRemove }).toEqual({ afterRemove: "closed" });
  });
});
