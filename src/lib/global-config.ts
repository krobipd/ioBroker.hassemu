/**
 * Global redirect override.
 *
 * Holds three datapoints:
 * - `global.enabled` — master switch. Toggling triggers a bulk-update of all
 *    `clients.<id>.mode` (driven from {@link main.ts}, not from this class).
 * - `global.mode` — dropdown with discovered URLs plus the `'manual'` sentinel.
 *    `'global'` is intentionally not allowed here (would be self-referential).
 * - `global.manualUrl` — free-text URL used when `global.mode === 'manual'`.
 *
 * The resolver delegates: a client whose `mode === 'global'` ends up here.
 */

import {
  buildDropdownStates,
  coerceBoolean,
  coerceSafeUrl,
  isNoChoice,
  oneLine,
  parseAdapterStateId,
  parseManualUrlWrite,
  parseModeWrite,
  safeGetState,
  shallowStatesEqual,
} from "./coerce";
import { MODE_GLOBAL, MODE_MANUAL } from "./constants";
import { resolveLabel } from "./i18n";
import type { AdapterInterface, ClientRecord, UrlStates } from "./types";

/** Extended adapter interface — needs state I/O and object extend. */
export type GlobalConfigAdapter = AdapterInterface &
  Pick<ioBroker.Adapter, "getStateAsync" | "setState" | "getObjectAsync" | "setObject" | "extendObject">;

/** Kinds of state IDs the GlobalConfig reacts to. */
export type GlobalStateKind = "mode" | "manualUrl" | "enabled";

/** Holds the runtime state of the global redirect override. */
export class GlobalConfig {
  private readonly adapter: GlobalConfigAdapter;
  private mode: string = "";
  private manualUrl: string | null = null;
  private enabled = false;

  /** @param adapter Adapter instance used for state and object I/O. */
  constructor(adapter: GlobalConfigAdapter) {
    this.adapter = adapter;
  }

  /** Loads the current global.* values from the broker. Call once on adapter start. */
  async restore(): Promise<void> {
    const modeState = await safeGetState(this.adapter, "global.mode");
    const manualState = await safeGetState(this.adapter, "global.manualUrl");
    const enabledState = await safeGetState(this.adapter, "global.enabled");
    this.mode = typeof modeState?.val === "string" ? modeState.val : "";
    this.manualUrl = coerceSafeUrl(manualState?.val);
    this.enabled = coerceBoolean(enabledState?.val) === true;

    // Promote a blank (`''`/null/undefined) OR a legacy numeric `0` mode value to
    // the string `"0"` so the admin dropdown renders the `0='---'` option as selected
    // AND the stored value type stays consistent (I19 v1.37.0 — the dropdown key is
    // the string "0"; older installs wrote the number 0). v1.2.0 installs left it as
    // `''`, which matched no common.states entry (empty selection).
    const v = modeState?.val;
    if (v === "" || v === null || v === undefined || v === 0) {
      await this.adapter.setState("global.mode", { val: "0", ack: true });
    }
  }

  /**
   * Resolves the redirect URL for `record`.
   *
   * Delegates via the client's `mode`:
   * - `'global'` → resolve global mode/manualUrl
   * - `'manual'` → client's manualUrl
   * - URL string → that URL
   * - empty / unknown → null (setup page)
   *
   * @param record Client to resolve for.
   */
  resolveUrlFor(record: ClientRecord): string | null {
    // Single resolution path: WithChain holds the logic; the plain caller just
    // drops the (cheap) chain string. Avoids the prior duplicate impl that could
    // drift from the chain version.
    return this.resolveUrlForWithChain(record).url;
  }

  /**
   * v1.32.0 B1: Resolves the redirect URL AND returns the resolution chain
   * for debug-tracing. Chain examples:
   *   `direct→{url}`           — client.mode is a URL itself
   *   `manual→{url}`           — client.mode='manual' + client.manualUrl
   *   `global→direct→{url}`    — client.mode='global' + global.mode=URL
   *   `global→manual→{url}`    — client.mode='global' + global.mode='manual' + global.manualUrl
   *   `global→landing`         — client.mode='global' + global has no resolvable URL
   *   `landing`                — client.mode is empty/no-choice
   *
   * @param record Client to resolve for.
   */
  resolveUrlForWithChain(record: ClientRecord): { url: string | null; chain: string } {
    // `global` recurses into the global config; every other mode value resolves the
    // same way at the client and global level, so both delegate to resolveOne().
    if (record.mode === MODE_GLOBAL) {
      const inner = this.resolveGlobalModeWithChain();
      return { url: inner.url, chain: `global→${inner.chain}` };
    }
    return this.resolveOne(record.mode, record.manualUrl);
  }

