import { errText } from "./err-text";

/**
 * Object operations shared by ClientRegistry and GlobalConfig for repairing a
 * persisted state object in place.
 */
type RepairAdapter = Pick<ioBroker.Adapter, "namespace" | "setForeignObject" | "log">;

/**
 * Replace a persisted object wholesale — stale `common.states` keys physically
 * removed — in ONE write that leaves the state value and the user's room/function
 * assignments untouched.
 *
 * Why a full write: `extendObject` deep-merges, so stale keys from an older dropdown
 * format survive and one leftover translation-object value keeps crashing Admin
 * (React #31, v1.28.4 / v1.27.2). Why `setForeignObject` with the full id and not
 * `setObject` or a delete + recreate: `setObject` is the repochecker's S5054 (and its
 * `…Async` twin is deprecated in `@iobroker/types` 7.2.2); `delObject` on a state
 * deletes the VALUE and strikes the id from every enum — the user's room and function
 * assignments — and nothing a recreate writes brings them back (js-controller-adapter
 * 7.2.2 `_delForeignObject`: `delForeignStateAsync` + `removeIdFromAllEnums`). Between
 * v1.27.2 and v1.44.0 this helper used that pair, restoring only the value; every
 * dropdown refresh that changed the URL list cost the datapoint its enum memberships.
 * Fleet rule since 2026-09-12, package check `object-rewrite` since 0.9.0.
 *
 * The write is not skipped on failure but surfaced as a `warn` — not thrown, because the
 * callers batch these under Promise.all and one broken datapoint must not abort the rest.
 * Unlike the old pair there is no window in which the datapoint does not exist: a failed
 * write leaves the stored object as it was.
 *
 * @param adapter Object write + log.
 * @param id State path relative to the adapter namespace (`clients.<id>.mode`, `global.mode`).
 * @param prepared The read-back object with its desired `common` already set.
 */
export async function replaceObjectPreservingValue(
  adapter: RepairAdapter,
  id: string,
  prepared: ioBroker.SettableObject,
): Promise<void> {
  try {
    // `<string>`: a template-literal id would narrow the accepted object to the adapter-scoped
    // types, and the callers hand over the object exactly as `getObjectAsync` returned it.
    await adapter.setForeignObject<string>(`${adapter.namespace}.${id}`, prepared);
  } catch (err) {
    adapter.log.warn(`Object repair for ${id} failed — the stored object is unchanged: ${errText(err)}`);
  }
}
