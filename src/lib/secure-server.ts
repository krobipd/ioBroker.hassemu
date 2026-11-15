// Fleet master — the release run requires this file byte for byte in every adapter that carries it; change it in
// Entwicklung/.consistency-master, never in an adapter.
/**
 * The adapter's own server with HTTPS as an option — the fleet's HTTPS standard (krobi 2026-11-11 22:22, translated:
 * every adapter that offers HTTPS has the same things; on what he said at 22:17: HTTPS is an option and not the
 * standard, whoever uses it must keep to what it needs, that is the user's matter). HTTPS is switched
 * with `native.secure` (default `false`) and takes the certificates the admin's `certificates` field chooses: a named
 * certificate of `system.certificates` (`certPublic`, `certPrivate`, `certChained`) and, when the acme adapter keeps
 * any, Let's Encrypt collections (`leCollection`: `false` none, `true` every one, a text the one of that id). What the
 * user must keep to (the device must trust the certificate and reach the name it is valid for) stands in the
 * instructions: the README, or the wiki where the adapter has one (krobi 2026-11-11 22:15, translated: the rest is
 * readme).
 *
 * The named certificate comes through the controller (`getCertificatesAsync`), which restarts the instance when it
 * changes. A collection the controller does not watch (`hasRelevantChange` compares the named certificates only): a
 * renewal reaches the running server through the subscription of `system.certificates` this file installs. A collection
 * covers the names it lists, chosen per connection by the name the client asks for (SNI); every other name gets the named
 * certificate. That is the way of `@iobroker/webserver`, without its fall back to HTTP (without a certificate it logs
 * an error line and goes on serving HTTP) and with the server options in the constructor — Node takes a request time
 * limit set after the construction no more (measured on Node 22, 2026-11-11). Measured at js-controller and admin of
 * the stable baseline of 2026-11-13.
 *
 * Start failures (`failStart`): a named certificate ioBroker does not hold is a {@link SettingsError} (exit code 11 and
 * a notification), checked before the controller is asked, whose own error line would be a second one; a collection
 * that is missing or unusable, or a certificate TLS cannot use, is an Error (exit code 6) — the acme adapter may not
 * have issued it yet.
 *
 * Fleet master: `Entwicklung/.consistency-master/src/lib/secure-server.ts`, required with its test for every adapter that
 * offers HTTPS (consistency level 2, `audit_https_option`). Change the master, then copy; never the copy.
 */
import { X509Certificate } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { errText } from "./err-text";
import { SettingsError } from "./start-failure";

/** The object the controller keeps the certificates and the collections in. */
export const CERTIFICATES_OBJECT_ID = "system.certificates";

/** ioBroker's own certificate pair, taken when the settings choose none. */
export const DEFAULT_CERTIFICATES = { publicName: "defaultPublic", privateName: "defaultPrivate" } as const;

/** The settings of the HTTPS option (io-package.json `native`), as the admin's `certificates` field writes them. */
export interface SecureSettings {
  /** HTTPS on — `true` only; the default is `false`. */
  readonly secure?: unknown;
  /** Name of the public certificate in `system.certificates`. */
  readonly certPublic?: unknown;
  /** Name of the private key. */
  readonly certPrivate?: unknown;
  /** Name of the chained certificates, if any. */
  readonly certChained?: unknown;
  /** Let's Encrypt collections: `false` none, `true` every one, a text the one of that id. */
  readonly leCollection?: unknown;
}

/** A change of a foreign object, as the adapter's `objectChange` event hands it over. */
export type ObjectChangeListener = (id: string, obj: { native?: unknown } | null | undefined) => void;

/** What the loader needs of the adapter — the adapter class itself. */
export interface SecureServerAdapter {
  /** The instance settings. */
  readonly config: SecureSettings;
  /** The adapter's logger. */
  readonly log: {
    /** A problem the user should look at. */
    warn(message: string): void;
  };
  /** The controller's certificate read; it restarts the instance when a named certificate changes. */
  getCertificatesAsync(publicName?: string, privateName?: string, chainedName?: string): Promise<unknown>;
  /** Reads a foreign object — here `system.certificates`. */
  getForeignObjectAsync(id: string): Promise<{ native?: unknown } | null | undefined>;
  /** Subscribes foreign objects — here `system.certificates`, for renewed collections. */
  subscribeForeignObjectsAsync(pattern: string): Promise<void>;
  /** Adds a listener to the adapter's events — here `objectChange`. */
  on(event: "objectChange", listener: ObjectChangeListener): unknown;
}