  private resolveGlobalModeWithChain(): { url: string | null; chain: string } {
    return this.resolveOne(this.mode, this.manualUrl);
  }

  /**
   * I16 (v1.37.0): resolve a single (mode, manualUrl) pair to a URL + debug chain.
   * The shared tail of {@link resolveUrlForWithChain} (client level) and
   * {@link resolveGlobalModeWithChain} (global level) — they differ only in whether
   * `global` is a legal mode (client-only), which the client caller handles before
   * delegating here. `ClientRecord.manualUrl` is already `string | null` (L45).
   *
   * @param mode      A `mode` value (`'manual'`, a URL, or a no-choice sentinel).
   * @param manualUrl The `manualUrl` paired with `mode === 'manual'`.
   */
  private resolveOne(mode: unknown, manualUrl: string | null): { url: string | null; chain: string } {
    if (isNoChoice(mode)) {
      return { url: null, chain: "landing" };
    }
    if (mode === MODE_MANUAL) {
      return { url: manualUrl, chain: manualUrl ? `manual→${manualUrl}` : "manual→landing" };
    }
    const safe = coerceSafeUrl(mode);
    return { url: safe, chain: safe ? `direct→${safe}` : "landing" };
  }

  /** Returns whether the master switch is currently active. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Accept a write on `global.mode`. Allowed values: `'manual'` or a URL that
   * passes {@link coerceSafeUrl}. `'global'` is rejected (would be
   * self-referential). Empty string clears the choice.
   *
   * @param rawValue Value written to the state.
   */
  async handleModeWrite(rawValue: unknown): Promise<void> {
    // v1.23.0 (F2): zentralisierte Validierung via parseModeWrite. Erlaubte
    // Sentinels: nur MODE_MANUAL — MODE_GLOBAL wäre self-referential
    // (global.mode='global' → resolve global.mode → ...).
    const result = parseModeWrite(rawValue, [MODE_MANUAL]);
    switch (result.kind) {
      case "no-choice":
        this.mode = "";
        await this.adapter.setState("global.mode", { val: "0", ack: true });
        this.adapter.log.debug(`global.mode → cleared (no-choice)`);
        return;
      case "rejected-non-string":
        this.adapter.log.warn(`global.mode rejected — non-string value`);
        await this.adapter.setState("global.mode", { val: this.mode || "0", ack: true });
        return;
      case "rejected-disallowed-sentinel":
        // MODE_GLOBAL bei global.mode → self-referential.
        this.adapter.log.warn(`global.mode rejected — "global" is not allowed at the global level (self-referential)`);
        // L37: revert to `this.mode || "0"` so a blank mode reverts to the dropdown's `0='---'`.
        await this.adapter.setState("global.mode", { val: this.mode || "0", ack: true });
        return;
      case "sentinel":
        if (result.value === MODE_MANUAL && !this.manualUrl) {
          this.adapter.log.warn(
            `global.mode is "manual" but global.manualUrl is empty — fill global.manualUrl to redirect`,
          );
        }
        this.mode = result.value;
        await this.adapter.setState("global.mode", { val: result.value, ack: true });
        this.adapter.log.debug(`global.mode → '${result.value}' (sentinel)`);
        return;
      case "rejected-unsafe-url":
        // L1(b): raw is an unvalidated state value — flatten + cap it for the log.
        this.adapter.log.warn(`global.mode rejected — unsafe URL value "${oneLine(result.raw).substring(0, 120)}"`);
        // L37: revert to `this.mode || "0"` so a blank mode reverts to the dropdown's `0='---'`.
        await this.adapter.setState("global.mode", { val: this.mode || "0", ack: true });
        return;
      case "url":
        this.mode = result.value;
        await this.adapter.setState("global.mode", { val: result.value, ack: true });
        this.adapter.log.debug(`global.mode → ${result.value} (direct URL)`);
        return;
    }
  }

  /**
   * Accept a write on `global.manualUrl`. Free-text — must pass
   * {@link coerceSafeUrl} (or be empty to clear).
   *
   * @param rawValue Value written to the state.
   */
  async handleManualUrlWrite(rawValue: unknown): Promise<void> {
    const result = parseManualUrlWrite(rawValue);
    if (!result.ok) {
      this.adapter.log.warn(`global.manualUrl rejected — unsafe URL`);
      await this.adapter.setState("global.manualUrl", { val: this.manualUrl ?? "", ack: true });
      return;
    }
    this.manualUrl = result.safe;
    await this.adapter.setState("global.manualUrl", { val: result.safe ?? "", ack: true });
    this.adapter.log.debug(`global.manualUrl → ${result.safe ?? "cleared"}`);
    if (this.mode === MODE_MANUAL && !result.safe) {
      this.adapter.log.warn(
        `global.manualUrl cleared while global.mode is "manual" — clients delegating to global will see the setup page`,
      );
    }
  }

