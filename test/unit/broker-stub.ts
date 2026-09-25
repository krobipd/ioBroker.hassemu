/**
 * Object-store semantics of js-controller 7.2.2, shared by the unit-test adapter stubs.
 *
 * A stub that merges `common` flat, or deletes a state whose object never existed, lets a
 * test pass against behaviour the broker does not have: a regression to
 * `extendObject(id, { common: { states } })` stayed green because the flat merge replaced
 * `states`, while the broker merges deeply and keeps every stale key (audit 2026-09-25, T1).
 * Sources, js-controller v7.2.2:
 * - `adapter.ts` `extendObject`/`extendForeignObject` (3290-3330, 3628-3660): preserved
 *   properties are removed from the patch, `common.members` and `native.repositories`/
 *   `certificates`/`devices` are emptied before the merge, then the patch is merged deeply.
 * - `objectsInRedisClient.ts` `_extendObject`: `extend(true, oldObj, obj)` — objects
 *   recursively, arrays index by index, `undefined` skipped, `null` taken over.
 * - `adapter.ts` `_delForeignObject`/`_deleteObjects` (4679-4810): a missing object deletes
 *   nothing; recursive deletion takes the object (when it exists) and every child; the value
 *   goes only with a `state` object; every deleted id leaves every enum.
 */

/** An object as the stubs store it. */
export interface StubObject {
  /** Object kind: state, channel, device, enum, instance … */
  type: string;
  /** The object's `common` part. */
  common?: Record<string, unknown>;
  /** The object's `native` part. */
  native?: Record<string, unknown>;
}

/** The `options` argument of `extendObject` as far as the broker reads it here. */
export interface ExtendOptions {
  /** Properties an existing object keeps (7.2.2 `removePreservedProperties`). */
  preserve?: { common?: string[] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `extend(true, target, source)` as node.extend does it: recursive for objects, index by
 * index for arrays, `undefined` skipped, everything else taken over.
 *
 * @param target Mutated in place and returned.
 * @param source The patch.
 */
function deepExtend(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      const current = target[key];
      // An array is extended index by index — treated as an object keyed by its indices.
      const base = (Array.isArray(current) ? current : []) as unknown as Record<string, unknown>;
      target[key] = deepExtend(base, value as unknown as Record<string, unknown>);
    } else if (isPlainObject(value)) {
      const current = target[key];
      target[key] = deepExtend(isPlainObject(current) ? current : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * The object the broker stores after `extendObject(id, patch, options)`.
 *
 * @param existing The stored object, or undefined when there is none yet.
 * @param patch The object handed to `extendObject`.
 * @param options The options handed to `extendObject`.
 * @param fallbackType The type of a newly created object when the patch names none.
 */
export function brokerExtend(
  existing: StubObject | undefined,
  patch: Partial<StubObject>,
  options?: ExtendOptions | Record<string, unknown>,
  fallbackType = "state",
): StubObject {
  const old: StubObject = existing ? structuredClone(existing) : { type: patch.type ?? fallbackType };
  const next = structuredClone(patch) as Record<string, unknown>;
  const nextCommon = next.common as Record<string, unknown> | undefined;
  const nextNative = next.native as Record<string, unknown> | undefined;
  for (const field of (options as ExtendOptions | undefined)?.preserve?.common ?? []) {
    if (old.common?.[field] !== undefined && nextCommon) {
      delete nextCommon[field];
    }
  }
  if (nextCommon && "members" in nextCommon && old.common?.members) {
    old.common.members = [];
  }
  for (const key of ["repositories", "certificates", "devices"]) {
    if (nextNative && key in nextNative && old.native?.[key]) {
      old.native[key] = [];
    }
  }
  return deepExtend(old as unknown as Record<string, unknown>, next) as unknown as StubObject;
}

/**
 * `delObject(fullId, { recursive })` against the stub maps, as 7.2.2 does it.
 *
 * @param objects The object store, keyed by full id.
 * @param states The state store, keyed by full id.
 * @param fullId The full id to delete.
 * @param recursive Whether the children go too.
 */
export function brokerDelObject(
  objects: Map<string, StubObject>,
  states: Map<string, unknown>,
  fullId: string,
  recursive = false,
): void {
  const tasks: { id: string; state: boolean }[] = [];
  const own = objects.get(fullId);
  if (own) {
    tasks.push({ id: fullId, state: own.type === "state" });
  }
  if (recursive) {
    for (const [id, obj] of objects) {
      if (id.startsWith(`${fullId}.`)) {
        tasks.push({ id, state: obj.type === "state" });
      }
    }
  }
  for (const task of tasks) {
    objects.delete(task.id);
    if (task.state) {
      states.delete(task.id);
    }
    for (const [enumId, obj] of objects) {
      const members = obj.common?.members;
      if (enumId.startsWith("enum.") && Array.isArray(members) && members.includes(task.id)) {
        obj.common = { ...obj.common, members: members.filter(m => m !== task.id) };
      }
    }
  }
}
