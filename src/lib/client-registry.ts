/**
 * Client Registry — persistent multi-client store.
 *
 * Each client gets a device `clients.<id>` (id rule: display-id.ts) with the states mode / manualUrl / ip /
 * resolvedUrl / remove. Cookie is the primary identity
 * (auto-sent by browsers on page navigation), IP is only advisory.
 *
 * Registry state lives in three places: in-memory maps for hot lookups, ioBroker
 * objects for the user-visible config, and `identities.json` in the instance data
 * folder for what the adapter generates and tracks — the server id, and per display
 * cookie, tokens, lastSeen (client-store.ts; never in an object's `native`).
 */

import crypto from "node:crypto";
import { join } from "node:path";
import {
  hasLegacyNative,
  LEGACY_NATIVE_KEYS,
  readStore,
  STORE_FILE,
  storedClientFrom,
  type StoredClient,
  writeStore,
} from "./client-store";
import {
  coerceDeviceName,
  coerceHostname,
  coerceSafeUrl,
  coerceString,
  coerceUuid,
  isPlainObject,
  oneLine,
} from "./coerce";
import { evictOldest, isBareStringName, nameText, parseAdapterStateId, shallowStatesEqual } from "./object-utils";
import { buildDropdownStates, parseManualUrlWrite, parseModeWrite } from "./state-write-rules";
import {
  CLIENT_OBJECTS_VERSION,
  GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW,
  LASTSEEN_FLUSH_INTERVAL_MS,
  MODE_GLOBAL,
  MODE_MANUAL,
  NEW_CLIENT_BURST_CAP,
  NO_CHOICE,
  NEW_CLIENT_BURST_WARN_THRESHOLD,
  NEW_CLIENT_THROTTLE_PER_HOUR,
  NEW_CLIENT_WINDOW_MS,
  OAUTH_ACCESS_TOKEN_TTL_S,
  IP_CHANGE_MIN_INTERVAL_MS,
} from "./constants";
import { displayIcon } from "./device-icon";
import { LEGACY_DISPLAY_ID, movedDisplayId, newDisplayId, randomIdTail } from "./display-id";
import { moveAllWithEnums } from "./enum-carry";
import { errText } from "./err-text";
import { resolveLabel, tName, tRaw } from "./i18n";
import { coveredBy } from "./known-objects";
import { replaceObjectPreservingValue } from "./object-repair";
import type { AdapterInterface, ClientRecord, UrlStates } from "./types";

/** Extended adapter interface for registry — needs object and state operations. */
export type RegistryAdapter = AdapterInterface &
  Pick<
    ioBroker.Adapter,
    | "namespace"
    | "getForeignObjectsAsync"
    | "getForeignObjectAsync"
    | "getAdapterObjectsAsync"
    | "getStateAsync"
    | "getStatesAsync"
    | "getObjectAsync"
    | "setObjectNotExistsAsync"
    | "extendObject"
    | "setState"
    | "delObjectAsync"
    | "setForeignObject"
    | "encrypt"
    | "decrypt"
  >;

const CLIENTS_PREFIX = "clients.";

/** Provides the default mode value for a freshly created client. */
export type NewClientModeProvider = () => string;

/** A display that moves to the id rule of K7 (display-id.ts). */
interface DisplayMove {
  /** The id it has. */
  from: string;
  /** The id it gets. */
  to: string;
  /** The journal at the old device names the target already — a move an earlier start began. */
  journaled: boolean;
}

/** A move journal names a display id: lower-case letters, digits and hyphens. */
const MOVE_TARGET = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The id an object has after a display moved, or undefined when it is not part of the moved display.
 *
 * @param id       A full object id.
 * @param fromFull The old device id, namespace included.
 * @param toFull   The new device id, namespace included.
 */
export function movedObjectId(id: string, fromFull: string, toFull: string): string | undefined {
  if (id === fromFull) {
    return toFull;
  }
  return id.startsWith(`${fromFull}.`) ? `${toFull}${id.slice(fromFull.length)}` : undefined;
}

/**
 * A copy of one object of a moving display, as it is written under the new id — its `common` (the user's
 * recording settings in `common.custom` included) and `native`, with what names the old id rewritten: the move
 * journal stays at the old object, a name that is the old id becomes the new id, and an enabled recording without
 * an alias id of its own records on under the old id (`aliasId`), so influxdb, history and sql keep the series the
 * datapoint always had (as in yamaha 3.0.0, `device-move.ts`).
 *
 * @param id        The object's old full id.
 * @param obj       The object as read.
 * @param move      The move.
 * @param move.from The old display id.
 * @param move.to   The new display id.
 * @param fromFull  The old device id, namespace included.
 */
export function movedObject(
  id: string,
  obj: ioBroker.Object,
  move: { from: string; to: string },
  fromFull: string,
): ioBroker.SettableObject {
  // An object without `common` (a broken one) or `native` moves with an empty one.
  const copy = structuredClone({ type: obj.type, common: obj.common ?? {}, native: obj.native ?? {} }) as {
    type: ioBroker.Object["type"];
    common: Record<string, unknown>;
    native: Record<string, unknown>;
  };
  if (id === fromFull) {
    delete copy.native.movingTo;
    if (nameText(copy.common.name) === move.from) {
      copy.common.name = tRaw(move.to);
    }
  }
  const custom = copy.common.custom;
  if (copy.type === "state" && isPlainObject(custom)) {
    for (const settings of Object.values(custom)) {
      if (
        isPlainObject(settings) &&
        settings.enabled &&
        (typeof settings.aliasId !== "string" || settings.aliasId === "")
      ) {
        settings.aliasId = id;
      }
    }
  }
  return copy as unknown as ioBroker.SettableObject;
}

/**
 * An alias target with the moved display followed — a plain id, or the read/write pair (as in homeconnect,
 * `device-move.ts` `movedAliasTarget`).
 *
 * @param target   `common.alias.id` as stored.
 * @param fromFull The old device id, namespace included.
 * @param toFull   The new device id, namespace included.
 * @returns The new target, or undefined when it points at nothing of the moved display.
 */
export function movedAliasTarget(target: unknown, fromFull: string, toFull: string): unknown {
  if (typeof target === "string") {
    return movedObjectId(target, fromFull, toFull);
  }
  if (isPlainObject(target)) {
    const read = typeof target.read === "string" ? movedObjectId(target.read, fromFull, toFull) : undefined;
    const write = typeof target.write === "string" ? movedObjectId(target.write, fromFull, toFull) : undefined;
    if (read === undefined && write === undefined) {
      return undefined;
    }
    return { ...target, ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}) };
  }
  return undefined;
}

/** What the restore of one display found. */
interface RestoredClient {
  /** Display id. */
  id: string;
  /** The device `native` still carries a key an earlier version stored there. */
  legacyNative: boolean;
}

/** Persistent multi-client store: cookie → channel, with in-memory lookup maps. */
export class ClientRegistry {
  private readonly adapter: RegistryAdapter;
  private readonly byCookie = new Map<string, ClientRecord>();
  private readonly byId = new Map<string, ClientRecord>();
  private readonly byToken = new Map<string, ClientRecord>();
  private readonly byRefreshToken = new Map<string, ClientRecord>();
  private currentUrlStates: UrlStates = {};
  private newClientModeProvider: NewClientModeProvider = () => MODE_GLOBAL;
  /**
   * In-flight client creations keyed by remote IP. Keeps parallel cookieless
   * requests from the same display (typical on first connect: HA clients fire
   * `GET /`, `GET /api/`, `POST /auth/login_flow` almost simultaneously) from
   * each creating a separate client record. The first request starts the
   * create; parallel requests await the same Promise and receive the same
   * client + cookie.
   */
  private readonly pendingByIp = new Map<string, Promise<ClientRecord>>();
  /**
   * Throttle for lastSeen-updates per client. Keyed by client id, value is the
   * last `Date.now()` stored as the client's `lastSeen` in the data file. Throttle
   * window is one hour — saves a file write on every request.
   */
  private readonly lastSeenFlushedAt = new Map<string, number>();
  /** The instance data folder that holds {@link STORE_FILE}. */
  private readonly dataDir: string;
  /** The server id the displays know hassemu by — set by {@link restore}, stored in {@link STORE_FILE}. */
  private serverId: string | null = null;
  /**
   * Entries of the data file that are not (yet) tracked displays — every entry while the
   * restore runs, afterwards only those of a display whose restore failed or whose objects
   * could not be listed. Every write of the file carries them, so a failed restore never
   * costs the identities it could not load.
   */
  private readonly carried = new Map<string, StoredClient>();
  /** When each display's address last changed — the window of {@link IP_CHANGE_MIN_INTERVAL_MS}. */
  private readonly ipChangedAt = new Map<string, number>();
  /** The device name each display's Companion app reported (K7), stored in {@link STORE_FILE}. */
  private readonly appNames = new Map<string, string>();
  /**
   * The device name hassemu last wrote for each display (K7), in memory only: a name is written when its sources
   * name the display differently, never read back from the tree (see applyName). The start fills it (restoreChannel).
   */
  private readonly writtenNames = new Map<string, string>();
  /**
   * The value each display's read-only `resolvedUrl` holds, in memory only: only hassemu writes it, so the start reads
   * it once with every other state of the displays (restore) and a later write compares here — a read of the
   * datapoint before each write (`setStateChangedAsync`) cost one database read per changed answer
   * (inventory suite, 2026-11-12). A display created after the start has no entry, so its first answer is written.
   */
  private readonly resolvedUrls = new Map<string, string>();
  /**
   * v1.19.0 (G5): per-IP burst tracking for broken-cookie displays. v1.37.0 (M4):
   * the window is now SLIDING — keyed on `lastActivity`, not a fixed start — so an
   * IP that keeps spraying cookieless requests stays throttled instead of getting
   * a fresh NEW_CLIENT_THROTTLE_PER_HOUR budget every hour. An IP idle for a full
   * NEW_CLIENT_WINDOW_MS recovers and can mint persistent clients again.
   */
  private readonly newClientBurst = new Map<string, { count: number; lastActivity: number; warnedAt: number }>();
  /**
   * IP-INDEPENDENT sliding-window counter for persistent cookieless creates — a
   * second ceiling below the per-IP {@link isIpThrottled} one. The per-IP throttle
   * keys on `req.ip`; with `trustProxy` on but no sanitising proxy in front, a single
   * device can rotate `X-Forwarded-For` per request so every request looks like a
   * fresh IP and never trips it, minting unbounded persisted `clients.<id>` objects.
   * This window closes that hole regardless of IP spoofing. Same reset-on-idle shape
   * as {@link newClientBurst}. See {@link GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW}.
   */
  private globalBurst = { count: 0, lastCreate: 0, warnedAt: 0 };
  /**
   * Legacy `clients.<id>.visUrl` values seen during {@link restore}, keyed by client id.
   *
   * `migrateVisUrlToMode` used to ask the broker for this state once per client on every
   * single start — sequentially, and on every installation migrated since v1.2.0 the
   * answer was `null` every time. `restore()` already reads that client's states in one
   * parallel batch, so the value comes along for free and the migration needs no
   * round-trip of its own. Consumed (and cleared) by {@link takeLegacyVisUrls}: a value
   * is offered exactly once, so a failed migration attempt is not retried against a
   * stale copy but against the broker on the next start.
   */
  private readonly legacyVisUrls = new Map<string, unknown>();

