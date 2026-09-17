/**
 * One readable line for anything a `catch` hands over — never `[object Object]`.
 *
 * Fleet rule (audit series 2026-09-02, class 1; enforced by the package check
 * `caught-value-text` since iobroker-adapter-checks 0.11): every caught value becomes
 * text through THIS helper, never inline. `String(err)` and `${err}` turn a thrown
 * plain object into `[object Object]`, `${err}` throws a second time on a symbol,
 * `(err as Error).message` reads `undefined` off a thrown string, and a bare
 * `JSON.stringify(err)` throws on a cyclic structure.
 *
 * @param err Whatever was thrown or rejected with.
 * @returns A non-empty, human-readable description of the value.
 */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err === null || err === undefined || typeof err !== "object") {
    // number, boolean, bigint, symbol (a template literal would throw on the symbol)
    return String(err);
  }
  try {
    // A thrown object ({ code: "ECONNRESET" }, an HTTP client's error object):
    // JSON.stringify THROWS on cyclic structures and yields `undefined` for a value
    // it cannot represent — both fall back to the type tag.
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
