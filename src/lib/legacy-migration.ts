import { coerceSafeUrl } from "./coerce";
import { decideLegacyVisMigration } from "./state-write-rules";
import { MODE_MANUAL } from "./constants";
import { moveWithEnums } from "./enum-carry";
import { errText } from "./err-text";
import { migrateNativeKeys, type NativeKeyMigration } from "./native-key-migration";
import type { ClientRegistry } from "./client-registry";
import type { GlobalConfig } from "./global-config";
import type { AdapterConfig } from "./types";

/**
 * The adapter surface the one-shot legacy migrations need. Extracted from main.ts
 * (I10 v1.37.0) so the data-loss-sensitive upgrade paths are unit-testable in
 * isolation instead of only through the full onReady harness.
 *
 * These migrations exist only for pre-1.2.0 installs where the legacy `visUrl`
 * still lives in instance-native / legacy states. They run once and do nothing on an
 * already-migrated install — which holds only because every legacy state they read is
 * REMOVED after the move, including one without an object (audit 2026-09-25, L2: an
 * object-less `global.visUrl` reset the global URL choice on every start). Removable in a
 * future major once such upgrades are no longer plausible — until then dropping them
 * would silently lose those users' configured URLs.
 */
export type MigrationAdapter = Pick<
  ioBroker.Adapter,
  | "log"
  | "namespace"
  | "config"
  | "getForeignObjectAsync"
  | "getForeignObjectsAsync"
  | "setForeignObject"
  | "extendForeignObjectAsync"
  | "getStateAsync"
  | "setState"
  | "delObjectAsync"
  | "delStateAsync"
>;

/**
 * The instance settings of 1.0.x (`visUrl`) and 1.1.0 (`defaultVisUrl`). js-controller never
 * deletes a native key, so an installation from then carries them for good — including the
 * empty manifest default `""` when no URL was ever entered. Dropped (nulled) ONLY after their
 * value was read and carried over: in onReady's rename table the drop would null a real URL
 * before this migration sees it (audit 2026-09-25, K3).
 */
const LEGACY_URL_DROPS: NativeKeyMigration[] = [{ drop: "defaultVisUrl" }, { drop: "visUrl" }];

/**
 * Remove a legacy datapoint for good. `delObject` removes a value only together with its
 * object (js-controller 7.2.2 `_delForeignObject`: a missing object deletes nothing), and a
 * `setState` on an id without an object only warns and stores the value anyway
 * (`performStrictObjectCheck`) — so a legacy value can exist WITHOUT an object, and only
 * `delState` gets rid of it (audit 2026-09-25, L2 and N12). Best effort: the next start retries.
 *
 * @param adapter Adapter surface for object/state I/O.
 * @param id      The id relative to the adapter namespace.
 */
async function deleteLegacyDatapoint(adapter: MigrationAdapter, id: string): Promise<void> {
  try {
    if (await adapter.getForeignObjectAsync(`${adapter.namespace}.${id}`)) {
      await adapter.delObjectAsync(id);
    } else {
      await adapter.delStateAsync(id);
    }
  } catch {
    /* best effort — the next start retries */
  }
}

/**
 * 1.0.x / 1.1.0 migration — move the legacy `defaultVisUrl`/`visUrl` from instance native
 * straight into `global.mode = manual` + `global.manualUrl`, switch the master switch on
 * (as 1.1.1 did, so new displays follow it) and drop the keys from native.
 *
 * @param adapter      Adapter surface for state/object I/O + logging.
 * @param config       Instance config (read for the legacy `defaultVisUrl`/`visUrl`).
 * @param globalConfig Global config collaborator (constructed and restored before this runs).
 * @returns true when the instance object was rewritten and a restart is coming — the
 *   caller must abort the start (a write to the own instance object restarts it).
 */
export async function migrateLegacyDefaultVisUrl(
  adapter: MigrationAdapter,
  config: AdapterConfig,
  globalConfig: GlobalConfig,
): Promise<boolean> {
  const legacy = config as AdapterConfig & { defaultVisUrl?: string; visUrl?: string };
  const url = legacy.defaultVisUrl || legacy.visUrl;
  if (!url) {
    // Nothing to carry over, but the empty default may still sit in the settings — drop it.
    // Only when a key is there at all: no instance-object read on an installation without them.
    const leftover = [legacy.defaultVisUrl, legacy.visUrl].some(v => v !== undefined && v !== null);
    return leftover ? await migrateNativeKeys(adapter, LEGACY_URL_DROPS, errText) : false;
  }
  // An unsafe legacy value (`javascript:`, `data:`) never reaches a datapoint.
  const safe = coerceSafeUrl(url);
  if (!safe) {
    adapter.log.warn(`Migration: legacy global URL rejected as unsafe — please set global.manualUrl manually`);
    return await migrateNativeKeys(adapter, LEGACY_URL_DROPS, errText);
  }

  adapter.log.info(`Migrating legacy URL configuration to the new model`);
  try {
    // Straight into the target, like 1.1.1: the global URL, and the master switch on so new
    // displays follow it (without bulkSetMode — existing displays keep their mode). The
    // detour through a `global.visUrl` state wrote a value without an object (the object is
    // gone since 1.2.0) that delObject can never remove, and migrateVisUrlToMode then reset
    // global.mode on every single start (audit 2026-09-25, L2).
    await globalConfig.migrationSet(MODE_MANUAL, safe);
    await globalConfig.handleEnabledWrite(true);
  } catch (err) {
    // The instance settings stay the recovery anchor — the user's URL must not be lost.
    adapter.log.warn(`Legacy URL preserved in instance config — writing global.manualUrl failed (${errText(err)})`);
    return false;
  }

  // Taken over — only now may the keys go.
  return await migrateNativeKeys(adapter, LEGACY_URL_DROPS, errText);
}

