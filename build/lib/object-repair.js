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
var object_repair_exports = {};
__export(object_repair_exports, {
  replaceObjectPreservingValue: () => replaceObjectPreservingValue
});
module.exports = __toCommonJS(object_repair_exports);
async function replaceObjectPreservingValue(adapter, id, prepared) {
  const prev = await adapter.getStateAsync(id);
  await adapter.delObjectAsync(id);
  try {
    await adapter.setObjectNotExistsAsync(id, prepared);
    if (prev && prev.val !== null && prev.val !== void 0) {
      await adapter.setState(id, { val: prev.val, ack: true });
    }
  } catch (err) {
    adapter.log.warn(
      `Object repair for ${id} failed after delete \u2014 the datapoint may be missing until the next restart: ${String(err)}`
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  replaceObjectPreservingValue
});
//# sourceMappingURL=object-repair.js.map
