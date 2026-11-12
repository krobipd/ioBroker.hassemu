/**
 * Guard K4 — HTTP stays the default, HTTPS is an option with a certificate from ioBroker.
 *
 * The page, K4: "HTTP stays the default, HTTPS as an option." "In the settings HTTPS can be switched on, with a
 * certificate from ioBroker. Without this choice everything stays as it is today. With HTTPS hassemu announces a name
 * on the network instead of the IP address, because a certificate is valid for a name."
 * Accepted by krobi with the page of hassemu's core decisions (version 30) on 2026-11-11 19:31 ("k3 and k4 absolutely
 * ok").
 *
 * Path: the adapter class from main.ts, started through the ready handler its constructor registers, over an adapter
 * whose object and state database lives in memory and whose certificate read answers like the controller with a
 * certificate inlined here (a self-signed test certificate for hassemu.guard.lan; its dates are never judged). The
 * server listens on a free port found at runtime and is asked over a real socket (plain HTTP or a TLS handshake) and
 * by inject from a peer address; the mDNS announcement is recorded by a stand-in for bonjour-service, so nothing goes
 * out on the network. The host carries one network (192.168.77.0/24); the data folder is a map in memory, since a
 * guard writes no file.
 */

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import type * as Os from "node:os";
import type { TLSSocket } from "node:tls";
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
    /** The named certificates the controller hands out; `null`: none configured. */
    certificates: { key: string; cert: string } | null = null;
    /** The names every certificate read asked for. */
    certificateReads: unknown[][] = [];
    // Like js-controller's certificate read: `[certificates, leConfigured]`, or "Not exists" when none is configured.
    getCertificatesAsync(...names: unknown[]): Promise<unknown> {
      this.certificateReads.push(names);
      return this.certificates ? Promise.resolve([this.certificates, false]) : Promise.reject(new Error("Not exists"));
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
  config: AdapterConfig;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  states: Map<string, ioBroker.State>;
  errors: string[];
  terminations: unknown[];
  certificates: { key: string; cert: string } | null;
  certificateReads: unknown[][];
  webServer: WebServer | null;
}

/** What a real socket brought back: the HTTP status and, over TLS, the certificate the server presented. */
interface OnTheWire {
  status: number | null;
  fingerprint: string | null;
  error: string | null;
}

