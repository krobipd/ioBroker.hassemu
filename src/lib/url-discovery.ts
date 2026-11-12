/**
 * URL Discovery — collects VIS / VIS-2 project URLs, Aura adapter frontends
 * and Admin intro-tile URLs from the running ioBroker instance. Result is
 * used as `common.states` dropdown on `clients.<id>.mode` (and the global
 * `global.mode`).
 *
 * All external object data is type-guarded via coerce helpers; invalid entries
 * are silently skipped.
 */

import { coerceFiniteNumber, coerceSafeUrl, coerceString, isPlainObject } from "./coerce";
import { errText } from "./err-text";
import { chosenAddress } from "./network-address";
import { getLocalIp } from "./network";
import type { AdapterInterface, UrlStates } from "./types";

/** Minimal adapter interface the discovery needs — allows easy mocking in tests. */
/**
 * The subset of js-controller file/object APIs the discovery walker needs.
 *
 * I8 (v1.37.0): the three returns below are deliberately `unknown`-ish
 * (`Record<string, unknown>`, `unknown[]`, a Buffer|string union) rather than the
 * precise `ioBroker.*` shapes. That is the API-boundary type-guard pattern (CLAUDE.md
 * HARDCORE): the dir/file/object APIs return shapes that vary across js-controller
 * versions, so `collect()` treats every result as untrusted and narrows it at runtime
 * (`Array.isArray`, `isPlainObject`, `coerce*`). Tightening these to `ioBroker.Object`
 * / `ReadDirResult` would assert a trust the code deliberately withholds, make those
 * defensive guards read as dead code, and force every test mock to fabricate full
 * shapes — all for zero runtime-safety gain. The looseness is the boundary, not an
 * oversight.
 */
export interface DiscoveryAdapter extends AdapterInterface {
  /** Mirrors `ioBroker.Adapter.getForeignObjectsAsync`. Result narrowed at runtime (see above). */
  getForeignObjectsAsync: (pattern: string, type: "instance") => Promise<Record<string, unknown>>;
  /** Mirrors `ioBroker.Adapter.getForeignObjectAsync` — reads `system.config`. Result narrowed at runtime. */
  getForeignObjectAsync: (id: string) => Promise<unknown>;
  /** Mirrors `ioBroker.Adapter.readDirAsync`. Entries narrowed with `isPlainObject` (see above). */
  readDirAsync: (adapterName: string, path: string) => Promise<unknown[]>;
  /** Mirrors `ioBroker.Adapter.readFileAsync`; the Buffer|string union is narrowed at the call site. */
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
// L27: file-local (was a re-added dead export — v1.3.0 already removed it once).
const DEFAULT_REFRESH_DEBOUNCE_MS = 2000;

/** One skipped URL source, collected for the discovery-summary log. v1.37.0 (L44). */
export type SkipEntry = {
  /** Short adapter/instance id that was skipped (e.g. `aura.0`, `vis-2.0`). */
  adapter: string;
  /** Machine-readable skip reason (e.g. `disabled`, `unsafe-url`, `no-web-instance`). */
  reason: string;
};

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
  "system.adapter.admin.",
  "system.adapter.web.",
  "system.adapter.vis.",
  "system.adapter.vis-2.",
  "system.adapter.aura.",
] as const);

/**
 * Short-name prefix of the aura adapter. Aura is the one URL source handled
 * specially (own HTTP server / port, no web extension): `collect()` builds its
 * entries directly and `collectFromInstance` skips it. Named once so both those
 * sites share the marker instead of each hardcoding `"aura."`. v1.37.0 (L32).
 */
const AURA_PREFIX = "aura.";

/**
 * The adapter part of a short instance id (`vis-2.0` → `vis-2`).
 *
 * @param instanceId Short instance id like `web.0`.
 */
function adapterOf(instanceId: string): string {
  return instanceId.replace(/\.\d+$/, "");
}

/**
 * True for an adapter whose own links never become an entry of the dropdown. Admin 8.3.5 (`Intro`,
 * `getInstances`) shows no tile of `web`, of a vis widget set (`vis-*` except `vis-2` and `vis-web-admin`) or of an
 * icon set (`icons-*`). The projects of `vis` and `vis-2` and the aura frontend come from their own sources in
 * `collect()`, so their tiles (editor, bare runtime, aura backend) stay out as well.
 *
 * @param adapter Adapter name like `web` or `vis-2`.
 */
function isNoTileAdapter(adapter: string): boolean {
  if (adapter === "web" || adapter === "vis" || adapter === "vis-2" || adapter === "aura") {
    return true;
  }
  if (adapter.startsWith("icons-")) {
    return true;
  }
  return adapter.startsWith("vis-") && adapter !== "vis-web-admin";
}

/**
 * Admin 8.3.5 (`Intro`, `normalizeLinks`) shows a welcomeScreen and a welcomeScreenPro link on the web server:
 * `%web_protocol%://%web_bind%:%web_port%/<link>`. devices 4.3.2 advertises `devices/index.html`.
 */
