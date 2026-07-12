import { coerceSafeUrl, decideLegacyVisMigration } from "./coerce";
import { MODE_MANUAL } from "./constants";
import type { ClientRegistry } from "./client-registry";
import type { GlobalConfig } from "./global-config";
import type { AdapterConfig } from "./types";

/**
 * The adapter surface the one-shot legacy migrations need. Extracted from main.ts
 * (I10 v1.37.0) so the data-loss-sensitive upgrade paths are unit-testable in
 * isolation instead of only through the full onReady harness. Behaviour is
 * unchanged — these are still called once from onReady.
 *
 * These migrations exist only for pre-1.2.0 installs where the legacy `visUrl`
 * still lives in instance-native / legacy states. They run once, are idempotent
 * (cheap no-op on already-migrated installs), and are removable in a future major
 * once such upgrades are no longer plausible — until then dropping them would
 * silently lose those users' configured URLs.
 */
export type MigrationAdapter = Pick<
  ioBroker.Adapter,
  | "log"
  | "namespace"
  | "getForeignObjectAsync"
  | "setForeignObjectAsync"
  | "getStateAsync"
  | "setState"
  | "delObjectAsync"
>;

/**
 * Drops the legacy `defaultVisUrl`/`visUrl` keys from the instance native config.
 * Shared by both exits of {@link migrateLegacyDefaultVisUrl} — the unsafe-rejected
 * path and the successfully-migrated path clean up identically. Best-effort:
 * failures only warn.
 *
 * @param adapter Adapter surface for object I/O + logging.
 */
export async function cleanupLegacyNativeUrl(adapter: MigrationAdapter): Promise<void> {
  try {
    const id = `system.adapter.${adapter.namespace}`;
    const obj = await adapter.getForeignObjectAsync(id);
    if (obj?.native) {
      delete obj.native.defaultVisUrl;
      delete obj.native.visUrl;
      await adapter.setForeignObjectAsync(id, obj);
    }
  } catch (err) {
    adapter.log.warn(`Legacy config cleanup failed: ${String(err)}`);
  }
}

/**
 * 1.0.x / 1.1.0 → 1.1.1 migration — move the legacy `defaultVisUrl` from instance
 * native into `global.visUrl` (+ `global.enabled=true`) and drop it from native.
 * The follow-up {@link migrateVisUrlToMode} then moves `global.visUrl` into the
 * mode/manualUrl model.
 *
 * @param adapter      Adapter surface for state/object I/O + logging.
 * @param config       Instance config (read for the legacy `defaultVisUrl`/`visUrl`).
 * @param globalConfig Global config collaborator, or null if not yet constructed.
 */
