/**
 * HTTPS of the HA emulation (K4, krobi 2026-11-11 19:31 "k3 und k4 absolut ok"): HTTP stays the default; with
 * `native.secure` the server takes a certificate from ioBroker and advertises the NAME the certificate is valid for
 * instead of the IP.
 *
 * Two sources, both chosen with the admin's `certificates` field (it writes `certPublic`/`certPrivate`/`certChained`
 * and `leCollection`):
 * - the named certificates of `system.certificates` (ioBroker's own self-signed `defaultPublic`/`defaultPrivate`, or
 *   one the user imported), read through the controller's `getCertificatesAsync` — js-controller 7.2.5 restarts the
 *   instance itself when one of them changes (adapter.ts `getCertificatesAsync`: file watchers plus a subscription to
 *   `system.certificates`);
 * - Let's Encrypt collections of the acme adapter (`system.certificates` → `native.collections`), served by SNI per
 *   domain — `leCollection` `false` uses none, `true` every one, a string the one of that id. A renewed collection
 *   reaches the running server through {@link TlsSetup.update}.
 *
 * Shape of a collection and of its certificate chain as `@iobroker/webserver` 3.4.0 reads them
 * (`buildCertificateChain`, `buildSecureContexts`): `cert` holds the leaf, `chain` the issuers, either may be one PEM
 * block, a concatenation or an array, and `chain` may repeat the leaf.
 */
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { isPlainObject } from "./coerce";

/** The `system.certificates` id the controller keeps certificates and collections in. */
export const CERTIFICATES_OBJECT_ID = "system.certificates";

/** What the controller's `getCertificatesAsync` answers with — `ioBroker.Certificates`. */
export interface NamedCertificates {
  /** Private key (PEM). */
  key: string;
  /** Public certificate (PEM). */
  cert: string;
  /** Chained certificates (PEM), when one was chosen. */
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

/** The HTTPS part of the server, built once per start. */
export interface TlsSetup {
  /** Options for `https.createServer`: the named certificate as default, SNI for the collections. */
  options: tls.SecureContextOptions & { SNICallback: (servername: string, cb: SniCallbackResult) => void };
  /** The name the server advertises — a certificate is valid for a name, not for the IP. `undefined`: none in it. */
  name: string | undefined;
  /** The collection setting (`leCollection`) the setup was built with — `false` when no collection is used. */
  collectionChoice: true | string | false;
  /**
   * Take renewed collections (a new version of `system.certificates`).
   *
   * @param collections The collections now in force.
   */
  update(collections: Map<string, CertificateCollection>): void;
}

type SniCallbackResult = (err: Error | null, ctx?: tls.SecureContext) => void;

/** The adapter surface the loader needs. */
export interface TlsAdapter {
  /**
   * The controller's certificate read (`ioBroker.Certificates` plus whether Let's Encrypt is configured).
   *
   * @param publicName  Name of the public certificate.
   * @param privateName Name of the private key.
   * @param chainedName Name of the chained certificates.
   */
  getCertificatesAsync(publicName?: string, privateName?: string, chainedName?: string): Promise<unknown>;
  /**
   * Read a foreign object.
   *
   * @param id Full object id.
   */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
}

/** The settings the loader reads. */
export interface TlsConfig {
  /** Name of the public certificate in `system.certificates` (admin `certificates` field). */
  certPublic?: unknown;
  /** Name of the private key. */
  certPrivate?: unknown;
  /** Name of the chained certificates. */
  certChained?: unknown;
  /** Let's Encrypt collection: `false` none, `true` every one, a string the one of that id. */
  leCollection?: unknown;
}

/**
 * The controller's "the named certificates are not configured" — `tools.ERRORS.ERROR_NOT_FOUND` (js-controller
 * 7.2.5 common-db tools.ts:146). Its `CertificateManager` has logged the error line itself before it threw.
 *
 * @param err A caught value.
 */
export function isCertificateNotFound(err: unknown): boolean {
  return err instanceof Error && err.message === "Not exists";
}

/**
 * The PEM certificate blocks in a collection field — a single block, a concatenation, or an array of either.
 *
 * @param source The field as the acme adapter wrote it.
 */
function pemBlocks(source: unknown): string[] {
  const parts = Array.isArray(source) ? source : source === undefined || source === null ? [] : [source];
  const blocks: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") {
      continue;
    }
    // A base64 body never contains a dash, so the end of a block is unambiguous.
    blocks.push(...(part.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []));
  }
  return blocks;
}

/**
 * The collections a setting selects, checked at the boundary.
 *
 * @param native The `native` of `system.certificates`.
 * @param choice `leCollection`: `false`/missing none, `true` every one, a string the one of that id.
 * @throws {Error} When a collection chosen by id does not exist or cannot be used — the server cannot present it.
 */
