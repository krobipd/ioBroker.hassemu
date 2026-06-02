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
var schema_repair_exports = {};
__export(schema_repair_exports, {
  DEFAULT_REPAIR_TARGETS: () => DEFAULT_REPAIR_TARGETS,
  repairGlobalSchemas: () => repairGlobalSchemas
});
module.exports = __toCommonJS(schema_repair_exports);
const DEFAULT_REPAIR_TARGETS = [
  ["global.mode", "mixed"],
  ["global.manualUrl", "string"]
];
async function repairGlobalSchemas(adapter, instanceObjects, targets = DEFAULT_REPAIR_TARGETS) {
  for (const [id, expectedCommonType] of targets) {
    await repairOne(adapter, instanceObjects, id, expectedCommonType);
  }
}
async function repairOne(adapter, instanceObjects, id, expectedCommonType) {
  var _a, _b;
  try {
    const obj = await adapter.getObjectAsync(id);
    if (obj && obj.type === "state" && ((_a = obj.common) == null ? void 0 : _a.type) === expectedCommonType) {
      return;
    }
  } catch {
  }
  const fullId = `${adapter.namespace}.${id}`;
  const schema = instanceObjects.find((o) => o._id === id || o._id === fullId);
  if (!schema) {
    adapter.log.debug(`repair ${id}: no instanceObjects-schema found, skipping`);
    return;
  }
  try {
    await adapter.extendObjectAsync(
      id,
      {
        type: schema.type,
        common: schema.common,
        native: (_b = schema.native) != null ? _b : {}
      },
      { preserve: { common: ["name"] } }
    );
    adapter.log.debug(`Schema repair applied: ${id} (common.type was missing, restored from instanceObjects)`);
  } catch (err) {
    adapter.log.debug(`repair ${id} failed: ${String(err)}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_REPAIR_TARGETS,
  repairGlobalSchemas
});
//# sourceMappingURL=schema-repair.js.map
