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

import { coerceBoolean, coerceSafeUrl, parseManualUrlWrite } from './coerce';
import type { AdapterInterface, ClientRecord, UrlStates } from './types';

/** Extended adapter interface — needs state I/O and object extend. */
export type GlobalConfigAdapter = AdapterInterface &
    Pick<ioBroker.Adapter, 'getStateAsync' | 'setStateAsync' | 'extendObjectAsync'>;

/** Kinds of state IDs the GlobalConfig reacts to. */
export type GlobalStateKind = 'mode' | 'manualUrl' | 'enabled';

/** Sentinel value: client delegates to global. Not legal as `global.mode`. */
export const MODE_GLOBAL = 'global';
/** Sentinel value: use the matching manualUrl datapoint. */
export const MODE_MANUAL = 'manual';

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
        const modeState = await this.safeGetState('global.mode');
        const manualState = await this.safeGetState('global.manualUrl');
        const enabledState = await this.safeGetState('global.enabled');
        this.mode = typeof modeState?.val === 'string' ? modeState.val : '';
        this.manualUrl = coerceSafeUrl(manualState?.val);
        this.enabled = coerceBoolean(enabledState?.val) === true;
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
        // No-choice markers: numeric 0, string '0', empty string — all → null
        if (m === 0 || m === '0' || m === '') {
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
        const m: unknown = this.mode;
        if (m === 0 || m === '0' || m === '') {
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
        // No-choice markers: numeric 0, string '0', empty string — all clear the choice
        if (rawValue === 0 || rawValue === '0' || rawValue === '') {
            this.mode = '';
            await this.adapter.setStateAsync('global.mode', { val: 0, ack: true });
            return;
        }
        if (typeof rawValue !== 'string') {
            this.adapter.log.warn('global-config: rejected non-string global.mode');
            await this.adapter.setStateAsync('global.mode', { val: this.mode || 0, ack: true });
            return;
        }
        if (rawValue === MODE_GLOBAL) {
            this.adapter.log.warn("global-config: 'global' is not allowed as global.mode (self-referential)");
            await this.adapter.setStateAsync('global.mode', { val: this.mode, ack: true });
            return;
        }
        if (rawValue === MODE_MANUAL) {
            if (!this.manualUrl) {
                this.adapter.log.warn(
                    "global-config: global.mode set to 'manual' but global.manualUrl is empty — fill it to redirect",
                );
            }
            this.mode = MODE_MANUAL;
            await this.adapter.setStateAsync('global.mode', { val: MODE_MANUAL, ack: true });
            return;
        }
        const safe = coerceSafeUrl(rawValue);
        if (!safe) {
            this.adapter.log.warn(`global-config: rejected unsafe global.mode value '${rawValue}'`);
            await this.adapter.setStateAsync('global.mode', { val: this.mode, ack: true });
            return;
        }
        this.mode = safe;
        await this.adapter.setStateAsync('global.mode', { val: safe, ack: true });
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
            this.adapter.log.warn('global-config: rejected unsafe global.manualUrl');
            await this.adapter.setStateAsync('global.manualUrl', { val: this.manualUrl ?? '', ack: true });
            return;
        }
        this.manualUrl = result.safe;
        await this.adapter.setStateAsync('global.manualUrl', { val: result.safe ?? '', ack: true });
        if (this.mode === MODE_MANUAL && !result.safe) {
            this.adapter.log.warn(
                "global-config: global.manualUrl cleared while global.mode='manual' — clients delegating to global will hit the setup page",
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
        // 0='---' is the no-choice fallback (analogous to govee-smart pattern).
        // 'global' is intentionally NOT in this map — it would be self-referential.
        const merged: UrlStates = { 0: '---', [MODE_MANUAL]: 'Manual URL', ...states };
        await this.adapter.extendObjectAsync('global.mode', {
            common: { states: merged },
        });
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
        this.mode = mode;
        this.manualUrl = manualUrl;
        await this.adapter.setStateAsync('global.mode', { val: mode, ack: true });
        await this.adapter.setStateAsync('global.manualUrl', { val: manualUrl ?? '', ack: true });
    }

    private async safeGetState(id: string): Promise<ioBroker.State | null> {
        try {
            return (await this.adapter.getStateAsync(id)) ?? null;
        } catch {
            return null;
        }
    }
}

/**
 * Check whether a full state ID matches a global control datapoint.
 *
 * @param fullId    The full state id from a state change event.
 * @param namespace The adapter namespace (e.g. `hassemu.0`).
 */
export function parseGlobalStateId(fullId: string, namespace: string): GlobalStateKind | null {
    const prefix = `${namespace}.global.`;
    if (!fullId.startsWith(prefix)) {
        return null;
    }
    const tail = fullId.substring(prefix.length);
    if (tail === 'mode' || tail === 'manualUrl' || tail === 'enabled') {
        return tail;
    }
    return null;
}
