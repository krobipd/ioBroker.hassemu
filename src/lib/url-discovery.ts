/**
 * URL Discovery — collects VIS / VIS-2 project URLs, Aura adapter frontends
 * and Admin intro-tile URLs from the running ioBroker instance. Result is
 * used as `common.states` dropdown on `clients.<id>.mode` (and the global
 * `global.mode`).
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
    readFileAsync: (
        adapterName: string,
        path: string,
    ) => Promise<{ file: Buffer | string; mimeType?: string } | string | Buffer>;
}

interface ResolveContext {
    instanceId: string;
    native: Record<string, unknown>;
    crossRefs: Map<string, Record<string, unknown>>;
    hostIp: string;
}

/** Default debounce (ms) for scheduleRefresh — groups bursts of objectChange events. */
export const DEFAULT_REFRESH_DEBOUNCE_MS = 2000;

/**
 * Adapter id-prefixes whose `objectChange` events should trigger an
 * automatic `scheduleRefresh`. Each entry corresponds to a URL source the
 * discovery actually consumes — admin tiles, web instances (for VIS / VIS-2
 * project listings), and aura standalone frontends.
 *
 * Adding a new source adapter here is half the work of supporting it; the
 * other half lives in `collect()` / `addAuraInstance` etc.
 */
export const URL_SOURCE_PREFIXES = Object.freeze([
    'system.adapter.admin.',
    'system.adapter.web.',
    'system.adapter.vis.',
    'system.adapter.vis-2.',
    'system.adapter.aura.',
] as const);

/**
 * True when an `objectChange` event for `id` belongs to an adapter whose
 * config can influence the URL discovery output. Used by main.ts to decide
 * whether to debounce-schedule a refresh.
 *
 * @param id Full ioBroker object id from the `objectChange` event.
 */
