import type { AdapterInterface } from "./types";

/** Adapter surface schema-repair needs — object I/O + namespace + logging. */
export type SchemaRepairAdapter = AdapterInterface &
  Pick<ioBroker.Adapter, "namespace" | "getObjectAsync" | "extendObject">;

/** One `instanceObjects` entry as read from io-package.json. */
export interface InstanceObjectSchema {
  /** Object id (relative `global.mode` or fully-namespaced `hassemu.0.global.mode`). */
  _id: string;
  /** ioBroker object type (`state`, `channel`, …). */
  type: string;
  /** `common` block to merge onto the existing object (shape validated at build time). */
  common?: unknown;
  /** `native` block; defaults to `{}` when absent. */
  native?: unknown;
}

/** Default repair targets: (state id, expected `common.type`). L27: file-local (no external importer). */
const DEFAULT_REPAIR_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ["global.mode", "mixed"],
  ["global.manualUrl", "string"],
];

/**
 * Repairs partial-formed `global.*` objects left behind by the v1.2.0 migration
 * bug (`extendObject` was called with only `common.type:'mixed'`, leaving
 * the object without top-level `type`/name/role/read/write/def). Merges the full
 * `instanceObjects` schema onto the existing partial object so js-controller
 * stops warning and the dropdown renders. Idempotent — an already-complete
 * object is skipped (no write).
 *
 * Extracted from `main.ts` so it can be unit-tested with a mock adapter (same
 * pattern as `global-config` / `client-registry`).
 *
 * @param adapter         Adapter surface (namespace + object I/O + log).
 * @param instanceObjects io-package.json `instanceObjects` list (schema source).
 * @param targets         (id, expected `common.type`) pairs to check/repair.
 */
export async function repairGlobalSchemas(
  adapter: SchemaRepairAdapter,
  instanceObjects: InstanceObjectSchema[],
  targets: ReadonlyArray<readonly [string, string]> = DEFAULT_REPAIR_TARGETS,
): Promise<void> {
  for (const [id, expectedCommonType] of targets) {
    await repairOne(adapter, instanceObjects, id, expectedCommonType);
  }
}

async function repairOne(
  adapter: SchemaRepairAdapter,
  instanceObjects: InstanceObjectSchema[],
  id: string,
  expectedCommonType: string,
): Promise<void> {
  // v1.14.0 (H3): needs-repair-Check vor unconditional extendObject —
  // spart 2 Round-Trips bei jedem Start für ~99% der Installationen.
  try {
    const obj = await adapter.getObjectAsync(id);
    if (obj && obj.type === "state" && obj.common?.type === expectedCommonType) {
      return; // bereits korrekt
    }
  } catch {
    /* fall through to repair */
  }
  // v1.25.0 (F3): schemas kommen aus io-package.json:instanceObjects (single
  // source of truth), nicht hardgecoded.
  const fullId = `${adapter.namespace}.${id}`;
  const schema = instanceObjects.find(o => o._id === id || o._id === fullId);
  if (!schema) {
    adapter.log.debug(`repair ${id}: no instanceObjects-schema found, skipping`);
    return;
  }
  try {
    // `extendObject` erwartet die diskriminierte Union `PartialObject`,
    // deren `type` ein `ObjectType`-LITERAL sein muss, damit der Compiler
    // `common` auf das passende Member narrowt. `schema` kommt aber aus der
    // (build-time-validierten) io-package.json, wo `type` zur Laufzeit ein
    // String und `common` `unknown` ist — ein Laufzeit-`type` lässt sich in
    // TS 6 NICHT auf die Literal-Union reduzieren (verifiziert: jeder Feld-Cast
    // scheitert an `Partial<StateCommon>` vs `Partial<OtherCommon>`). Daher der
    // bewusste Cast auf `PartialObject` (statt `never`): die Shape ist durch das
    // Manifest garantiert.
    // v1.41.0: no `preserve` any more. It used to shield `common.name`, but the adapter
    // owns the names of its own manifest objects and `refreshInstanceObjects` overwrites
    // them from admin/i18n on the very next step of onReady — two writes in one start
    // disagreeing about who owns the name is a contradiction, not a safeguard
    // (`reference_preserve_name_verhindert_umbenennung`).
    await adapter.extendObject(id, {
      type: schema.type,
      common: schema.common,
      native: schema.native ?? {},
    } as unknown as ioBroker.PartialObject);
    adapter.log.debug(`Schema repair applied: ${id} (common.type was missing, restored from instanceObjects)`);
  } catch (err) {
    adapter.log.debug(`repair ${id} failed: ${String(err)}`);
  }
}