  /**
   * @param adapter Adapter instance used for object/state I/O.
   * @param dataDir The instance data folder (`utils.getAbsoluteInstanceDataDir`, declared as `common.dataFolder`).
   */
  constructor(adapter: RegistryAdapter, dataDir: string) {
    this.adapter = adapter;
    this.dataDir = dataDir;
  }

  /**
   * Wires the default-mode provider used when a new client is registered.
   * Called from main.ts once registry, globalConfig and urlDiscovery exist.
   *
   * @param provider Function returning the desired default mode for a new client.
   */
  setNewClientModeProvider(provider: NewClientModeProvider): void {
    this.newClientModeProvider = provider;
  }

  /**
   * The server id the displays know hassemu by — the same for the web server and mDNS. Available once
   * {@link restore} has run.
   */
  get serverUuid(): string {
    if (this.serverId === null) {
      throw new Error("the server id is read by restore() first");
    }
    return this.serverId;
  }

  /**
   * Loads the server id and the existing clients from the data file and the ioBroker objects into memory, and
   * writes the data file back. Call once on adapter start.
   *
   * Throws — the start fails and js-controller restarts it (K16) — when the data file exists but cannot be used,
   * when the objects or a display's states cannot be read, and when the data file cannot be written: a read error
   * must not make every display re-onboard or overwrite a setting, and a run from memory would lose the identities
   * at the next start. The write at every start is that check (ST1 of the start-failure standard).
   *
   * The server id 1.46.1 kept as the value of `info.serverUuid` moves into the file once, while the file holds none;
   * without a valid one a new id is generated.
   */
  async restore(): Promise<void> {
    const read = readStore(this.dataDir, this.adapter);
    if (read.error !== undefined) {
      throw new Error(
        `the stored identities ${join(this.dataDir, STORE_FILE)} cannot be used (${read.error}) — no display was touched`,
      );
    }
    this.serverId = read.server ?? null;
    for (const [id, entry] of read.clients) {
      this.carried.set(id, entry);
    }
    let objects = await this.listDisplayObjects();
    // A read error propagates (design decision 2, K16): a new server id would make every display onboard again.
    const states = await this.readStates();
    if (this.serverId === null) {
      // Resolved before the moves below: each of them stores the identities it re-keys.
      const moved = coerceUuid(states.get(`${this.adapter.namespace}.info.serverUuid`)?.val);
      this.serverId = moved ?? crypto.randomUUID();
      this.adapter.log.debug(moved ? "Server id moved into the data file" : "Server id generated");
    }
    objects = await this.moveToDisplayIds(objects, states);
    const datapoints = await this.readDatapointObjects(objects);

    // All displays in parallel — restoreChannel shares nothing between displays except
    // synchronous Map writes; an error of one display fails the start (K16). Serial, this was N × (five
    // reads + five existence checks + one object read) before the port was bound
    // (audit 2026-09-15, D1).
    const restored = await Promise.all(
      Object.entries(objects).map(([fullId, obj]) => this.restoreChannel(fullId, obj, states, datapoints)),
    );
    // An entry whose display has no object any more (removed in the object browser, or the
    // removal's file write failed) is dropped.
    const listed = new Set(Object.keys(objects).map(fullId => this.clientIdOf(fullId)));
    const orphanEntries = [...this.carried.keys()].filter(id => !listed.has(id));
    for (const id of orphanEntries) {
      this.carried.delete(id);
    }
    const legacy = restored.filter((r): r is RestoredClient => r !== null && r.legacyNative).map(r => r.id);
    await this.settleStore(legacy);
    this.adapter.log.debug(`client-registry: restored ${this.byId.size} client(s)`);
  }

  /**
   * Every state of the instance with ONE read, the fleet's read at start (`getStatesAsync("*")`): the server id 1.46.1
   * kept, the values the moves carry and the values of every display come from it. Before, each display cost five
   * single reads, a read-only datapoint (`ip`, `resolvedUrl`) was read again before each write, and the server id and
   * each old display's values were read on their own.
   *
   * Throws when the states cannot be read (K16): read as "empty", the restore wrote "0" over the mode.
   *
   * @returns full state id → state, null for a datapoint without a value — every datapoint of the instance is a key
   */
  private async readStates(): Promise<Map<string, ioBroker.State | null>> {
    try {
      const states = await this.adapter.getStatesAsync("*");
      return new Map(Object.entries(states ?? {}).map(([id, state]) => [id, state ?? null]));
    } catch (err) {
      throw new Error(`reading the states failed (${errText(err)}) — no display was touched`);
    }
  }

  /**
   * The datapoint objects of every display with ONE read — only while a display's text revision is behind, so that the
   * text refresh writes only the datapoints whose texts differ. Before, a revision bump rewrote every datapoint of a
   * display, also those whose texts were current (inventory, upgrade from 1.46.1: "rewrites no object unchanged",
   * 2026-11-12). Read after the moves: the refresh writes onto the moved datapoints.
   *
   * Throws when the objects cannot be read (K16), like the read of the display objects.
   *
   * @param objects The display objects after the moves.
   * @returns full datapoint id → object; empty while every display's texts are current
   */
  private async readDatapointObjects(
    objects: Record<string, ioBroker.Object>,
  ): Promise<ReadonlyMap<string, ioBroker.Object>> {
    const behind = Object.values(objects).some(
      obj => !isPlainObject(obj.native) || obj.native.objectsVersion !== CLIENT_OBJECTS_VERSION,
    );
    if (!behind) {
      return new Map();
    }
    try {
      const found = await this.adapter.getForeignObjectsAsync(`${this.adapter.namespace}.${CLIENTS_PREFIX}*`, "state");
      return new Map(Object.entries(found ?? {}));
    } catch (err) {
      throw new Error(`reading the display datapoints failed (${errText(err)}) — no display was touched`);
    }
  }

  /**
   * Every `clients.<id>` container — devices, and the channels of an install before 1.37.0.
   *
   * Throws when the objects cannot be read (K16, ST1): running on would re-create every known display as a new one.
   */
  private async listDisplayObjects(): Promise<Record<string, ioBroker.Object>> {
    try {
      // Query each client-container type EXPLICITLY and merge. A string pattern with
      // NO type argument resolves to js-controller's `state` object view
      // (`getObjectView('system', type || 'state')`, verified in js-controller v7.2.2),
      // so it returns ONLY sub-states — NEVER the `device`/`channel` client containers.
      // restoreChannel then skips every state (its id contains a dot) → restore()
      // silently loaded ZERO clients (regression from v1.37.0/I22, which dropped the
      // previous `"channel"` type filter). Both types are required because the
      // channel→device migration (I22) is still in flight: legacy installs carry
      // `channel` containers, migrated/new ones carry `device`. Fleet gotcha:
      // reference_getforeignobjects_state_default (hueemu v1.12.0 hit the same class).
      const pattern = `${this.adapter.namespace}.${CLIENTS_PREFIX}*`;
      const [devices, channels] = await Promise.all([
        this.adapter.getForeignObjectsAsync(pattern, "device"),
        this.adapter.getForeignObjectsAsync(pattern, "channel"),
      ]);
      return { ...(channels ?? {}), ...(devices ?? {}) };
    } catch (err) {
      // Running on would re-create every known display as a new one (duplicate objects, its settings
      // gone). The start fails instead and the controller restarts the instance (K16, ST1: no access to
      // ioBroker is a failed start; before, this warned and went on).
      throw new Error(`reading the display objects failed (${errText(err)}) — no display was touched`);
    }
  }

  /**
   * Move every display of the id form before K7 (`clients.61c3a1`) to `display-<its last four characters>`, once
   * (acceptance page K7, krobi 2026-11-11 19:51 "k7 ist ok"), and finish a move an earlier start began. Runs before
   * any display is restored, so nothing reads a display under its old id afterwards.
   *
   * Each step can be repeated, and nothing is lost when the process ends between two of them (as in yamaha 3.0.0,
   * `migrateDeviceIds`): the journal (`native.movingTo` at the old device) first; then the copy of the device and its
   * datapoints with their values; then every alias that points at the old datapoints pointed at the new ones (like the
   * fleet's id moves); then the identity re-keyed in the data file; then every datapoint below the old
   * device deleted with its rooms and functions carried to the new ids (`moveAllWithEnums` — a recursive delete would
   * take the device and its journal first); the old device last. A step that fails fails the start (K16): the journal
   * stays, and the restart finishes the move.
   *
   * @param objects The display containers as listed.
   * @param states  Every state of the instance as the restore read it; a move carries the values under the new ids.
   * @returns The display containers after the moves.
   */
  private async moveToDisplayIds(
    objects: Record<string, ioBroker.Object>,
    states: Map<string, ioBroker.State | null>,
  ): Promise<Record<string, ioBroker.Object>> {
    const moves = this.planMoves(objects);
    if (moves.length === 0) {
      return objects;
    }
    const all = (await this.adapter.getAdapterObjectsAsync()) as Record<string, ioBroker.Object | null | undefined>;
    for (const move of moves) {
      await this.moveDisplay(move, all, states);
    }
    return this.listDisplayObjects();
  }

  /**
   * Which displays move, and where to: first every journal (a move an earlier start began), then every display of
   * the old id form, both by id, so two displays whose old ids end alike get the same new ids on every start. A
   * display without an identity does not move — restoreChannel removes it as an orphan.
   *
   * @param objects The display containers as listed.
   */
  private planMoves(objects: Record<string, ioBroker.Object>): DisplayMove[] {
    const containers = Object.entries(objects)
      .map(([fullId, obj]) => [this.clientIdOf(fullId), obj] as const)
      .filter(([id]) => id !== "" && !id.includes("."))
      .sort(([a], [b]) => a.localeCompare(b));
    const taken = new Set(containers.map(([id]) => id));
    const moves: DisplayMove[] = [];
    const moving = new Set<string>();
    for (const [id, obj] of containers) {
      const journal = isPlainObject(obj.native) ? obj.native.movingTo : undefined;
      if (
        typeof journal === "string" &&
        MOVE_TARGET.test(journal) &&
        journal !== id &&
        !moves.some(m => m.to === journal)
      ) {
        moves.push({ from: id, to: journal, journaled: true });
        moving.add(id);
        taken.add(journal);
      }
    }
    for (const [id, obj] of containers) {
      if (moving.has(id) || !LEGACY_DISPLAY_ID.test(id)) {
        continue;
      }
      const native = isPlainObject(obj.native) ? obj.native : {};
      if (!(this.carried.get(id) ?? storedClientFrom(native))) {
        continue;
      }
      const to = movedDisplayId(id, other => taken.has(other));
      taken.add(to);
      moves.push({ from: id, to, journaled: false });
    }
    return moves;
  }