const WEB_SERVER_BASE = "%web_protocol%://%web_bind%:%web_port%/";

/**
 * A relative localLink/localLinks link opens beside the admin page (echarts 6.3.0
 * `/adapter/echarts/preview/index.html`); the list takes the lowest enabled admin instance, the rule of
 * `%<adapter>_<field>%` without an instance number.
 */
const ADMIN_SERVER_BASE = "%admin_protocol%://%admin_bind%:%admin_port%/";

/** The object that carries the start page's hidden tiles (`common.intro`) and its own link cards (`native.introLinks`). */
export const SYSTEM_CONFIG_ID = "system.config";

/**
 * The path of a relative link — one that names neither a scheme nor a placeholder nor a host (`//…`) — without its
 * leading slashes, or null for any other link.
 *
 * @param link Link template.
 */
function relativePath(link: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|%|\/\/)/i.test(link)) {
    return null;
  }
  return link.replace(/^\/+/, "");
}

/**
 * True when a server bound to `bind` answers on this machine only — aura 0.113.2 `lib/serverBind.js`
 * `isLoopbackOnly`: 127.x.x.x, `::1` and `localhost`.
 *
 * @param bind The instance's `native.bind`.
 */
function isLoopbackOnly(bind: unknown): boolean {
  const address = chosenAddress(bind);
  return (
    address !== undefined && (address === "::1" || address === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(address))
  );
}

/** The reason in the discovery summary for a source whose link reaches this machine only. */
const LOOPBACK_ONLY = "loopback-only";

/**
 * True when a link reaches this machine only: its host is a loopback address, read as {@link isLoopbackOnly} reads a
 * bind. A display is always another device — from there such a link reaches nothing, whichever source gave it (a tile
 * of an instance bound to loopback, a link that names `localhost`, a web instance on loopback, an aura address).
 *
 * @param url A link that passed `coerceSafeUrl`.
 */
function reachesThisMachineOnly(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return isLoopbackOnly(host.replace(/^\[(.*)\]$/, "$1"));
}

/**
 * Records in the discovery summary that a source gave a link for this machine only — once per source.
 *
 * @param skipped The summary's skip list.
 * @param source  The instance (or `system.config`) the link came from.
 */
function skipLoopback(skipped: SkipEntry[], source: string): void {
  if (!skipped.some(s => s.adapter === source && s.reason === LOOPBACK_ONLY)) {
    skipped.push({ adapter: source, reason: LOOPBACK_ONLY });
  }
}

/**
 * The address of a web extension's path on the web instance it runs in (admin 8.3.5 `getWebExtensionLinks`): the
 * named instance, or for `*` the lowest enabled one. A web instance that is switched off serves nothing — then null.
 *
 * @param webInstance `native.webInstance` of the extension (`web.0` or `*`).
 * @param path        The path the extension is mounted on (`aura/`).
 * @param crossRefs   Instances by short id.
 * @param hostIp      This host's address.
 */
function webExtensionUrl(
  webInstance: string,
  path: string,
  crossRefs: Map<string, Record<string, unknown>>,
  hostIp: string,
): string | null {
  const web =
    webInstance === "*"
      ? instanceFor("web", { instanceId: "", native: {}, crossRefs, hostIp })
      : (crossRefs.get(webInstance) ?? null);
  if (!web || !isPlainObject(web.common) || web.common.enabled !== true || !isPlainObject(web.native)) {
    return null;
  }
  const port = coerceFiniteNumber(web.native.port);
  if (port === null || port <= 0) {
    return null;
  }
  const protocol = web.native.secure === true ? "https" : "http";
  return `${protocol}://${instanceAddress(web.native, hostIp)}:${port}/${path}`;
}

/**
 * The address an instance answers on, as admin 8.3.5 reads `%ip%`/`%bind%` (`native.bind`, else `native.ip`):
 * the address it is bound to, this host's address while it listens on every address.
 *
 * @param native The instance's `native`.
 * @param hostIp This host's address.
 */
function instanceAddress(native: Record<string, unknown>, hostIp: string): string {
  const bind = typeof native.bind === "string" && native.bind.trim() !== "" ? native.bind : native.ip;
  return chosenAddress(bind) ?? hostIp;
}

/**
 * The name admin 8.3.5 keys a tile by in `system.config.common.intro` (`Intro`, `getInstances`): the link without
 * its scheme, cut after the last `:` that comes before any `_` — the same string operations, in the same order.
 *
 * @param link The resolved link.
 */
function introLinkName(link: string): string {
  return link
    .replace("https://", "")
    .replace("http://", "")
    .replace(/^[^_]+:/, "");
}

/**
 * The tiles the start page hides, read from `system.config.common.intro` (`<tile id>_<link name>`).
 *
 * @param config The `system.config` object, or null.
 */
function hiddenTiles(config: Record<string, unknown> | null): Set<string> {
  const intro = config && isPlainObject(config.common) ? config.common.intro : undefined;
  return new Set(Array.isArray(intro) ? intro.filter((key): key is string => typeof key === "string") : []);
}

