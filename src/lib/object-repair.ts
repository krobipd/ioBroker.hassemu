/**
 * Object operations shared by ClientRegistry and GlobalConfig for repairing a
 * persisted state object in place.
 */
type RepairAdapter = Pick<
  ioBroker.Adapter,
  "getStateAsync" | "delObjectAsync" | "setObjectNotExistsAsync" | "setState"
>;

/**
 * Replace a persisted object wholesale — stale `common.states` keys physically
 * removed — while preserving the state value.
 *
 * Why not the obvious single call: `setObject` does exactly this but repochecker
 * flags every `setObject` as S5054 (blanket "should be avoided"); `extendObject`
 * deep-merges, so stale keys from an older dropdown format survive and one
 * leftover translation-object value keeps crashing Admin (React #31, v1.28.4 /
 * v1.27.2). The js-controller-blessed full replace is `delObject` →
 * `setObjectNotExists`. `delObject` can drop the state value, so it is captured
 * and restored — belt-and-suspenders, correct whether or not delObject cascades
 * to the value; the restore is `ack:true`, which `onStateChange` ignores, so it
 * never triggers command logic. The id MUST be a leaf state (delObject on a
 * parent would recurse into children).
 *
 * @param adapter Object/state operations.
 * @param id Full leaf-state path.
 * @param prepared The read-back object with its desired `common` already set.
 */
export async function replaceObjectPreservingValue(
  adapter: RepairAdapter,
  id: string,
  prepared: ioBroker.SettableObject,
): Promise<void> {
  const prev = await adapter.getStateAsync(id);
  await adapter.delObjectAsync(id);
  await adapter.setObjectNotExistsAsync(id, prepared);
  if (prev && prev.val !== null && prev.val !== undefined) {
    await adapter.setState(id, { val: prev.val, ack: true });
  }
}
