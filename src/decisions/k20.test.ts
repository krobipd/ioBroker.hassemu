/**
 * Guard K20 — when the user removes a display (button "Remove this display"), its running connection ends at once; at
 * its next request it appears as a new display with the start page.
 *
 * The page, K20: "If you remove a display (button 'Remove this display'), its running connection ends at once. On its
 * next request it shows up as a new display with the landing page."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:56 ("k20 sure").
 *
 * Path: the adapter class from main.ts, its stateChange handler as the constructor registers it (the remove button
 * and the display's mode are user writes), over an adapter whose object and state database lives in memory; the
 * registry and the global settings are the adapter's own, the new-display mode is wired as main.ts wires it, and the
 * web server as main.ts starts it runs on the same adapter and registry. HTTP requests by inject from a peer address
 * of the own network, the WebSocket over a real socket on a free port of this machine; the start page is the page the
 * product renders for a display without a target (`renderLandingPage`). The host carries two networks
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

vi.mock("@iobroker/adapter-core", async () => {
  const { FakeAdapter } = await import("../lib/adapter-fake.js");
  const noop = (): void => undefined;
  /** The adapter base class: the fleet's fake adapter over a database in memory, plus what hassemu itself calls. */
  class Adapter extends FakeAdapter {
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    states = new Map<string, ioBroker.State>();
    log = { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: "info" };
    on(event: string, handler: (...args: never[]) => unknown): this {
      this.handlers.set(event, handler as (...args: unknown[]) => unknown);
      return this;
    }
    setInterval(): object {
      return {};
    }
    clearInterval(): void {}
    getObjectAsync(id: string): Promise<Record<string, unknown> | null> {
      return Promise.resolve(structuredClone(this.objects.get(this.full(id)) ?? null));
    }
    getAdapterObjectsAsync(): Promise<Record<string, Record<string, unknown>>> {
      const own = [...this.objects].filter(([id]) => id.startsWith(`${this.namespace}.`));
      return Promise.resolve(structuredClone(Object.fromEntries(own)));
    }
    setObjectNotExistsAsync(id: string, obj: ioBroker.Object): Promise<{ id: string }> {
      if (!this.objects.has(this.full(id))) {
        this.objects.set(this.full(id), { ...structuredClone(obj), _id: this.full(id) });
      }
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
import { renderLandingPage } from "../lib/landing-page";
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

/** A display that signed in: its id and the access token it opens a WebSocket with. */
interface SignedIn {
  id: string;
  access: string;
}

const { HassEmu } = mainModule as unknown as { HassEmu: new () => ioBroker.Adapter };

const PEER = "192.168.77.50";
const NS = "hassemu.0";
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
 * @param extra cookie, form body
 * @param extra.cookie the display's cookie header
 * @param extra.form a form body
 */
function ask(
  server: WebServer,
  method: "GET" | "POST",
  url: string,
  extra: { cookie?: string; form?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)" };
  if (extra.cookie) {
    headers.cookie = extra.cookie;
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
  ).json() as { access_token?: string };
  return { id, access: tokens.access_token ?? "" };
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
  closedWithin: (ms: number) => Promise<"closed" | "open">;
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
  let closed = false;
  socket.addEventListener("close", () => {
    closed = true;
  });
  const closedWithin = (ms: number): Promise<"closed" | "open"> =>
    new Promise(resolve => {
      if (closed) {
        resolve("closed");
        return;
      }
      const timer = setTimeout(() => resolve("open"), ms);
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve("closed");
      });
    });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("WebSocket did not open")));
  });
  return { socket, next, afterSend, closedWithin };
}

describe("K20: removing a display", () => {
  it("ends its running connection at once", async () => {
    const { emu, server } = await adapterWithServer();
    const display = await signedInDisplay(emu, server);
    const ws = await webSocketTo(server);
    const required = await ws.next();
    ws.socket.send(JSON.stringify({ type: "auth", access_token: display.access }));
    const auth = await ws.next();
    const whileKnown = await ws.afterSend({ id: 1, type: "get_config" });

    await userWrites(emu, `clients.${display.id}.remove`, true);
    const afterRemove = await ws.closedWithin(1000);

    expect({ required: required.type, auth: auth.type, whileKnown }).toEqual({
      required: "auth_required",
      auth: "auth_ok",
      whileKnown: "answered",
    });
    expect({ afterRemove }).toEqual({ afterRemove: "closed" });
  });

  it("at its next request it appears as a new display with the start page", async () => {
    const { emu, server } = await adapterWithServer();
    const cookie = cookieOf(await ask(server, "GET", "/"));
    const [id] = displays(emu);
    await userWrites(emu, `clients.${id}.mode`, TARGET);
    const before = await ask(server, "GET", "/", { cookie });

    await userWrites(emu, `clients.${id}.remove`, true);
    const next = await ask(server, "GET", "/", { cookie });
    const nextCookie = cookieOf(next);
    const now = displays(emu);

    expect({ known: cookie !== "" && id !== undefined, onItsTarget: before.body !== startPage(id) }).toEqual({
      known: true,
      onItsTarget: true,
    });
    expect({
      newCookie: nextCookie !== "" && nextCookie !== cookie,
      newDisplay: now.length === 1 && now[0] !== id,
      startPage: now.length === 1 && next.body === startPage(now[0]),
    }).toEqual({ newCookie: true, newDisplay: true, startPage: true });
  });
});

/**
 * The start page the product renders for a display without a target, as the server renders it for the display's
 * address.
 *
 * @param id the display id
 */
function startPage(id: string): string {
  return renderLandingPage(id, NS, "en", PEER);
}
