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
 * „No-choice"-Marker: User hat den Default-Eintrag `0='---'` (oder eine seiner
 * Repräsentationen) gewählt. Behandelt sowohl die numerische `0` (Admin-UI
 * mit `type: mixed` Dropdowns), die String-Variante `'0'` und den leeren String.
 *
 * Wird in beiden Mode-Handlers (client-registry, global-config) gleich behandelt
 * — vor v1.8.0 war die Logik 4× dupliziert. Jeder andere Wert ist ein „echter"
 * User-Input und muss validiert werden.
 *
 * @param value Untrusted input vom Mode-State (numeric 0 / string '0' / '' / URL / sentinel).
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
 * v1.23.0 (F2): zentralisierte Validierung für Mode-Writes. Vorher hatten
 * `ClientRegistry.handleModeWrite` und `GlobalConfig.handleModeWrite` ~80%
 * der Logik dupliziert (no-choice, non-string-reject, sentinel-check, URL-
 * coerce). Beide nutzen jetzt diesen Helper und steuern nur ihre eigenen
 * State-IDs / Logging-Prefixes / erlaubte Sentinels.
 *
 * `allowedSentinels` ist die Liste der zulässigen non-URL Mode-Werte —
 * client-registry erlaubt z.B. `[MODE_GLOBAL, MODE_MANUAL]`, global-config
 * nur `[MODE_MANUAL]` (MODE_GLOBAL wäre self-referential).
 *
 * @param rawValue         Wert vom State-Write.
 * @param allowedSentinels Erlaubte Non-URL-Sentinels.
 */
export function parseModeWrite(rawValue: unknown, allowedSentinels: readonly string[]): ModeWriteResult {
  if (isNoChoice(rawValue)) {
    return { kind: "no-choice" };
  }
  if (typeof rawValue !== "string") {
    return { kind: "rejected-non-string" };
  }
  // String-Sentinels haben Vorrang vor URL-Coerce.
  if (allowedSentinels.includes(rawValue)) {
    return { kind: "sentinel", value: rawValue };
  }
  // Disallowed-Sentinel-Detection: wenn der Caller MODE_GLOBAL/MODE_MANUAL
  // als known-strings hat, aber sie nicht in allowedSentinels sind, melden
  // wir das explizit (für Self-Referential-Check in global-config).
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
 * v1.25.0 (J1): pure decision-helper für `gcStaleClients` (main.ts).
 * Drei Outcomes:
 *  - `'seed'` — kein lastSeen vorhanden, Timestamp setzen, GC wartet einen Cycle
 *  - `'stale'` — lastSeen älter als TTL → entfernen
 *  - `'keep'` — lastSeen neu genug → keep
 *
 * Vorher war diese Logik inline in main.ts → nicht direkt unit-testbar.
 *
 * @param lastSeen Untyped value (kommt aus broker `native.lastSeen`).
 * @param now      Aktuelle Zeit in ms.
 * @param ttlMs    Stale-TTL in ms.
 */
export function decideGcAction(lastSeen: unknown, now: number, ttlMs: number): "seed" | "stale" | "keep" {
  const ls = typeof lastSeen === "number" && Number.isFinite(lastSeen) ? lastSeen : 0;
  if (ls === 0) {
    return "seed";
  }
  if (now - ls > ttlMs) {
    return "stale";
  }
  return "keep";
}

/**
 * v1.25.0 (J2): pure decision-helper für die `migrateVisUrlToMode`-Logik
 * (main.ts). Behandelt drei Fälle:
 *  - leer/undefined/null → `'empty'` (keine Migration nötig)
 *  - safe-URL → `'safe-url'` (legacy-URL übernehmen)
 *  - unsafe (`javascript:`/Credentials/etc.) → `'unsafe-rejected'` (Manual-Mode setzen, URL verwerfen)
 *
 * Vorher war diese Logik inline in main.ts → nicht direkt unit-testbar.
 *
 * @param rawValue Untyped value (aus dem legacy `*.visUrl`-State).
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
 * v1.20.0 (F4): composed `0='---' + sentinels + url-states` — Grundgerüst
 * der Mode-Dropdowns. Vorher hatten `client-registry.buildModeStates` und
 * `global-config.syncUrlDropdown` identische Composition.
 *
 * @param sentinels Zusätzliche Sentinel-Einträge (z.B. `{ global: 'Follow master', manual: 'Manual URL' }`).
 * @param urlStates Discovered URLs (`{ 'http://x/': 'X', ... }`).
 */
export function buildDropdownStates(
  sentinels: Record<string, string>,
  urlStates: Record<string, string>,
): Record<string, string> {
  return { 0: "---", ...sentinels, ...urlStates };
}
