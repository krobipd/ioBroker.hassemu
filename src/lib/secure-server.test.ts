// Fleet master — the release run requires this file byte for byte in every adapter that carries it; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { generateKeyPairSync, sign } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";
import {
  CERTIFICATES_OBJECT_ID,
  certificateName,
  certificateNames,
  collectionChoice,
  createOwnServer,
  loadCertificates,
  type ObjectChangeListener,
  type SecureServerAdapter,
  type SecureSettings,
  selectCollections,
} from "./secure-server";
import { SettingsError } from "./start-failure";

// Certificates made while the test runs — no key material is kept in the repository.

/** A certificate with its key (PEM). */
interface KeyPair {
  /** The private key. */
  key: string;
  /** The certificate. */
  cert: string;
}

/**
 * One DER element.
 *
 * @param tag the tag byte
 * @param parts the content
 */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

/**
 * An object identifier.
 *
 * @param dotted the identifier in dotted form
 */
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) {
      chunk.unshift((v & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

/**
 * A UTC time.
 *
 * @param date the moment
 */
function utcTime(date: Date): Buffer {
  return der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
}

/**
 * A self-signed certificate (EC P-256, ECDSA with SHA-256) for a common name and DNS names.
 *
 * @param cn the common name
 * @param dns the DNS names (subject alternative names)
 */
function selfSigned(cn: string, dns: string[] = []): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = der(0x30, oid("1.2.840.10045.4.3.2"));
  const name = der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))));
  const now = Date.now();
  const validity = der(0x30, utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000)));
  const altNames = der(0x30, ...dns.map(d => der(0x82, Buffer.from(d))));
  const extensions = dns.length ? [der(0xa3, der(0x30, der(0x30, oid("2.5.29.17"), der(0x04, altNames))))] : [];
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ type: "spki", format: "der" }),
    ...extensions,
  );
  const signed = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const body = signed.toString("base64").replace(/.{64}/g, "$&\n");
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`.replace("\n\n", "\n"),
  };
}

const NAMED = selfSigned("iobroker-host", ["iobroker-host", "*.lan"]);
const OTHER = selfSigned("other-host");
const LE = selfSigned("le.example.org", ["le.example.org"]);
const WILD = selfSigned("*.example.net", ["*.example.net"]);
const RENEWED = selfSigned("le.example.org", ["le.example.org", "renewed.example.org"]);
const HELD = { defaultPublic: "a", defaultPrivate: "b", ownPublic: "c", ownPrivate: "d", ownChain: "e" };

/**
 * A collection as the acme adapter writes it.
 *
 * @param pair the certificate and its key
 * @param domains the names it is valid for
 * @param chain the issuers, if any
 */
function collection(pair: KeyPair, domains: string[], chain?: unknown): Record<string, unknown> {
  return { key: pair.key, cert: pair.cert, domains, ...(chain === undefined ? {} : { chain }) };
}

/**
 * An adapter whose controller holds `held` and the collections, and answers the certificate read with `answer`; every
 * call lands in `calls`, the `objectChange` listeners in `listeners`.
 *
 * @param config the instance settings
 * @param opts what the controller holds and answers
 * @param opts.held the named certificates `system.certificates` holds, or `null` when the object is missing
 * @param opts.collections the collections it holds
 * @param opts.answer what `getCertificatesAsync` resolves with
 */
function fakeAdapter(
  config: SecureSettings,
  opts: { held?: Record<string, unknown> | null; collections?: Record<string, unknown>; answer?: unknown } = {},
): { calls: string[]; listeners: ObjectChangeListener[]; adapter: SecureServerAdapter } {
  const calls: string[] = [];
  const listeners: ObjectChangeListener[] = [];
  const held = opts.held === undefined ? HELD : opts.held;
  const answer = "answer" in opts ? opts.answer : [NAMED, false];
  const adapter: SecureServerAdapter = {
    config,
    log: {
      warn: message => {
        calls.push(`warn ${message}`);
      },
    },
    getCertificatesAsync: (publicName, privateName, chainedName) => {
      calls.push(`certificates ${publicName} ${privateName} ${chainedName}`);
      // Round 179 (R179-11): like js-controller-adapter 7.2.5 getCertificates — an empty name falls back to the
      // setting, and what it then holds must be a text (Validator.assertString)
      const used = [publicName || config.certPublic, privateName || config.certPrivate];
      const wrong = [...used, chainedName || config.certChained].find(
        value => value !== undefined && typeof value !== "string",
      );
      return wrong === undefined
        ? Promise.resolve(answer)
        : Promise.reject(new Error(`a name needs to be of type "string" but type "${typeof wrong}" has been passed`));
    },
    getForeignObjectAsync: id => {
      calls.push(`object ${id}`);
      return Promise.resolve(
        held === null ? null : structuredClone({ native: { certificates: held, collections: opts.collections ?? {} } }),
      );
    },
    subscribeForeignObjectsAsync: pattern => {
      calls.push(`subscribe ${pattern}`);
      return Promise.resolve();
    },
    on: (event, listener) => {
      calls.push(`on ${event}`);
      listeners.push(listener);
    },
  };
  return { calls, listeners, adapter };
}

/**
 * The common name of the certificate a server presents for a name.
 *
 * @param server the listening server
 * @param servername the name the client asks for
 */
function presented(server: http.Server | https.Server, servername: string): Promise<string | undefined> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }, () => {
      const cn = socket.getPeerCertificate().subject?.CN;
      socket.end();
      resolve(Array.isArray(cn) ? cn[0] : cn);
    });
    socket.on("error", reject);
  });
}

/**
 * Starts a server on a free loopback port.
 *
 * @param server the server
 */
function listening(server: http.Server | https.Server): Promise<void> {
  return new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
}

describe("loadCertificates — HTTPS is an option of the user", () => {
  it("HTTPS off: no certificate and no call to the controller", async () => {
    const { calls, adapter } = fakeAdapter({ secure: false, certPublic: "ownPublic", leCollection: true });
    expect(await loadCertificates(adapter)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("only `true` switches it on — a text or a number leaves it off", async () => {
    for (const secure of ["true", 1, undefined, null]) {
      const { calls, adapter } = fakeAdapter({ secure });
      expect(await loadCertificates(adapter)).toBeUndefined();
      expect(calls).toEqual([]);
    }
  });

  it("without a choice it takes ioBroker's own pair, checked first, then read through the controller", async () => {
    const { calls, adapter } = fakeAdapter({ secure: true, certPublic: "", certPrivate: "  " });
    const setup = await loadCertificates(adapter);
    expect(setup?.options).toMatchObject({ key: NAMED.key, cert: NAMED.cert });
    expect(setup?.options.ca).toBeUndefined();
    expect(setup?.name).toBe("iobroker-host");
    // no collection chosen: nothing subscribed
    expect(calls).toEqual([`object ${CERTIFICATES_OBJECT_ID}`, "certificates defaultPublic defaultPrivate undefined"]);
  });

  it("the chosen certificate with its chain", async () => {
    const { calls, adapter } = fakeAdapter(
      { secure: true, certPublic: "ownPublic", certPrivate: "ownPrivate", certChained: "ownChain" },
      { answer: [{ ...NAMED, ca: NAMED.cert }, false] },
    );
    const setup = await loadCertificates(adapter);
    expect(setup?.options.ca).toBe(NAMED.cert);
    expect(calls[1]).toBe("certificates ownPublic ownPrivate ownChain");
  });

  it("a chain setting that names no certificate is a settings error — the controller is not asked", async () => {
    for (const certChained of [null, 5, "  ", {}]) {
      const { calls, adapter } = fakeAdapter({ secure: true, certChained });
      const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SettingsError);
      expect((err as Error).message).toBe(
        "HTTPS is on, but the setting of the chained certificate names none — choose one under Certificates or none",
      );
      expect(calls).toEqual([]);
    }
    // admin stores "" for none: no chain, ioBroker's own pair
    const { calls, adapter } = fakeAdapter({ secure: true, certChained: "" });
    expect((await loadCertificates(adapter))?.options.ca).toBeUndefined();
    expect(calls[1]).toBe("certificates defaultPublic defaultPrivate undefined");
  });

  it("an empty chain in the answer is no chain", async () => {
    const { adapter } = fakeAdapter({ secure: true }, { answer: [{ ...NAMED, ca: "" }, false] });
    expect((await loadCertificates(adapter))?.options.ca).toBeUndefined();
  });

  it("a name ioBroker does not hold is a settings error — the controller is not asked", async () => {
    const { calls, adapter } = fakeAdapter({ secure: true, certPublic: "gone", certChained: "goneToo" });
    const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as Error).message).toBe(
      'HTTPS is on, but ioBroker holds no certificate "gone", "goneToo" — choose one under Certificates or switch HTTPS off',
    );
    expect(calls).toEqual([`object ${CERTIFICATES_OBJECT_ID}`]);
  });

  it("one name ioBroker does not hold is a settings error on its own", async () => {
    const { calls, adapter } = fakeAdapter({ secure: true, certPrivate: "gone" });
    const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as Error).message).toBe(
      'HTTPS is on, but ioBroker holds no certificate "gone" — choose one under Certificates or switch HTTPS off',
    );
    expect(calls).toEqual([`object ${CERTIFICATES_OBJECT_ID}`]);
  });

  it("an empty or non-text entry counts as not held", async () => {
    const { adapter } = fakeAdapter({ secure: true }, { held: { defaultPublic: "", defaultPrivate: 7 } });
    const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as Error).message).toContain('"defaultPublic", "defaultPrivate"');
  });

  it("no certificate object at all is a settings error too", async () => {
    const { calls, adapter } = fakeAdapter({ secure: true }, { held: null });
    await expect(loadCertificates(adapter)).rejects.toBeInstanceOf(SettingsError);
    expect(calls).toEqual([`object ${CERTIFICATES_OBJECT_ID}`]);
  });

  it("an answer the controller could not fill ends the start as an error, never as a settings error", async () => {
    const answers = [null, NAMED, [], [null, false], [{ key: NAMED.key }, false], [{ key: 1, cert: NAMED.cert }]];
    for (const answer of answers) {
      const { adapter } = fakeAdapter({ secure: true }, { answer });
      const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SettingsError);
      expect((err as Error).message).toBe("the controller handed over no usable certificate");
    }
  });

  it("a certificate TLS cannot use ends the start as an error — never a fall back to HTTP", async () => {
    const { adapter } = fakeAdapter({ secure: true }, { answer: [{ key: OTHER.key, cert: NAMED.cert }, false] });
    const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SettingsError);
  });

  it("a chosen collection subscribes its renewals; its first name is the server's name", async () => {
    const { calls, listeners, adapter } = fakeAdapter(
      { secure: true, leCollection: "le" },
      { collections: { le: collection(LE, ["*.example.org", "le.example.org"]) } },
    );
    const setup = await loadCertificates(adapter);
    expect(setup?.name).toBe("le.example.org");
    expect(calls.slice(2)).toEqual(["on objectChange", `subscribe ${CERTIFICATES_OBJECT_ID}`]);
    expect(listeners).toHaveLength(1);
  });

  it("a chosen collection that is missing ends the start as an error, not as a settings error", async () => {
    const { adapter } = fakeAdapter({ secure: true, leCollection: "gone" });
    const err: unknown = await loadCertificates(adapter).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SettingsError);
    expect((err as Error).message).toBe('the certificate collection "gone" is missing or holds no usable certificate');
  });
});

describe("the server presents the certificate for the name the client asks for", () => {
  const servers: (http.Server | https.Server)[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  it("a collection for its names, a wildcard one, the named certificate for every other name", async () => {
    const { adapter } = fakeAdapter(
      { secure: true, leCollection: true },
      { collections: { le: collection(LE, ["le.example.org"]), wild: collection(WILD, ["*.example.net"]) } },
    );
    const server = createOwnServer(await loadCertificates(adapter), {});
    servers.push(server);
    await listening(server);
    expect(await presented(server, "le.example.org")).toBe("le.example.org");
    expect(await presented(server, "a.example.net")).toBe("*.example.net");
    expect(await presented(server, "elsewhere.example.com")).toBe("iobroker-host");
    expect(await presented(server, "nodots")).toBe("iobroker-host");
  });

  it("a renewed collection reaches the running server; one that turns unusable keeps the previous with a warning", async () => {
    const { calls, listeners, adapter } = fakeAdapter(
      { secure: true, leCollection: "le" },
      { collections: { le: collection(LE, ["le.example.org"]) } },
    );
    const server = createOwnServer(await loadCertificates(adapter), {});
    servers.push(server);
    await listening(server);
    expect(await presented(server, "renewed.example.org")).toBe("iobroker-host");
    const renewal = { native: { collections: { le: collection(RENEWED, ["le.example.org", "renewed.example.org"]) } } };
    listeners[0]("system.adapter.other.0", null);
    expect(await presented(server, "renewed.example.org")).toBe("iobroker-host");
    listeners[0](CERTIFICATES_OBJECT_ID, renewal);
    expect(await presented(server, "renewed.example.org")).toBe("le.example.org");
    listeners[0](CERTIFICATES_OBJECT_ID, null);
    expect(calls.at(-1)).toBe(
      'warn The certificate collections changed and cannot be used: the certificate collection "le" is missing or holds no usable certificate — the server keeps the previous ones',
    );
    expect(await presented(server, "renewed.example.org")).toBe("le.example.org");
  });

  it("every collection: one that is gone after a renewal leaves the named certificate for its names", async () => {
    const { listeners, adapter } = fakeAdapter(
      { secure: true, leCollection: true },
      { collections: { le: collection(LE, ["le.example.org"]) } },
    );
    const server = createOwnServer(await loadCertificates(adapter), {});
    servers.push(server);
    await listening(server);
    listeners[0](CERTIFICATES_OBJECT_ID, { native: { collections: {} } });
    expect(await presented(server, "le.example.org")).toBe("iobroker-host");
  });
});

describe("selectCollections", () => {
  it("puts the leaf first and takes its issuers without the leaf again — from a text or an array", () => {
    const native = {
      collections: {
        text: collection(LE, ["le.example.org"], `${LE.cert}${OTHER.cert}`),
        list: collection(LE, ["le.example.org"], [OTHER.cert, 7]),
      },
    };
    for (const id of ["text", "list"]) {
      const cert = selectCollections(native, id).get(id)?.cert ?? "";
      expect(cert.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
      expect(cert.indexOf(LE.cert.trim())).toBe(0);
      expect(cert).toContain(OTHER.cert.trim());
    }
  });

  it("`every one` skips an unusable collection; a chosen id that is unusable throws", () => {
    const native = {
      collections: {
        good: { ...collection(LE, ["le.example.org"]), domains: ["le.example.org", "", 3] },
        noDomains: collection(LE, []),
        noCert: { key: LE.key, cert: "none", domains: ["x.example.org"] },
        noKey: { cert: LE.cert, domains: ["y.example.org"] },
        notAnObject: "text",
      },
    };
    const every = selectCollections(native, true);
    expect([...every.keys()]).toEqual(["good"]);
    expect(every.get("good")?.domains).toEqual(["le.example.org"]);
    for (const id of ["noDomains", "noCert", "noKey", "notAnObject"]) {
      expect(() => selectCollections(native, id)).toThrow(`the certificate collection "${id}"`);
    }
    expect(selectCollections(native, false).size).toBe(0);
    expect(selectCollections(undefined, true).size).toBe(0);
    expect(selectCollections({ collections: [] }, true).size).toBe(0);
    // a list is no map of collections, not even with a usable collection at its first place
    expect(() => selectCollections({ collections: [collection(LE, ["le.example.org"])] }, "0")).toThrow(
      `the certificate collection "0"`,
    );
  });
});

describe("the settings", () => {
  it("certificateNames trims the names and takes the default for a missing or non-text one", () => {
    expect(certificateNames({ certPublic: " ownPublic ", certPrivate: 3, certChained: "" })).toEqual({
      publicName: "ownPublic",
      privateName: "defaultPrivate",
    });
    expect(certificateNames({ certChained: " ownChain " })).toEqual({
      publicName: "defaultPublic",
      privateName: "defaultPrivate",
      chainedName: "ownChain",
    });
  });

  it("collectionChoice: `true` every one, a text one id, anything else none", () => {
    expect(collectionChoice(true)).toBe(true);
    expect(collectionChoice(" le ")).toBe("le");
    for (const value of [false, "", "  ", "true".length, undefined, null]) {
      expect(collectionChoice(value)).toBe(false);
    }
  });

  it("certificateName: the first DNS name without a wildcard, else the common name, never a wildcard", () => {
    expect(certificateName(selfSigned("cn-name", ["*.lan", "dns-name"]).cert)).toBe("dns-name");
    expect(certificateName(OTHER.cert)).toBe("other-host");
    expect(certificateName(WILD.cert)).toBeUndefined();
    expect(certificateName("no certificate")).toBeUndefined();
  });
});

describe("createOwnServer — the options in the constructor", () => {
  it("without a certificate an HTTP server with the options and the handler", () => {
    const handler: http.RequestListener = () => undefined;
    const server = createOwnServer(undefined, { requestTimeout: 2000 }, handler);
    expect(server).toBeInstanceOf(http.Server);
    expect(server).not.toBeInstanceOf(https.Server);
    expect(server.requestTimeout).toBe(2000);
    expect(server.listeners("request")).toContain(handler);
  });

  it("with a certificate an HTTPS server with the options", async () => {
    const { adapter } = fakeAdapter({ secure: true });
    const server = createOwnServer(await loadCertificates(adapter), { requestTimeout: 2000 });
    expect(server).toBeInstanceOf(https.Server);
    expect(server.requestTimeout).toBe(2000);
  });
});