export function selectCollections(native: unknown, choice: true | string | false): Map<string, CertificateCollection> {
  const selected = new Map<string, CertificateCollection>();
  if (choice === false) {
    return selected;
  }
  const all = isPlainObject(native) && isPlainObject(native.collections) ? native.collections : {};
  const ids = choice === true ? Object.keys(all) : [choice];
  for (const id of ids) {
    const raw = all[id];
    const leaf = isPlainObject(raw) ? pemBlocks(raw.cert) : [];
    const domains =
      isPlainObject(raw) && Array.isArray(raw.domains)
        ? raw.domains.filter((d): d is string => typeof d === "string" && d !== "")
        : [];
    if (!isPlainObject(raw) || typeof raw.key !== "string" || leaf.length === 0 || domains.length === 0) {
      if (choice === true) {
        continue; // "every collection" takes the usable ones
      }
      throw new Error(`the certificate collection "${id}" does not exist or holds no usable certificate`);
    }
    const issuers = pemBlocks(raw.chain).filter(block => !leaf.includes(block));
    // Joined by a newline: OpenSSL only recognises a BEGIN marker at the start of a line.
    selected.set(id, { key: raw.key, cert: `${[...leaf, ...issuers].join("\n")}\n`, domains });
  }
  return selected;
}

/**
 * The name a certificate is valid for: its first DNS name without a wildcard, else its common name.
 *
 * @param pem The certificate (PEM; a bundle is read from its first block).
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
  if (dns !== undefined) {
    return dns;
  }
  const cn = /^CN=(.+)$/m.exec(x509.subject)?.[1]?.trim();
  return cn && !cn.includes("*") ? cn : undefined;
}

/**
 * Build the HTTPS part from the named certificates and the selected collections.
 *
 * @param named The named certificates (the default context for every name no collection covers).
 * @param collections The selected collections.
 * @param collectionChoice The `leCollection` setting they were selected with.
 * @throws {Error} When a certificate or key cannot be used (`tls.createSecureContext` refuses it).
 */
export function buildTls(
  named: NamedCertificates,
  collections: Map<string, CertificateCollection>,
  collectionChoice: true | string | false,
): TlsSetup {
  const fallback = tls.createSecureContext({ key: named.key, cert: named.cert, ca: named.ca });
  let contexts = contextsOf(collections);
  const first = [...collections.values()][0];
  return {
    options: {
      key: named.key,
      cert: named.cert,
      ...(named.ca ? { ca: named.ca } : {}),
      // The display names the host it reaches hassemu under (SNI): the collection for that name, a wildcard one, or
      // the named certificate.
      SNICallback: (servername, cb) => {
        const wildcard = servername.includes(".") ? `*${servername.slice(servername.indexOf("."))}` : undefined;
        cb(null, contexts.get(servername) ?? (wildcard ? contexts.get(wildcard) : undefined) ?? fallback);
      },
    },
    name: first?.domains.find(d => !d.includes("*")) ?? certificateName(named.cert),
    collectionChoice,
    update: next => {
      contexts = contextsOf(next);
    },
  };
}

/**
 * One secure context per domain of each collection.
 *
 * @param collections The selected collections.
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
 * The `leCollection` setting as the loader reads it.
 *
 * @param value `native.leCollection`.
 */
export function collectionChoiceOf(value: unknown): true | string | false {
  return value === true ? true : typeof value === "string" && value.trim() !== "" ? value.trim() : false;
}

/**
 * Load the HTTPS part for a start: the named certificates (ioBroker's default pair when none is chosen, like
 * `@iobroker/webserver` 3.4.0 `getCustomCertificates`) and the chosen collections.
 *
 * @param adapter The adapter.
 * @param config The settings.
 * @throws {Error} The controller's `ERROR_NOT_FOUND` ({@link isCertificateNotFound}) when the named certificates are not
 *   configured — it has logged the line itself; an Error naming the cause when a chosen collection is missing or a
 *   certificate cannot be used.
 */
export async function loadTls(adapter: TlsAdapter, config: TlsConfig): Promise<TlsSetup> {
  const name = (v: unknown, dflt: string): string => (typeof v === "string" && v.trim() !== "" ? v.trim() : dflt);
  const answer = await adapter.getCertificatesAsync(
    name(config.certPublic, "defaultPublic"),
    name(config.certPrivate, "defaultPrivate"),
    name(config.certChained, "") || undefined,
  );
  const certs = Array.isArray(answer) ? (answer[0] as unknown) : undefined;
  if (!isPlainObject(certs) || typeof certs.key !== "string" || typeof certs.cert !== "string") {
    throw new Error("the controller handed over no usable certificate");
  }
  const named: NamedCertificates = {
    key: certs.key,
    cert: certs.cert,
    ...(typeof certs.ca === "string" && certs.ca !== "" ? { ca: certs.ca } : {}),
  };
  const choice = collectionChoiceOf(config.leCollection);
  const collections =
    choice === false
      ? new Map<string, CertificateCollection>()
      : selectCollections((await adapter.getForeignObjectAsync(CERTIFICATES_OBJECT_ID))?.native, choice);
  return buildTls(named, collections, choice);
}
