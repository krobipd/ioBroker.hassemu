/**
 * Global redirect override.
 *
 * When `global.enabled` is true, every client is redirected to `global.visUrl`.
 * Otherwise each client uses its own `clients.<id>.visUrl`. If neither is set,
 * the webserver serves the setup page instead of a redirect.
 */

import { coerceBoolean, coerceSafeUrl } from './coerce';
import type { AdapterInterface, ClientRecord, UrlStates } from './types';

/** Extended adapter interface — needs state I/O and object extend. */
export type GlobalConfigAdapter = AdapterInterface &
    Pick<ioBroker.Adapter, 'getStateAsync' | 'setStateAsync' | 'extendObjectAsync'>;

/** Kinds of state IDs the GlobalConfig reacts to. */
export type GlobalStateKind = 'visUrl' | 'enabled';

/** Holds the runtime state of the global redirect override. */
export class GlobalConfig {
    private readonly adapter: GlobalConfigAdapter;
    private visUrl: string | null = null;
    private enabled = false;

    /** @param adapter Adapter instance used for state and object I/O. */
    constructor(adapter: GlobalConfigAdapter) {
        this.adapter = adapter;
    }

    /** Loads the current global.* values from the broker. Call once on adapter start. */
    async restore(): Promise<void> {
        const urlState = await this.safeGetState('global.visUrl');
        const enabledState = await this.safeGetState('global.enabled');
        this.visUrl = coerceSafeUrl(urlState?.val);
        this.enabled = coerceBoolean(enabledState?.val) === true;
    }

    /**
     * Resolves the redirect URL for `record`.
     * Returns the global URL if the override is enabled and set, otherwise the
     * client's own URL, or `null` when nothing is configured.
     *
     * @param record Client to resolve the URL for.
     */
    resolveUrlFor(record: ClientRecord): string | null {
        if (this.enabled && this.visUrl) {
            return this.visUrl;
        }
        return record.visUrl;
    }

    /** Returns the stored global URL regardless of the enabled flag. */
    getGlobalUrl(): string | null {
        return this.visUrl;
    }

    /** Returns whether the global override is currently active. */
    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Accept an external write on `global.visUrl`. Unsafe URLs are rejected,
     * empty string / null clears the override.
     *
     * @param rawValue Value written to the state.
     */
    async handleVisUrlWrite(rawValue: unknown): Promise<void> {
        const empty = rawValue === '' || rawValue === null || rawValue === undefined;
        const safe = empty ? null : coerceSafeUrl(rawValue);
        if (!empty && !safe) {
            this.adapter.log.warn('global-config: rejected unsafe global.visUrl');
            await this.adapter.setStateAsync('global.visUrl', { val: this.visUrl ?? '', ack: true });
            return;
        }
        this.visUrl = safe;
        await this.adapter.setStateAsync('global.visUrl', { val: safe ?? '', ack: true });
    }

    /**
     * Accept an external write on `global.enabled`.
     *
     * @param rawValue Value written to the state.
     */
    async handleEnabledWrite(rawValue: unknown): Promise<void> {
        const enabled = coerceBoolean(rawValue) === true;
        this.enabled = enabled;
        await this.adapter.setStateAsync('global.enabled', { val: enabled, ack: true });
    }

    /**
     * Updates the dropdown states (common.states) on `global.visUrl`.
     *
     * @param states Discovered URL → label map.
     */
    async syncUrlDropdown(states: UrlStates): Promise<void> {
        await this.adapter.extendObjectAsync('global.visUrl', {
            common: { states: { ...states } },
        });
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
    if (tail === 'visUrl' || tail === 'enabled') {
        return tail;
    }
    return null;
}
