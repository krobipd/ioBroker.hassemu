"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var legacy_migration_exports = {};
__export(legacy_migration_exports, {
  cleanupLegacyNativeUrl: () => cleanupLegacyNativeUrl,
  migrateLegacyDefaultVisUrl: () => migrateLegacyDefaultVisUrl,
  migrateVisUrlToMode: () => migrateVisUrlToMode
});
module.exports = __toCommonJS(legacy_migration_exports);
var import_coerce = require("./coerce");
var import_constants = require("./constants");
async function cleanupLegacyNativeUrl(adapter) {
  try {
    const id = `system.adapter.${adapter.namespace}`;
    const obj = await adapter.getForeignObjectAsync(id);
    if (obj == null ? void 0 : obj.native) {
      delete obj.native.defaultVisUrl;
      delete obj.native.visUrl;
      await adapter.setForeignObjectAsync(id, obj);
    }
  } catch (err) {
    adapter.log.warn(`Legacy config cleanup failed: ${String(err)}`);
  }
}
async function migrateLegacyDefaultVisUrl(adapter, config, globalConfig) {
  const legacy = config;
  const url = legacy.defaultVisUrl || legacy.visUrl;
  if (!url) {
    return;
  }
  const safe = (0, import_coerce.coerceSafeUrl)(url);
  if (!safe) {
    adapter.log.warn(`Migration: legacy global URL rejected as unsafe \u2014 please set global.manualUrl manually`);
    await cleanupLegacyNativeUrl(adapter);
    return;
  }
  adapter.log.info(`Migrating legacy URL configuration to the new model`);
  let stateWritten = false;
  try {
    await adapter.setState("global.visUrl", { val: safe, ack: true });
    stateWritten = true;
  } catch {
    try {
      if (globalConfig) {
        await globalConfig.migrationSet(import_constants.MODE_MANUAL, safe);
        adapter.log.debug(`Migration shortcut: global.visUrl-state missing \u2014 wrote directly to manualUrl=${safe}`);
        stateWritten = true;
      }
    } catch (err) {
      adapter.log.debug(`Legacy URL migration fallback failed: ${String(err)}`);
    }
  }
  if (!stateWritten) {
    adapter.log.warn(`Legacy URL preserved in instance config \u2014 neither global URL write succeeded`);
    return;
  }
  await cleanupLegacyNativeUrl(adapter);
}
async function migrateVisUrlToMode(adapter, globalConfig, registry) {
  var _a;
  let globalMigrated = true;
  let globalHadLegacy = false;
  try {
    const legacyGlobal = await adapter.getStateAsync("global.visUrl");
    const decision = (0, import_coerce.decideLegacyVisMigration)(legacyGlobal == null ? void 0 : legacyGlobal.val);
    globalHadLegacy = decision.kind !== "empty";
    if (decision.kind === "safe-url") {
      await globalConfig.migrationSet(import_constants.MODE_MANUAL, decision.safe);
      adapter.log.info(`Migration: global URL "${decision.safe}" moved to global.manualUrl`);
    } else if (decision.kind === "unsafe-rejected") {
      await globalConfig.migrationSet(import_constants.MODE_MANUAL, null);
      adapter.log.warn(`Migration: legacy global URL rejected as unsafe \u2014 please set global.manualUrl manually`);
    }
  } catch (err) {
    globalMigrated = false;
    adapter.log.warn(`Migration: global URL move failed \u2014 legacy global.visUrl preserved (${String(err)})`);
  }
  if (globalMigrated && globalHadLegacy) {
    try {
      await adapter.delObjectAsync("global.visUrl");
    } catch {
    }
  }
  const records = (_a = registry == null ? void 0 : registry.listAll()) != null ? _a : [];
  for (const record of records) {
    let clientMigrated = true;
    let clientHadLegacy = false;
    try {
      const legacy = await adapter.getStateAsync(`clients.${record.id}.visUrl`);
      const decision = (0, import_coerce.decideLegacyVisMigration)(legacy == null ? void 0 : legacy.val);
      clientHadLegacy = decision.kind !== "empty";
      if (decision.kind === "safe-url") {
        record.mode = import_constants.MODE_MANUAL;
        record.manualUrl = decision.safe;
        await adapter.setState(`clients.${record.id}.mode`, { val: import_constants.MODE_MANUAL, ack: true });
        await adapter.setState(`clients.${record.id}.manualUrl`, { val: decision.safe, ack: true });
        adapter.log.info(`Migration: client ${record.id} URL "${decision.safe}" moved to manualUrl`);
      } else if (decision.kind === "unsafe-rejected") {
        adapter.log.warn(`Migration: client ${record.id} legacy URL rejected as unsafe \u2014 please set the URL manually`);
      }
    } catch (err) {
      clientMigrated = false;
      adapter.log.warn(`Migration: client ${record.id} URL move failed \u2014 legacy visUrl preserved (${String(err)})`);
    }
    if (clientMigrated && clientHadLegacy) {
      try {
        await adapter.delObjectAsync(`clients.${record.id}.visUrl`);
      } catch {
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cleanupLegacyNativeUrl,
  migrateLegacyDefaultVisUrl,
  migrateVisUrlToMode
});
//# sourceMappingURL=legacy-migration.js.map
