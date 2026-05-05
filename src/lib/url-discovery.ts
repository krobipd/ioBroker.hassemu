/**
 * URL Discovery — collects VIS/VIS-2 project URLs and Admin intro-tile URLs
 * from the running ioBroker instance. Result is used as `common.states` dropdown
 * on `clients.<id>.visUrl`.
 *
 * All external object data is type-guarded via coerce helpers; invalid entries
 * are silently skipped.
 */

import { coerceFiniteNumber, coerceString, coerceSafeUrl, isPlainObject } from './coerce';
import { getLocalIp, isWildcardBind } from './network';
import type { AdapterInterface, UrlStates } from './types';

/** Minimal adapter interface the discovery needs — allows easy mocking in tests. */
export interface DiscoveryAdapter extends AdapterInterface {
    /** Mirrors `ioBroker.Adapter.getForeignObjectsAsync`; typed loose so tests can mock it. */
    getForeignObjectsAsync: (pattern: string, type: 'instance') => Promise<Record<string, unknown>>;
    /** Mirrors `ioBroker.Adapter.readDirAsync`; returns an array of file entries. */
    readDirAsync: (adapterName: string, path: string) => Promise<unknown[]>;
    /** Mirrors `ioBroker.Adapter.readFileAsync`; tests mock this to provide vis-views.json. */
    readFileAsync: (adapterName: string, path: string) => Promise<{ file: Buffer | string; mimeType?: string } | string | Buffer>;
}

interface ResolveContext {
    instanceId: string;
    native: Record<string, unknown>;
    crossRefs: Map<string, Record<string, unknown>>;
    hostIp: string;
}

/** Default debounce (ms) for scheduleRefresh — groups bursts of objectChange events. */
export const DEFAULT_REFRESH_DEBOUNCE_MS = 2000;

/** Callback invoked after each successful refresh with the newly collected URL states. */
export type UrlStatesListener = (states: UrlStates) => void | Promise<void>;

/** Collects VIS/VIS-2 project URLs and Admin intro-tile URLs into the visUrl dropdown. */
export class UrlDiscovery {
    private readonly adapter: DiscoveryAdapter;
    private readonly onChange?: UrlStatesListener;
    private cached: UrlStates = {};
    private debounceTimer: ioBroker.Timeout | null = null;

    /**
     * @param adapter  Adapter instance used to read broker state.
     * @param onChange Optional callback fired after every successful refresh.
     */
    constructor(adapter: DiscoveryAdapter, onChange?: UrlStatesListener) {
        this.adapter = adapter;
        this.onChange = onChange;
    }

    /** Returns a copy of the last collected URL states. Does not trigger collection. */
    getCached(): UrlStates {
        return { ...this.cached };
    }

    /**
     * Returns the first discovered URL (insertion order), or null if the cache
     * is empty. Used by the global-config bulk-sync when the master switch is
     * flipped off — clients fall back to a sensible default URL.
     */
    getFirstDiscoveredUrl(): string | null {
        for (const url of Object.keys(this.cached)) {
            return url;
        }
        return null;
    }

    /**
     * Schedules a refresh after `debounceMs`. Multiple calls within the window coalesce into one.
     *
     * @param debounceMs Debounce window in milliseconds.
     */
    scheduleRefresh(debounceMs: number = DEFAULT_REFRESH_DEBOUNCE_MS): void {
        if (this.debounceTimer !== null) {
            this.adapter.clearTimeout(this.debounceTimer);
        }
        this.debounceTimer =
            this.adapter.setTimeout(() => {
                this.debounceTimer = null;
                this.collect().catch(err => {
                    this.adapter.log.debug(`url-discovery: refresh failed: ${String(err)}`);
                });
            }, debounceMs) ?? null;
    }