/**
 * 1.x → 1.2.0 migration — move legacy per-client `visUrl`-states to the
 * `mode`/`manualUrl` model, plus the global `visUrl` to `global.mode` +
 * `global.manualUrl`. Old datapoints are removed. Idempotent — does nothing on
 * subsequent starts. Decision logic lives in the pure `decideLegacyVisMigration`
 * helper (v1.25.0 J2); this function is just the broker I/O.
 *
 * @param adapter      Adapter surface for state/object I/O + logging.
 * @param globalConfig Global config collaborator (non-null when this runs).
 * @param registry     Client registry, or null if not yet constructed.
 */
export async function migrateVisUrlToMode(
  adapter: MigrationAdapter,
  globalConfig: GlobalConfig,
  registry: ClientRegistry | null,
): Promise<void> {
  // 1) Global visUrl → mode + manualUrl
  let globalMigrated = true;
  let globalHadLegacy = false;
  try {
    const legacyGlobal = await adapter.getStateAsync("global.visUrl");
    const decision = decideLegacyVisMigration(legacyGlobal?.val);
    globalHadLegacy = decision.kind !== "empty";
    if (decision.kind === "safe-url") {
      await globalConfig.migrationSet(MODE_MANUAL, decision.safe);
      adapter.log.info(`Migration: global URL "${decision.safe}" moved to global.manualUrl`);
    } else if (decision.kind === "unsafe-rejected") {
      await globalConfig.migrationSet(MODE_MANUAL, null);
      adapter.log.warn(`Migration: legacy global URL rejected as unsafe — please set global.manualUrl manually`);
    }
  } catch (err) {
    // A missing state does NOT throw (getStateAsync returns null) — the realistic
    // thrower is the migrationSet write. Do NOT delete the legacy source below on a
    // write failure, or the user's URL is lost silently: keep global.visUrl as a
    // recovery anchor + warn once. Mirrors migrateLegacyDefaultVisUrl. v1.36.0 (C5).
    globalMigrated = false;
    adapter.log.warn(`Migration: global URL move failed — legacy global.visUrl preserved (${errText(err)})`);
  }
  // I5: only attempt the delete when a legacy value was actually present — on an
  // already-migrated install `decision` is "empty" and this delObject round-trip
  // (per start) was a wasted no-op.
  if (globalMigrated && globalHadLegacy) {
    // The delete strikes the id from every room/function enum — the memberships move to the
    // successor around it (v1.45.0; order: the fleet master enum-carry.ts). The delete also
    // takes a value without an object, or this would migrate again on every start (L2).
    await moveWithEnums(
      adapter,
      `${adapter.namespace}.global.visUrl`,
      `${adapter.namespace}.global.manualUrl`,
      () => deleteLegacyDatapoint(adapter, "global.visUrl"),
      errText,
    );
  }

  // 2) Per-client visUrl → mode='manual' + manualUrl
  //
  // The legacy values come from the registry's restore pass, which read them in the
  // batch it runs for every client anyway. Before that, this block asked the broker for
  // `clients.<id>.visUrl` once per client on EVERY start — sequentially, and answered
  // `null` every time on any installation migrated since v1.2.0. Now an already-migrated
  // install does nothing here at all, and the rare real migration runs its clients in
  // parallel like every other per-client pass in the adapter.
  const legacyByClient = registry?.takeLegacyVisUrls() ?? new Map<string, unknown>();
  if (legacyByClient.size === 0) {
    return;
  }
  const byId = new Map((registry?.listAll() ?? []).map(r => [r.id, r]));
  await Promise.all(
    [...legacyByClient].map(async ([id, rawValue]) => {
      const record = byId.get(id);
      if (!record) {
        return;
      }
      let clientMigrated = true;
      const decision = decideLegacyVisMigration(rawValue);
      if (decision.kind === "empty") {
        return;
      }
      try {
        if (decision.kind === "safe-url") {
          record.mode = MODE_MANUAL;
          record.manualUrl = decision.safe;
          await adapter.setState(`clients.${id}.mode`, { val: MODE_MANUAL, ack: true });
          await adapter.setState(`clients.${id}.manualUrl`, { val: decision.safe, ack: true });
          adapter.log.info(`Migration: client ${id} URL "${decision.safe}" moved to manualUrl`);
        } else {
          adapter.log.warn(`Migration: client ${id} legacy URL rejected as unsafe — please set the URL manually`);
        }
      } catch (err) {
        // Same as the global block: a write failure must not delete the legacy
        // source — keep clients.<id>.visUrl as a recovery anchor + warn. v1.36.0 (C5).
        clientMigrated = false;
        adapter.log.warn(`Migration: client ${id} URL move failed — legacy visUrl preserved (${errText(err)})`);
      }
      if (clientMigrated) {
        await moveWithEnums(
          adapter,
          `${adapter.namespace}.clients.${id}.visUrl`,
          `${adapter.namespace}.clients.${id}.manualUrl`,
          () => deleteLegacyDatapoint(adapter, `clients.${id}.visUrl`),
          errText,
        );
      }
    }),
  );

  // 3) global.mode + global.manualUrl repair handled by repairGlobalSchemas()
  // (called separately in onReady so it ALSO runs for users upgrading from
  // v1.2.0/v1.3.0/v1.3.1 where the legacy visUrl is already gone but the
  // partial-formed mode-object from the v1.2.0 extendObject-bug persists).
}