// A self-signed test certificate (EC P-256) for the name hassemu.guard.lan, made for this guard only.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgetCpeoZRnmkYeeeb
jKorhl8Q5yZjiX3dwRFJsgR5GlChRANCAAShYh/hEEhL7+OfhWaYkOgOKHZXhmM2
rmMx0bbAg/2TTrRaFIdl8LYmMmKLjKXn0CM+Xc0uWIYTFlTd8YaLUOSv
-----END PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUA60MGvgq4uAD1huhvtmrqImmwDAwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRaGFzc2VtdS5ndWFyZC5sYW4wIBcNMjYxMTEyMTcxNTAzWhgP
MjEyNjEwMTkxNzE1MDNaMBwxGjAYBgNVBAMMEWhhc3NlbXUuZ3VhcmQubGFuMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEoWIf4RBIS+/jn4VmmJDoDih2V4ZjNq5j
MdG2wIP9k060WhSHZfC2JjJii4yl59AjPl3NLliGExZU3fGGi1Dkr6N3MHUwHQYD
VR0OBBYEFCCzF9Mrw6pkq/zD8nS1BRIYOFEcMB8GA1UdIwQYMBaAFCCzF9Mrw6pk
q/zD8nS1BRIYOFEcMA8GA1UdEwEB/wQFMAMBAf8wIgYDVR0RBBswGYIRaGFzc2Vt
dS5ndWFyZC5sYW6HBMCoTQowCgYIKoZIzj0EAwIDSAAwRQIhALRKPvkcoAlANYIx
QunLm8QWF3uksT/QcA+EGZLzZHV/AiBoA+cg8YEHfdbdpGZ/7oqe6QvgEFJg2RVe
6tDj+h/4XQ==
-----END CERTIFICATE-----
`;
const CERT_NAME = "hassemu.guard.lan";

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

/**
 * The adapter started through its ready handler, with the defaults of the instance settings plus these.
 *
 * @param port the port of the instance settings
 * @param extra the settings that differ from the defaults
 * @param certificates the named certificates the controller hands out
 */
async function startedWith(
  port: number,
  extra: Partial<AdapterConfig>,
  certificates: { key: string; cert: string } | null,
): Promise<Emu> {
  const emu = new HassEmu() as unknown as Emu;
  const native = rootJson("io-package.json").native as Record<string, unknown>;
  emu.config = { ...(native as unknown as AdapterConfig), port, mdnsEnabled: true, ...extra };
  emu.certificates = certificates;
  started.push(emu);
  await emu.handlers.get("ready")?.();
  return emu;
}

/**
 * One request over a real socket — plain HTTP, or HTTPS with a TLS handshake that takes any certificate and reports
 * the one it got; a failed connection or handshake is an answer too.
 *
 * @param scheme "http" or "https"
 * @param port the port to connect to
 */
function overSocket(scheme: "http" | "https", port: number): Promise<OnTheWire> {
  return new Promise(resolve => {
    const options = { host: "127.0.0.1", port, path: "/api/", method: "GET", agent: false };
    const onAnswer = (res: http.IncomingMessage): void => {
      res.resume();
      const socket = res.socket as Partial<TLSSocket>;
      const fingerprint =
        typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate().fingerprint256 : null;
      resolve({ status: res.statusCode ?? null, fingerprint: fingerprint ?? null, error: null });
    };
    const req =
      scheme === "https"
        ? https.request({ ...options, servername: CERT_NAME, rejectUnauthorized: false }, onAnswer)
        : http.request(options, onAnswer);
    req.on("error", (err: NodeJS.ErrnoException) =>
      resolve({ status: null, fingerprint: null, error: err.code ?? "error" }),
    );
    req.end();
  });
}

/**
 * What the running server answers on /api/discovery_info, asked by inject from a display of the network.
 *
 * @param emu the started adapter
 */
async function discoveryInfo(emu: Emu): Promise<{ base_url?: unknown; internal_url?: unknown }> {
  const answer = await emu.webServer?.inject({
    method: "GET",
    url: "/api/discovery_info",
    remoteAddress: "192.168.77.50",
  });
  return answer?.json() ?? {};
}

/**
 * A JSON file of the adapter root, read as data.
 *
 * @param name the file name
 */
function rootJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), name), "utf8")) as Record<string, unknown>;
}

describe("K4: HTTP stays the default, HTTPS is an option with a certificate from ioBroker", () => {
  it("offers HTTPS in the settings, switched off by default, with ioBroker's certificate choice", () => {
    const native = rootJson("io-package.json").native as Record<string, unknown>;
    const items = (rootJson(join("admin", "jsonConfig.json")) as { items: Record<string, Record<string, unknown>> })
      .items;

    expect({ secure: native.secure }).toEqual({ secure: false });
    expect({
      field: items.secure?.type,
      fieldDefault: items.secure?.default,
      certificateChoice: Object.values(items).some(item => item.type === "certificates"),
    }).toEqual({ field: "checkbox", fieldDefault: false, certificateChoice: true });
  });

  it("without the choice speaks plain HTTP, announces the IP address and asks for no certificate", async () => {
    const port = await freePort();
    const emu = await startedWith(port, {}, { key: KEY, cert: CERT });
    const plain = await overSocket("http", port);
    const tls = await overSocket("https", port);
    const info = await discoveryInfo(emu);

    expect({
      running: emu.states.get(`${emu.namespace}.info.connection`)?.val,
      errors: emu.errors,
      terminations: emu.terminations,
    }).toEqual({ running: true, errors: [], terminations: [] });
    expect({
      plainAnswers: typeof plain.status === "number",
      tlsHandshake: typeof tls.status === "number",
      certificateReads: emu.certificateReads,
    }).toEqual({ plainAnswers: true, tlsHandshake: false, certificateReads: [] });
    expect({ base: info.base_url, internal: info.internal_url, announced: announced.map(a => a.txt.base_url) }).toEqual(
      {
        base: `http://192.168.77.10:${port}`,
        internal: `http://192.168.77.10:${port}`,
        announced: [`http://192.168.77.10:${port}`],
      },
    );
  });

  it("with the choice serves HTTPS with the certificate from ioBroker and announces its name instead of the IP", async () => {
    const port = await freePort();
    const emu = await startedWith(
      port,
      { secure: true, certPublic: "guardPublic", certPrivate: "guardPrivate" },
      { key: KEY, cert: CERT },
    );
    const tls = await overSocket("https", port);
    const info = await discoveryInfo(emu);

    expect({
      running: emu.states.get(`${emu.namespace}.info.connection`)?.val,
      errors: emu.errors,
      terminations: emu.terminations,
      certificateReads: emu.certificateReads.map(names => names.slice(0, 2)),
    }).toEqual({ running: true, errors: [], terminations: [], certificateReads: [["guardPublic", "guardPrivate"]] });
    expect({ tlsAnswers: typeof tls.status === "number", presented: tls.fingerprint }).toEqual({
      tlsAnswers: true,
      presented: new X509Certificate(CERT).fingerprint256,
    });
    expect({ base: info.base_url, internal: info.internal_url, announced: announced.map(a => a.txt.base_url) }).toEqual(
      {
        base: `https://${CERT_NAME}:${port}`,
        internal: `https://${CERT_NAME}:${port}`,
        announced: [`https://${CERT_NAME}:${port}`],
      },
    );
  });
});
