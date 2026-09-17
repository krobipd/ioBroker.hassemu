/**
 * Enum memberships (rooms, functions) of a datapoint that moves to a new id.
 *
 * `delObject` on a state strikes its id from EVERY enum (js-controller-adapter 7.2.2,
 * `_delForeignObject` → `removeIdFromAllEnums`) and nothing a later create writes brings
 * that back: a user who had put the old datapoint into a room finds the successor
 * unassigned after the migration. Fleet rule (2026-09-12): where an object really moves,
 * the delete pair stays — and the memberships travel first.
 */

import { errText } from "./err-text";

/** The two broker calls the carry-over needs. */
export type EnumCarryAdapter = Pick<ioBroker.Adapter, "getEnumsAsync" | "extendForeignObject" | "log">;

/**
 * Replace `oldFullId` with `newFullId` in the member list of every enum that carries it —
 * in place, so the position in the room/function survives. Runs BEFORE the delete of the
 * old id, so the delete finds nothing left to strike. Best effort: a failure is a `warn`
 * and the migration goes on — a stale membership is a smaller loss than a stuck upgrade.
 *
 * `extendForeignObject` with `common.members` replaces the list wholesale (7.2.2 empties
 * the stored list before the merge), so a list that shrank by a duplicate is written as is.
 *
 * @param adapter   Enum read + write + log.
 * @param oldFullId The full id (with namespace) that is about to be deleted.
 * @param newFullId The full id of its successor.
 * @returns The number of enums rewritten.
 */
export async function carryEnumMembership(
  adapter: EnumCarryAdapter,
  oldFullId: string,
  newFullId: string,
): Promise<number> {
  let carried = 0;
  try {
    const groups = await adapter.getEnumsAsync();
    for (const group of Object.values(groups ?? {})) {
      for (const [enumId, enumObj] of Object.entries(group)) {
        const members = enumObj?.common?.members;
        if (!Array.isArray(members) || !members.includes(oldFullId)) {
          continue;
        }
        const replaced = members.map(m => (m === oldFullId ? newFullId : m));
        const deduped = replaced.filter((m, i) => replaced.indexOf(m) === i);
        await adapter.extendForeignObject(enumId, { common: { members: deduped } });
        carried++;
      }
    }
  } catch (err) {
    adapter.log.warn(`Could not carry the room/function assignments of ${oldFullId} to ${newFullId}: ${errText(err)}`);
  }
  return carried;
}
