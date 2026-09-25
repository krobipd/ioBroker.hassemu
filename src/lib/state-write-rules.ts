/**
 * The rules that decide what an incoming state WRITE means.
 *
 * Split out of `coerce.ts` in v1.43.0. Coercion answers "is this a string / a URL / a
 * UUID"; these answer "the user wrote this into `mode` — is it a sentinel, a URL, a
 * rejection, or the no-choice entry?" and "is this legacy value worth migrating?". That is
 * adapter behaviour, not input validation, and it is where the two mode handlers and the
 * two migrations share their logic.
 */

import { coerceSafeUrl, isEmptyValue } from "./coerce";
import { MODE_GLOBAL, MODE_MANUAL, NO_CHOICE } from "./constants";

/** Result of {@link parseManualUrlWrite}. */
export type ManualUrlWriteResult = { ok: true; safe: string | null } | { ok: false };

/** Result of {@link parseModeWrite}. */
export type ModeWriteResult =
  | { kind: "no-choice" }
  | { kind: "sentinel"; value: string }
  | { kind: "url"; value: string }
  | { kind: "rejected-non-string" }
  | { kind: "rejected-disallowed-sentinel"; value: string }
  | { kind: "rejected-unsafe-url"; raw: string };

/** Result of {@link decideLegacyVisMigration}. */
export type LegacyVisMigration = { kind: "empty" } | { kind: "safe-url"; safe: string } | { kind: "unsafe-rejected" };

/**
 * "No choice" marker: the user picked the default entry `0='---'` (or one of its
 * representations). Covers the numeric `0` (admin UI with `type: mixed` dropdowns),
 * the string `'0'` and the empty string.
 *
 * Both mode handlers (client-registry, global-config) treat it the same way — before
 * v1.8.0 the logic existed four times. Any other value is "real" user input and has
 * to be validated.
 *
 * @param value Untrusted input from the mode state (numeric 0 / string '0' / '' / URL / sentinel).
 */
export function isNoChoice(value: unknown): boolean {
  return value === 0 || value === NO_CHOICE || value === "";
}

/**
 * Validates a write to a `manualUrl` state. Empty / null / undefined → clear
 * (`safe: null`). Otherwise must pass {@link coerceSafeUrl}; if not → `ok: false`
 * so the caller can reject + revert. Centralises the validation that both
 * `ClientRegistry.handleManualUrlWrite` and `GlobalConfig.handleManualUrlWrite`
 * share — caller still owns logging + setState because the prefixes/state-IDs
 * differ.
 *
 * @param rawValue Value written to the state.
 */
export function parseManualUrlWrite(rawValue: unknown): ManualUrlWriteResult {
  if (isEmptyValue(rawValue)) {
    return { ok: true, safe: null };
  }
  const safe = coerceSafeUrl(rawValue);
  if (!safe) {
    return { ok: false };
  }
  return { ok: true, safe };
}

/**
 * v1.23.0 (F2): central validation for mode writes. `ClientRegistry.handleModeWrite`
 * and `GlobalConfig.handleModeWrite` used to duplicate ~80% of the logic (no choice,
 * non-string rejection, sentinel check, URL coercion). Both use this helper now and
 * only supply their own state ids, log prefixes and allowed sentinels.
 *
 * `allowedSentinels` lists the non-URL mode values that are allowed — client-registry
 * allows `[MODE_GLOBAL, MODE_MANUAL]`, global-config only `[MODE_MANUAL]` (MODE_GLOBAL
 * would refer to itself).
 *
 * @param rawValue         Value of the state write.
 * @param allowedSentinels Allowed non-URL sentinels.
 */
export function parseModeWrite(rawValue: unknown, allowedSentinels: readonly string[]): ModeWriteResult {
  if (isNoChoice(rawValue)) {
    return { kind: "no-choice" };
  }
  if (typeof rawValue !== "string") {
    return { kind: "rejected-non-string" };
  }
  // String sentinels take precedence over URL coercion.
  if (allowedSentinels.includes(rawValue)) {
    return { kind: "sentinel", value: rawValue };
  }
  // Disallowed sentinel: MODE_GLOBAL/MODE_MANUAL is a known string, but not in
  // allowedSentinels — reported explicitly (the self-reference check in global-config).
  if (rawValue === MODE_GLOBAL || rawValue === MODE_MANUAL) {
    return { kind: "rejected-disallowed-sentinel", value: rawValue };
  }
  const safe = coerceSafeUrl(rawValue);
  if (!safe) {
    return { kind: "rejected-unsafe-url", raw: rawValue };
  }
  return { kind: "url", value: safe };
}

/**
 * v1.25.0 (J1): pure decision helper for `gcStaleClients` (main.ts). Three outcomes:
 *  - `'seed'` — no lastSeen yet: stamp it, the GC waits one cycle
 *  - `'stale'` — lastSeen more than the TTL behind the reference → remove
 *  - `'keep'` — recent enough
 *
 * @param lastSeen  Untyped value (the broker's `native.lastSeen`).
 * @param reference The time the age is measured against: the most recently seen display, not
 *   the clock — while the adapter was off nobody could be seen (audit 2026-09-25, L3).
 * @param ttlMs     Stale TTL in ms.
 */
export function decideGcAction(lastSeen: unknown, reference: number, ttlMs: number): "seed" | "stale" | "keep" {
  const ls = typeof lastSeen === "number" && Number.isFinite(lastSeen) ? lastSeen : 0;
  if (ls === 0) {
    return "seed";
  }
  if (reference - ls > ttlMs) {
    return "stale";
  }
  return "keep";
}

/**
 * v1.25.0 (J2): pure decision helper for `migrateVisUrlToMode` (legacy-migration.ts).
 * Three cases:
 *  - empty/undefined/null → `'empty'` (nothing to migrate)
 *  - safe URL → `'safe-url'` (take the legacy URL over)
 *  - unsafe (`javascript:`, credentials, …) → `'unsafe-rejected'` (set manual mode, drop the URL)
 *
 * The logic used to sit inline in main.ts, where no unit test could reach it directly.
 *
 * @param rawValue Untyped value (from the legacy `*.visUrl` state).
 */
export function decideLegacyVisMigration(rawValue: unknown): LegacyVisMigration {
  if (isEmptyValue(rawValue)) {
    return { kind: "empty" };
  }
  const safe = coerceSafeUrl(rawValue);
  if (safe) {
    return { kind: "safe-url", safe };
  }
  return { kind: "unsafe-rejected" };
}

/**
 * v1.20.0 (F4): composes `0='---' + sentinels + url states` — the skeleton of the mode
 * dropdowns. `client-registry.buildModeStates` and `global-config.syncUrlDropdown`
 * used to compose it identically.
 *
 * @param sentinels Extra sentinel entries (e.g. `{ global: 'Global URL', manual: 'Manual URL' }`).
 * @param urlStates Discovered URLs (`{ 'http://x/': 'X', ... }`).
 */
export function buildDropdownStates(
  sentinels: Record<string, string>,
  urlStates: Record<string, string>,
): Record<string, string> {
  return { 0: "---", ...sentinels, ...urlStates };
}
