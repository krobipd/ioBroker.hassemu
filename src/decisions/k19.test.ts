/**
 * Guard K19 — when a foreign address wants the access code during sign-in, hassemu first shows a page with the button
 * "Continue"; without that question only the Home Assistant app and the address the request came from get it.
 *
 * The page, K19: "If at sign-in a foreign address wants the access code, hassemu first shows a page with the button
 * 'Continue'. Without asking, only the Home Assistant app and the address the request came from get it."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:56 ("k19 sounds ok").
 *
 * Path: the web server as main.ts starts it (plugins, peer guard, auth guard, routes, listener on a free port), asked
 * for /auth/authorize by inject from a display of its own network — GET without sign-in, POST with sign-in — over an
 * adapter whose object and state database lives in memory. The sign-in request comes from hassemu's own sign-in page
 * the display shows: it is sent from that page's address (Origin and Referer) to the same address (Host) — that is the
 * address the request came from. Page texts are the adapter's English texts, as adapter-core's I18n resolves a key.
 * The host carries one network (192.168.77.0/24); the data folder is a map in memory, since a guard writes no file.
 */

import type * as Os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@iobroker/adapter-core", async () => {
  const fs = await import("node:fs");
  /** The adapter's English texts, as adapter-core's I18n resolves a key. */
  const english = JSON.parse(fs.readFileSync(`${process.cwd()}/admin/i18n/en.json`, "utf8")) as Record<string, string>;
  return {
    I18n: {
      getTranslatedObject: (key: string) => ({ en: english[key] ?? key }),
      translate: (key: string) => english[key] ?? key,
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

import { ClientRegistry } from "../lib/client-registry";
import { GlobalConfig } from "../lib/global-config";
import type { AdapterConfig } from "../lib/types";
import { WebServer } from "../lib/webserver";

/** What a route answers. */
interface Answer {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}

/** An adapter over a database in memory. */
interface Memory {
  adapter: Record<string, unknown>;
  objects: Map<string, ioBroker.Object>;
}

const NS = "hassemu.0";
const DATA_DIR = "/guard/hassemu.0";
const PEER = "192.168.77.50";
/** The address of hassemu's own sign-in page, which sends the request — the address the request came from. */
const HOST = "192.168.77.10:8123";
const PASSWORD = "guard-secret";
const FOREIGN_CLIENT = "http://192.168.77.99:8080/";
const FOREIGN_TARGET = "http://192.168.77.99:8080/callback";
const OWN_CLIENT = `http://${HOST}/`;
const OWN_TARGET = `http://${HOST}/auth-done`;
const APP_TARGET = "homeassistant://auth-callback";
const servers: WebServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  files.clear();
});

/**
 * Merge a patch into an object the way js-controller's extendObject does: plain objects key by key, everything else
 * replaced.
 *
 * @param base the stored value
 * @param patch the patch
 */
function merged(base: unknown, patch: unknown): unknown {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(base) || !plain(patch)) {
    return structuredClone(patch);
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = merged(base[key], value);
  }
  return out;
}

/** An adapter whose database lives in memory. */
function memory(): Memory {
  const objects = new Map<string, ioBroker.Object>();
  const states = new Map<string, ioBroker.State>();
  const full = (id: string): string => (id.startsWith(`${NS}.`) ? id : `${NS}.${id}`);
  const noop = (): void => undefined;
  const adapter: Record<string, unknown> = {
    namespace: NS,
    log: { silly: noop, debug: noop, info: noop, warn: noop, error: noop, level: "info" },
    setInterval: () => ({}),
    clearInterval: noop,
    setTimeout: () => undefined,
    clearTimeout: noop,
    getForeignObjectsAsync(pattern: string, type?: string) {
      const prefix = pattern.replace(/\*$/, "");
      const wanted = type ?? "state";
      const found = [...objects].filter(([id, obj]) => id.startsWith(prefix) && obj.type === wanted);
      return Promise.resolve(structuredClone(Object.fromEntries(found)));
    },
    getForeignObjectAsync: (id: string) => Promise.resolve(structuredClone(objects.get(id) ?? null)),
    getAdapterObjectsAsync: () =>
      Promise.resolve(structuredClone(Object.fromEntries([...objects].filter(([id]) => id.startsWith(`${NS}.`))))),
    getObjectAsync: (id: string) => Promise.resolve(structuredClone(objects.get(full(id)) ?? null)),
    getStateAsync: (id: string) => Promise.resolve(structuredClone(states.get(full(id)) ?? null)),
    getStatesAsync: (pattern: string) => {
      // js-controller 7.2.5 getStates: every state object below the pattern, with its value or null.
      const prefix = full(pattern.replace(/\*/g, ""));
      const found: Record<string, ioBroker.State | null> = {};
      for (const [id, obj] of objects) {
        if (obj.type === "state" && id.startsWith(prefix)) {
          found[id] = structuredClone(states.get(id) ?? null);
        }
      }
      return Promise.resolve(found);
    },
    setObjectNotExistsAsync(id: string, obj: ioBroker.Object) {
      if (!objects.has(full(id))) {
        objects.set(full(id), { ...structuredClone(obj), _id: full(id) } as ioBroker.Object);
      }
      return Promise.resolve({ id: full(id) });
    },
    extendObject(id: string, patch: Partial<ioBroker.Object>) {
      objects.set(full(id), {
        ...(merged(objects.get(full(id)) ?? {}, patch) as object),
        _id: full(id),
      } as ioBroker.Object);
      return Promise.resolve({ id: full(id) });
    },
    setState(id: string, state: ioBroker.SettableState) {
      states.set(full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve(full(id));
    },
    setStateChangedAsync(id: string, state: ioBroker.SettableState) {
      const before = states.get(full(id));
      const value = (state as ioBroker.State).val;
      if (before && before.val === value && before.ack === ((state as ioBroker.State).ack ?? false)) {
        return Promise.resolve({ id: full(id), notChanged: true });
      }
      states.set(full(id), { ...(state as ioBroker.State), ts: Date.now(), lc: Date.now() });
      return Promise.resolve({ id: full(id), notChanged: false });
    },
  };
  return { adapter, objects };
}

/**
 * The web server as main.ts starts it.
 *
 * @param mem the adapter
 * @param authRequired whether the display signs in with user name and password
 */
async function started(mem: Memory, authRequired: boolean): Promise<WebServer> {
  const registry = new ClientRegistry(mem.adapter as never, DATA_DIR);
  await registry.restore();
  const global = new GlobalConfig(mem.adapter as never);
  const config: AdapterConfig = {
    port: 0,
    bind: "0.0.0.0",
    authRequired,
    username: "admin",
    password: PASSWORD,
    mdnsEnabled: false,
    serviceName: "ioBroker",
  };
  const server = new WebServer(mem.adapter as never, config, registry, global, registry.serverUuid, "en", () =>
    Promise.resolve(true),
  );
  servers.push(server);
  await server.start();
  return server;
}

/**
 * The authorize request a display's browser sends, on the Host it reaches hassemu by.
 *
 * @param server the server
 * @param method GET (no sign-in) or POST (the sign-in form)
 * @param clientId the OAuth2 client_id
 * @param redirectUri the OAuth2 redirect_uri the code goes to
 */
function authorize(server: WebServer, method: "GET" | "POST", clientId: string, redirectUri: string): Promise<Answer> {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "s1",
  };
  const headers: Record<string, string> = {
    host: HOST,
    origin: `http://${HOST}`,
    referer: `http://${HOST}/`,
    "user-agent": "Mozilla/5.0 (Linux; Android 13; WebView)",
  };
  if (method === "GET") {
    return server.inject({
      method,
      url: `/auth/authorize?${new URLSearchParams(params).toString()}`,
      headers,
      remoteAddress: PEER,
    });
  }
  headers["content-type"] = "application/x-www-form-urlencoded";
  return server.inject({
    method,
    url: "/auth/authorize",
    headers,
    payload: new URLSearchParams({ ...params, username: "admin", password: PASSWORD }).toString(),
    remoteAddress: PEER,
  });
}