/** A certificate with its key (`ioBroker.Certificates`). */
export interface NamedCertificates {
  /** Private key (PEM). */
  key: string;
  /** Public certificate (PEM). */
  cert: string;
  /** Chained certificates (PEM), when chosen. */
  ca?: string;
}

/** One Let's Encrypt collection of the acme adapter, checked at the boundary. */
export interface CertificateCollection {
  /** Private key (PEM). */
  key: string;
  /** The leaf and its issuers, one PEM bundle. */
  cert: string;
  /** The names the certificate is valid for (may hold a wildcard `*.example.org`). */
  domains: string[];
}

/** The certificate names the settings choose. */
export interface CertificateNames {
  /** Public certificate. */
  publicName: string;
  /** Private key. */
  privateName: string;
  /** Chained certificates, when chosen. */
  chainedName?: string;
}

/** The HTTPS part of the server, built once per start. */
export interface SecureSetup {
  /** The TLS options for {@link createOwnServer}: the named certificate and the choice per name (SNI). */
  readonly options: https.ServerOptions;
  /**
   * The name the server is reached under with a valid certificate — announce or show it instead of the IP: the first
   * name of the first collection, else the named certificate's; `undefined` when the certificate names none.
   */
  readonly name: string | undefined;
}

/**
 * The certificate names of the settings — ioBroker's own pair where none is chosen.
 *
 * @param settings the instance settings
 */
export function certificateNames(settings: SecureSettings): CertificateNames {
  const name = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const chained = name(settings.certChained);
  return {
    publicName: name(settings.certPublic) || DEFAULT_CERTIFICATES.publicName,
    privateName: name(settings.certPrivate) || DEFAULT_CERTIFICATES.privateName,
    ...(chained ? { chainedName: chained } : {}),
  };
}

/**
 * The `leCollection` setting: `true` every collection, a text the one of that id, anything else none.
 *
 * @param value `native.leCollection`
 */
export function collectionChoice(value: unknown): true | string | false {
  return value === true ? true : typeof value === "string" && value.trim() !== "" ? value.trim() : false;
}

/**
 * The PEM certificate blocks of a collection field — one block, a concatenation, or an array of either.
 *
 * @param source the field as the acme adapter wrote it
 */
function pemBlocks(source: unknown): string[] {
  const parts: unknown[] = Array.isArray(source) ? source : [source];
  // A base64 body never contains a dash, so the end of a block is unambiguous.
  return parts.flatMap(part =>
    typeof part === "string" ? (part.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []) : [],
  );
}

/**
 * The collections a choice selects, checked at the boundary — the leaf first, then its issuers without the leaf again.
 *
 * @param native the `native` of `system.certificates`
 * @param choice what {@link collectionChoice} read
 * @throws {Error} a collection chosen by its id is missing or holds no usable certificate ("every one" skips such)
 */
export function selectCollections(native: unknown, choice: true | string | false): Map<string, CertificateCollection> {
  const selected = new Map<string, CertificateCollection>();
  const all = isRecord(native) && isRecord(native.collections) ? native.collections : {};
  const ids = choice === false ? [] : choice === true ? Object.keys(all) : [choice];
  for (const id of ids) {
    const raw = all[id];
    const leaf = isRecord(raw) ? pemBlocks(raw.cert) : [];
    const domains =
      isRecord(raw) && Array.isArray(raw.domains)
        ? raw.domains.filter((domain): domain is string => typeof domain === "string" && domain !== "")
        : [];
    if (!isRecord(raw) || typeof raw.key !== "string" || leaf.length === 0 || domains.length === 0) {
      if (choice === true) {
        continue;
      }
      throw new Error(`the certificate collection "${id}" is missing or holds no usable certificate`);
    }
    const issuers = pemBlocks(raw.chain).filter(block => !leaf.includes(block));
    // Joined by a newline: OpenSSL recognises a BEGIN marker only at the start of a line.
    selected.set(id, { key: raw.key, cert: `${[...leaf, ...issuers].join("\n")}\n`, domains });
  }
  return selected;
}

/**
 * The name a certificate is valid for: its first DNS name without a wildcard, else its common name.
 *
 * @param pem the certificate (PEM; a bundle is read from its first block)
 */