export async function migrateLegacyDefaultVisUrl(
  adapter: MigrationAdapter,
  config: AdapterConfig,
  globalConfig: GlobalConfig | null,
): Promise<void> {
  const legacy = config as AdapterConfig & { defaultVisUrl?: string; visUrl?: string };
  const url = legacy.defaultVisUrl || legacy.visUrl;
  if (!url) {
    return;
  }
  // Defensive: validiere die legacy-URL bevor wir sie nach `global.visUrl`
  // schreiben. Malicious-Werte (`javascript:`, `data:`) sollen nicht durch
  // die Migration durchrutschen — `migrateVisUrlToMode` validiert zwar
  // nochmal, aber zwischen den Migrations-Schritten würde unsafe-Wert
  // sichtbar sein, und die native-Cleanup ist unbedingt.
  const safe = coerceSafeUrl(url);
  if (!safe) {
    adapter.log.warn(`Migration: legacy global URL rejected as unsafe — please set global.manualUrl manually`);
    await cleanupLegacyNativeUrl(adapter);
    return;
  }

  adapter.log.info(`Migrating legacy URL configuration to the new model`);
  // We cannot call globalConfig.handleVisUrlWrite — that method is gone in
  // v1.2.0. Write the legacy state directly so migrateVisUrlToMode picks it up.
  // Wichtig: wenn der State-Write FEHLSCHLÄGT (z.B. weil global.visUrl-Object
  // in v1.2.0+ schon weg ist), dürfen wir die native-Werte NICHT löschen —
  // sonst ist die User-URL silent verloren. Stattdessen direkt nach
  // global.mode/manualUrl schreiben (das Ziel wo migrateVisUrlToMode
  // sie sonst hingeschrieben hätte).
  let stateWritten = false;
  try {
    await adapter.setState("global.visUrl", { val: safe, ack: true });
    stateWritten = true;
  } catch {
    // global.visUrl-Object existiert nicht mehr → direkt ins Ziel schreiben
    try {
      if (globalConfig) {
        await globalConfig.migrationSet(MODE_MANUAL, safe);
        // Tech-Internal-Pfad: shortcut wenn global.visUrl-state fehlt — debug-only.
        adapter.log.debug(`Migration shortcut: global.visUrl-state missing — wrote directly to manualUrl=${safe}`);
        stateWritten = true;
      }
    } catch (err) {
      adapter.log.debug(`Legacy URL migration fallback failed: ${String(err)}`);
    }
  }

  if (!stateWritten) {
    // Both paths failed — keep native values as a recovery anchor for the user.
    adapter.log.warn(`Legacy URL preserved in instance config — neither global URL write succeeded`);
    return;
  }

  await cleanupLegacyNativeUrl(adapter);
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
    adapter.log.warn(`Migration: global URL move failed — legacy global.visUrl preserved (${String(err)})`);
  }
  // I5: only attempt the delete when a legacy value was actually present — on an
  // already-migrated install `decision` is "empty" and this delObject round-trip
  // (per start) was a wasted no-op.
  if (globalMigrated && globalHadLegacy) {
    try {
      await adapter.delObjectAsync("global.visUrl");
    } catch {
      /* didn't exist */
    }
  }

  // 2) Per-client visUrl → mode='manual' + manualUrl
  const records = registry?.listAll() ?? [];
  for (const record of records) {
    let clientMigrated = true;
    let clientHadLegacy = false;
    try {
      const legacy = await adapter.getStateAsync(`clients.${record.id}.visUrl`);
      const decision = decideLegacyVisMigration(legacy?.val);
      clientHadLegacy = decision.kind !== "empty";
      if (decision.kind === "safe-url") {
        record.mode = MODE_MANUAL;
        record.manualUrl = decision.safe;
        await adapter.setState(`clients.${record.id}.mode`, { val: MODE_MANUAL, ack: true });
        await adapter.setState(`clients.${record.id}.manualUrl`, { val: decision.safe, ack: true });
        adapter.log.info(`Migration: client ${record.id} URL "${decision.safe}" moved to manualUrl`);
      } else if (decision.kind === "unsafe-rejected") {
        adapter.log.warn(`Migration: client ${record.id} legacy URL rejected as unsafe — please set the URL manually`);
      }
    } catch (err) {
      // Same as the global block: a write failure must not delete the legacy
      // source — keep clients.<id>.visUrl as a recovery anchor + warn. v1.36.0 (C5).
      clientMigrated = false;
      adapter.log.warn(`Migration: client ${record.id} URL move failed — legacy visUrl preserved (${String(err)})`);
    }
    // I5: as for the global block — skip the delete when there was no legacy value.
    if (clientMigrated && clientHadLegacy) {
      try {
        await adapter.delObjectAsync(`clients.${record.id}.visUrl`);
      } catch {
        /* didn't exist */
      }
    }
  }

  // 3) global.mode + global.manualUrl repair handled by repairGlobalSchemas()
  // (called separately in onReady so it ALSO runs for users upgrading from
  // v1.2.0/v1.3.0/v1.3.1 where the legacy visUrl is already gone but the
  // partial-formed mode-object from the v1.2.0 extendObject-bug persists).
}
