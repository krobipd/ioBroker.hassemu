/**
 * Enum memberships (rooms, functions) of a datapoint that moves to a new id.
 *
 * `delObject` on a state strikes its id from EVERY enum (js-controller-adapter 7.2.2,
 * `_delForeignObject` → `removeIdFromAllEnums`) and nothing a later create writes brings
 * that back: a user who had put the old datapoint into a room finds the successor
 * unassigned after the migration. Fleet rule (2026-09-12): where an object really moves,
 * the delete stays — and the memberships travel with it.
 *
 * The ORDER matters (audit 2026-09-25, L5): `removeIdFromAllEnums` writes every enum back
 * from the adapter's CACHED `this.enums` (common-db `tools.ts` 2792-2806), and that cache
 * follows the database only through the asynchronous `enum.*` subscription. A successor
 * written into an enum BEFORE the delete can be overwritten by the cached list the delete
 * writes back. So: read the memberships fresh, delete, and only then write the successor
 * into a freshly read copy of each enum.
 */

import { errText } from "./err-text";

/** The broker calls the carry-over needs. */
export type EnumCarryAdapter = Pick<
  ioBroker.Adapter,
  "getEnumsAsync" | "getForeignObjectAsync" | "extendForeignObject" | "log"
>;

/**
 * Move the enum memberships of `oldFullId` to `newFullId` around the deletion of the old id.
 * The successor takes the old id's position in each list. Best effort: a failure is a `warn`
 * and the migration goes on — a stale membership is a smaller loss than a stuck upgrade.
 *
 * `extendForeignObject` with `common.members` replaces the list wholesale (7.2.2 empties the
 * stored list before the merge), so the list is written exactly as built here.
 *
 * @param adapter   Enum read + write + log.
 * @param oldFullId The full id (with namespace) that is being deleted.
 * @param newFullId The full id of its successor.
 * @param deleteOld Deletes the old id; runs exactly once, after the memberships were read.
 * @returns The number of enums rewritten.
 */
export async function carryEnumMembership(
  adapter: EnumCarryAdapter,
  oldFullId: string,
  newFullId: string,
  deleteOld: () => Promise<void>,
): Promise<number> {
  // 1. Which enums hold the old id, and where — read from the database (getEnums reads the
  //    object view), not from a cache.
  const holders = new Map<string, number>();
  try {
    const groups = await adapter.getEnumsAsync();
    for (const group of Object.values(groups ?? {})) {
      for (const [enumId, enumObj] of Object.entries(group)) {
        const members = enumObj?.common?.members;
        if (Array.isArray(members) && members.includes(oldFullId)) {
          holders.set(enumId, members.indexOf(oldFullId));
        }
      }
    }
  } catch (err) {
    adapter.log.warn(`Could not read the room/function assignments of ${oldFullId}: ${errText(err)}`);
  }
  // 2. Delete. 7.2.2 strikes the old id and writes every enum back from ITS cache — a
  //    carry-over written before this point could be overwritten.
  await deleteOld();
  // 3. Only now add the successor, at the old position, into a freshly read copy.
  let carried = 0;
  for (const [enumId, position] of holders) {
    try {
      const stored = await adapter.getForeignObjectAsync(enumId);
      const current = (stored?.common as { members?: unknown } | undefined)?.members;
      if (!Array.isArray(current)) {
        // The enum is gone meanwhile — never re-create it.
        continue;
      }
      // The delete strikes the old id only when its object existed — drop it here too.
      const members = (current as unknown[]).filter(m => m !== oldFullId);
      if (!members.includes(newFullId)) {
        members.splice(Math.min(position, members.length), 0, newFullId);
      }
      await adapter.extendForeignObject(enumId, { common: { members: members as string[] } });
      carried++;
    } catch (err) {
      adapter.log.warn(`Could not carry the assignment of ${oldFullId} to ${newFullId} in ${enumId}: ${errText(err)}`);
    }
  }
  return carried;
}