/** How an authorize answer treats the access code. */
interface Handover {
  /** The page shows a button "Continue". */
  continueButton: boolean;
  /** The answer hands the code to the target without a button: a forwarding to it that is no button's link. */
  handedOver: boolean;
}

/**
 * Read from an authorize answer whether it asks with a "Continue" button or hands the code to the target by itself.
 *
 * @param answer the answer
 * @param target the redirect_uri the code goes to
 */
function handover(answer: Answer, target: string): Handover {
  const body = answer.body.replace(/&amp;/g, "&");
  const buttons = [...body.matchAll(/<a class="button" href="([^"]*)">([^<]*)<\/a>/g)];
  const withCode = `${target}?code=`;
  const location = typeof answer.headers.location === "string" ? answer.headers.location : "";
  const outsideButtons = buttons.reduce((rest, b) => rest.replace(b[0], ""), body);
  return {
    continueButton: buttons.some(b => b[2] === "Continue"),
    handedOver: location.startsWith(withCode) || outsideButtons.includes(withCode),
  };
}

describe("K19: the access code and a foreign address", () => {
  it("a foreign address that wants the access code first gets a page with the button 'Continue' — without and with sign-in", async () => {
    const open = await started(memory(), false);
    const signIn = await started(memory(), true);

    const withoutSignIn = handover(await authorize(open, "GET", FOREIGN_CLIENT, FOREIGN_TARGET), FOREIGN_TARGET);
    const afterSignIn = handover(await authorize(signIn, "POST", FOREIGN_CLIENT, FOREIGN_TARGET), FOREIGN_TARGET);

    expect({ withoutSignIn, afterSignIn }).toEqual({
      withoutSignIn: { continueButton: true, handedOver: false },
      afterSignIn: { continueButton: true, handedOver: false },
    });
  });

  it("the Home Assistant app gets the access code without the question", async () => {
    const open = await started(memory(), false);
    const signIn = await started(memory(), true);

    const android = handover(await authorize(open, "GET", "https://home-assistant.io/android", APP_TARGET), APP_TARGET);
    const ios = handover(await authorize(open, "GET", "https://home-assistant.io/iOS", APP_TARGET), APP_TARGET);
    const afterSignIn = handover(
      await authorize(signIn, "POST", "https://home-assistant.io/android", APP_TARGET),
      APP_TARGET,
    );

    expect({ android, ios, afterSignIn }).toEqual({
      android: { continueButton: false, handedOver: true },
      ios: { continueButton: false, handedOver: true },
      afterSignIn: { continueButton: false, handedOver: true },
    });
  });

  it("the address the request came from gets the access code without the question", async () => {
    const open = await started(memory(), false);
    const signIn = await started(memory(), true);

    const withoutSignIn = handover(await authorize(open, "GET", OWN_CLIENT, OWN_TARGET), OWN_TARGET);
    const afterSignIn = handover(await authorize(signIn, "POST", OWN_CLIENT, OWN_TARGET), OWN_TARGET);

    expect({ withoutSignIn, afterSignIn }).toEqual({
      withoutSignIn: { continueButton: false, handedOver: true },
      afterSignIn: { continueButton: false, handedOver: true },
    });
  });
});