/**
 * The instance an instance-less `%<adapter>_<field>%` placeholder means, as admin 8.3.5 `replaceLink` reads it: the
 * own instance when the adapter is the own one, else the enabled instance of that adapter with the lowest number (the
 * start page keeps one link of several). A disabled instance serves nothing, so it is never taken.
 *
 * @param adapter Adapter name from the placeholder.
 * @param ctx     Lookup context.
 */
function instanceFor(adapter: string, ctx: ResolveContext): Record<string, unknown> | null {
  if (adapterOf(ctx.instanceId) === adapter) {
    return { native: ctx.native };
  }
  const candidates = Array.from(ctx.crossRefs.entries())
    .filter(([shortName, instance]) => {
      return (
        adapterOf(shortName) === adapter &&
        /\.\d+$/.test(shortName) &&
        isPlainObject(instance.common) &&
        instance.common.enabled === true
      );
    })
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return candidates.length > 0 ? candidates[0][1] : null;
}

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

/**
 * True when an `objectChange` event can change what the dropdown lists: an object of a URL source adapter,
 * `system.config` (the start page's hidden tiles and link cards), or an instance that advertises links of its own
 * (switching the devices adapter on or off reaches the list without a press on "Refresh URL discovery").
 *
 * @param id  Full object id from the `objectChange` event.
 * @param obj The new object, or null/undefined when it was deleted.
 */