export function certificateName(pem: string): string | undefined {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(pem);
  } catch {
    return undefined;
  }
  const dns = (x509.subjectAltName ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith("DNS:"))
    .map(entry => entry.slice(4))
    .find(name => name !== "" && !name.includes("*"));
  const cn = /^CN=(.+)$/m.exec(x509.subject)?.[1]?.trim();
  return dns ?? (cn && !cn.includes("*") ? cn : undefined);
}

/**
 * The certificate for the start: nothing while HTTPS is off, else the chosen certificates — the named one through the
 * controller, the collections from `system.certificates`, whose renewals this function subscribes.
 *
 * @param adapter the adapter (`this`)
 * @throws {SettingsError} HTTPS is on and ioBroker does not hold a named certificate the settings choose
 * @throws {Error} the controller handed over no usable certificate, a chosen collection is missing or unusable, or TLS
 *   cannot use a certificate
 */
export async function loadCertificates(adapter: SecureServerAdapter): Promise<SecureSetup | undefined> {
  if (adapter.config.secure !== true) {
    return undefined;
  }
  const names = certificateNames(adapter.config);
  const stored = (await adapter.getForeignObjectAsync(CERTIFICATES_OBJECT_ID))?.native;
  const held = isRecord(stored) && isRecord(stored.certificates) ? stored.certificates : {};
  const missing = [names.publicName, names.privateName, names.chainedName].filter(
    (name): name is string => name !== undefined && !(typeof held[name] === "string" && held[name] !== ""),
  );
  if (missing.length > 0) {
    throw new SettingsError(
      `HTTPS is on, but ioBroker holds no certificate ${missing.map(n => `"${n}"`).join(", ")} — choose one under Certificates or switch HTTPS off`,
    );
  }
  const answer = await adapter.getCertificatesAsync(names.publicName, names.privateName, names.chainedName);
  const certs: unknown = Array.isArray(answer) ? answer[0] : undefined;
  if (!isRecord(certs) || typeof certs.key !== "string" || typeof certs.cert !== "string") {
    throw new Error("the controller handed over no usable certificate");
  }
  const named: NamedCertificates = {
    key: certs.key,
    cert: certs.cert,
    ...(typeof certs.ca === "string" && certs.ca !== "" ? { ca: certs.ca } : {}),
  };
  const choice = collectionChoice(adapter.config.leCollection);
  const collections = selectCollections(stored, choice);
  const fallback = tls.createSecureContext(named);
  let contexts = contextsOf(collections);
  if (choice !== false) {
    adapter.on("objectChange", (id, obj) => {
      if (id !== CERTIFICATES_OBJECT_ID) {
        return;
      }
      try {
        contexts = contextsOf(selectCollections(obj?.native, choice));
      } catch (err) {
        adapter.log.warn(
          `The certificate collections changed and cannot be used: ${errText(err)} — the server keeps the previous ones`,
        );
      }
    });
    await adapter.subscribeForeignObjectsAsync(CERTIFICATES_OBJECT_ID);
  }
  const first = [...collections.values()][0];
  return {
    options: {
      ...named,
      // The name the client asks for (SNI): the collection for that name, a wildcard one, or the named certificate.
      SNICallback: (servername, callback) => {
        const wildcard = servername.includes(".") ? `*${servername.slice(servername.indexOf("."))}` : "";
        callback(null, contexts.get(servername) ?? contexts.get(wildcard) ?? fallback);
      },
    },
    name: first?.domains.find(domain => !domain.includes("*")) ?? certificateName(named.cert),
  };
}

/**
 * One secure context per name of each collection.
 *
 * @param collections the selected collections
 * @throws {Error} TLS cannot use a collection's certificate or key
 */
function contextsOf(collections: Map<string, CertificateCollection>): Map<string, tls.SecureContext> {
  const contexts = new Map<string, tls.SecureContext>();
  for (const collection of collections.values()) {
    const context = tls.createSecureContext({ key: collection.key, cert: collection.cert });
    for (const domain of collection.domains) {
      contexts.set(domain, context);
    }
  }
  return contexts;
}

/**
 * The adapter's own server: HTTPS with the certificates, HTTP without — the options in the constructor either way.
 *
 * @param setup what {@link loadCertificates} returned
 * @param options the server options (time limits)
 * @param handler the request handler, if any
 */
export function createOwnServer(
  setup: SecureSetup | undefined,
  options: http.ServerOptions,
  handler?: http.RequestListener,
): http.Server | https.Server {
  return setup ? https.createServer({ ...options, ...setup.options }, handler) : http.createServer(options, handler);
}

/**
 * A plain object, checked at the boundary.
 *
 * @param value any value
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
