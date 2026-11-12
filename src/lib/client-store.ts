/**
 * What hassemu itself generates or tracks — the server id the displays know it by, and per display the cookie that
 * identifies it, its tokens and when it was last seen — kept in ONE file in the instance data folder, never in the
 * `native` of an object and never as the value of a datapoint.
 *
 * Fleet rules on the hassemu acceptance page (krobi 2026-11-11, K1 and K5): a secret the adapter generates or
 * receives, its runtime values, and an id it generates and must keep because devices know it by that id, stand in the
 * same file in the instance data folder. The server id is generated once and never again: an unreadable file fails the start. Up to 1.46.1 the
 * server id was the value of `info.serverUuid`, which any script could overwrite.
 *
 * Werkbank standard of round 173 (krobi 2026-11-10 14:34 on the Werkbank's question; ioBroker objectsschema:
 * `native` holds the properties of the target system; CLAUDE_PATTERNS § native „Wohin“): generated secrets and
 * runtime values live in a file of the instance data folder. Up to this version every display carried them in
 * `clients.<id>.native` — each token grant and the hourly lastSeen stamp was an object write, and every object
 * dump showed the secrets.
 *
 * Keyed by the display id, not by the cookie: an id is unique by construction (display-id.ts), and the restore
 * finds a display's entry from its device object.
 */

import { coerceDeviceName, coerceHostname, coerceUuid, isPlainObject } from "./coerce";
import { readDataFile, writeDataFile } from "./data-file";

/**
 * A stored time stamp: a finite number, never a string form — the file and the objects only ever held numbers.
 *
 * @param value the raw field
 */
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The file in the instance data folder. */
export const STORE_FILE = "identities.json";

/** The keys an earlier version kept in `clients.<id>.native` — taken over once, then removed from the object. */
export const LEGACY_NATIVE_KEYS = ["cookie", "token", "tokenExpiresAt", "refreshToken", "lastSeen"] as const;

/** What the file holds for one display. */
export interface StoredClient {
  /** The cookie (UUID) the display presents — its identity. */
  cookie: string;
  /** The current access token, or null. */
  token: string | null;
  /** When {@link token} expires (ms since epoch), or null without a token. */
  tokenExpiresAt: number | null;
  /** The current refresh token, or null. */
  refreshToken: string | null;
  /** When the display was last seen (ms since epoch); absent before the first stamp. */
  lastSeen?: number;
  /** The device name its Companion app reported (K7); absent without an app. */
  appName?: string;
  /**
   * The host name its address last resolved to (K7) — a source of the display's name, so the start names the display
   * as before. Absent until a lookup answered; a display stored before K7 has none and gets it at its first contact.
   */
  hostname?: string;
}

/** The result of reading the file: the server id and every usable entry, or why the file is unusable. */
export interface StoreRead {
  /** The server id; absent before the first write. */
  server?: string;
  /** Display id → stored entry; empty before the first write. */
  clients: Map<string, StoredClient>;
  /** Set when the file exists but cannot be used. */
  error?: string;
}

/**
 * One display's entry from untyped data — the file, or the `native` of an earlier version's device object.
 * Type guard at the boundary: a value without a usable cookie is no entry; a broken token field counts as none.
 *
 * @param value the raw entry
 * @returns the entry, or null when it carries no usable cookie
 */
export function storedClientFrom(value: unknown): StoredClient | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const cookie = coerceUuid(value.cookie);
  if (!cookie) {
    return null;
  }
  const token = coerceUuid(value.token);
  const lastSeen = finiteNumber(value.lastSeen);
  const appName = coerceDeviceName(value.appName);
  const hostname = coerceHostname(value.hostname);
  return {
    cookie,
    token,
    // An expiry without a token means nothing (v1.36.0, S5: getByToken rejects an expired token).
    tokenExpiresAt: token ? (finiteNumber(value.tokenExpiresAt) ?? null) : null,
    refreshToken: coerceUuid(value.refreshToken),
    ...(lastSeen === undefined ? {} : { lastSeen }),
    ...(appName === null ? {} : { appName }),
    ...(hostname === null ? {} : { hostname }),
  };
}

/**
 * Whether a device object's `native` still carries a key an earlier version stored there.
 *
 * @param native the `native` of a `clients.<id>` object
 */
export function hasLegacyNative(native: Record<string, unknown>): boolean {
  return LEGACY_NATIVE_KEYS.some(key => key in native);
}

/**
 * Read the file.
 *
 * @param dir the instance data folder
 * @returns the server id and every usable entry (an entry without a usable cookie is left out), or the reason the
 *   file is unusable — a file without a valid server id is unusable: generating a new one would make every display
 *   onboard again
 */
export function readStore(dir: string): StoreRead {
  const read = readDataFile(dir, STORE_FILE);
  const clients = new Map<string, StoredClient>();
  if (read.error !== undefined) {
    return { clients, error: read.error };
  }
  if (read.value === undefined) {
    return { clients };
  }
  if (!isPlainObject(read.value)) {
    return { clients, error: "no object in it" };
  }
  const server = coerceUuid(read.value.server);
  if (!server) {
    return { clients, error: "no valid server id in it" };
  }
  const displays = read.value.displays;
  if (!isPlainObject(displays)) {
    return { clients, error: "no object of displays in it" };
  }
  for (const [id, raw] of Object.entries(displays)) {
    const entry = storedClientFrom(raw);
    if (entry) {
      clients.set(id, entry);
    }
  }
  return { server, clients };
}

/**
 * Write the file — the server id and every entry, sorted by display id, as one replacement.
 *
 * @param dir the instance data folder (created when missing)
 * @param server the server id
 * @param clients display id → entry
 */
export function writeStore(dir: string, server: string, clients: ReadonlyMap<string, StoredClient>): void {
  const displays: Record<string, StoredClient> = {};
  for (const id of [...clients.keys()].sort()) {
    displays[id] = clients.get(id)!;
  }
  writeDataFile(dir, STORE_FILE, { server, displays });
}