export function isUrlSourceObjectChange(id: string, obj: unknown): boolean {
  if (id === SYSTEM_CONFIG_ID || isUrlSourceAdapterEvent(id)) {
    return true;
  }
  if (!/^system\.adapter\.[^.]+\.\d+$/.test(id) || !isPlainObject(obj) || !isPlainObject(obj.common)) {
    return false;
  }
  const common = obj.common;
  return (
    typeof common.localLink === "string" ||
    isPlainObject(common.localLinks) ||
    Boolean(common.welcomeScreen) ||
    Boolean(common.welcomeScreenPro)
  );
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
   * The pass currently running, if any. A second caller (the refresh button pressed
   * while a debounced pass is running) joins it instead of starting a parallel pass —
   * two passes replaced the same `.mode` objects concurrently (audit 2026-09-15, E5).
   */
  private inflight: Promise<UrlStates> | null = null;
  /** This host's address for a dashboard that listens on every address. */
  private readonly hostAddress: () => string;

  /**
   * @param adapter     Adapter instance used to read broker state.
   * @param onChange    Optional callback fired after every successful refresh.
   * @param hostAddress This host's address for a dashboard on every address — the address
   *                    hassemu itself is reached at (main.ts: the chosen one, else the LAN
   *                    address); before, it was always the first address the host listed,
   *                    so a display in the chosen network got URLs of another network
   *                    (review 2026-11-07, R-05).
   */
  constructor(adapter: DiscoveryAdapter, onChange?: UrlStatesListener, hostAddress: () => string = getLocalIp) {
    this.adapter = adapter;
    this.onChange = onChange;
    this.hostAddress = hostAddress;
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
          this.adapter.log.debug(`url-discovery: refresh failed: ${errText(err)}`);
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

  /**
   * Collects all discoverable URLs from the broker and pushes them to listeners
   * via the `onChange` callback (the production effect channel). The returned
   * states map is what the `info.refreshUrls` handler counts for its line; the
   * {@link cached} fallback on a broker error exists for the unit tests. v1.37.0 (L29).
   */
  collect(): Promise<UrlStates> {
    if (!this.inflight) {
      this.inflight = this.collectOnce().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async collectOnce(): Promise<UrlStates> {
    const result: UrlStates = {};
    const hostIp = this.hostAddress();
    // v1.32.0 B2: per-adapter tracking for the discovery summary instead of N silent skips.
    // Every skip site adds to `skipped`; one final line per collect() sums it up.
    const skipped: SkipEntry[] = [];

    let instances: Record<string, unknown> = {};
    let instancesOk = false;
    try {
      instances = (await this.adapter.getForeignObjectsAsync("system.adapter.*", "instance")) ?? {};
      instancesOk = true;
    } catch (err) {
      this.adapter.log.debug(`url-discovery: getForeignObjectsAsync failed: ${errText(err)}`);
    }

    // v1.8.1 (D4): on a transient broker error, do NOT hand listeners an empty
    // map — mode='global' resolved via a discovered URL would fall through to
    // null. The actual protection is this early return BEFORE onChange fires, so
    // onChange never sees `{}` on error; the returned `this.cached` is only read
    // by tests. Recovers on the next refresh (debounce). v1.37.0 (L29).
    if (!instancesOk) {
      return { ...this.cached };
    }

    const crossRefs = buildCrossRefs(instances);

    // The start page's hidden tiles and its own link cards. Unreadable, the list goes on without them — the tiles
    // are what it is built from.
    let config: Record<string, unknown> | null = null;
    try {
      const raw = await this.adapter.getForeignObjectAsync(SYSTEM_CONFIG_ID);
      config = isPlainObject(raw) ? raw : null;
    } catch (err) {
      this.adapter.log.debug(`url-discovery: ${SYSTEM_CONFIG_ID} not readable: ${errText(err)}`);
    }
    const hidden = hiddenTiles(config);

    // Instances in numeric order, so the lowest one wins an address several tiles share (admin 8.3.5 `addLinks`).
    const ordered = Object.entries(instances).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    for (const [id, obj] of ordered) {
      collectFromInstance(id, obj, crossRefs, hostIp, result, skipped, hidden);
    }
    collectLinkCards(config, crossRefs, hostIp, result, skipped);

    // v1.17.0 (E10): iterate over every `web.*` instance instead of a hard-coded
    // `web.0`. Users with `web.1` (a second web instance, e.g. one just for VIS)
    // used to get no VIS projects in the dropdown.
    //
    // v1.27.2: with SEVERAL web instances the instance id goes into the label
    // (otherwise users with 2-3 web instances get identical labels in the dropdown —
    // `VIS-2: main / Living room` three times, with no hint which belongs to which
    // web instance). With a single web instance the label stays minimal
    // (`VIS-2: main / Living room`).
    //
    // Only ENABLED web instances serve anything. A disabled second instance (a test
    // instance, an old port) used to contribute VIS entries that sent a display to a port
    // nobody listens on — and inflated the instance suffix on every label (audit
    // 2026-09-15, A2). Same rule as the aura source and collectFromInstance; the skip
    // is recorded so the discovery summary names it. The VIS instances themselves are
    // NOT filtered: web serves their runtime, the vis instance need not be running.
    // collectFromInstance already records a disabled instance that carries links of
    // its own; the summary names each instance once.
    const enabledInstances = (prefix: string): Array<[string, Record<string, unknown>]> =>
      Array.from(crossRefs.entries()).filter(([shortName, instance]) => {
        if (!shortName.startsWith(prefix)) {
          return false;
        }
        const enabled = isPlainObject(instance.common) && instance.common.enabled === true;
        if (!enabled && !skipped.some(s => s.adapter === shortName && s.reason === "disabled")) {
          skipped.push({ adapter: shortName, reason: "disabled" });
        }
        return enabled;
      });
    const webInstances = enabledInstances("web.");
    const showWebSuffix = webInstances.length > 1;
    // v1.28.3 (UD1): per web instance, the vis-2 and vis-1 discovery run in parallel.
    // addVisProjects writes into `result` directly — the output stays deterministic
    // because every project URL is a key of its own (no race on identical keys: vis-2
    // and vis-1 use different URL paths).
    // The URL path comes from `common.localLinks.Runtime.link` or
    // `common.welcomeScreen.link` of the vis instance:
    //   vis-2: `/vis-2/index.html`     (NOT `/vis-2.0/`)
    //   vis-1: `/vis/index.html`       (NOT `/vis.0/`)
    // Verified in the io-package.json of iobroker.vis-2 and iobroker.vis.
    // adapterName (`vis-2.0`/`vis.0`) is needed for `readDirAsync` / `readFileAsync`
    // (folder lookup), urlPath only for the URL.
    // I7 (v1.37.0): bound the fan-out. Process web instances sequentially while
    // keeping the vis-2 + vis-1 lookup per instance parallel — concurrency is capped
    // at 2 regardless of how many web instances exist, instead of an unbounded
    // instance×2 Promise.all. Behaviour is identical for the common single-web-server
    // case; with several web instances it also makes the `skipped` order deterministic
    // (instance order) instead of completion-race order.
    // Which VIS instances exist is read from the SAME instance list the web and aura
    // sources are read from — `vis-2.0` / `vis.0` used to be hardcoded here, so a second
    // VIS server contributed nothing, and an installation without VIS ran a doomed
    // `readDirAsync` on every discovery pass. `vis.` does not match `vis-2.0`, so the two
    // families stay apart. Sorted for a deterministic dropdown order across restarts.
    const visInstances = (prefix: string): string[] =>
      Array.from(crossRefs.keys())
        .filter(n => n.startsWith(prefix))
        .sort();
    const vis2Instances = visInstances("vis-2.");
    const vis1Instances = visInstances("vis.");
    const showVis2Suffix = vis2Instances.length > 1;
    const showVis1Suffix = vis1Instances.length > 1;

    for (const [shortName, webInstance] of webInstances) {
      const labelSuffix = showWebSuffix ? ` (${shortName})` : "";
      // I7 (v1.37.0) keeps the fan-out bounded: web instances stay sequential, the VIS
      // lookups of ONE web instance run in parallel.
      await Promise.all([
        ...vis2Instances.map(visName =>
          this.addVisProjects(
            result,
            webInstance,
            hostIp,
            visName,
            "vis-2",
            `VIS-2${showVis2Suffix ? ` (${visName})` : ""}${labelSuffix}`,
            skipped,
          ),
        ),
        ...vis1Instances.map(visName =>
          this.addVisProjects(
            result,
            webInstance,
            hostIp,
            visName,
            "vis",
            `VIS${showVis1Suffix ? ` (${visName})` : ""}${labelSuffix}`,
            skipped,
          ),
        ),
      ]);
    }

    // v1.29.2: aura adapter — standalone HTTP server (own port, default
    // 8095), frontend at `/`. Discovery uses native.port + native.secure
    // directly because aura's localLinks template has `:8095` hardcoded
    // instead of `%port%` (would point at the wrong port if user changed
    // it). Skipped in collectFromInstance to avoid duplicate / wrong-port
    // entries. Source: forks/ioBroker.aura/io-package.json native = {
    //   port: 8095, socketPort: 8082, secure: false, customUrl: "" }.
    // Filter first, count second — a disabled aura instance must neither appear nor
    // earn the running one an instance suffix (same rule as the web instances above).
    const auraInstances = enabledInstances(AURA_PREFIX);
    const showAuraSuffix = auraInstances.length > 1;
    for (const [shortName, obj] of auraInstances) {
      this.addAuraInstance(result, obj, crossRefs, hostIp, shortName, showAuraSuffix, skipped);
    }

    this.cached = result;

    // v1.32.0 B2: discovery summary with the id of each adapter. One line per collect()
    // instead of N silent skip lines. On a busy ioBroker (30+ adapters) a log line per
    // skip would have produced ~36000 lines a day — this summary is small and
    // deterministic (~150 characters worst case) and carries the full triage information.
    // L47: flat, readable summary line — the central discovery triage log.
    const labels = Object.values(result);
    const count = labels.length;
    const listPart = count > 0 ? ` [${labels.join(", ")}]` : "";
    const skippedPart =
      skipped.length > 0 ? `, skipped: ${skipped.map(s => `${s.adapter}=${s.reason}`).join(", ")}` : "";
    this.adapter.log.debug(`URL discovery: ${count} entr${count === 1 ? "y" : "ies"}${listPart}${skippedPart}`);

    if (this.onChange) {
      try {
        await this.onChange(result);
      } catch (err) {
        this.adapter.log.debug(`url-discovery: onChange listener failed: ${errText(err)}`);
      }
    }
    return result;
  }

  /**
   * Add a single aura adapter instance to the dropdown — at the address aura answers on.
   *
   * Aura is a React+vite single-page dashboard with its own HTTP server, served at `/` on `native.port`
   * (default 8095) and bound to `native.bind` (aura 0.113.2 `lib/serverBind.js`: empty = every address,
   * 127.x/::1/localhost = this machine only). With `native.webInstance` set, aura is also served by that web
   * instance under `/aura/` (`lib/webExtension.js`), and admin 8.3.5 (`replaceLink`, `getWebExtensionLinks`) shows
   * that address — so does the list. Aura's own server listens on every start (`main.js` `server.listen(port,
   * bindAddr)`), so a web instance that answers on this machine only leaves the own port. An address of this machine
   * only — aura bound to loopback without a usable web instance, a `customUrl` naming `localhost` — is no target for a
   * display.
   * Multi-instance setups get a `(aura.X)` suffix on the label so users can distinguish them. `native.customUrl`
   * overrides everything (used for reverse-proxy / external-URL setups).
   *
   * @param result       Output map — mutated with the resolved URL.
   * @param obj          Raw `system.adapter.aura.<n>` instance object.
   * @param crossRefs    Instances, for the web instance aura runs in.
   * @param hostIp       Local host IP for the URL.
   * @param shortName    Short instance id like `aura.0`.
   * @param showSuffix   If true, append `(aura.X)` to the label.
   * @param skipped      v1.32.0 B2: receives `{adapter, reason}` for the discovery-summary log.
   */
  private addAuraInstance(
    result: UrlStates,
    obj: Record<string, unknown>,
    crossRefs: Map<string, Record<string, unknown>>,
    hostIp: string,
    shortName: string,
    showSuffix: boolean,
    skipped: SkipEntry[],
  ): void {
    const native = isPlainObject(obj.native) ? obj.native : {};
    const customUrl = typeof native.customUrl === "string" ? native.customUrl.trim() : "";
    const webInstance = typeof native.webInstance === "string" ? native.webInstance.trim() : "";
    const webUrl = webInstance ? webExtensionUrl(webInstance, "aura/", crossRefs, hostIp) : null;
    const viaWeb = webUrl && !reachesThisMachineOnly(webUrl) ? webUrl : null;
    let url: string;
    if (customUrl) {
      url = customUrl.endsWith("/") ? customUrl : `${customUrl}/`;
    } else if (viaWeb) {
      url = viaWeb;
    } else if (isLoopbackOnly(native.bind)) {
      skipLoopback(skipped, shortName);
      return;
    } else {
      const port = coerceFiniteNumber(native.port);
      const finalPort = port !== null && port > 0 ? port : 8095;
      const protocol = native.secure === true ? "https" : "http";
      url = `${protocol}://${instanceAddress(native, hostIp)}:${finalPort}/`;
    }
    const safe = coerceSafeUrl(url);
    if (!safe) {
      skipped.push({ adapter: shortName, reason: "unsafe-url" });
      return;
    }
    if (reachesThisMachineOnly(safe)) {
      skipLoopback(skipped, shortName);
      return;
    }
    const suffix = showSuffix ? ` (${shortName})` : "";
    result[safe] = `Aura${suffix}`;
  }

  private async addVisProjects(
    result: UrlStates,
    webInstance: Record<string, unknown> | undefined,
    hostIp: string,
    adapterName: string,
    urlPath: string,
    label: string,
    skipped: SkipEntry[],
  ): Promise<void> {
    if (!webInstance) {
      skipped.push({ adapter: adapterName, reason: "no-web-instance" });
      return;
    }
    const native = isPlainObject(webInstance.native) ? webInstance.native : null;
    if (!native) {
      skipped.push({ adapter: adapterName, reason: "no-native" });
      return;
    }
    const port = coerceFiniteNumber(native.port);
    if (port === null) {
      skipped.push({ adapter: adapterName, reason: "port-null" });
      return;
    }
    // "Every address" (empty, 0.0.0.0, ::) is read by the fleet master — the dashboard is
    // then reached at this host's address.
    const ip = chosenAddress(native.bind) ?? hostIp;
    if (isLoopbackOnly(ip)) {
      skipLoopback(skipped, adapterName);
      return;
    }
    const protocol = native.secure === true ? "https" : "http";

    let entries: unknown[] = [];
    try {
      entries = (await this.adapter.readDirAsync(adapterName, "/")) ?? [];
    } catch {
      skipped.push({ adapter: adapterName, reason: "readDir-fail" });
      return;
    }
    if (!Array.isArray(entries)) {
      skipped.push({ adapter: adapterName, reason: "readDir-non-array" });
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
      if (!name || name.startsWith("_")) {
        continue;
      }
      // URL form (source: io-package.json `localLinks.Runtime.link` or
      // `welcomeScreen.link` of iobroker.vis-2 + iobroker.vis):
      //   vis-2: http(s)://<ip>:<port>/vis-2/index.html
      //   vis-1: http(s)://<ip>:<port>/vis/index.html
      //
      // Project switch through the `?<project>` query — works in BOTH:
      //   VIS-2: `Runtime.tsx:920-923` parses `window.location.search`
      //          (`projectName = window.location.search.replace('?', '')`).
      //   VIS-1: `visEdit.js:1539, 1562, 2225` sets `?<project>` on a switch.
      // One runtime URL with an explicit query per project folder — so every project
      // is reachable directly, without a localStorage trick.
      //
      // The view is the hash fragment after the query (visEngine.tsx:430-455
      // for VIS-2; visEdit.js:2225 for VIS-1).
      const runtimeUrl = `${protocol}://${ip}:${port}/${urlPath}/index.html?${encodeURIComponent(name)}`;
      const safeBase = coerceSafeUrl(runtimeUrl);
      if (!safeBase) {
        continue;
      }
      result[safeBase] = `${label}: ${name}`;

      // Sub-views from <project>/vis-views.json — one <base>#<viewName> entry per
      // view. VIS-2 and VIS-1 use the same file convention (top-level object,
      // optional `views` wrapper). File missing or malformed → skipped silently.
      await this.addVisViews(result, adapterName, name, safeBase, label);
    }
  }

  /**
   * Read `<project>/vis-views.json` and add one dropdown entry `<runtimeUrl>#<viewName>`
   * per view. Defensive — every error is caught silently.
   *
   * VIS-2 hash routing source: iobroker.vis-2 v2.13.19+
   * src-vis/src/Vis/visEngine.tsx:430-455 (`getCurrentPath` parses
   * `window.location.hash`, `buildPath` builds `#encodeURIComponent(view)`).
   *
   * @param result Output map (mutated)
   * @param adapterName VIS adapter (e.g. `vis-2.0`)
   * @param projectName Project folder name (for the vis-views.json lookup, NOT in the URL)
   * @param runtimeUrl Complete runtime URL including `/index.html` (e.g. `http://host:8082/vis-2/index.html`)
   * @param label Label for the dropdown (`VIS-2`)
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
      return; // file missing — no VIS-2 project with views, or pre-VIS-2.x
    }

    // Depending on the js-controller version, readFileAsync returns a Buffer, a string
    // or { file, mimeType } — normalise every variant to a UTF-8 string.
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else if (isPlainObject(raw) && raw.file !== undefined) {
      const f = raw.file;
      text = typeof f === "string" ? f : Buffer.isBuffer(f) ? f.toString("utf8") : "";
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
      return; // malformed JSON — the project entry at the top level is enough
    }

    if (!isPlainObject(parsed)) {
      return;
    }

    // A VIS-2 vis-views.json has an optional top-level key `views` (object). Without it
    // the view keys sit directly in the top-level object. Both variants are supported —
    // VIS-2 changed this across versions.
    const viewsContainer = isPlainObject(parsed.views) ? parsed.views : parsed;

    for (const viewName of Object.keys(viewsContainer)) {
      // Skip meta keys (typical VIS-2 structure: `views`, `settings`, `___settings`, `activeView`, ...)
      if (viewName.startsWith("_") || viewName === "settings" || viewName === "activeView") {
        continue;
      }
      // Skip when the value is not a view object (view objects carry typical
      // fields such as `widgets` or `name`).
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
    const short = id.startsWith("system.adapter.") ? id.substring("system.adapter.".length) : id;
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
 * @param hidden    Tiles the start page hides (`system.config.common.intro`), keyed `<tile id>_<link name>`.
 */
export function collectFromInstance(
  id: string,
  obj: unknown,
  crossRefs: Map<string, Record<string, unknown>>,
  hostIp: string,
  result: UrlStates,
  skipped: SkipEntry[],
  hidden: ReadonlySet<string> = new Set(),
): void {
  if (!isPlainObject(obj)) {
    return;
  }
  const common = isPlainObject(obj.common) ? obj.common : null;
  if (!common) {
    return;
  }
  const instanceId = id.startsWith("system.adapter.") ? id.substring("system.adapter.".length) : id;

  if (common.enabled !== true) {
    // v1.32.0 B2: only track disabled non-aura adapters that COULD have been
    // a URL-source (have localLinks/localLink/welcomeScreen). Otherwise we'd
    // flood the summary with every disabled adapter in the system.
    if (
      isPlainObject(common.localLinks) ||
      typeof common.localLink === "string" ||
      common.welcomeScreen ||
      common.welcomeScreenPro
    ) {
      skipped.push({ adapter: instanceId, reason: "disabled" });
    }
    return;
  }

  // v1.29.2: aura adapter has hardcoded `:8095` in its localLinks template
  // (instead of `%port%`) AND advertises a `backend` link to `#/admin` —
  // both undesirable for hassemu's display dropdown. We handle aura
  // explicitly in addAuraInstances() with native.port + frontend-only.
  // web, vis, vis-2, the vis widget sets and the icon sets give no entry either (isNoTileAdapter).
  if (instanceId.startsWith(AURA_PREFIX) || isNoTileAdapter(adapterOf(instanceId))) {
    return;
  }

  const native = isPlainObject(obj.native) ? obj.native : {};
  const ctx: ResolveContext = { instanceId, native, crossRefs, hostIp };

  // In the order admin 8.3.5 `normalizeLinks` reads them: `localLink`, `localLinks`, `welcomeScreen`,
  // `welcomeScreenPro`. Admin shows a `localLink` beside `localLinks` (hm-rega 6.1.0 carries both); a plain string
  // entry of `localLinks` is a link of its own (hm-rega `_default`). Each tile carries the id admin keys it by in
  // `system.config.common.intro`.
  if (typeof common.localLink === "string") {
    addTile({ link: common.localLink }, instanceId, ADMIN_SERVER_BASE, ctx, hidden, result, skipped);
  }
  if (isPlainObject(common.localLinks)) {
    for (const [key, entry] of Object.entries(common.localLinks)) {
      const tileId = typeof entry === "string" || key === "_default" ? instanceId : `${instanceId} ${key}`;
      const link = typeof entry === "string" ? { link: entry } : entry;
      addTile(link, tileId, ADMIN_SERVER_BASE, ctx, hidden, result, skipped);
    }
  }
  // A welcomeScreen or welcomeScreenPro path (`devices/index.html`) is served by the web server.
  for (const [key, suffix] of [
    ["welcomeScreen", "cloud"],
    ["welcomeScreenPro", "pro"],
  ] as const) {
    const ws = common[key];
    const entries = Array.isArray(ws) ? ws : isPlainObject(ws) ? [ws] : [];
    for (const entry of entries) {
      addTile(entry, `${instanceId} ${suffix}`, WEB_SERVER_BASE, ctx, hidden, result, skipped);
    }
  }
}

/**
 * Adds one tile to the list unless the start page hides it, an earlier tile has the same address — admin 8.3.5
 * (`addLinks`) shows one tile per address, the first it meets, and it meets instances in their order — or it reaches
 * this machine only.
 *
 * @param entry   The link entry (`{link, name}`).
 * @param tileId  The id admin keys the tile by (`web.0`, `vis-2.0 Runtime`, `devices.0 cloud`).
 * @param base    Where a relative link of this kind opens (web server or admin).
 * @param ctx     Lookup context of the instance.
 * @param hidden  Hidden tiles from `system.config.common.intro`.
 * @param result  Output map.
 * @param skipped The discovery summary's skip list.
 */
function addTile(
  entry: unknown,
  tileId: string,
  base: string,
  ctx: ResolveContext,
  hidden: ReadonlySet<string>,
  result: UrlStates,
  skipped: SkipEntry[],
): void {
  if (!isPlainObject(entry)) {
    return;
  }
  const link = coerceString(entry.link);
  if (!link) {
    return;
  }
  const path = relativePath(link);
  const resolved = resolvePlaceholders(path === null ? link : `${base}${path}`, ctx);
  if (!resolved || hidden.has(`${tileId}_${introLinkName(resolved)}`)) {
    return;
  }
  const safe = coerceSafeUrl(resolved);
  if (!safe) {
    return;
  }
  if (reachesThisMachineOnly(safe)) {
    skipLoopback(skipped, ctx.instanceId);
    return;
  }
  if (safe in result) {
    return;
  }
  const name = coerceString(entry.name);
  result[safe] = name ? `${ctx.instanceId}: ${name}` : ctx.instanceId;
}

/**
 * Adds the start page's own link cards (`system.config.native.introLinks`) that are switched on — admin 8.3.5
 * (`Intro`, `getLinkCards`) shows those, each opening its `link`; a relative link opens beside the admin page.
 * A card with the address of a tile already in the list adds nothing, nor does one that reaches this machine only.
 *
 * @param config    The `system.config` object, or null.
 * @param crossRefs Instances for the admin address of a relative link.
 * @param hostIp    This host's address.
 * @param result    Output map.
 * @param skipped   The discovery summary's skip list.
 */
export function collectLinkCards(
  config: Record<string, unknown> | null,
  crossRefs: Map<string, Record<string, unknown>>,
  hostIp: string,
  result: UrlStates,
  skipped: SkipEntry[],
): void {
  const cards = config && isPlainObject(config.native) ? config.native.introLinks : undefined;
  if (!Array.isArray(cards)) {
    return;
  }
  const ctx: ResolveContext = { instanceId: "", native: {}, crossRefs, hostIp };
  for (const card of cards) {
    if (!isPlainObject(card) || card.enabled !== true) {
      continue;
    }
    const link = coerceString(card.link);
    if (!link) {
      continue;
    }
    const path = relativePath(link);
    const target = path === null ? link : resolvePlaceholders(`${ADMIN_SERVER_BASE}${path}`, ctx);
    const safe = target ? coerceSafeUrl(target) : null;
    if (!safe) {
      continue;
    }
    if (reachesThisMachineOnly(safe)) {
      skipLoopback(skipped, SYSTEM_CONFIG_ID);
      continue;
    }
    if (safe in result) {
      continue;
    }
    result[safe] = coerceString(card.name) ?? safe;
  }
}

/**
 * Resolves `%token%` placeholders in a template string. Returns null if any token cannot be resolved.
 *
 * Supported tokens: %ip%, %bind%, %port%, %protocol%, %secure%, %instance%, %instanceNumeric%,
 * %native_<field>%, %<adapter>.<inst>_<field>% (cross-instance, e.g. %web.0_port%), %<adapter>_<field>% (the own
 * instance or the lowest enabled one of that adapter, e.g. %web_port%) and %<field>% (a field of the own native,
 * e.g. hm-rega's %homematicAddress%) — the forms admin 8.3.5 `replaceLink` resolves.
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
    case "ip":
    case "bind":
      return instanceAddress(ctx.native, ctx.hostIp);
    case "port": {
      const p = coerceFiniteNumber(ctx.native.port);
      return p !== null ? String(p) : null;
    }
    case "protocol":
      return ctx.native.secure === true ? "https" : "http";
    case "secure":
      return ctx.native.secure === true ? "true" : "false";
    case "instance":
      return ctx.instanceId.split(".").pop() ?? null;
    case "instanceNumeric": {
      const last = ctx.instanceId.split(".").pop();
      return last && /^\d+$/.test(last) ? last : null;
    }
  }

  if (token.startsWith("native_")) {
    const field = token.substring("native_".length);
    return primitiveToString(ctx.native[field]);
  }

  const crossMatch = token.match(/^([a-zA-Z0-9-]+\.\d+)_(.+)$/);
  if (crossMatch) {
    const [, refKey, field] = crossMatch;
    return fieldOf(ctx.crossRefs.get(refKey) ?? null, field, ctx.hostIp);
  }

  const adapterMatch = token.match(/^([a-zA-Z0-9-]+)_(.+)$/);
  if (adapterMatch) {
    const [, adapter, field] = adapterMatch;
    return fieldOf(instanceFor(adapter, ctx), field, ctx.hostIp);
  }

  // A token without `_` is a field of the own native (admin 8.3.5 `replaceLink`, last branch).
  if (!token.includes("_")) {
    return primitiveToString(ctx.native[token]);
  }

  return null;
}

/**
 * One field of a referenced instance, read the way the cross-instance placeholders read it.
 *
 * @param refInstance The referenced instance object, or null when there is none.
 * @param field       Field name after the `_`.
 * @param hostIp      This host's address for a dashboard on every address.
 */
function fieldOf(refInstance: Record<string, unknown> | null, field: string, hostIp: string): string | null {
  const refNative = refInstance && isPlainObject(refInstance.native) ? refInstance.native : null;
  if (!refNative) {
    return null;
  }
  if (field === "bind" || field === "ip") {
    return instanceAddress(refNative, hostIp);
  }
  if (field === "port") {
    const p = coerceFiniteNumber(refNative.port);
    return p !== null ? String(p) : null;
  }
  if (field === "protocol") {
    return refNative.secure === true ? "https" : "http";
  }
  return primitiveToString(refNative[field]);
}

function primitiveToString(v: unknown): string | null {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  return null;
}