    /** Cancels any pending scheduled refresh. */
    cancelRefresh(): void {
        if (this.debounceTimer !== null) {
            this.adapter.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /** Collects all discoverable URLs from the broker. Updates cache, returns states map. */
    async collect(): Promise<UrlStates> {
        const result: UrlStates = {};
        const hostIp = getLocalIp();

        let instances: Record<string, unknown> = {};
        try {
            instances = (await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance')) ?? {};
        } catch (err) {
            this.adapter.log.debug(`url-discovery: getForeignObjectsAsync failed: ${String(err)}`);
        }

        const crossRefs = buildCrossRefs(instances);

        for (const [id, obj] of Object.entries(instances)) {
            collectFromInstance(id, obj, crossRefs, hostIp, result);
        }

        await this.addVisProjects(result, crossRefs.get('web.0'), hostIp, 'vis-2.0', 'vis-2', 'VIS-2');
        await this.addVisProjects(result, crossRefs.get('web.0'), hostIp, 'vis.0', 'vis', 'VIS');

        this.cached = result;
        if (this.onChange) {
            try {
                await this.onChange(result);
            } catch (err) {
                this.adapter.log.debug(`url-discovery: onChange listener failed: ${String(err)}`);
            }
        }
        return result;
    }

    private async addVisProjects(
        result: UrlStates,
        webInstance: Record<string, unknown> | undefined,
        hostIp: string,
        adapterName: string,
        urlPath: string,
        label: string,
    ): Promise<void> {
        if (!webInstance) {
            return;
        }
        const native = isPlainObject(webInstance.native) ? webInstance.native : null;
        if (!native) {
            return;
        }
        const port = coerceFiniteNumber(native.port);
        if (port === null) {
            return;
        }
        const bindRaw = coerceString(native.bind);
        const ip = isWildcardBind(bindRaw) ? hostIp : bindRaw!;
        const protocol = native.secure === true ? 'https' : 'http';

        let entries: unknown[] = [];
        try {
            entries = (await this.adapter.readDirAsync(adapterName, '/')) ?? [];
        } catch {
            return;
        }
        if (!Array.isArray(entries)) {
            return;
        }

        for (const e of entries) {
            if (!isPlainObject(e)) {
                continue;
            }
            if (e.isDir !== true) {
                continue;
            }
            const name = coerceString(e.file);
            if (!name || name.startsWith('_')) {
                continue;
            }
            const url = `${protocol}://${ip}:${port}/${urlPath}/index.html?${name}`;
            const safe = coerceSafeUrl(url);
            if (!safe) {
                continue;
            }
            result[safe] = `${label}: ${name}`;

            // VIS-2 hat sub-views in <project>/vis-views.json. Pro View einen
            // zusätzlichen Dropdown-Eintrag mit `?<project>/<view>` (path-routing).
            // Wenn die Datei fehlt oder malformed ist → silently skip,
            // Top-level-Projekt-Eintrag bleibt funktional.
            if (adapterName === 'vis-2.0') {
                await this.addVisViews(result, adapterName, name, url, label);
            }
        }
    }

    /**
     * Lese `<project>/vis-views.json` und füge pro View einen Dropdown-Eintrag
     * `?<project>/<viewName>` ein. Defensive — alle Fehler silently caught.
     *
     * @param result Output-Map (mutated)
     * @param adapterName VIS-Adapter (z.B. `vis-2.0`)
     * @param projectName Top-level-Projekt-Folder
     * @param projectUrl Bereits berechneter Projekt-URL (`...?projectName`)
     * @param label Sprach-Label für Dropdown (`VIS-2`)
     */
    private async addVisViews(
        result: UrlStates,
        adapterName: string,
        projectName: string,
        projectUrl: string,
        label: string,
    ): Promise<void> {
        let raw: unknown;
        try {
            raw = await this.adapter.readFileAsync(adapterName, `${projectName}/vis-views.json`);
        } catch {
            return; // file fehlt — kein VIS-2-Projekt mit Views, oder pre-VIS-2.x
        }

        // readFileAsync kann je nach js-controller-Version Buffer, string oder
        // { file, mimeType } returnen — alle Varianten zu utf-8-string normalisieren.
        let text: string;
        if (typeof raw === 'string') {
            text = raw;
        } else if (Buffer.isBuffer(raw)) {
            text = raw.toString('utf8');
        } else if (isPlainObject(raw) && raw.file !== undefined) {
            const f = raw.file;
            text = typeof f === 'string' ? f : Buffer.isBuffer(f) ? f.toString('utf8') : '';
        } else {
            return;
        }

        if (!text) {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return; // malformed JSON — Top-level-Projekt-Eintrag reicht
        }

        if (!isPlainObject(parsed)) {
            return;
        }

        // VIS-2 vis-views.json hat optionalen Top-Key `views` (Object). Wenn der
        // fehlt, sind die View-Keys direkt im Top-Level-Object. Beide Varianten
        // unterstützen — VIS-2 hat sich da über Versionen verändert.
        const viewsContainer = isPlainObject(parsed.views) ? parsed.views : parsed;

        for (const viewName of Object.keys(viewsContainer)) {
            // Skip Meta-Keys (typische VIS-2-Struktur: `views`, `settings`, `___settings`, `activeView`, ...)
            if (viewName.startsWith('_') || viewName === 'settings' || viewName === 'activeView') {
                continue;
            }
            // Skip wenn dazugehöriger Wert kein View-Object ist (View-Objects haben
            // typische Felder wie `widgets` oder `name`).
            const v = (viewsContainer as Record<string, unknown>)[viewName];
            if (!isPlainObject(v)) {
                continue;
            }
            const viewUrl = `${projectUrl}/${encodeURIComponent(viewName)}`;
            const safe = coerceSafeUrl(viewUrl);
            if (!safe) {
                continue;
            }
            result[safe] = `${label}: ${projectName} / ${viewName}`;
        }
    }
}

// --- Pure helpers (exported for testing) ---

/**
 * Indexes raw instance objects by short name (e.g. `web.0`) for placeholder cross-refs.
 *
 * @param instances Raw `system.adapter.*` objects keyed by full id.
 */
export function buildCrossRefs(instances: Record<string, unknown>): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    for (const [id, obj] of Object.entries(instances)) {
        if (!isPlainObject(obj)) {
            continue;
        }
        const short = id.startsWith('system.adapter.') ? id.substring('system.adapter.'.length) : id;
        map.set(short, obj);
    }
    return map;
}

/**
 * Scans one instance object for `localLinks`, `localLink`, `welcomeScreen`, `welcomeScreenPro`
 * and appends resolved URLs to `result`.
 *
 * @param id        Full instance id (`system.adapter.<name>.<n>`).
 * @param obj       Raw instance object.
 * @param crossRefs Map for placeholder cross-instance lookup.
 * @param hostIp    Local host IP used for wildcard binds.
 * @param result    Output map — mutated with discovered URL → label entries.
 */
export function collectFromInstance(
    id: string,
    obj: unknown,
    crossRefs: Map<string, Record<string, unknown>>,
    hostIp: string,
    result: UrlStates,
): void {
    if (!isPlainObject(obj)) {
        return;
    }
    const common = isPlainObject(obj.common) ? obj.common : null;
    if (!common) {
        return;
    }
    if (common.enabled !== true) {
        return;
    }

    const instanceId = id.startsWith('system.adapter.') ? id.substring('system.adapter.'.length) : id;
    const native = isPlainObject(obj.native) ? obj.native : {};
    const ctx: ResolveContext = { instanceId, native, crossRefs, hostIp };

    // New format: common.localLinks = { key: {link, name, ...}, ... }
    if (isPlainObject(common.localLinks)) {
        for (const entry of Object.values(common.localLinks)) {
            addFromEntry(entry, ctx, instanceId, result);
        }
    }

    // Legacy format: common.localLink = "template string"
    if (typeof common.localLink === 'string' && !isPlainObject(common.localLinks)) {
        const resolved = resolvePlaceholders(common.localLink, ctx);
        if (resolved) {
            const safe = coerceSafeUrl(resolved);
            if (safe) {
                result[safe] = instanceId;
            }
        }
    }

    // welcomeScreen / welcomeScreenPro — array or single object
    for (const key of ['welcomeScreen', 'welcomeScreenPro'] as const) {
        const ws = common[key];
        const entries = Array.isArray(ws) ? ws : isPlainObject(ws) ? [ws] : [];
        for (const entry of entries) {
            addFromEntry(entry, ctx, instanceId, result);
        }
    }
}

function addFromEntry(entry: unknown, ctx: ResolveContext, instanceId: string, result: UrlStates): void {
    if (!isPlainObject(entry)) {
        return;
    }
    const linkTpl = coerceString(entry.link);
    if (!linkTpl) {
        return;
    }
    const resolved = resolvePlaceholders(linkTpl, ctx);
    if (!resolved) {
        return;
    }
    const safe = coerceSafeUrl(resolved);
    if (!safe) {
        return;
    }
    const name = coerceString(entry.name);
    result[safe] = name ? `${instanceId}: ${name}` : instanceId;
}

/**
 * Resolves `%token%` placeholders in a template string. Returns null if any token cannot be resolved.
 *
 * Supported tokens: %ip%, %bind%, %port%, %protocol%, %secure%, %instance%, %instanceNumeric%,
 * %native_<field>%, %<adapter>.<inst>_<field>% (cross-instance, e.g. %web.0_port%).
 *
 * @param template Link template containing `%...%` placeholders.
 * @param ctx      Lookup context (instance native, cross-refs, host IP).
 */
export function resolvePlaceholders(template: string, ctx: ResolveContext): string | null {
    let failed = false;
    const out = template.replace(/%([^%]+)%/g, (match, token: string) => {
        const v = resolveOne(token, ctx);
        if (v === null) {
            failed = true;
            return match;
        }
        return v;
    });
    return failed ? null : out;
}

function resolveOne(token: string, ctx: ResolveContext): string | null {
    switch (token) {
        case 'ip':
            return ctx.hostIp;
        case 'bind': {
            const b = coerceString(ctx.native.bind);
            return isWildcardBind(b) ? ctx.hostIp : b;
        }
        case 'port': {
            const p = coerceFiniteNumber(ctx.native.port);
            return p !== null ? String(p) : null;
        }
        case 'protocol':
            return ctx.native.secure === true ? 'https' : 'http';
        case 'secure':
            return ctx.native.secure === true ? 'true' : 'false';
        case 'instance':
            return ctx.instanceId.split('.').pop() ?? null;
        case 'instanceNumeric': {
            const last = ctx.instanceId.split('.').pop();
            return last && /^\d+$/.test(last) ? last : null;
        }
    }

    if (token.startsWith('native_')) {
        const field = token.substring('native_'.length);
        return primitiveToString(ctx.native[field]);
    }

    const crossMatch = token.match(/^([a-zA-Z0-9-]+\.\d+)_(.+)$/);
    if (crossMatch) {
        const [, refKey, field] = crossMatch;
        const refInstance = ctx.crossRefs.get(refKey);
        if (!refInstance) {
            return null;
        }
        const refNative = isPlainObject(refInstance.native) ? refInstance.native : null;
        if (!refNative) {
            return null;
        }
        if (field === 'bind') {
            const b = coerceString(refNative.bind);
            return isWildcardBind(b) ? ctx.hostIp : b;
        }
        if (field === 'port') {
            const p = coerceFiniteNumber(refNative.port);
            return p !== null ? String(p) : null;
        }
        if (field === 'protocol') {
            return refNative.secure === true ? 'https' : 'http';
        }
        return primitiveToString(refNative[field]);
    }

    return null;
}

function primitiveToString(v: unknown): string | null {
    if (typeof v === 'string') {
        return v;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
        return String(v);
    }
    if (typeof v === 'boolean') {
        return String(v);
    }
    return null;
}
