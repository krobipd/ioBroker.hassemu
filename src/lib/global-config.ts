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
    parseAdapterStateId,
    parseManualUrlWrite,
    parseModeWrite,
    safeGetState,
} from './coerce';
import { MODE_GLOBAL, MODE_MANUAL } from './constants';
import { tLabel } from './i18n-states';
import type { AdapterInterface, ClientRecord, UrlStates } from './types';

/** Extended adapter interface — needs state I/O and object extend. */
export type GlobalConfigAdapter = AdapterInterface &
    Pick<
        ioBroker.Adapter,
        'getStateAsync' | 'setStateAsync' | 'getObjectAsync' | 'setObjectAsync' | 'extendObjectAsync'
    >;

/** Kinds of state IDs the GlobalConfig reacts to. */
export type GlobalStateKind = 'mode' | 'manualUrl' | 'enabled';

// Re-export für Backwards-Kompatibilität — Tests importieren direkt von hier.
export { MODE_GLOBAL, MODE_MANUAL } from './constants';

/** Holds the runtime state of the global redirect override. */
export class GlobalConfig {
    private readonly adapter: GlobalConfigAdapter;
    private mode: string = '';
    private manualUrl: string | null = null;
    private enabled = false;

    /** @param adapter Adapter instance used for state and object I/O. */
    constructor(adapter: GlobalConfigAdapter) {
        this.adapter = adapter;
    }

    /** Loads the current global.* values from the broker. Call once on adapter start. */
    async restore(): Promise<void> {
        const modeState = await safeGetState(this.adapter, 'global.mode');
        const manualState = await safeGetState(this.adapter, 'global.manualUrl');
        const enabledState = await safeGetState(this.adapter, 'global.enabled');
        this.mode = typeof modeState?.val === 'string' ? modeState.val : '';
        this.manualUrl = coerceSafeUrl(manualState?.val);
        this.enabled = coerceBoolean(enabledState?.val) === true;

        // Promote a blank state-value (`''`/null/undefined) to numeric `0` so
        // the admin dropdown renders the `0='---'` option as selected. v1.2.0
        // installs left the value as `''` which doesn't match any common.states
        // entry, so the dropdown showed an empty selection.
        const v = modeState?.val;
        if (v === '' || v === null || v === undefined) {
            await this.adapter.setStateAsync('global.mode', { val: 0, ack: true });
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
        return this.resolveClientMode(record);
    }

    private resolveClientMode(record: ClientRecord): string | null {
        const m: unknown = record.mode;
        if (isNoChoice(m)) {
            return null;
        }
        if (m === MODE_GLOBAL) {
            return this.resolveGlobalMode();
        }
        if (m === MODE_MANUAL) {
            return record.manualUrl ?? null;
        }
        return coerceSafeUrl(m);
    }

    private resolveGlobalMode(): string | null {
        if (isNoChoice(this.mode)) {
            return null;
        }
        if (this.mode === MODE_MANUAL) {
            return this.manualUrl;
        }
        return coerceSafeUrl(this.mode);
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
            case 'no-choice':
                this.mode = '';
                await this.adapter.setStateAsync('global.mode', { val: 0, ack: true });
                return;
            case 'rejected-non-string':
                this.adapter.log.warn(`global.mode rejected — non-string value`);
                await this.adapter.setStateAsync('global.mode', { val: this.mode || 0, ack: true });
                return;
            case 'rejected-disallowed-sentinel':
                // MODE_GLOBAL bei global.mode → self-referential.
                this.adapter.log.warn(
                    `global.mode rejected — "global" is not allowed at the global level (self-referential)`,
                );
                await this.adapter.setStateAsync('global.mode', { val: this.mode, ack: true });
                return;
            case 'sentinel':
                if (result.value === MODE_MANUAL && !this.manualUrl) {
                    this.adapter.log.warn(
                        `global.mode is "manual" but global.manualUrl is empty — fill global.manualUrl to redirect`,
                    );
                }
                this.mode = result.value;
                await this.adapter.setStateAsync('global.mode', { val: result.value, ack: true });
                return;
            case 'rejected-unsafe-url':
                this.adapter.log.warn(`global.mode rejected — unsafe URL value "${result.raw}"`);
                await this.adapter.setStateAsync('global.mode', { val: this.mode, ack: true });
                return;
            case 'url':
                this.mode = result.value;
                await this.adapter.setStateAsync('global.mode', { val: result.value, ack: true });
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
            await this.adapter.setStateAsync('global.manualUrl', { val: this.manualUrl ?? '', ack: true });
            return;
        }
        this.manualUrl = result.safe;
        await this.adapter.setStateAsync('global.manualUrl', { val: result.safe ?? '', ack: true });
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
        const enabled = coerceBoolean(rawValue) === true;
        this.enabled = enabled;
        await this.adapter.setStateAsync('global.enabled', { val: enabled, ack: true });
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
        const merged = buildDropdownStates({ [MODE_MANUAL]: tLabel('manualUrl') as unknown as string }, states);
        // v1.27.2: extendObjectAsync mergt `common.states` tief — alte
        // URL-Schlüssel bleiben drin nach Format-Wechsel (z.B. v1.26→v1.27).
        // Object lesen, common.states ersetzen, setObjectAsync.
        const existing = await this.adapter.getObjectAsync('global.mode');
        if (!existing) {
            return;
        }
        existing.common.states = merged;
        await this.adapter.setObjectAsync('global.mode', existing);
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
        await this.adapter.setStateAsync('global.mode', { val: safeMode, ack: true });
        await this.adapter.setStateAsync('global.manualUrl', { val: safeManual ?? '', ack: true });
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
    const parts = parseAdapterStateId(fullId, namespace, 'global.', 1);
    if (!parts) {
        return null;
    }
    const [tail] = parts;
    if (tail === 'mode' || tail === 'manualUrl' || tail === 'enabled') {
        return tail;
    }
    return null;
}