  /**
   * One move (see {@link moveToDisplayIds}).
   *
   * @param move   The move.
   * @param all    Every object of the instance, read once before the moves.
   * @param states Every state of the instance, read once by the restore; the values move to the new ids in it too.
   */
  private async moveDisplay(
    move: DisplayMove,
    all: Record<string, ioBroker.Object | null | undefined>,
    states: Map<string, ioBroker.State | null>,
  ): Promise<void> {
    const ns = this.adapter.namespace;
    const fromFull = `${ns}.${CLIENTS_PREFIX}${move.from}`;
    const toFull = `${ns}.${CLIENTS_PREFIX}${move.to}`;
    const local = (fullId: string): string => fullId.slice(ns.length + 1);
    if (!move.journaled) {
      await this.adapter.extendObject(`${CLIENTS_PREFIX}${move.from}`, { native: { movingTo: move.to } });
    }
    // The device first, then what lies below it — every parent exists before its child.
    const tree = Object.entries(all)
      .filter(
        (entry): entry is [string, ioBroker.Object] =>
          !!entry[1] && movedObjectId(entry[0], fromFull, toFull) !== undefined,
      )
      .sort(([a], [b]) => a.length - b.length || a.localeCompare(b));
    for (const [id, obj] of tree) {
      await this.adapter.setForeignObject(movedObjectId(id, fromFull, toFull)!, movedObject(id, obj, move, fromFull));
    }
    // The values of the old display come from the one read at start (readStates), and move to the new ids there too,
    // so the restore reads each display under its new id. A value a journaled move already carried and deleted is
    // missing under the old id — its new id holds it since that start.
    for (const [id, obj] of tree) {
      if (obj.type !== "state" || !states.has(id)) {
        continue;
      }
      const target = movedObjectId(id, fromFull, toFull)!;
      const state = states.get(id) ?? null;
      states.delete(id);
      states.set(target, state);
      if (!state || state.val === undefined) {
        continue;
      }
      await this.adapter.setState(local(target), {
        val: state.val,
        ack: state.ack,
        ...(typeof state.ts === "number" ? { ts: state.ts } : {}),
        ...(typeof state.lc === "number" ? { lc: state.lc } : {}),
        ...(typeof state.q === "number" ? { q: state.q } : {}),
      });
    }
    await this.retargetAliases(fromFull, toFull);
    // The identity follows before the old device goes: the file must name the display under its new id first.
    const entry = this.carried.get(move.from);
    if (entry) {
      this.carried.delete(move.from);
      this.carried.set(move.to, entry);
    }
    this.persist();
    const below = tree
      .map(([id]) => id)
      .filter(id => id !== fromFull)
      .sort((a, b) => b.length - a.length);
    await moveAllWithEnums(
      this.adapter,
      id => {
        const next = movedObjectId(id, fromFull, toFull);
        return next ? [next] : [];
      },
      async () => {
        for (const id of below) {
          await this.adapter.delObjectAsync(local(id));
        }
      },
      errText,
    );
    await this.adapter.delObjectAsync(`${CLIENTS_PREFIX}${move.from}`);
    this.adapter.log.info(
      `Display ${move.from} is now ${move.to} — scripts and visualisations that use clients.${move.from} need the new id`,
    );
  }

  /**
   * Point every alias whose target lies in the moving display at the new id — in both forms of `common.alias.id`.
   * Repeatable: an alias already on the new id is left alone, so a restart from the journal does it again safely.
   * A read or write error propagates (K16): the restart finishes the move.
   *
   * @param fromFull The old device id, namespace included.
   * @param toFull   The new device id, namespace included.
   */
  private async retargetAliases(fromFull: string, toFull: string): Promise<void> {
    const aliases = (await this.adapter.getForeignObjectsAsync("alias.*", "state")) ?? {};
    for (const [id, obj] of Object.entries(aliases)) {
      const alias = (obj?.common as { alias?: { id?: unknown } } | undefined)?.alias;
      if (!obj || !isPlainObject(alias)) {
        continue;
      }
      const moved = movedAliasTarget(alias.id, fromFull, toFull);
      if (moved === undefined) {
        continue;
      }
      await this.adapter.setForeignObject(id, {
        ...obj,
        common: { ...obj.common, alias: { ...alias, id: moved } },
      } as ioBroker.SettableObject);
    }
  }

  /**
   * After the restore: write the data file — the server id, the identities, and what an earlier version kept
   * in the device objects — and only once the file holds it remove those copies from the objects. A file that
   * cannot be written fails the start (K16) with the objects left as they are.
   *
   * @param legacy Ids of restored displays whose device `native` still carries a key of {@link LEGACY_NATIVE_KEYS}.
   */
  private async settleStore(legacy: string[]): Promise<void> {
    try {
      this.persist();
    } catch (err) {
      throw new Error(
        `the identities could not be stored in ${join(this.dataDir, STORE_FILE)} (${errText(err)}) — no display was touched`,
      );
    }
    await Promise.all(legacy.map(id => this.dropLegacyNative(id)));
  }

  /**
   * Remove the keys an earlier version stored in `clients.<id>.native` — in ONE full write: `extendObject`
   * merges, so a key written as `null` would stay in the object.
   *
   * @param id Display id.
   */
  private async dropLegacyNative(id: string): Promise<void> {
    let obj: ioBroker.Object | null | undefined;
    try {
      obj = await this.adapter.getObjectAsync(`clients.${id}`);
    } catch (err) {
      this.adapter.log.debug(
        `client-registry: reading clients.${id} to drop its old native keys failed: ${errText(err)}`,
      );
      return;
    }
    if (!obj || !isPlainObject(obj.native) || !hasLegacyNative(obj.native)) {
      return;
    }
    for (const key of LEGACY_NATIVE_KEYS) {
      delete obj.native[key];
    }
    await replaceObjectPreservingValue(this.adapter, `clients.${id}`, obj);
  }

  /**
   * The display id of a full `clients.<id>` object id.
   *
   * @param fullId Full object id (`<namespace>.clients.<id>`).
   */
  private clientIdOf(fullId: string): string {
    return fullId.substring(`${this.adapter.namespace}.${CLIENTS_PREFIX}`.length);
  }

