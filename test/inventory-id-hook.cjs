"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (FIXTURE_HOOKS in test/inventory.js, every start of the
// inventory run). Runs before any adapter module.
//
// It hits exactly one place of the product code: `randomIdTail()` in src/lib/display-id.ts, the four characters hassemu
// assigns a new display itself (K7) — `crypto.randomBytes(2).toString("hex")`. No other code of the adapter and no file
// under node_modules asks for exactly two random bytes (measured 2026-11-12); cookies, tokens, the server id and the
// webhook id come from `crypto.randomUUID`, which stays real.
//
// Why: the inventory is a golden file, compared byte for byte in CI (G8 on the release run). A real installation names
// its displays with chance — `display-7f3a` here, `display-02c9` there — and the template's dumpObjects keeps every id
// as the adapter wrote it. So the inventory run gives the displays a fixed sequence instead: the first new display of a
// process gets `0001`, the next `0002`, and so on — ids of the form a real installation has (`display-0001`), the same
// in every run. Every other call of `randomBytes` (another size, or with a callback) goes to the real function
// unchanged. The guard test of K7 runs without this hook and holds that the four characters come from real chance.
/** @typedef {{ randomBytes: (size: number, ...rest: unknown[]) => unknown }} RandomSource */
const crypto = /** @type {RandomSource} */ (/** @type {unknown} */ (require("node:crypto")));

const real = crypto.randomBytes;
let next = 0;

/**
 * `crypto.randomBytes`, with a fixed sequence for exactly two bytes asked synchronously.
 *
 * @param {number} size how many bytes
 * @param {...unknown} rest the callback, if any
 * @returns {unknown} the bytes (nothing with a callback)
 */
crypto.randomBytes = function randomBytes(size, ...rest) {
  if (size === 2 && rest.length === 0) {
    next += 1;
    return Buffer.from([(next >> 8) & 0xff, next & 0xff]);
  }
  return Reflect.apply(real, this, [size, ...rest]);
};