export function isUrlSourceAdapterEvent(id: string): boolean {
    return URL_SOURCE_PREFIXES.some(p => id.startsWith(p));
}

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
        // v1.32.0 B2: per-Adapter-Tracking für Discovery-Summary statt N silent-skips.
        // Skip-Sites mutieren `skipped`; finale Zeile pro collect() summarisiert.
        const skipped: Array<{ adapter: string; reason: string }> = [];

        let instances: Record<string, unknown> = {};
        let instancesOk = false;
        try {
            instances = (await this.adapter.getForeignObjectsAsync('system.adapter.*', 'instance')) ?? {};
            instancesOk = true;
        } catch (err) {
            this.adapter.log.debug(`url-discovery: getForeignObjectsAsync failed: ${String(err)}`);
        }

        // v1.8.1 (D4): bei transientem Broker-Fehler nicht den Cache mit `{}`
        // wipen. Listeners würden sonst leere Dropdowns sehen, mode='global'
        // resolved-via-discovered-URL fiele in null durch. Beim nächsten Refresh
        // (debounce 2s) erholt es sich. Neue States werden NUR bei Erfolg
        // committed.
        if (!instancesOk) {
            return { ...this.cached };
        }

        const crossRefs = buildCrossRefs(instances);

        for (const [id, obj] of Object.entries(instances)) {
            collectFromInstance(id, obj, crossRefs, hostIp, result, skipped);
        }

        // v1.17.0 (E10): über alle `web.*`-Instances iterieren statt nur `web.0`
        // hardcoded. User mit `web.1` (zweite Web-Instance, z.B. separat für VIS)
        // hatten vorher keine VIS-Projekte im Dropdown.
        //
        // v1.27.2: bei MEHREREN web-Instances die Instance-ID ins Label nehmen
        // (sonst landen die User mit 2-3 web-Instances bei identischen Labels
        // im Dropdown — drei Mal `VIS-2: main / Wohnzimmer` ohne Hinweis welche
        // welcher web-Instance gehört). Bei nur einer web-Instance bleibt das
        // Label minimal (`VIS-2: main / Wohnzimmer`).
        const webInstances = Array.from(crossRefs.entries()).filter(([n]) => n.startsWith('web.'));
        const showWebSuffix = webInstances.length > 1;
        // v1.28.3 (UD1): pro web-Instance vis-2- und vis-1-Discovery parallel.
        // addVisProjects mutiert `result` direkt — der Output bleibt deterministisch
        // weil jede Project-URL ein eigener key ist (keine Race auf identischen
        // keys möglich, da vis-2 und vis-1 unterschiedliche urlPaths benutzen).
        // URL-Pfad-Komponente kommt aus `common.localLinks.Runtime.link`
        // bzw. `common.welcomeScreen.link` der jeweiligen vis-Instance:
        //   vis-2: `/vis-2/index.html`     (NICHT `/vis-2.0/`)
        //   vis-1: `/vis/index.html`       (NICHT `/vis.0/`)
        // Verifiziert in iobroker.vis-2 + iobroker.vis io-package.json.
        // adapterName (`vis-2.0`/`vis.0`) wird für `readDirAsync` /
        // `readFileAsync` gebraucht (Folder-Lookup), urlPath nur für die URL.
        await Promise.all(
            webInstances.flatMap(([shortName, native]) => {
                const labelSuffix = showWebSuffix ? ` (${shortName})` : '';
                return [
                    this.addVisProjects(result, native, hostIp, 'vis-2.0', 'vis-2', `VIS-2${labelSuffix}`, skipped),
                    this.addVisProjects(result, native, hostIp, 'vis.0', 'vis', `VIS${labelSuffix}`, skipped),
                ];
            }),
        );

        // v1.29.2: aura adapter — standalone HTTP server (own port, default
        // 8095), frontend at `/`. Discovery uses native.port + native.secure
        // directly because aura's localLinks template has `:8095` hardcoded
        // instead of `%port%` (would point at the wrong port if user changed
        // it). Skipped in collectFromInstance to avoid duplicate / wrong-port
        // entries. Source: forks/ioBroker.aura/io-package.json native = {
        //   port: 8095, socketPort: 8082, secure: false, customUrl: "" }.
        const auraInstances = Array.from(crossRefs.entries()).filter(([n]) => n.startsWith('aura.'));
        const showAuraSuffix = auraInstances.length > 1;
        for (const [shortName, obj] of auraInstances) {
            const enabled = isPlainObject(obj.common) && obj.common.enabled === true;
            if (!enabled) {
                skipped.push({ adapter: shortName, reason: 'disabled' });
                continue;
            }
            this.addAuraInstance(result, obj, hostIp, shortName, showAuraSuffix, skipped);
        }

        this.cached = result;

        // v1.32.0 B2: Discovery-Summary mit per-Adapter-ID. Eine Zeile pro collect()
        // statt N silent-skip-lines. Bei busy ioBroker (30+ Adapter) hätte per-skip-log
        // ~36000 lines/Tag produziert — diese Summary ist deterministisch klein
        // (~150 chars worst-case) und gibt volle Triage-Information.
        const entries = Object.keys(result);
        const skippedDetail =
            skipped.length > 0 ? `, skipped: ${skipped.map(s => `${s.adapter}=${s.reason}`).join(', ')}` : '';
        this.adapter.log.debug(
            `URL discovery: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${entries.length > 0 ? ` [${entries.map(u => result[u]).join(', ')}]` : ''}${skippedDetail}`,
        );

        if (this.onChange) {
            try {
                await this.onChange(result);
            } catch (err) {
                this.adapter.log.debug(`url-discovery: onChange listener failed: ${String(err)}`);
            }
        }
        return result;
    }

    /**
     * Add a single aura adapter instance to the dropdown.
     *
     * Aura is a React+vite single-page dashboard with its own HTTP server.
     * Unlike vis/vis-2 it does NOT register a web extension — the dashboard
     * is served at `/` on the configured `native.port` (default 8095).
     * Multi-instance setups get a `(aura.X)` suffix on the label so users
     * can distinguish them. `native.customUrl` overrides everything (used
     * for reverse-proxy / external-URL setups).
     *
     * @param result       Output map — mutated with the resolved URL.
     * @param obj          Raw `system.adapter.aura.<n>` instance object.
     * @param hostIp       Local host IP for the URL.
     * @param shortName    Short instance id like `aura.0`.
     * @param showSuffix   If true, append `(aura.X)` to the label.
     * @param skipped      v1.32.0 B2: receives `{adapter, reason}` for the discovery-summary log.
     */
    private addAuraInstance(
        result: UrlStates,
        obj: Record<string, unknown>,
        hostIp: string,
        shortName: string,
        showSuffix: boolean,
        skipped: Array<{ adapter: string; reason: string }>,
    ): void {
        const native = isPlainObject(obj.native) ? obj.native : {};
        const customUrl = typeof native.customUrl === 'string' ? native.customUrl.trim() : '';
        let url: string;
        if (customUrl) {
            url = customUrl.endsWith('/') ? customUrl : `${customUrl}/`;
        } else {
            const port = Number(native.port);
            const finalPort = Number.isFinite(port) && port > 0 ? port : 8095;
            const protocol = native.secure === true ? 'https' : 'http';
            url = `${protocol}://${hostIp}:${finalPort}/`;
        }
        const safe = coerceSafeUrl(url);
        if (!safe) {
            skipped.push({ adapter: shortName, reason: 'unsafe-url' });
            return;
        }
        const suffix = showSuffix ? ` (${shortName})` : '';
        result[safe] = `Aura${suffix}`;
    }

    private async addVisProjects(
        result: UrlStates,
        webInstance: Record<string, unknown> | undefined,
        hostIp: string,
        adapterName: string,
        urlPath: string,
        label: string,
        skipped: Array<{ adapter: string; reason: string }>,
    ): Promise<void> {
        if (!webInstance) {
            skipped.push({ adapter: adapterName, reason: 'no-web-instance' });
            return;
        }
        const native = isPlainObject(webInstance.native) ? webInstance.native : null;
        if (!native) {
            skipped.push({ adapter: adapterName, reason: 'no-native' });
            return;
        }
        const port = coerceFiniteNumber(native.port);
        if (port === null) {
            skipped.push({ adapter: adapterName, reason: 'port-null' });
            return;
        }
        const bindRaw = coerceString(native.bind);
        const ip = isWildcardBind(bindRaw) ? hostIp : bindRaw!;
        const protocol = native.secure === true ? 'https' : 'http';

        let entries: unknown[] = [];
        try {
            entries = (await this.adapter.readDirAsync(adapterName, '/')) ?? [];
        } catch {
            skipped.push({ adapter: adapterName, reason: 'readDir-fail' });
            return;
        }
        if (!Array.isArray(entries)) {
            skipped.push({ adapter: adapterName, reason: 'readDir-non-array' });
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
            // URL-Form (Quelle: io-package.json `localLinks.Runtime.link`
            // bzw. `welcomeScreen.link` aus iobroker.vis-2 + iobroker.vis):
            //   vis-2: http(s)://<ip>:<port>/vis-2/index.html
            //   vis-1: http(s)://<ip>:<port>/vis/index.html
            //
            // Project-Switch via `?<project>` Query — funktioniert in BEIDEN:
            //   VIS-2: `Runtime.tsx:920-923` parst `window.location.search`
            //          (`projectName = window.location.search.replace('?', '')`).
            //   VIS-1: `visEdit.js:1539, 1562, 2225` setzt `?<project>` beim Switch.
            // Pro Project-Folder eine eigene Runtime-URL mit explizitem Query —
            // damit ist jedes Projekt ohne localStorage-Trick direkt erreichbar.
            //
            // View ist Hash-Fragment hinter dem Query (visEngine.tsx:430-455
            // für VIS-2; visEdit.js:2225 für VIS-1).
            const runtimeUrl = `${protocol}://${ip}:${port}/${urlPath}/index.html?${encodeURIComponent(name)}`;
            const safeBase = coerceSafeUrl(runtimeUrl);
            if (!safeBase) {
                continue;
            }
            result[safeBase] = `${label}: ${name}`;

            // Sub-views aus <project>/vis-views.json — pro View ein
            // <base>#<viewName>-Eintrag. Sowohl VIS-2 als auch VIS-1
            // verwenden dieselbe Datei-Konvention (Top-Level-Object,
            // optionaler `views`-Wrapper). Datei fehlt/malformed → silently skip.
            await this.addVisViews(result, adapterName, name, safeBase, label);
        }
    }

    /**
     * Lese `<project>/vis-views.json` und füge pro View einen Dropdown-Eintrag
     * `<runtimeUrl>#<viewName>` ein. Defensive — alle Fehler silently caught.
     *
     * VIS-2-Hash-Routing-Quelle: iobroker.vis-2 v2.13.19+
     * src-vis/src/Vis/visEngine.tsx:430-455 (`getCurrentPath` parst
     * `window.location.hash`, `buildPath` baut `#encodeURIComponent(view)`).
     *
     * @param result Output-Map (mutated)
     * @param adapterName VIS-Adapter (z.B. `vis-2.0`)
     * @param projectName Project-Folder-Name (für vis-views.json-Lookup, NICHT in URL)
     * @param runtimeUrl Komplette Runtime-URL inkl. `/index.html` (z.B. `http://host:8082/vis-2/index.html`)
     * @param label Sprach-Label für Dropdown (`VIS-2`)
     */
    private async addVisViews(
        result: UrlStates,
        adapterName: string,
        projectName: string,
        runtimeUrl: string,
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
            const v = viewsContainer[viewName];
            if (!isPlainObject(v)) {
                continue;
            }
            const viewUrl = `${runtimeUrl}#${encodeURIComponent(viewName)}`;
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
 * @param skipped   v1.32.0 B2: optional collector — receives `{adapter, reason}` for the summary log.
 */
export function collectFromInstance(
    id: string,
    obj: unknown,
    crossRefs: Map<string, Record<string, unknown>>,
    hostIp: string,
    result: UrlStates,
    skipped?: Array<{ adapter: string; reason: string }>,
): void {
    if (!isPlainObject(obj)) {
        return;
    }
    const common = isPlainObject(obj.common) ? obj.common : null;
    if (!common) {
        return;
    }
    const instanceId = id.startsWith('system.adapter.') ? id.substring('system.adapter.'.length) : id;

    if (common.enabled !== true) {
        // v1.32.0 B2: only track disabled non-aura adapters that COULD have been
        // a URL-source (have localLinks/localLink/welcomeScreen). Otherwise we'd
        // flood the summary with every disabled adapter in the system.
        if (
            skipped &&
            (isPlainObject(common.localLinks) ||
                typeof common.localLink === 'string' ||
                common.welcomeScreen ||
                common.welcomeScreenPro)
        ) {
            skipped.push({ adapter: instanceId, reason: 'disabled' });
        }
        return;
    }

    // v1.29.2: aura adapter has hardcoded `:8095` in its localLinks template
    // (instead of `%port%`) AND advertises a `backend` link to `#/admin` —
    // both undesirable for hassemu's display dropdown. We handle aura
    // explicitly in addAuraInstances() with native.port + frontend-only.
    if (instanceId.startsWith('aura.')) {
        return;
    }

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