  /**
   * Restore a single `clients.<id>` channel into the in-memory registry. Extracted
   * from restore() (I11 v1.37.0) so restore() reads as a thin loop over the channels.
   * An error of one display fails the start (K16): the per-display catch of HE1 (v1.28.3) let a read
   * error pass as an empty value, and the restore wrote `"0"` over the display's mode.
   *
   * The identity comes from the data file; a display an earlier version stored keeps it in its
   * device `native`, taken over here once (settleStore moves it into the file).
   *
   * @param fullId Full object id (`<namespace>.clients.<id>`).
   * @param obj    The client object (channel or device) read from the objects DB.
   * @param states Every state of the instance, read once by restore (readStates), the moved values under their new ids.
   * @param datapoints The datapoint objects below `clients.`, read once by restore while a revision is behind
   *   (readDatapointObjects).
   * @returns What was found, or null when the object is no restorable display.
   */
  private async restoreChannel(
    fullId: string,
    obj: ioBroker.Object,
    states: ReadonlyMap<string, ioBroker.State | null>,
    datapoints: ReadonlyMap<string, ioBroker.Object>,
  ): Promise<RestoredClient | null> {
    const id = this.clientIdOf(fullId);
    if (!id || id.includes(".")) {
      return null;
    }
    const native = isPlainObject(obj.native) ? obj.native : {};
    const fromFile = this.carried.get(id);
    const identity = fromFile ?? storedClientFrom(native);
    if (!identity) {
      // A clients.<id> device with no valid cookie — neither in the data file
      // nor (from an earlier version) in its object — cannot belong to any
      // display: the cookie is the identity and is stored at creation. Such a
      // device can only be an orphan left by an object write that raced a
      // remove(). restore() runs before the web server starts, so nothing is
      // mid-creation here, and an unreadable file stopped the start before
      // this point; delete it so it stops lingering in the object tree (where
      // nothing ever reaps it — it has no cookie to restore). v1.37.0 (M5).
      this.adapter.log.warn(`client-registry: removing orphaned client channel without cookie: ${id}`);
      try {
        await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
      } catch (err) {
        this.adapter.log.debug(`client-registry: orphan cleanup failed for ${id}: ${errText(err)}`);
      }
      return null;
    }
    const { cookie, token, refreshToken } = identity;
    // The values come from the one read of every state in restore() (readStates). The
    // pre-1.2.0 `visUrl` the migration needs rides along instead of costing the migration its own
    // round-trip per client on every start (see legacyVisUrls).
    const valueOf = (kind: string): unknown => states.get(`${fullId}.${kind}`)?.val ?? null;
    const [modeRaw, manualUrlRaw, ipRaw, hostnameRaw, legacyVisUrlRaw] = [
      valueOf("mode"),
      valueOf("manualUrl"),
      valueOf("ip"),
      valueOf("hostname"),
      valueOf("visUrl"),
    ];
    // Remembered only what a write of hassemu leaves behind (ack, quality 0, no comment) — the default js-controller
    // puts into a new datapoint carries the quality "initial value" and is replaced by the first answer, as
    // setStateChangedAsync, which compares val, ack, q and c (7.2.5), did.
    const resolved = states.get(`${fullId}.resolvedUrl`);
    if (resolved?.ack === true && typeof resolved.val === "string" && !resolved.q && resolved.c === undefined) {
      this.resolvedUrls.set(id, resolved.val);
    }
    // Handed over whenever the datapoint exists — also empty, its value from creation in 1.0/1.1: the migration
    // removes it either way (before, an empty one was never handed over and stayed in the tree for good).
    if (states.has(`${fullId}.visUrl`)) {
      this.legacyVisUrls.set(id, legacyVisUrlRaw);
    }
    const mode = typeof modeRaw === "string" ? modeRaw : "";
    // A pre-v1.43.0 install may still hold "" in the state; normalise on the way in so
    // exactly one form lives in memory.
    const normalisedMode = mode === "" ? NO_CHOICE : mode;
    const manualUrl = coerceSafeUrl(manualUrlRaw);
    const ip = coerceString(ipRaw);
    // The lastSeen throttle window survives a restart: the persisted stamp IS the last
    // flush. Without this every display's first contact after a restart re-wrote a
    // `lastSeen` that was seconds old — N writes per restart for nothing
    // (audit 2026-09-15, C1). A stamp older than the window is refreshed as before.
    // gcStaleClients reads the same map instead of re-reading every object (D1).
    if (identity.lastSeen !== undefined) {
      this.lastSeenFlushedAt.set(id, identity.lastSeen);
    }
    // v1.36.0 (S5): the persisted access-token expiry comes back, so a token that
    // already expired before the restart is rejected by getByToken on next use.
    const { tokenExpiresAt } = identity;

    // Legacy migration (<=1.1.1): hostname lived in its own datapoint. Its value becomes the host name, and the
    // datapoint goes whenever it exists — also empty, as 1.1.1 left it for a display without a reverse-DNS name
    // (before, an empty one stayed in the tree for good).
    const legacyHostname = coerceHostname(hostnameRaw);
    if (states.has(`${fullId}.hostname`)) {
      if (legacyHostname) {
        this.adapter.log.debug(
          `restore: legacy hostname migration for client ${id} — '${legacyHostname}' becomes the host name`,
        );
      }
      try {
        await this.adapter.delObjectAsync(`clients.${id}.hostname`);
      } catch {
        /* best effort — ignore */
      }
    }
    // The sources of the name (K7): the app's device name and the host name from the data file — or the host name of
    // a datapoint up to 1.1.1, which hassemu wrote itself. The name in the tree is never one: a display stored before
    // K7 is named by its address until its host name resolves at the first contact.
    const { appName } = identity;
    const hostname = identity.hostname ?? legacyHostname;
    if (appName !== undefined) {
      this.appNames.set(id, appName);
    }

    const record: ClientRecord = {
      id,
      cookie,
      token,
      tokenExpiresAt,
      refreshToken,
      mode: normalisedMode,
      manualUrl,
      ip,
      hostname,
      persistent: true,
    };
    // The start brings the name in the tree to what the sources name the display (K7) — also over a name typed in
    // the object tree, which is no source: a user has no business in an adapter's datapoints (krobi 2026-09-02,
    // fleet rule; 2026-11-11 22:40 „Adapter hat sich an die Flotte zu halten!“). A bare string from before v1.41.0
    // becomes a translation object in the same write (core team, nut2 #15). Compared by text (`nameText`), so a
    // display whose name is current costs no write.
    const want = this.wantName(record);
    const rawName = obj.common?.name;
    const deviceCommon: { name?: ioBroker.StringOrTranslated; icon?: string } = {};
    if (isBareStringName(rawName) || nameText(rawName) !== want) {
      deviceCommon.name = tRaw(want);
    }
    this.writtenNames.set(id, want);
    this.trackInMemory(record);
    // Tracked: from here every write of the file takes the entry from the record.
    this.carried.delete(id);
    const restored: RestoredClient = { id, legacyNative: hasLegacyNative(native) };
    // Text revision this client's objects were last written with. Missing/older →
    // ensureObjects refreshes the texts once and re-stamps; equal → it only guarantees
    // the objects EXIST and writes nothing (see CLIENT_OBJECTS_VERSION).
    const storedVersion = typeof native.objectsVersion === "number" ? native.objectsVersion : 0;
    // Legacy clients (v1.1.x) only had `visUrl` + `ip` + `remove` objects;
    // ensure the v1.2.0+ objects (`mode`, `manualUrl`) exist before any
    // state writes from migration land — otherwise js-controller logs
    // "State has no existing object" warnings.
    await this.ensureObjects(record, false, storedVersion, datapoints);
    // ONE write of the device for everything the start brings up to date: the container kind of an install before
    // 1.37.0 (I22: `channel` → `device`, in place — cookie, name and datapoints stay), the name (K7), and the text
    // revision with the pictogram (CLIENT_OBJECTS_VERSION, R-19 — the stamp lets the next start skip the text
    // refresh). Three writes before, each an objectChange (inventory: "writes no object more than MAX_OBJECT_WRITES
    // times", 2026-11-12). A failed write fails the start like the name write did.
    const textsCurrent = storedVersion === CLIENT_OBJECTS_VERSION;
    const icon = textsCurrent ? undefined : displayIcon();
    if (icon !== undefined) {
      deviceCommon.icon = icon;
    }
    const kindChanges = obj.type === "channel";
    if (kindChanges || !textsCurrent || Object.keys(deviceCommon).length > 0) {
      await this.adapter.extendObject(`clients.${id}`, {
        ...(kindChanges ? { type: "device" as const } : {}),
        ...(Object.keys(deviceCommon).length > 0 ? { common: deviceCommon } : {}),
        ...(textsCurrent ? {} : { native: { objectsVersion: CLIENT_OBJECTS_VERSION } }),
      });
    }
    // Promote a blank mode value to the string "0" so the dropdown renders the
    // `0='---'` option as selected. v1.2.0 installs left the value as `''`
    // which matches no common.states entry. Reuses `mode` from the parallel
    // read above (which is `''` for both a blank and a missing value) —
    // ensureObjects() only writes objects, never the mode value, so a second
    // getState would return the same thing. v1.37.0 (L24).
    if (mode === "") {
      await this.adapter.setState(`clients.${id}.mode`, { val: NO_CHOICE, ack: true });
    }
    return restored;
  }

  /**
   * Find the client for this cookie or create a new one.
   * Creates channel + states on first call and updates IP/hostname if changed.
   *
   * @param cookie         Incoming cookie value (may be null/invalid).
   * @param ip             Remote IP observed by the server.
   * @param opts           Optional details, named so a call site can't transpose the nullable strings. v1.37.0 (L30).
   * @param opts.hostname  Hostname (from reverse DNS), stored for the admin UI.
   * @param opts.userAgent User-Agent header for NAT-collision protection in the pending lock.
   * @param opts.create    False: a request without a known cookie gets a transient record, never
   *   a new display (HEAD requests, audit 2026-09-25, H2). Default true.
   */
  async identifyOrCreate(
    cookie: string | null,
    ip: string | null,
    opts: { hostname?: string | null; userAgent?: string | null; create?: boolean } = {},
  ): Promise<ClientRecord> {
    const hostname = opts.hostname ?? null;
    const userAgent = opts.userAgent ?? null;
    const validCookie = coerceUuid(cookie);
    if (validCookie) {
      const existing = this.byCookie.get(validCookie);
      if (existing) {
        await this.updateIpHostname(existing, ip, hostname);
        this.touchLastSeen(existing);
        return existing;
      }
    }
    // HEAD never mints a display: uptime monitors, port scanners and both Companion apps'
    // connectivity checks send HEAD without a cookie — each used to create a device tree
    // that lived 30 days (audit 2026-09-25, H2). Nothing is counted against the throttles.
    if (opts.create === false) {
      this.adapter.log.debug("identify: no known cookie on a request that may not create a display — transient record");
      return this.transientRecord(ip, hostname);
    }
    // IP-INDEPENDENT ceiling on persistent creation, checked before the per-IP path
    // below. Closes the trustProxy / spoofed-X-Forwarded-For hole: a device rotating
    // its apparent IP never trips the per-IP throttle, so without this it could grow
    // the object DB without bound. Over budget → transient record (still resolves to
    // the dashboard, just no persisted identity until the burst subsides). The per-IP
    // window is still refreshed so a throttled real IP keeps its own budget accurate.
    const now = Date.now();
    if (this.isGloballyThrottled(now)) {
      if (ip) {
        this.recordNewClientActivity(ip, false, now);
      }
      this.warnGlobalThrottleOnce(now);
      this.adapter.log.debug("identify: global new-client ceiling reached — serving a transient record (no object)");
      return this.transientRecord(ip, hostname);
    }
    // No valid cookie: before spinning up a new client, check whether this
    // IP already has a create in flight. If so, await that Promise — the
    // parallel request of the same display's initial burst will get the
    // same cookie + client, no more duplicate "New client" log entries.
    //
    // v1.17.0 (C8): the bucket key combines the IP and a hash of the User-Agent, so
    // two different displays behind the same NAT address do NOT fall into the same
    // pending lock (before: same cookie/token/mode — a way to steal a cookie). The UA
    // hash is cut to 12 hex characters to keep the memory footprint small. With no
    // UA the bucket falls back to the IP alone.
    if (ip) {
      // Refuse to mint a new *persistent* client for an IP spraying cookieless
      // requests — hand out a transient (non-persisted, no object) record so the
      // ioBroker object DB cannot grow without bound. A real display keeps its
      // cookie and is identified above, so it never reaches this throttle.
      if (this.isIpThrottled(ip)) {
        // Keep the sliding window alive so a continuously-spraying IP never
        // recovers, but do NOT mint a persistent client (persistent = false).
        // v1.37.0 (M4).
        this.recordNewClientActivity(ip, false);
        this.adapter.log.debug(`identify: IP ${ip} over new-client throttle — serving a transient record (no object)`);
        return this.transientRecord(ip, hostname);
      }
      const bucketKey = userAgent
        ? `${ip}|${crypto.createHash("sha256").update(userAgent).digest("hex").substring(0, 12)}`
        : ip;
      const pending = this.pendingByIp.get(bucketKey);
      if (pending) {
        // v1.21.0 (D3): the pending promise can reject — e.g. when createClient
        // fails asynchronously (broker disconnect, object create error). There is
        // nothing to recover (the first caller has failed already), but the error
        // must stay diagnosable: catch + rethrow gives one log line instead of an
        // unhandled rejection in the fastify error handler.
        return pending.catch(err => {
          this.adapter.log.debug(`client-registry: pending createClient for ${bucketKey} rejected: ${errText(err)}`);
          throw err;
        });
      }
      const promise = this.createClient(ip, hostname, userAgent);
      this.pendingByIp.set(bucketKey, promise);
      try {
        return await promise;
      } catch (err) {
        // Technical diagnosis with stack detail — stays debug (maintainers only).
        this.adapter.log.debug(`client-registry: createClient failed for IP ${ip}: ${errText(err)}`);
        throw err;
      } finally {
        this.pendingByIp.delete(bucketKey);
      }
    }
    return this.createClient(ip, hostname, userAgent);
  }

  /**
   * Lookup by short client id (channel segment).
   *
   * @param id Client id.
   */
  getById(id: string): ClientRecord | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Lookup by cookie value. Invalid UUIDs return null.
   *
   * @param cookie Raw cookie string.
   */
  getByCookie(cookie: string): ClientRecord | null {
    const v = coerceUuid(cookie);
    return v ? (this.byCookie.get(v) ?? null) : null;
  }

  /**
   * Lookup by access token issued during the auth flow.
   *
   * @param token Bearer token.
   */
  getByToken(token: string): ClientRecord | null {
    const record = this.byToken.get(token);
    if (!record) {
      return null;
    }
    // v1.36.0 (S5): reject (and drop) an expired access token so the advertised
    // 30-min TTL is enforced — a captured token stops working once it expires.
    // Refresh tokens stay long-lived (byRefreshToken) for HA Companion compat.
    if (record.tokenExpiresAt != null && Date.now() > record.tokenExpiresAt) {
      this.byToken.delete(token);
      if (record.token === token) {
        record.token = null;
      }
      return null;
    }
    return record;
  }

