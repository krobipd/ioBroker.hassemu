/**
 * ioBroker object/state helpers — reading and comparing the shapes the broker hands back.
 *
 * Split out of `coerce.ts` in v1.43.0. These are not boundary coercion: they know what an
 * ioBroker `common.name` looks like in both of its forms, how a state id is built, and how
 * to compare a `common.states` dropdown. Keeping them next to the URL/UUID validators made
 * the module's name cover about a third of its contents.
 */

import { isPlainObject } from "./coerce";

/** Minimal-Surface für `safeGetState` — Tests können das mocken. */
export interface StateReader {
  /** Returns the state for `id`, or `null|undefined` if it does not exist. */
  getStateAsync: (id: string) => Promise<ioBroker.State | null | undefined>;
}

/**
 * Read the plain text out of a `common.name`, whichever form it has.
 *
 * `common.name` is either a bare string (what every version before v1.41.0 wrote)
 * or a translation object (what the adapter writes now). Every comparison against
 * a name — "is this still the auto-assigned one?", "does this hold a hostname?" —
 * has to work on both, otherwise converting the form silently breaks the logic that
 * reads it. English is the reference key because that is the language the adapter
 * writes its own auto-names in.
 *
 * @param value `common.name` as read from an object.
 * @returns The text, or null when there is none.
 */
export function nameText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (isPlainObject(value)) {
    const en = value.en;
    if (typeof en === "string" && en.length > 0) {
      return en;
    }
  }
  return null;
}

/**
 * True when `common.name` is still a bare string — i.e. the object predates the
 * translation-object standard and needs converting.
 *
 * @param value `common.name` as read from an object.
 */
export function isBareStringName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * v1.20.0 (F10): try/catch + null-Fallback um `getStateAsync`. Vorher hatten
 * `client-registry.readState` und `global-config.safeGetState` identische
 * Wrapper. Caller extrahieren `.val` selbst, wenn sie nur den Wert wollen.
 *
 * @param adapter Anything that exposes `getStateAsync(id)`.
 * @param id      Voller State-ID (mit Namespace) oder relativer Pfad — wie der
 *                Caller das schon bisher übergeben hat.
 */
export async function safeGetState(adapter: StateReader, id: string): Promise<ioBroker.State | null> {
  try {
    return (await adapter.getStateAsync(id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * v1.20.0 (F9): generischer Parser für Namespace-Prefix-Tail-Kind State-IDs.
 * Vorher hatten `parseClientStateId` und `parseGlobalStateId` identische
 * Prefix-Validierung + Split-Logik. Beide delegieren jetzt hier.
 *
 * Beispiel: `parseAdapterStateId('hassemu.0.clients.abc.mode', 'hassemu.0', 'clients.', 2)`
 * liefert `['abc', 'mode']` (zwei Tail-Parts mit `clients.<id>.<kind>`).
 *
 * @param fullId      Voller State-ID aus dem Event.
 * @param namespace   Adapter-Namespace (z.B. `hassemu.0`).
 * @param prefix      Sub-Pfad nach dem Namespace, **mit** trailing dot (z.B. `clients.`).
 * @param expectedParts Anzahl erwarteter Tail-Segmente (1 für `global.<kind>`, 2 für `clients.<id>.<kind>`).
 * @returns Tail-Segments als Tuple, oder `null` wenn Prefix/Anzahl nicht passt.
 */
export function parseAdapterStateId(
  fullId: string,
  namespace: string,
  prefix: string,
  expectedParts: number,
): string[] | null {
  const fullPrefix = `${namespace}.${prefix}`;
  if (!fullId.startsWith(fullPrefix)) {
    return null;
  }
  const tail = fullId.substring(fullPrefix.length);
  const parts = tail.split(".");
  if (parts.length !== expectedParts) {
    return null;
  }
  return parts;
}

/**
 * Drops oldest entries from a Map until size is below `cap`. Map iteration order
 * in JS is insertion order, so `keys().next()` is the oldest. While-loop is
 * defensive — if `cap` is lowered at runtime or a bulk-insert pushes multiple
 * entries past the threshold in one call, all overflow gets evicted.
 *
 * v1.32.0: konsolidiert aus `webserver.ts:evictOldest` (private static, while-loop)
 * und `client-registry.ts:recordNewClientIp` (single-shot inline) zu einem shared
 * helper.
 *
 * @param map Map to evict from.
 * @param cap Hard cap — evicts while `map.size >= cap`.
 */
export function evictOldest<V>(map: Map<string, V>, cap: number): void {
  while (map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

/**
 * Order-independent shallow equality for a `common.states` dropdown map (flat
 * string→string). Used to skip an object rewrite when the discovered dropdown
 * has not changed. A non-object `a`, or any differing key/value, counts as
 * unequal — so a malformed or stale existing object is always rewritten (repaired).
 *
 * @param a Existing states value from the broker (untrusted shape).
 * @param b Freshly built states map.
 */
export function shallowStatesEqual(a: unknown, b: Record<string, string>): boolean {
  if (!isPlainObject(a)) {
    return false;
  }
  const bKeys = Object.keys(b);
  if (Object.keys(a).length !== bKeys.length) {
    return false;
  }
  for (const k of bKeys) {
    if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}