  /**
   * Accept a write on `global.enabled`. Persists the value but does NOT trigger
   * the bulk-sync of client modes — the caller (main.ts) does that, because it
   * holds the registry + url-discovery references needed for the sync.
   *
   * @param rawValue Value written to the state.
   */
  async handleEnabledWrite(rawValue: unknown): Promise<void> {
    const coerced = coerceBoolean(rawValue);
    if (coerced === null) {
      // L9: a non-boolean write (a script setting 1 or "true") must not silently
      // flip the master switch off — revert to the current value + warn, like the
      // mode-write rejects. main.ts reads isEnabled() afterwards, so an unchanged
      // value bulk-syncs to a no-op.
      this.adapter.log.warn(`global.enabled rejected — non-boolean value`);
      await this.adapter.setState("global.enabled", { val: this.enabled, ack: true });
      return;
    }
    this.enabled = coerced;
    await this.adapter.setState("global.enabled", { val: coerced, ack: true });
    this.adapter.log.debug(`global.enabled → ${coerced} (master switch)`);
  }

  /**
   * Updates the dropdown states (`common.states`) on `global.mode`.
   * The `'manual'` sentinel is added; `'global'` is NOT (would be self-referential).
   *
   * @param states Discovered URL → label map.
   */
  async syncUrlDropdown(states: UrlStates): Promise<void> {
    // v1.20.0 (F4): buildDropdownStates Helper aus coerce.ts — vorher
    // hatten client-registry und global-config identische `0='---' +
    // sentinels + states`-Composition. Hier nur `manual`-Sentinel weil
    // `global` in global-config self-referential wäre.
    // resolveLabel() returns a plain string (I18n.translate) — NOT a translation
    // object: Admin renders common.states VALUES directly as a React child and
    // crashes on translation objects with React Error #31.
    const merged = buildDropdownStates({ [MODE_MANUAL]: resolveLabel("manualUrl") }, states);
    // v1.27.2: extendObject mergt `common.states` tief — alte
    // URL-Schlüssel bleiben drin nach Format-Wechsel (z.B. v1.26→v1.27).
    // Object lesen, common.states ersetzen, setObject.
    const existing = await this.adapter.getObjectAsync("global.mode");
    if (!existing) {
      return;
    }
    // I4: skip the write when the dropdown is already identical — no jsonl churn
    // / objectChange fan-out for a discovery run that changed nothing.
    if (shallowStatesEqual(existing.common.states, merged)) {
      return;
    }
    existing.common.states = merged;
    await this.adapter.setObject("global.mode", existing);
  }

  /**
   * Convenience for migration: set mode + manualUrl together. Skips the
   * write-side validation that {@link handleModeWrite} / {@link handleManualUrlWrite}
   * apply, because migration trusts the legacy values it carries forward.
   *
   * @param mode      New mode value.
   * @param manualUrl New manualUrl, or null to clear.
   */
  async migrationSet(mode: string, manualUrl: string | null): Promise<void> {
    // v1.12.0 (C10): trust-Annahme aus dem Caller droppen. Wenn `mode` weder
    // 'manual' noch eine sichere URL ist, defaulten wir auf 'manual' (das
    // legt user-facing den Setup-Pfad nah und vermeidet schreiben von
    // unsicheren values wie `javascript:alert(1)`).
    const safeMode = mode === MODE_MANUAL || coerceSafeUrl(mode) ? mode : MODE_MANUAL;
    const safeManual = manualUrl !== null ? coerceSafeUrl(manualUrl) : null;
    this.mode = safeMode;
    this.manualUrl = safeManual;
    await this.adapter.setState("global.mode", { val: safeMode, ack: true });
    await this.adapter.setState("global.manualUrl", { val: safeManual ?? "", ack: true });
  }

  // v1.20.0 (F10): private safeGetState war duplicate zu coerce.ts:safeGetState —
  // jetzt direkt importiert.
}

/**
 * Check whether a full state ID matches a global control datapoint.
 *
 * @param fullId    The full state id from a state change event.
 * @param namespace The adapter namespace (e.g. `hassemu.0`).
 */
export function parseGlobalStateId(fullId: string, namespace: string): GlobalStateKind | null {
  // v1.20.0 (F9): generischer parseAdapterStateId-Helper. Vorher hatte
  // global-config seine eigene Prefix-+-Tail-Validierung dupliziert mit
  // client-registry.parseClientStateId.
  const parts = parseAdapterStateId(fullId, namespace, "global.", 1);
  if (!parts) {
    return null;
  }
  const [tail] = parts;
  if (tail === "mode" || tail === "manualUrl" || tail === "enabled") {
    return tail;
  }
  return null;
}