  /**
   * Lookup by refresh token issued during the auth flow.
   *
   * @param refreshToken Refresh token value.
   */
  getByRefreshToken(refreshToken: string): ClientRecord | null {
    return this.byRefreshToken.get(refreshToken) ?? null;
  }

  /** Returns a snapshot array of all registered clients. */
  listAll(): ClientRecord[] {
    return [...this.byId.values()];
  }

  /**
   * Persist the URL a display was just sent to.
   *
   * Written only when the value differs from what the datapoint holds, so a display polling every 15–30 s costs
   * no writes while nothing moves — and no reads: the value is compared with {@link resolvedUrls}, which the start
   * fills from the datapoint (a display's first poll after a restart looked like a change to the caller, which only
   * knows what it served since the restart; audit 2026-09-15, C2).
   *
   * @param id  Client id.
   * @param url The resolved URL, or null for the landing page.
   */
  async setResolvedUrl(id: string, url: string | null): Promise<void> {
    if (!this.byId.has(id)) {
      return; // transient (throttled) record — it owns no objects
    }
    const val = url ?? "";
    const before = this.resolvedUrls.get(id);
    if (before === val) {
      return;
    }
    // Remembered before the write, so a second answer arriving meanwhile writes nothing twice; a failed write takes
    // it back, and the next answer tries again.
    this.resolvedUrls.set(id, val);
    try {
      await this.adapter.setState(`clients.${id}.resolvedUrl`, { val, ack: true });
    } catch (err) {
      if (this.resolvedUrls.get(id) === val) {
        if (before === undefined) {
          this.resolvedUrls.delete(id);
        } else {
          this.resolvedUrls.set(id, before);
        }
      }
      this.adapter.log.debug(`setResolvedUrl failed for ${id}: ${errText(err)}`);
    }
  }

  /**
   * Hand over the legacy `visUrl` values collected during {@link restore} and forget them.
   *
   * Empty on every installation migrated since v1.2.0 — which is the point: the migration
   * then does nothing at all instead of asking the broker once per client, every start.
   * Handing them over exactly once keeps a failed migration honest: the next start reads
   * the broker again rather than a stale in-memory copy.
   *
   * @returns Map of client id → raw legacy value; empty when there is nothing to migrate.
   */
  takeLegacyVisUrls(): Map<string, unknown> {
    const taken = new Map(this.legacyVisUrls);
    this.legacyVisUrls.clear();
    return taken;
  }

  /**
   * Updates the in-memory token and stores it in the data file. Old token is freed.
   *
   * @param id    Client id.
   * @param token New bearer token, or null to clear.
   * @returns Settles once the file holds the token; rejects when it cannot be written.
   */
  setToken(id: string, token: string | null): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return Promise.resolve();
    }
    this.trackToken(record, token);
    return this.persisted();
  }

  /**
   * Sets access AND refresh token in one write — the onboarding grant and the revoke
   * both change the pair (audit 2026-09-15, G1). The refresh token is stored plain-text
   * in the data file — same exposure profile as the access token (see
   * {@link ClientRecord.refreshToken}).
   *
   * @param id           Client id.
   * @param token        New bearer token, or null to clear.
   * @param refreshToken New refresh token, or null to clear.
   * @returns Settles once the file holds both tokens; rejects when it cannot be written.
   */
  setTokens(id: string, token: string | null, refreshToken: string | null): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return Promise.resolve();
    }
    this.trackToken(record, token);
    if (record.refreshToken) {
      this.byRefreshToken.delete(record.refreshToken);
    }
    record.refreshToken = refreshToken;
    if (refreshToken) {
      this.byRefreshToken.set(refreshToken, record);
    }
    return this.persisted();
  }

  /**
   * Write every identity this registry holds to the data file — the tracked displays and
   * the {@link carried} entries — as one synchronous replacement, so two writes can never
   * interleave. Throws when the file cannot be written.
   */
  private persist(): void {
    const clients = new Map(this.carried);
    for (const record of this.byId.values()) {
      const lastSeen = this.lastSeenFlushedAt.get(record.id);
      const appName = this.appNames.get(record.id);
      clients.set(record.id, {
        cookie: record.cookie,
        token: record.token,
        tokenExpiresAt: record.tokenExpiresAt,
        refreshToken: record.refreshToken,
        ...(lastSeen === undefined ? {} : { lastSeen }),
        ...(appName === undefined ? {} : { appName }),
        ...(record.hostname === null ? {} : { hostname: record.hostname }),
      });
    }
    writeStore(this.dataDir, this.adapter, this.serverUuid, clients);
  }

  /**
   * {@link persist} for the token setters, whose callers await them and answer the display
   * only once the identity is stored (Auth-Flow step 4): a failed write rejects.
   */
  private persisted(): Promise<void> {
    try {
      this.persist();
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(errText(err)));
    }
  }

  /**
   * {@link persist} where a failed write costs only a stamp or a stale entry the next start
   * drops — logged on debug.
   *
   * @param context What the write was for (log line).
   */
  private persistQuietly(context: string): void {
    try {
      this.persist();
    } catch (err) {
      this.adapter.log.debug(`client-registry: ${context} — the data file could not be written: ${errText(err)}`);
    }
  }

  /**
   * In-memory half of an access-token change: frees the old lookup entry, stamps the
   * expiry and indexes the new token.
   *
   * @param record Tracked client record.
   * @param token  New bearer token, or null to clear.
   */
  private trackToken(record: ClientRecord, token: string | null): void {
    if (record.token) {
      this.byToken.delete(record.token);
    }
    record.token = token;
    // v1.36.0 (S5): stamp the access-token expiry so the advertised 30-min TTL is
    // actually enforced (see getByToken) — a captured token can't be replayed forever.
    record.tokenExpiresAt = token ? Date.now() + OAUTH_ACCESS_TOKEN_TTL_S * 1000 : null;
    if (token) {
      this.byToken.set(token, record);
    }
  }

  /**
   * Accept an external mode write on `clients.<id>.mode`.
   *
   * Allowed values: `'global'`, `'manual'`, or any URL that passes
   * {@link coerceSafeUrl}. Empty string clears the choice → setup page.
   *
   * @param id       Client id.
   * @param rawValue Value written to the state.
   */
  async handleModeWrite(id: string, rawValue: unknown): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    // v1.23.0 (F2): central validation through parseModeWrite. client-registry and
    // global-config used to duplicate ~80% of the logic (no choice, non-string,
    // sentinel, URL coercion).
    const result = parseModeWrite(rawValue, [MODE_GLOBAL, MODE_MANUAL]);
    switch (result.kind) {
      case "no-choice":
        // "0" in memory too, not "" — the value the state carries and the dropdown key.
        // Two representations for one meaning made `bulkSetMode`'s equality skip miss:
        // a client sitting on "" got a pointless write every time the master switch went
        // off. I19 (v1.37.0) unified the STORED value; this unifies the in-memory one.
        record.mode = NO_CHOICE;
        await this.adapter.setState(`clients.${id}.mode`, { val: NO_CHOICE, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → cleared (no-choice)`);
        return;
      case "rejected-non-string":
        // v1.18.0 (G7): debug instead of warn — non-string mode writes are a UI
        // echo, not a server concern.
        this.adapter.log.debug(`client-registry: rejected non-string mode for ${id}`);
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || NO_CHOICE, ack: true });
        return;
      case "sentinel":
        if (result.value === MODE_MANUAL && !record.manualUrl) {
          // debug, not warn: writing the mode before the URL is a normal order (a script, two
          // clicks); the landing page and clients.<id>.resolvedUrl show the outcome
          // (audit 2026-09-25, Z1).
          this.adapter.log.debug(
            `Client ${id}: mode set to "manual" but manualUrl is empty — fill clients.${id}.manualUrl to redirect`,
          );
        }
        record.mode = result.value;
        await this.adapter.setState(`clients.${id}.mode`, { val: result.value, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → '${result.value}' (sentinel)`);
        return;
      case "rejected-unsafe-url":
        // The value stays out of the log: coerceSafeUrl rejects an address with user:pass@,
        // and echoing it put the password into the log (fleet rule, krobi 2026-11-11 18:17/18:20).
        this.adapter.log.warn(`Client ${id}: rejected unsafe mode value`);
        // L37: revert to `record.mode || 0` (not bare `record.mode`) so a blank
        // mode reverts to the string "0" the dropdown renders, matching the other
        // revert paths — a bare "" regresses the dropdown to no selection.
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || NO_CHOICE, ack: true });
        return;
      case "url":
        record.mode = result.value;
        await this.adapter.setState(`clients.${id}.mode`, { val: result.value, ack: true });
        this.adapter.log.debug(`Client ${id}: mode → ${result.value} (direct URL)`);
        return;
      // 'rejected-disallowed-sentinel' cannot occur here, because both sentinels
      // (global/manual) are allowed. Defensive: revert.
      default:
        await this.adapter.setState(`clients.${id}.mode`, { val: record.mode || NO_CHOICE, ack: true });
    }
  }

  /**
   * Accept an external manualUrl write on `clients.<id>.manualUrl`.
   * Free-text — must pass {@link coerceSafeUrl} or be empty (clears).
   *
   * @param id       Client id.
   * @param rawValue Value written to the state.
   */
  async handleManualUrlWrite(id: string, rawValue: unknown): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    const result = parseManualUrlWrite(rawValue);
    if (!result.ok) {
      this.adapter.log.warn(`Client ${id}: rejected unsafe manualUrl value`);
      await this.adapter.setState(`clients.${id}.manualUrl`, { val: record.manualUrl ?? "", ack: true });
      return;
    }
    record.manualUrl = result.safe;
    await this.adapter.setState(`clients.${id}.manualUrl`, { val: result.safe ?? "", ack: true });
    this.adapter.log.debug(`Client ${id}: manualUrl → ${result.safe ?? "cleared"}`);
    if (record.mode === MODE_MANUAL && !result.safe) {
      // debug, not warn: clearing the URL before switching the mode is a normal order (N8).
      this.adapter.log.debug(
        `Client ${id}: manualUrl cleared while mode is "manual" — display will see the setup page`,
      );
    }
  }

  /**
   * Set every client's `mode` to the same value. Used by the master switch
   * (`global.enabled`) to bulk-sync all displays — `'global'` when on,
   * `'0'` (no-choice → landing page) when off.
   *
   * Skips clients whose mode already matches (no spurious state writes).
   *
   * @param value New mode value (sentinel or URL).
   */
  async bulkSetMode(value: string): Promise<number> {
    // v1.8.1 (D7): parallel setState instead of sequential — with 50 displays that
    // used to be 50 sequential broker round trips. setState is broker-internal, running
    // them in parallel is safe.
    const writes: Array<Promise<unknown>> = [];
    let changed = 0;
    for (const record of this.byId.values()) {
      if (record.mode === value) {
        continue;
      }
      record.mode = value;
      writes.push(this.adapter.setState(`clients.${record.id}.mode`, { val: value, ack: true }));
      changed++;
    }
    if (writes.length > 0) {
      await Promise.all(writes);
    }
    if (changed > 0) {
      this.adapter.log.debug(`bulkSetMode applied to ${changed} client(s)`);
    }
    return changed;
  }

  /**
   * Removes the client entirely — channel + states deleted, next visit creates a new entry.
   *
   * @param id Client id to forget.
   */
  async remove(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (!record) {
      return;
    }
    this.untrack(record);
    this.persistQuietly(`forgetting ${id}`);
    let objectRemoved = true;
    try {
      await this.adapter.delObjectAsync(`clients.${id}`, { recursive: true });
    } catch (err) {
      objectRemoved = false;
      // Stack-trace level — Maintainer-Diagnose, EN bleibt.
      this.adapter.log.debug(`client-registry: delObject failed for ${id}: ${errText(err)}`);
    }
    if (objectRemoved) {
      // debug: the `remove` button gets no info line (krobi 2026-10-16 07:29/07:39), and
      // the stale-client GC already sums its removals in one info line.
      this.adapter.log.debug(`Client forgotten: ${id}`);
    } else {
      // The in-memory maps are already cleared, but the object survived and will
      // be read back as a client on the next restart — don't claim success, or
      // the "why is it back?" diagnosis costs the time this log should save.
      // v1.37.0 (L28).
      this.adapter.log.warn(
        `Client ${id} forgotten in memory, but its object could not be removed — it will reappear after an adapter restart`,
      );
    }
  }

  /**
   * Updates the mode dropdown states (`common.states`) on every client's mode datapoint.
   * Adds the `'global'` and `'manual'` sentinels on top of the discovered URLs.
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states: UrlStates): Promise<void> {
    this.currentUrlStates = states;
    const merged = this.buildModeStates();
    // v1.27.2: extendObject deep-merges `common.states` — URL keys that are no longer
    // discovered would stay in the dropdown (seen after the v1.26→v1.27 URL format
    // change: old `vis-2.0/main/index.html` keys beside new `vis-2/index.html?main`).
    // Read the object, replace common.states wholesale, then ONE full write via
    // replaceObjectPreservingValue (setForeignObject since v1.45.0 — the earlier
    // delete + recreate pair struck the datapoint from every enum).
    // v1.30.0 (R4): get+write per client in parallel instead of sequentially, like
    // gcStaleClients in main.ts (v1.28.3 M5) — noticeable on display farms with 30+
    // clients, which used to cost 2×N broker round-trips in sequence.
    await Promise.all(
      Array.from(this.byId.keys()).map(async id => {
        const stateId = `clients.${id}.mode`;
        const existing = await this.adapter.getObjectAsync(stateId);
        if (!existing) {
          return;
        }
        // Skip the write when the dropdown is already identical — avoids a full
        // object write (jsonl churn + objectChange fan-out) per client on every
        // discovery run that changed nothing. v1.37.0 (I4).
        if (shallowStatesEqual(existing.common.states, merged)) {
          return;
        }
        existing.common.states = merged;
        await replaceObjectPreservingValue(this.adapter, stateId, existing);
      }),
    );
  }

  // --- internal ---

  /**
   * Drop a record from every lookup map — the inverse of {@link trackInMemory}.
   *
   * @param record The record to forget in memory.
   */
  private untrack(record: ClientRecord): void {
    this.byId.delete(record.id);
    this.byCookie.delete(record.cookie);
    if (record.token) {
      this.byToken.delete(record.token);
    }
    if (record.refreshToken) {
      this.byRefreshToken.delete(record.refreshToken);
    }
    // v1.8.1 (D2): the lastSeen throttle entry goes too — on an id reuse (16M space, possible
    // after years) it would suppress the new display's first lastSeen write; plus a small leak.
    this.lastSeenFlushedAt.delete(record.id);
    this.ipChangedAt.delete(record.id);
    this.appNames.delete(record.id);
    this.writtenNames.delete(record.id);
    this.resolvedUrls.delete(record.id);
  }

  private trackInMemory(record: ClientRecord): void {
    this.byId.set(record.id, record);
    this.byCookie.set(record.cookie, record);
    if (record.token) {
      this.byToken.set(record.token, record);
    }
    if (record.refreshToken) {
      this.byRefreshToken.set(record.refreshToken, record);
    }
  }

  /**
   * The id of a new display (K7, display-id.ts) that no display holds — neither a tracked one nor one the data file
   * still carries. Shared by the persistent and the transient path: a transient id that collided with a live display
   * used to make that display's `byId` checks succeed for a stranger's request (audit 2026-09-15, B3).
   *
   * @param userAgent The User-Agent of the display's first request — the model in it starts the id.
   */
  private freshClientId(userAgent: string | null): string {
    return newDisplayId(userAgent, randomIdTail(), id => this.byId.has(id) || this.carried.has(id));
  }

  private async createClient(
    ip: string | null,
    hostname: string | null,
    userAgent: string | null,
  ): Promise<ClientRecord> {
    const record = this.buildRecord(this.freshClientId(userAgent), ip, hostname, true);
    const { id } = record;
    // Tracked BEFORE the objects are written: freshClientId() checks byId, so a second
    // display arriving meanwhile cannot draw the same id.
    this.trackInMemory(record);
    // The first lastSeen stamp goes into the same write as the cookie; the device is created with the name below.
    this.lastSeenFlushedAt.set(id, Date.now());
    this.writtenNames.set(id, this.wantName(record));
    try {
      // The identity is stored before the objects exist — a display is never handed a
      // cookie the next start would not know.
      this.persist();
      await this.createObjects(record);
    } catch (err) {
      // A display whose identity or objects could not be written must not stay in the lookup
      // maps: it would answer byId/byCookie with no object behind it, grow the maps with every
      // retry, and neither throttle would count it (audit 2026-09-25, L6).
      this.untrack(record);
      this.persistQuietly(`rolling back the new display ${id}`);
      throw err;
    }
    this.adapter.log.info(
      ip ? `New client connected: ${id} (${oneLine(hostname ?? ip)})` : `New client connected: ${id}`,
    );
    // Count this persistent create against the global, IP-independent ceiling
    // (the trustProxy / spoofed-X-Forwarded-For bound; see isGloballyThrottled).
    this.recordGlobalCreate();
    // v1.19.0 (G5): IP burst detection for broken-cookie displays. A persistent
    // create bumps the sliding-window count and warns once per window if the same
    // IP mints more than NEW_CLIENT_BURST_WARN_THRESHOLD clients (cookie mechanism
    // broken on the display: aggressive privacy, refresh bug).
    if (ip) {
      this.recordNewClientActivity(ip, true);
    }
    return record;
  }

  /**
   * True when `ip` has minted at least {@link NEW_CLIENT_THROTTLE_PER_HOUR} new
   * clients AND is still active within the sliding {@link NEW_CLIENT_WINDOW_MS}.
   * Once true, `identifyOrCreate` hands out transient records (no object). An IP
   * that stops spraying for a full window recovers here; {@link recordNewClientActivity}
   * refreshes the window on every cookieless request (throttled or not), so
   * continuous spraying never recovers. v1.37.0 (M4).
   *
   * @param ip  Remote IP to check.
   * @param now Current time in ms (injectable for tests).
   */
  private isIpThrottled(ip: string, now: number = Date.now()): boolean {
    const entry = this.newClientBurst.get(ip);
    if (!entry || now - entry.lastActivity >= NEW_CLIENT_WINDOW_MS) {
      return false;
    }
    return entry.count >= NEW_CLIENT_THROTTLE_PER_HOUR;
  }

  /**
   * True when the global persistent-create window is over budget. IP-independent
   * companion to {@link isIpThrottled}; see {@link globalBurst} +
   * {@link GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW}. Read-only — the window is advanced
   * by {@link recordGlobalCreate} on an actual persistent create, and reset after a
   * full idle {@link NEW_CLIENT_WINDOW_MS}.
   *
   * @param now Current time in ms (injectable for tests).
   */
  private isGloballyThrottled(now: number = Date.now()): boolean {
    if (now - this.globalBurst.lastCreate >= NEW_CLIENT_WINDOW_MS) {
      return false;
    }
    return this.globalBurst.count >= GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW;
  }

  /**
   * Records one persistent cookieless create into the global window. Resets the
   * window (count + warn cooldown) after a full idle {@link NEW_CLIENT_WINDOW_MS}, so
   * a continuous spray keeps the window alive and stays throttled while normal
   * onboarding — gaps far longer than the window — always starts fresh. Called only
   * from {@link createClient}, the single persistent-create site.
   *
   * @param now Current time in ms (injectable for tests).
   */
  private recordGlobalCreate(now: number = Date.now()): void {
    if (now - this.globalBurst.lastCreate >= NEW_CLIENT_WINDOW_MS) {
      this.globalBurst.count = 0;
      this.globalBurst.warnedAt = 0;
    }
    this.globalBurst.count += 1;
    this.globalBurst.lastCreate = now;
  }

  /**
   * One warn per window when the global ceiling is serving transient records — the
   * signature of a spoofed-`X-Forwarded-For` spray (or `trustProxy` set without a
   * sanitising proxy). Deduplicated against `warnedAt`, which resets with the window.
   *
   * @param now Current time in ms.
   */
  private warnGlobalThrottleOnce(now: number): void {
    if (now - this.globalBurst.warnedAt > NEW_CLIENT_WINDOW_MS) {
      this.adapter.log.warn(
        `More than ${GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW} new clients within an hour across all IPs — throttling persistent client creation (a spoofed X-Forwarded-For spray, or trustProxy enabled without a sanitising reverse proxy?)`,
      );
      this.globalBurst.warnedAt = now;
    }
  }

  /**
   * A non-persisted, untracked client handed out when an IP is over the
   * new-client throttle. No `clients.<id>` object is created and the record is
   * not added to any lookup map, so a cookieless spray cannot grow the object
   * DB. Mode is the normal new-client default, so a legitimate-but-throttled
   * client (e.g. behind a busy NAT) still resolves to the configured dashboard
   * — it just doesn't get a persistent identity.
   *
   * @param ip       Remote IP (advisory).
   * @param hostname Reverse-DNS hostname, if any.
   */
  private transientRecord(ip: string | null, hostname: string | null): ClientRecord {
    return this.buildRecord(this.freshClientId(null), ip, hostname, false);
  }

  /**
   * Builds a fresh ClientRecord with a new cookie and the current default mode.
   * Single construction site so every field — notably the nullable
   * token / tokenExpiresAt / refreshToken — is set in exactly one place:
   * createClient persists + tracks it, transientRecord hands it out untracked.
   * v1.37.0 (L13).
   *
   * @param id         Short client id (see {@link freshClientId}).
   * @param ip         Last observed IP.
   * @param hostname   Reverse-DNS hostname, if any.
   * @param persistent Whether the record is backed by objects (see {@link ClientRecord.persistent}).
   */
  private buildRecord(id: string, ip: string | null, hostname: string | null, persistent: boolean): ClientRecord {
    return {
      id,
      cookie: crypto.randomUUID(),
      token: null,
      tokenExpiresAt: null,
      refreshToken: null,
      mode: this.newClientModeProvider(),
      manualUrl: null,
      ip,
      hostname,
      persistent,
    };
  }

  /**
   * Records cookieless-identify activity for an IP into the sliding burst window.
   * Called on EVERY cookieless identify — a persistent create (`persistent = true`,
   * bumps the count and may warn once per window) and a throttled transient
   * (`persistent = false`, only refreshes `lastActivity`). Refreshing on the
   * throttled path is what keeps a continuously-spraying IP from recovering. The
   * window resets only after a full idle window. Map-cap 200 (FIFO).
   * v1.19.0 (G5); sliding window v1.37.0 (M4).
   *
   * @param ip         Remote IP that just performed a cookieless identify.
   * @param persistent True if a persistent client was minted (bumps the count).
   * @param now        Current time in ms (injectable for tests).
   */
  private recordNewClientActivity(ip: string, persistent: boolean, now: number = Date.now()): void {
    let entry = this.newClientBurst.get(ip);
    if (!entry || now - entry.lastActivity >= NEW_CLIENT_WINDOW_MS) {
      // Fresh IP, or one idle for a full window → start a new window.
      entry = { count: 0, lastActivity: now, warnedAt: 0 };
    }
    entry.lastActivity = now;
    if (persistent) {
      entry.count += 1;
      if (entry.count > NEW_CLIENT_BURST_WARN_THRESHOLD && now - entry.warnedAt > NEW_CLIENT_WINDOW_MS) {
        this.adapter.log.warn(
          `IP ${ip} created ${entry.count} clients within an hour — display likely is not persisting cookies (privacy mode? refresh bug?)`,
        );
        entry.warnedAt = now;
      }
    }
    this.newClientBurst.set(ip, entry);
    // v1.32.0: soft-cap via shared `evictOldest`.
    evictOldest(this.newClientBurst, NEW_CLIENT_BURST_CAP);
  }

  /**
   * Stores the client's `lastSeen` in the data file, throttled to once per hour per
   * client. Used for the stale-client-GC: clients whose lastSeen lies 30 days
   * behind the most recently seen display get auto-removed on adapter start.
   *
   * Failures only debug-logged.
   *
   * @param record Client whose lastSeen-timestamp should be refreshed.
   */
  private touchLastSeen(record: ClientRecord): void {
    // Only for persistent, tracked records. A transient (throttled) record owns no
    // identity, and a record removed while a request was still in flight must not be
    // resurrected by a stamp. v1.37.0 (M5).
    if (!record.persistent || !this.byId.has(record.id)) {
      return;
    }
    const now = Date.now();
    const last = this.lastSeenFlushedAt.get(record.id) ?? 0;
    if (now - last < LASTSEEN_FLUSH_INTERVAL_MS) {
      return; // throttle: once per flush interval
    }
    this.lastSeenFlushedAt.set(record.id, now);
    this.persistQuietly(`lastSeen of ${record.id}`);
  }

  /**
   * v1.19.0 (F11): the one path that seeds lastSeen. main.ts gcStaleClients used to
   * carry its own write with the same format — a duplicate that would break the day
   * the format changes. Both paths use this method now. The throttle map is updated
   * too, so the next touchLastSeen does not overwrite the seed right away.
   *
   * @param id  Client id (short segment, without the `clients.` prefix).
   * @param now Optional timestamp for tests; default Date.now().
   */
  seedLastSeen(id: string, now: number = Date.now()): void {
    if (!this.byId.has(id)) {
      return;
    }
    this.lastSeenFlushedAt.set(id, now);
    this.persistQuietly(`seeding lastSeen of ${id}`);
  }

  /**
   * The last `lastSeen` this registry knows for a client — restored from the data file
   * (or an earlier version's device object) on start, advanced by every flush. `undefined`
   * for a client that never got a stamp (pre-1.2.0) — the stale-GC seeds one then. Lets
   * the GC decide without a second read per display (audit 2026-09-15, D1).
   *
   * @param id Client id.
   */
  lastSeenOf(id: string): number | undefined {
    return this.lastSeenFlushedAt.get(id);
  }

  /**
   * Builds the dropdown-states map for `clients.<id>.mode`. Includes the
   * `0='---'` no-choice fallback (analogous to the govee-smart pattern), the
   * `'global'` + `'manual'` sentinels, and all currently discovered URLs.
   */
  private buildModeStates(): UrlStates {
    // v1.20.0 (F4): the shared helper (state-write-rules.ts). global-config used to
    // duplicate it — except for the extra `global` sentinel here: a client can delegate
    // to global with `mode='global'`, global itself cannot.
    // resolveLabel() returns a plain string (I18n.translate, resolved in the
    // system language loaded at I18n.init) — NOT a translation object: Admin
    // renders common.states VALUES directly as a React child and crashes on
    // translation objects with React Error #31. v1.28.0 slipped a translation
    // object in here via an `as unknown as string` cast that satisfied the type
    // check but broke the admin dropdown on open.
    // Memory `reference_common_states_plain_string_only`.
    return buildDropdownStates(
      {
        [MODE_GLOBAL]: resolveLabel("globalUrl"),
        [MODE_MANUAL]: resolveLabel("manualUrl"),
      },
      this.currentUrlStates,
    );
  }

  /**
   * Idempotently creates all per-client objects (channel + states). Safe to
   * call repeatedly — uses `setObjectNotExistsAsync` everywhere. Called from
   * both `restore()` (so legacy v1.1.x clients gain the new mode/manualUrl
   * objects before migration writes states) and `createClient()`.
   *
   * @param record        Client to create or ensure objects for.
   * @param refreshStates  When true (runtime) the mode dropdown states are compared and
   *                       refreshed; when false (restore, before URL discovery) only a
   *                       broken schema is repaired and states are left untouched (L1).
   * @param storedVersion  The `native.objectsVersion` this client's objects were last
   *                       written with. Equal to {@link CLIENT_OBJECTS_VERSION} → the texts
   *                       are current and only EXISTENCE is guaranteed (no write). Older or
   *                       missing → the texts that differ are refreshed once (the restore renews the stamp).
   *                       Defaults to 0 (unknown) so `createClient` always writes in full.
   * @param stored         The datapoint objects as the restore read them (full id → object): a refresh leaves out
   *                       a datapoint that already carries its texts. Empty → every refresh writes.
   */
  private async ensureObjects(
    record: ClientRecord,
    refreshStates = true,
    storedVersion = 0,
    stored: ReadonlyMap<string, ioBroker.Object> = new Map(),
  ): Promise<void> {
    const { id } = record;
    const mergedStates = this.buildModeStates();
    // Whether the four per-client texts have to be (re)written this start. See
    // CLIENT_OBJECTS_VERSION: v1.41.0 wrote them unconditionally — four broker calls per
    // display per start to deliver a text that changes about once a year.
    const textsCurrent = storedVersion === CLIENT_OBJECTS_VERSION;

    // Device (I22 v1.37.0): each client is a `device` — it represents a physical
    // display, matching the ioBroker convention (and govee-smart) of `device` for a
    // physical thing. Legacy `channel` client objects are migrated to `device` on
    // restore (see restoreChannel). setObjectNotExistsAsync — common.name is updated
    // dynamically by updateIpHostname() when reverse-DNS resolves; we must not clobber it.
    // v1.41.0: the auto-name goes in as a translation object like every other name
    // (core team, nut2 #15). The TEXT is unchanged — it is the display's own hostname
    // (or its IP / id); `tRaw` only offers it under every language key so the object
    // browser shows it whatever the system language is.
    // A freshly created device carries the current text revision from the start: its
    // objects are written with the current texts below, so the separate stamp write
    // and the second name write of the old create path were two writes for nothing
    // (audit 2026-09-15, G2). On restore the object exists and this is a no-op.
    // The pictogram (R-19) is an INPUT of this create, the stored device gets it through the
    // version write below — once, then the stamp is current (CLAUDE_PATTERNS.md § Geräte-Piktogramme).
    const icon = displayIcon();
    await this.adapter.setObjectNotExistsAsync(`clients.${id}`, {
      type: "device",
      common: {
        name: tRaw(this.wantName(record)),
        ...(icon === undefined ? {} : { icon }),
      },
      // Only the text revision: cookie, tokens and lastSeen live in the data file (client-store.ts).
      native: { objectsVersion: CLIENT_OBJECTS_VERSION },
    });

    // States:
    //   - `clients.<id>.mode` uses get + one full write (replaceObjectPreservingValue,
    //     like the `global-config.ts` v1.27.2 fix): extendObject deep-merges
    //     common.states, so old i18n-object keys from pre-v1.28.4 installs stayed
    //     under the same keys → React error #31 when the admin opened the dropdown.
    //     The full write replaces common wholesale (custom subscriptions such as
    //     influxdb.0 survive via the spread of `existing`).
    //   - The repair path for partially formed objects (v1.2.0 migration bug: common
    //     without top-level type/name/role) is covered too: the existing fields are
    //     overwritten completely by the full schema common.
    //   - `clients.<id>.manualUrl` stays extendObject — it has no states field, so
    //     no risk of an i18n object there.
    const modeFullCommon: ioBroker.StateCommon = {
      // tName returns StringOrTranslated, which common.name/desc accept directly.
      name: tName("clientMode"),
      // M3 (v1.38.0): explain the mode dropdown (incl. the "---" landing-page option)
      // right on the datapoint. New/repaired objects carry it; existing valid objects
      // are intentionally not rewritten just to add a doc field (would defeat L1).
      desc: tName("clientModeDesc"),
      // Every value is text — "0", `global`, `manual` or a URL (review 2026-11-07, R-17: the
      // inventory gate's `native-type` and `fallback-role` rules); an older `mixed`/`state`
      // object is repaired by the schema check below.
      type: "string",
      role: "text",
      read: true,
      write: true,
      // I19: no-choice sentinel is the STRING "0" everywhere (matches the dropdown key
      // built by buildDropdownStates); a numeric default would be a lone drift from
      // that convention. v1.38.0 (I2).
      def: NO_CHOICE,
      states: mergedStates,
    };
    // Whether it wrote the full schema — which carries the current name and description.
    const ensureModeObject = async (refreshStates: boolean): Promise<boolean> => {
      const path = `clients.${id}.mode`;
      const existing = await this.adapter.getObjectAsync(path);
      if (!existing) {
        await this.adapter.setObjectNotExistsAsync(path, { type: "state", common: modeFullCommon, native: {} });
        return true;
      }
      // ensureObjects runs on every restart for every client. Skip the rewrite when the
      // object already matches the desired schema — an unconditional replace was 1
      // write/client/start plus an objectChange fan-out for no change (I6). On the
      // RESTORE pass (refreshStates=false) currentUrlStates is still empty (discovery
      // runs later), so mergedStates carries no URL keys; comparing/writing states here
      // would STRIP the persisted URLs only for syncUrlDropdown to write them straight
      // back — 2× object replace per client per restart (L1 v1.38.0). syncUrlDropdown
      // is the single states authority, so on restore we repair only a broken schema
      // and never touch states.
      const c = existing.common;
      const schemaOk = existing.type === "state" && c?.type === "string" && c.role === "text";
      const statesOk = refreshStates ? shallowStatesEqual(c?.states, mergedStates) : true;
      if (schemaOk && statesOk) {
        return false;
      }
      // The name/desc of `.mode` are the adapter's own text (tName), never the user's —
      // a broken schema is repaired with the CURRENT text, not with whatever the tree
      // held (audit 2026-09-15, E3; the device name is the user-owned one, not this).
      const preservedStates = refreshStates ? mergedStates : (c?.states ?? mergedStates);
      existing.common = { ...c, ...modeFullCommon, states: preservedStates };
      existing.type = "state";
      await replaceObjectPreservingValue(this.adapter, path, existing);
      return true;
    };
    // v1.41.0: the schema pass above deliberately keeps whatever name is in the tree
    // (and returns early when the schema is fine), so the CURRENT text can only reach an
    // existing object through its own `extendObject`. Sequenced AFTER the schema pass —
    // running both concurrently would let the full-object replace overwrite this write.
    // Only name/desc go in: `states` stays with syncUrlDropdown, its single authority,
    // and `extendObject` deep-merges `states` (v1.27.2).
    const refreshModeText = async (): Promise<void> => {
      // A just created or repaired object carries the current texts already — a second write would change nothing
      // (inventory: "writes no object more than MAX_OBJECT_WRITES times", 2026-11-12).
      const written = await ensureModeObject(refreshStates);
      const patch = { common: { name: tName("clientMode"), desc: tName("clientModeDesc") } };
      if (!textsCurrent && !written && !coveredBy(patch, stored.get(`${this.adapter.namespace}.clients.${id}.mode`))) {
        await this.adapter.extendObject(`clients.${id}.mode`, patch);
      }
    };

    // The three plain states. `extendObject` carries a CHANGED text into an object that
    // already exists (what `setObjectNotExists` never did — measured on the live tree
    // 2026-09-03: `.ip` still read "Client IP", `.remove` "Forget this client"), but it
    // also writes when nothing changed. So: while the stamp is behind, write each one whose
    // texts differ from what the restore read (a bump for one datapoint rewrote all four
    // before), and otherwise fall back to `setObjectNotExists`, which still RE-CREATES an
    // object somebody deleted in the object browser but writes nothing when it is there.
    const stateSchemas: Array<[string, ioBroker.StateCommon]> = [
      [
        `clients.${id}.manualUrl`,
        {
          name: tName("clientManualUrl"),
          desc: tName("clientManualUrlDesc"),
          type: "string",
          role: "url",
          read: true,
          write: true,
          def: "",
        },
      ],
      [
        `clients.${id}.ip`,
        { name: tName("clientIp"), type: "string", role: "info.ip", read: true, write: false, def: "" },
      ],
      [
        // Read-only: what the resolver ACTUALLY answered for this display. `mode` shows the
        // CHOICE; with `mode = global` the user had to walk the chain (global.mode → maybe
        // global.manualUrl) by hand to learn where the display went. The adapter computes
        // this on every request anyway — it just never wrote it down.
        `clients.${id}.resolvedUrl`,
        {
          name: tName("clientResolvedUrl"),
          desc: tName("clientResolvedUrlDesc"),
          type: "string",
          role: "url",
          read: true,
          write: false,
          def: "",
        },
      ],
      [
        `clients.${id}.remove`,
        {
          name: tName("clientRemove"),
          desc: tName("clientRemoveDesc"),
          type: "boolean",
          role: "button",
          read: false,
          write: true,
          def: false,
        },
      ],
    ];

    await Promise.all([
      refreshModeText(),
      ...stateSchemas.map(([path, common]) => {
        const patch = { type: "state" as const, common, native: {} };
        if (textsCurrent) {
          return this.adapter.setObjectNotExistsAsync(path, patch);
        }
        return coveredBy(patch, stored.get(`${this.adapter.namespace}.${path}`))
          ? Promise.resolve()
          : this.adapter.extendObject(path, patch);
      }),
    ]);
    // The revision stamp is written by the restore, together with the rest of the device (restoreChannel); a new
    // display carries the current revision from its create above.
  }

  private async createObjects(record: ClientRecord): Promise<void> {
    // The objects of a new display are created with the current texts — the revision
    // is current by construction, so ensureObjects takes the existence-only path.
    await this.ensureObjects(record, true, CLIENT_OBJECTS_VERSION);
    const { id, mode, ip } = record;
    await Promise.all([
      this.adapter.setState(`clients.${id}.ip`, { val: ip ?? "", ack: true }),
      this.adapter.setState(`clients.${id}.mode`, { val: mode, ack: true }),
      this.adapter.setState(`clients.${id}.manualUrl`, { val: "", ack: true }),
    ]);
  }

  /**
   * Store a display's new address — without an app name and a host name it is also the device name (K7).
   *
   * @param record The display.
   * @param ip     Its new address.
   */
  private async applyIpChange(record: ClientRecord, ip: string): Promise<void> {
    record.ip = ip;
    await this.adapter.setState(`clients.${record.id}.ip`, { val: ip, ack: true });
    await this.applyName(record);
  }

  private async updateIpHostname(record: ClientRecord, ip: string | null, hostname: string | null): Promise<void> {
    if (ip && ip !== record.ip) {
      const now = Date.now();
      // At most one address change per window: with trustProxy the address is a
      // client-supplied header, and every rotated value cost a state and an object write
      // (audit 2026-09-25, H4). Neither memory nor state moves inside the window — updating
      // memory alone would leave the datapoint stale for good.
      if (now - (this.ipChangedAt.get(record.id) ?? 0) < IP_CHANGE_MIN_INTERVAL_MS) {
        this.adapter.log.silly(`client-registry: address change for ${record.id} deferred (at most one per minute)`);
      } else {
        this.ipChangedAt.set(record.id, now);
        await this.applyIpChange(record, ip);
      }
    }
    if (hostname) {
      await this.applyHostname(record, hostname);
    }
  }

  /**
   * Updates a KNOWN client's reverse-DNS hostname — the target of the web server's
   * asynchronous reverse-DNS callback. A byCookie miss is a deliberate no-op: the
   * client was removed (or the cookie became unknown) while the up-to-5s lookup
   * ran, and we must NOT create a new client here — that would mint a ghost with a
   * fresh cookie no display owns. Replaces the earlier `identifyOrCreate` misuse
   * as an update channel. v1.37.0 (M5).
   *
   * @param cookie   Cookie of the client whose hostname resolved.
   * @param hostname Reverse-DNS hostname (untrusted).
   */
  async updateHostname(cookie: string, hostname: string): Promise<void> {
    const record = this.getByCookie(cookie);
    if (record) {
      await this.applyHostname(record, hostname);
    }
  }

  /**
   * Store a display's resolved host name in the data file — the start names the display by it (K7) — and make it the
   * device name unless the app reported one.
   *
   * @param record Tracked client record.
   * @param raw    Resolved host name (untrusted: a PTR label is attacker-influenceable, L1(a)).
   */
  private async applyHostname(record: ClientRecord, raw: string): Promise<void> {
    const hostname = coerceHostname(raw);
    if (hostname === null || hostname === record.hostname) {
      return;
    }
    record.hostname = hostname;
    this.persistQuietly(`the host name of ${record.id}`);
    await this.applyName(record);
  }

  /**
   * Store the device name a display's Companion app reported (K7) and make it the display's name — it follows every
   * change in the app. Never rejects: the webhook answers regardless.
   *
   * @param id  Client id.
   * @param raw The app's `device_name` (untrusted).
   */
  async setAppName(id: string, raw: unknown): Promise<void> {
    try {
      const record = this.byId.get(id);
      const name = coerceDeviceName(raw);
      if (!record || name === null || name === this.appNames.get(id)) {
        return;
      }
      this.appNames.set(id, name);
      this.persistQuietly(`the app's device name of ${id}`);
      await this.applyName(record);
    } catch (err) {
      this.adapter.log.debug(`client-registry: the app's device name of ${id} could not be applied: ${errText(err)}`);
    }
  }

  /**
   * The name hassemu names a display by (K7): the device name its Companion app reported, else the host name its
   * address resolved to, else the address, else the id.
   *
   * @param record The display.
   */
  private wantName(record: ClientRecord): string {
    return this.appNames.get(record.id) ?? record.hostname ?? record.ip ?? record.id;
  }

  /**
   * Write the display's name ({@link wantName}) when its sources changed it — compared with the name hassemu last
   * wrote, never with the tree: the name belongs to the adapter, a name typed in the object tree is no source and
   * does not stay (krobi 2026-09-02, fleet rule; 2026-11-11 22:40 „Adapter hat sich an die Flotte zu halten!“ — up
   * to 1.46.1 a read-before-write kept it, v1.36.0 C4 / v1.37.0 M1). Written as a translation object (v1.41.0).
   *
   * @param record Tracked client record.
   */
  private async applyName(record: ClientRecord): Promise<void> {
    if (this.byId.get(record.id) !== record) {
      return;
    }
    const want = this.wantName(record);
    if (this.writtenNames.get(record.id) === want) {
      return;
    }
    await this.adapter.extendObject(`clients.${record.id}`, { common: { name: tRaw(want) } });
    this.writtenNames.set(record.id, want);
  }
}

/**
 * Check whether a full state ID matches a client control datapoint and extract id + kind.
 *
 * @param fullId    The full state id from a state change event.
 * @param namespace The adapter namespace (e.g. `hassemu.0`).
 */
export function parseClientStateId(
  fullId: string,
  namespace: string,
): { id: string; kind: "mode" | "manualUrl" | "remove" } | null {
  // v1.20.0 (F9): the generic parseAdapterStateId helper. client-registry used to
  // duplicate the prefix + tail validation of global-config.parseGlobalStateId.
  const parts = parseAdapterStateId(fullId, namespace, CLIENTS_PREFIX, 2);
  if (!parts) {
    return null;
  }
  const [id, kind] = parts;
  // v1.9.0 (E5): empty id rejection (`clients..mode` would parse to id='').
  if (!id) {
    return null;
  }
  if (kind !== "mode" && kind !== "manualUrl" && kind !== "remove") {
    return null;
  }
  return { id, kind };
}
