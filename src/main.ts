import { join } from "node:path";
import { I18n } from "@iobroker/adapter-core";
import * as utils from "@iobroker/adapter-core";
import { ClientRegistry, parseClientStateId } from "./lib/client-registry";
import { moveWithEnums } from "./lib/enum-carry";
import { errText } from "./lib/err-text";
import { decideGcAction } from "./lib/state-write-rules";
import { MODE_GLOBAL, NO_CHOICE, STALE_CLIENT_TTL_MS } from "./lib/constants";
import { GlobalConfig, parseGlobalStateId } from "./lib/global-config";
import { tName } from "./lib/i18n";
import { KnownObjects } from "./lib/known-objects";
import { migrateLegacyDefaultVisUrl, migrateVisUrlToMode } from "./lib/legacy-migration";
import { migrateNativeKeys } from "./lib/native-key-migration";
import { MDNSService } from "./lib/mdns";
import { advertisedBaseUrl, resolveAdvertisedHost } from "./lib/network";
import { carriesAddress, chosenAddress } from "./lib/network-address";
import { resolveRedirect } from "./lib/redirect-resolver";
import { type InstanceObjectSchema, repairGlobalSchemas } from "./lib/schema-repair";
import { CERTIFICATES_OBJECT_ID, isCertificateNotFound, loadTls, selectCollections, type TlsSetup } from "./lib/tls";
import { isUrlSourceObjectChange, SYSTEM_CONFIG_ID, UrlDiscovery, type UrlStatesListener } from "./lib/url-discovery";
import { WebServer } from "./lib/webserver";
import type { AdapterConfig } from "./lib/types";
// v1.25.0 (F3): instanceObjects as the single source of truth — repairGlobalSchemas
// reads the object schemas from io-package.json instead of duplicating them.
// resolveJsonModule is enabled in the tsconfig.
import iobrokerPackage from "../io-package.json";
const instanceObjectsList = (iobrokerPackage as { instanceObjects: unknown[] }).instanceObjects ?? [];

/**
 * A legacy listen address on its way to `native.bind`: an empty value meant "all
 * interfaces" and becomes the explicit "0.0.0.0" — the admin's port-conflict check skips
 * an instance whose `bind` is empty, which is exactly the invisibility the rename ends.
 *
 * @param value The value stored under the old key.
 */
function bindOrAllInterfaces(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "0.0.0.0";
}

/**
 * HA emulator adapter — lifecycle, migrations, state-dispatch, master switch.
 * Exported so the orchestration unit tests can drive its handlers directly.
 */
class HassEmu extends utils.Adapter {
  /**
   * ioBroker system language used to render the user-facing landing page (HTML)
   * in the user's language. Adapter logs themselves stay English by ioBroker
   * convention. Read in `onReady` from `system.config.language` (EN fallback) and
   * passed to WebServer as a constructor argument — not part of AdapterInterface.
   */
  private systemLanguage: string = "en";

  private mdnsService: MDNSService | null = null;
  private webServer: WebServer | null = null;
  private registry: ClientRegistry | null = null;
  private globalConfig: GlobalConfig | null = null;
  private urlDiscovery: UrlDiscovery | null = null;
  /**
   * Set first thing in `onUnload`. js-controller 7.2.2 marks the adapter ready right after
   * emitting `ready` (adapter.ts 11801/11805), so a stop can arrive while `onReady` is still
   * running — the start checks this flag before it binds anything else (audit 2026-09-25, L4).
   */
  private unloading = false;

  // Factory seams — production builds the real collaborators; the orchestration
  // unit tests (src/main.test.ts) override these fields with fakes so onReady &
  // friends can run without sockets, mDNS or a js-controller.
  private makeGlobalConfig: () => GlobalConfig = () => new GlobalConfig(this);
  // The data folder holds identities.json (the server id; cookie, tokens, lastSeen per display) — declared as
  // `common.dataFolder`, so a backup carries it.
  private makeRegistry: () => ClientRegistry = () => new ClientRegistry(this, utils.getAbsoluteInstanceDataDir(this));
  private makeUrlDiscovery: (onChange: UrlStatesListener) => UrlDiscovery = onChange =>
    new UrlDiscovery(this, onChange, () => resolveAdvertisedHost(this.config.bind));
  private makeWebServer: (instanceUuid: string, tls: TlsSetup | null) => WebServer = (instanceUuid, tls) =>
    new WebServer(
      this,
      this.config,
      this.registry!,
      this.globalConfig!,
      instanceUuid,
      this.systemLanguage,
      undefined,
      undefined,
      tls,
    );
  private makeMdnsService: (instanceUuid: string, tls: TlsSetup | null) => MDNSService = (instanceUuid, tls) =>
    new MDNSService(
      this,
      this.config,
      instanceUuid,
      tls ? () => advertisedBaseUrl(this.config.bind, this.config.port, tls) : undefined,
    );
  /** The HTTPS part of this start (K4), or `null` for plain HTTP — renewed collections go into it. */
  private tlsSetup: TlsSetup | null = null;

  declare config: AdapterConfig;

  /** @param options Adapter options forwarded to the ioBroker base class. */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "hassemu" });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /**
   * Remove the leftover `supportedMessages` key from this instance's own object.
   *
   * The entry was dropped from the manifest, which only helps a FRESH install: an upgrade
   * merges the manifest into the existing instance object and never removes a key, so the old
   * value survives in the database — and that is what the host reads. While it says
   * `stopInstance`, the host kills the process one second after asking it to stop, `onUnload`
   * never runs, `info.connection` stays `true` and the mDNS goodbye that tells the displays the
   * server is gone never leaves.
   *
   * Only written when the key is actually there: every instance-object change restarts the
   * instance, so doing it unconditionally would be a restart loop.
   *
   * @returns true when the correction was written and the restart is coming — the caller has
   *   to stop right there instead of binding a port in a process that is going down.
   */
  private async clearStopInstanceFlag(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages;
      // Correct as soon as the KEY exists at all — not just when the flag is on. The earlier
      // guard never matched its own result, so an instance corrected once stayed that way
      // forever.
      if (supported === undefined || supported === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      // Delete the whole key instead of writing an object into it. `supportedMessages` is a
      // POSITIVE LIST: js-controller stops looking at `common.messagebox` as soon as the field
      // is an object, and a list without a single entry that is not `false` means "no messages
      // at all" — `subscribeMessage` never runs and no `sendTo` ever reaches the adapter, with
      // no log line at all (that is what happened to govee-smart for weeks). hassemu has no
      // message handler today, so nothing is broken right now — but a half-corrected object is
      // a trap for the day it gets one. `null` is copied by the merge (`undefined` would be
      // skipped), which puts the instance back on the plain messagebox path.
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (err: unknown) {
      // Objects DB unreachable — not worth failing the start over; the next start retries.
      this.log.debug(`Could not check the instance object ${id}: ${errText(err)}`);
      return false;
    }
  }

  private async onReady(): Promise<void> {
    try {
      // The translations come first (package check `i18n-before-messages`): every step after
      // this may write a translated name or log a translated text.
      await I18n.init(join(this.adapterDir, "admin"), this);

      // Then: without this the whole shutdown path stays dead on an updated install.
      // A correction means the host is restarting us — no point starting anything.
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      // Fleet standard "listen-port declaration" (2026-09-15): the listen address lives
      // under `native.bind` — the key the admin's port-conflict check reads; it used to be
      // `bindAddress`. js-controller adds the new key with its default on the update and
      // never removes the old one, so the user's value is carried over here, once. The
      // write restarts the instance — stop like the flag correction above does.
      if (await migrateNativeKeys(this, [{ from: "bindAddress", to: "bind", coerce: bindOrAllInterfaces }], errText)) {
        return;
      }
      this.config.bind = this.listenAddress();

      // v1.14.0 (H7): a second onReady without an unload in between (a js-controller edge
      // case) must not orphan a server or its listeners from the first run.
      await this.stopStartedServices();

      await this.setState("info.connection", { val: false, ack: true });

      // Read the system language — handed to the WebServer for the user-facing
      // landing page (HTML). Adapter logs are English.
      this.systemLanguage = await this.readSystemLanguage();

      this.globalConfig = this.makeGlobalConfig();
      await this.globalConfig.restore();

      this.registry = this.makeRegistry();
      // The server id and the display identities come from the data file; 1.46.1 kept the server id as the
      // value of info.serverUuid, read here once to move it into the file (B3).
      await this.registry.restore(async () => (await this.getStateAsync("info.serverUuid"))?.val);
      await this.dropLegacyServerUuid();

      // Migrations run before subscriptions / webserver — first the legacy
      // 1.0.x-style native config, then the visUrl → mode/manualUrl move,
      // then a defensive schema repair for users upgrading from v1.2.0+
      // (where the partial-formed mode-object from the v1.2.0 extend-bug
      // persists since `legacy.visUrl` is already gone and migrate doesn't trigger).
      // These three target pre-1.2.0 → v1.2.0 upgrades; they run once and are
      // idempotent (cheap no-op on already-migrated installs). Removable in a
      // future major once pre-1.2.0 upgrades are no longer plausible — until then
      // dropping them would silently break those upgrade paths.
      // Dropping the legacy keys writes this instance's own object, which makes the host
      // restart us — so stop here exactly like clearStopInstanceFlag does, instead of
      // binding a port in a process that is already going down. Only ever true on a
      // pre-1.1.1 upgrade, and only once.
      if (await migrateLegacyDefaultVisUrl(this, this.config, this.globalConfig)) {
        return;
      }
      // globalConfig was constructed + restored above (control-flow keeps it non-null
      // here), so it satisfies migrateVisUrlToMode's non-null contract — its writes
      // have no null-safe fallback, unlike the nullable registry. L5.
      await migrateVisUrlToMode(this, this.globalConfig, this.registry);
      await repairGlobalSchemas(this, instanceObjectsList as InstanceObjectSchema[]);

      // Carry the manifest's names/descriptions into an ALREADY EXISTING tree — without
      // this an update reaches fresh installs only. Runs after the schema repair so a
      // just-healed object gets the current text in the same start.
      await this.refreshInstanceObjects();

      // L59 (v1.37.0): the manual-refresh button was renamed info.refresh_urls →
      // info.refreshUrls. Delete the old state once on upgrade so it doesn't linger
      // as an orphan beside the new one — js-controller does not auto-remove states
      // dropped from instanceObjects. Guarded like the visUrl cleanups (I5): no
      // wasted delObject round-trip once it's gone. The room/function assignments
      // travel to the new id first — the delete would strike them (v1.45.0).
      if (await this.getObjectAsync("info.refresh_urls")) {
        await moveWithEnums(
          this,
          `${this.namespace}.info.refresh_urls`,
          `${this.namespace}.info.refreshUrls`,
          () =>
            this.delObjectAsync("info.refresh_urls").catch(() => {
              /* raced with another delete — already gone */
            }),
          errText,
        );
      }

      // Garbage-collect stale displays: lastSeen more than 30 days behind the most recently
      // seen display — tokens do not matter (design decision 14).
      await this.gcStaleClients();

      // The HA server id stays the same across restarts — otherwise HA clients (Companion app, Wall
      // Display, ...) treat every restart as a "new server": re-onboarding, invalidated tokens. It lives in
      // the data file (design decision 2), read by the registry's restore above.
      const instanceUuid = this.registry.serverUuid;
      this.log.debug(
        `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`,
      );

      this.urlDiscovery = this.makeUrlDiscovery(async states => {
        await this.globalConfig?.syncUrlDropdown(states);
        await this.registry?.syncUrlDropdown(states);
      });
      // v1.13.0 (H5): set the provider BEFORE collect() — otherwise the first collect()
      // runs with the default provider (`() => MODE_GLOBAL`), which does not reflect
      // what the resolver gives new clients.
      this.registry.setNewClientModeProvider(() => this.computeNewClientMode());
      await this.urlDiscovery.collect();
      // A stop arrived during the start (see `unloading`). Nothing is bound yet.
      if (this.unloading) {
        return;
      }

      // HTTPS (K4): the certificate is loaded before anything listens. Not configured, the controller has logged
      // the error line itself (CertificateManager, js-controller 7.2.5) — the echo here is debug, one line per
      // failed start; any other cause reaches the catch below with its own line. Both end with code 6.
      if (this.config.secure === true) {
        try {
          this.tlsSetup = await loadTls(this, this.config);
        } catch (err) {
          if (!isCertificateNotFound(err)) {
            throw err;
          }
          this.log.debug(`HTTPS certificates could not be loaded: ${errText(err)}`);
          await this.stopStartedServices();
          if (!this.unloading) {
            this.terminate("HTTPS certificates missing", utils.EXIT_CODES.UNCAUGHT_EXCEPTION);
          }
          return;
        }
      }

      // Kept in a local: onUnload nulls the field, and the check below must still reach
      // the server that is opening its listener right now (audit 2026-09-25, N7).
      let webServer: WebServer;
      try {
        webServer = this.makeWebServer(instanceUuid, this.tlsSetup);
        this.webServer = webServer;
        await webServer.start();
      } catch (err) {
        // webServer.start() already logged a friendly, actionable error (EADDRINUSE /
        // generic startup) at error level, so keep only a debug echo of the raw error
        // here — otherwise the same failure prints two error lines. I5 (v1.38.0).
        this.log.debug(`Web server failed to start: ${errText(err)}`);
        if (this.unloading) {
          return;
        }
        // Close what the start opened — the URL discovery's refresh timer, the half-opened
        // server — before the end: in compact mode the process lives on (start-failure
        // standard ST5, K16). Subscriptions come after this block.
        await this.stopStartedServices();
        // v1.10.0 (B4): never sit idle as a zombie (no server, no subscriptions). The exit
        // code matters: 11 (ADAPTER_REQUESTED_TERMINATION) means "do not restart" to
        // js-controller 7.2.2 (controller main.ts 4231/4305) — the instance stayed off until
        // someone started it by hand. UNCAUGHT_EXCEPTION restarts after 30 s and stops with a
        // restart-loop notice after three failures in ten minutes, so a port that is briefly
        // in use heals itself (audit 2026-09-25, L1).
        this.terminate("Web server failed to start", utils.EXIT_CODES.UNCAUGHT_EXCEPTION);
        return;
      }
      // The stop came while the listener was opening: onUnload closed a server that was not
      // listening yet — close it again.
      if (this.unloading) {
        await webServer.stop().catch(() => {});
        return;
      }

      // v1.13.0 (D11+H6): subscriptions AFTER webServer.start() — before, a state write
      // between subscribe and start would have fired a handler that touched a server
      // not yet running. Plus: when webServer.start() throws, no subscription exists
      // yet (no cleanup path needed in the catch block).
      await this.subscribeForeignObjectsAsync("system.adapter.*");
      await this.subscribeForeignObjectsAsync(SYSTEM_CONFIG_ID);
      await this.subscribeStatesAsync("clients.*");
      await this.subscribeStatesAsync("global.*");
      await this.subscribeStatesAsync("info.refreshUrls");
      if (this.tlsSetup && this.tlsSetup.collectionChoice !== false) {
        await this.subscribeForeignObjectsAsync(CERTIFICATES_OBJECT_ID);
      }

      let mdnsActive = false;
      if (this.config.mdnsEnabled) {
        this.mdnsService = this.makeMdnsService(instanceUuid, this.tlsSetup);
        this.mdnsService.start();
        // v1.10.0 (H1): mdns.start() catches internally and sets active=false on an
        // error — before, info.connection=true was set regardless, and the user was led
        // to believe discovery worked. Now the log and the suffix of the running line
        // say so.
        mdnsActive = this.mdnsService.isActive();
        if (!mdnsActive) {
          // Generic warn — MDNSService already logged the underlying cause.
          this.log.warn("mDNS failed to start — see preceding mDNS warning");
        }
      } else {
        this.log.debug("mDNS disabled — clients must enter the URL manually.");
      }

      // The stop came while subscribing and announcing: take back what started after it.
      if (this.unloading) {
        await this.stopStartedServices();
        return;
      }
      await this.setState("info.connection", { val: true, ack: true });
      const bindAddr = this.config.bind;
      // "started" (not "active"): isActive() is read synchronously right after start(),
      // before an asynchronous bonjour publish error could fire — so the headline must
      // not over-claim; a later publish failure surfaces as its own mDNS warn. I6 (v1.38.0).
      const mdnsSuffix = this.config.mdnsEnabled ? (mdnsActive ? ", mDNS started" : ", mDNS FAILED") : "";
      this.log.info(`HA emulation running on ${bindAddr}:${this.config.port}${mdnsSuffix}`);
    } catch (err: unknown) {
      // M2: never sit idle as a zombie when any other step fails. A failed start must not keep
      // the port or the mDNS announcement either — in compact mode the process lives on
      // (audit 2026-09-25, L7).
      await this.stopStartedServices();
      // A stop during the start nulls the collaborators, so the start then fails as a
      // CONSEQUENCE of the stop — no error line and no crash code for an ordinary shutdown
      // (audit 2026-09-25, N3).
      if (this.unloading) {
        this.log.debug(`Start abandoned during shutdown: ${errText(err)}`);
        return;
      }
      this.log.error(`onReady failed: ${errText(err)}`);
      // UNCAUGHT_EXCEPTION, not 11: see the web-server branch above (L1).
      this.terminate("onReady failed", utils.EXIT_CODES.UNCAUGHT_EXCEPTION);
    }
  }

  /**
   * Stop whatever this start (or an earlier one) brought up: URL discovery, web server, mDNS.
   * The fields are cleared first, so a concurrent `onUnload` cannot stop the same object twice.
   */
  private async stopStartedServices(): Promise<void> {
    this.urlDiscovery?.cancelRefresh();
    this.urlDiscovery = null;
    const webServer = this.webServer;
    const mdns = this.mdnsService;
    this.webServer = null;
    this.mdnsService = null;
    // While unloading, adapter-core refuses managed timers — mDNS then sends its goodbye
    // without the fallback timer.
    await Promise.allSettled([webServer?.stop(), mdns?.stop(this.unloading)]);
  }

  /**
   * Re-apply the adapter's OWN eight objects on every start, so a changed name or
   * description reaches an installation that already has them.
   *
   * js-controller applies the manifest's `instanceObjects` on every start, but preserves
   * `common.name` (7.2.2 `_extendObjects`, `preserve: { common: ["name"] }`): a changed name
   * reaches fresh installations only. Without this pass the manifest, the state-role gate
   * and the linter are all green while the real tree keeps the name of whatever version
   * first created it. Measured on the live tree
   * 2026-09-03: seven objects still carried a bare English string instead of the
   * translation object the manifest declares, `clients` still read "Known display
   * clients" and `global.manualUrl` still showed the developer note
   * "(used when mode='manual')" to the user.
   *
   * Written out one object at a time on purpose, not looped over the manifest: the
   * consistency gate verifies coverage by finding each id in the source, and a loop
   * names none of them. Texts come from `tName`, i.e. from `admin/i18n` — the same file
   * `scripts/sync-iopackage-from-i18n.py` fills the manifest from, so the runtime and
   * the manifest cannot drift apart.
   *
   * Only name and description are written; the rest of the shape is the manifest's (see
   * the note at the writes below).
   *
   * Two things are deliberately NOT written: `common.states` (the mode dropdown belongs
   * to `syncUrlDropdown`, and `extendObject` deep-merges it — a copy here would resurrect
   * stale URL keys) and a `desc` on the four objects that have nothing to explain
   * (fleet rule: an empty description is allowed, an invented sentence is not).
   *
   * Each object is written only when the stored one does not already carry its name and
   * description: `extendObject` always writes, stamps a new `ts` and sends an `objectChange` to
   * every subscriber, so an unconditional pass rewrote all eight objects on every start of every
   * installation. The tree is read once (the fleet master `KnownObjects`, one
   * `getObjectListAsync` over the namespace) and every write goes through `known.extend`, which
   * compares with js-controller's own merge (`coveredBy`). If that read fails, nothing is known
   * and every object is written as before.
   */
  private async refreshInstanceObjects(): Promise<void> {
    // Tolerance per OBJECT, not per pass: if one write fails, the remaining objects must
    // still be refreshed — stopping at the first failure would leave everything after it
    // silently on the old text, which is exactly the defect this pass exists to fix.
    // The id stays the literal first argument of `known.extend` so the package check
    // (instance-objects-refresh, which counts the fleet master's extend like extendObject)
    // can verify coverage.
    const tolerate = async (id: string, write: Promise<boolean>): Promise<void> => {
      try {
        await write;
      } catch (err: unknown) {
        this.log.debug(`Could not refresh the object ${id}: ${errText(err)}`);
      }
    };

    // Name and description only (iobroker-adapter-checks 0.19.0, instance-objects-refresh): the
    // object's shape — kind, value type, role, read/write, default, native — is the manifest's,
    // which js-controller applies on every start. A runtime copy of it is a second source that
    // drifts: a role or type changed in the manifest would be written back here on every start.
    const known = new KnownObjects(this);
    try {
      await known.load();
    } catch (err: unknown) {
      this.log.debug(`Could not read the adapter's own objects, refreshing all of them: ${errText(err)}`);
    }
    await Promise.all([
      tolerate("info", known.extend("info", { common: { name: tName("info") } })),
      tolerate("info.connection", known.extend("info.connection", { common: { name: tName("connection") } })),
      tolerate(
        "info.refreshUrls",
        known.extend("info.refreshUrls", {
          common: { name: tName("refreshUrls"), desc: tName("refreshUrlsDesc") },
        }),
      ),
      tolerate("clients", known.extend("clients", { common: { name: tName("clients") } })),
      tolerate("global", known.extend("global", { common: { name: tName("global") } })),
      tolerate(
        "global.enabled",
        known.extend("global.enabled", {
          common: { name: tName("globalEnabled"), desc: tName("globalEnabledDesc") },
        }),
      ),
      // No `states` here — syncUrlDropdown is the single authority for the dropdown.
      tolerate(
        "global.mode",
        known.extend("global.mode", {
          common: { name: tName("globalMode"), desc: tName("globalModeDesc") },
        }),
      ),
      tolerate(
        "global.manualUrl",
        known.extend("global.manualUrl", {
          common: { name: tName("globalManualUrl"), desc: tName("globalManualUrlDesc") },
        }),
      ),
    ]);
    this.log.debug("Refreshed the adapter's own objects (names/descriptions reach existing installations)");
  }

  /**
   * Remove `info.serverUuid` — 1.46.1 kept the server id there; since the restore moved it into the data file,
   * a second copy would only invite a script to overwrite it (B3, krobi 2026-11-11 19:31). Called after the
   * restore, which fails the start when the file cannot be written, so the file holds the id by then.
   */
  private async dropLegacyServerUuid(): Promise<void> {
    if (await this.getObjectAsync("info.serverUuid")) {
      await this.delObjectAsync("info.serverUuid");
    }
  }

  /**
   * Default mode for newly registered clients. Respects the master switch:
   * - `global.enabled=true`  → `'global'` (follow master)
   * - otherwise              → `'0'` (no choice) → the resolver returns null →
   *   landing page until the user picks a URL in the mode dropdown.
   *   Before v1.26.0 the default was the first discovered URL — that made the
   *   landing page practically invisible for new displays and surprised the
   *   user with an unwanted automatic choice.
   */
  private computeNewClientMode(): string {
    if (this.globalConfig?.isEnabled()) {
      return MODE_GLOBAL;
    }
    return NO_CHOICE;
  }

  /**
   * The address the adapter listens, sends and connects on — the chosen one, or `0.0.0.0`
   * for every address. The chosen address is the only one the communication runs on
   * (krobi 2026-10-03 00:27); one this host does not carry (a new address from the router, a
   * backup restored on other hardware) falls back to every address with exactly one warning
   * that says what to fix — the fleet rule in the head of the master network-address.ts
   * (fakeroku F-05/F-06, krobi 2026-10-02 23:52).
   */
  private listenAddress(): string {
    const chosen = chosenAddress(this.config.bind);
    if (chosen !== undefined && !carriesAddress(chosen)) {
      this.log.warn(
        `Address ${chosen} does not exist on this host — listening on all addresses; choose another address in the instance settings`,
      );
      return "0.0.0.0";
    }
    return chosen ?? "0.0.0.0";
  }

  /**
   * Read the ioBroker system language (set in Admin → Main Settings). Used for the
   * landing page so the end-user sees the same language as their admin UI. Any
   * non-empty language is passed through as-is; an unknown one falls back to
   * English only at render time (htmlLangFor / tPage). An unreadable system.config
   * falls back to `en` here. Read once on startup — a runtime language switch takes
   * effect after an adapter restart, fine for a setup-hint page seen once.
   */
  private async readSystemLanguage(): Promise<string> {
    try {
      const cfg = await this.getForeignObjectAsync("system.config");
      const lang = (cfg?.common as { language?: string } | undefined)?.language;
      return typeof lang === "string" && lang.length > 0 ? lang : "en";
    } catch {
      return "en";
    }
  }

  /**
   * Removes clients that are clearly stale: a `lastSeen` (data file) older than
   * {@link STALE_CLIENT_TTL_MS}.
   *
   * Clients without `lastSeen` (pre-1.2.0) get the timestamp seeded on this run
   * — GC kicks in only on subsequent restarts.
   *
   * v1.11.0 (C9): the GC used to skip every token-holding client (`if record.token`),
   * so the list grew for years with "authenticated, but never seen again" displays
   * (replaced, refurbished, reset). Since then it is lastSeen-based regardless of
   * tokens — including the long-lived refresh token persisted since v1.31.0: a display
   * unseen for 30 days is forgotten and re-onboards when it comes back (documented in
   * docs/, `remove` is the tool for anything earlier). Decided, not an oversight.
   *
   * Reads the stamps the registry restored with the client objects — no second object
   * read per display (audit 2026-09-15, D1).
   *
   * The age is measured against the most recently seen display, not the clock: while the
   * adapter or its host was off, nobody could be seen, and `now` counted that downtime as
   * absence — one start after 30+ days off removed every display with its settings, room
   * assignments and tokens (audit 2026-09-25, L3). The most recently seen display is thus
   * never removed automatically; `remove` is the tool for that. Capped at `now`, so one
   * stamp from a clock that ran ahead cannot age all the others.
   */
  private async gcStaleClients(): Promise<void> {
    const now = Date.now();
    const records = this.registry?.listAll() ?? [];
    const newestSeen = Math.min(now, Math.max(0, ...records.map(r => this.registry!.lastSeenOf(r.id) ?? 0)));
    if (records.length > 0) {
      const ttlDays = Math.round(STALE_CLIENT_TTL_MS / (24 * 60 * 60 * 1000));
      this.log.debug(`gcStaleClients: scanning ${records.length} client(s) for staleness (TTL=${ttlDays}d)`);
    }
    // v1.28.3 (M5): the GC pass runs in parallel instead of sequentially. With many
    // clients (a farm of displays) the broker round trips at start added up to a
    // noticeable pause before `webServer.start()`. The per-client try/catch stays — one
    // failed read must not abort the pass. The counter is a primitive number, safe
    // under Promise.all.
    const results: number[] = await Promise.all(
      records.map(async (record): Promise<number> => {
        try {
          // v1.25.0 (J1): the decision lives in the pure helper decideGcAction
          // (state-write-rules.ts); only the broker I/O is here.
          const action = decideGcAction(this.registry!.lastSeenOf(record.id), newestSeen, STALE_CLIENT_TTL_MS);
          if (action === "seed") {
            this.registry!.seedLastSeen(record.id, now);
            return 0;
          }
          if (action === "stale") {
            await this.registry!.remove(record.id);
            return 1;
          }
          return 0;
        } catch (err) {
          this.log.debug(`Stale-GC: failed for ${record.id}: ${errText(err)}`);
          return 0;
        }
      }),
    );
    const removed = results.reduce((acc, n) => acc + n, 0);
    if (removed > 0) {
      this.log.info(`Removed ${removed} inactive client(s) (30 days behind the most recently seen display)`);
    }
  }

  /**
   * Master-switch action: when `global.enabled` flips, propagate to every
   * client's `mode`. `true` → all clients follow `'global'`. `false` → all
   * clients drop to `'0'` (no-choice) so the next display load shows the
   * landing page until the user picks a URL again (since v1.26 — earlier
   * versions auto-selected the first discovered URL which surprised users).
   *
   * @param enabled New value of `global.enabled`.
   */
  private async applyMasterSwitch(enabled: boolean): Promise<void> {
    if (!this.registry) {
      return;
    }
    // A switch datapoint gets no info line (krobi 2026-10-16 07:29/07:49: feedback for
    // admin actions, never log spam from datapoints) — the count stays on debug.
    if (enabled) {
      const changed = await this.registry.bulkSetMode(MODE_GLOBAL);
      this.log.debug(`Master switch on — ${changed} display(s) now follow the global URL`);
      return;
    }
    // Master off → every client to no choice. Without an explicit choice by the user,
    // every display shows the landing page (instead of switching automatically to some
    // discovered URL the user may never have meant).
    const changed = await this.registry.bulkSetMode(NO_CHOICE);
    this.log.debug(`Master switch off — ${changed} display(s) back to their landing page`);
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      if (!state || state.ack) {
        return;
      }
      // L41: narrow the collaborators once so the branch bodies below are
      // assertion-free (was a mix of `this.registry ? … : null` guards and
      // `this.registry!` asserts in the same function).
      const registry = this.registry;
      const globalConfig = this.globalConfig;
      const clientParsed = registry ? parseClientStateId(id, this.namespace) : null;
      if (clientParsed && registry) {
        if (clientParsed.kind === "mode") {
          await registry.handleModeWrite(clientParsed.id, state.val);
          // B4: if the user picked 'global' but global resolves to nothing, name the cause of
          // the empty redirect. On debug, not warn: picking 'global' before filling the global
          // URL is a normal order; clients.<id>.resolvedUrl shows the outcome (N8).
          const record = registry.getById(clientParsed.id);
          if (record?.mode === MODE_GLOBAL && globalConfig && resolveRedirect(record, globalConfig.redirect) === null) {
            this.log.debug(
              `Client ${record.id}: mode is "global" but global has no resolvable URL — fill global.mode/manualUrl, or pick a different mode`,
            );
          }
        } else if (clientParsed.kind === "manualUrl") {
          await registry.handleManualUrlWrite(clientParsed.id, state.val);
        } else if (clientParsed.kind === "remove" && state.val === true) {
          await registry.remove(clientParsed.id);
        }
        return;
      }
      const globalParsed = globalConfig ? parseGlobalStateId(id, this.namespace) : null;
      if (globalParsed && globalConfig) {
        if (globalParsed === "mode") {
          await globalConfig.handleModeWrite(state.val);
        } else if (globalParsed === "manualUrl") {
          await globalConfig.handleManualUrlWrite(state.val);
        } else if (globalParsed === "enabled") {
          // Only a TRANSITION propagates to the displays. bulkSetMode compares every
          // client with the target mode, not the master switch with its previous value —
          // so a write of the same value (a script re-asserting `true` every morning) or
          // a rejected non-boolean write used to reset every display's own choice to
          // 'global' / '---' (audit 2026-09-15, A1). Design decision 7: "toggling".
          const wasEnabled = globalConfig.isEnabled();
          await globalConfig.handleEnabledWrite(state.val);
          if (globalConfig.isEnabled() !== wasEnabled) {
            await this.applyMasterSwitch(globalConfig.isEnabled());
          }
        }
        // I7 (v1.38.0): every global.* write is fully handled here — return so it
        // can't fall through to the info.refreshUrls check (symmetry with the client
        // block above; the ids never collide, so this is clarity, not a bug fix).
        return;
      }

      // info.refreshUrls — the user's trigger for refreshing the dropdowns without an
      // adapter restart. Scans the broker again for VIS/VIS-2 projects and admin tiles and
      // writes the new states maps into every mode dropdown.
      if (id === `${this.namespace}.info.refreshUrls` && state.val === true) {
        await this.handleRefreshUrlsWrite();
      }
    } catch (err: unknown) {
      this.log.error(`stateChange failed: ${errText(err)}`);
    }
  }

  /**
   * Handler for the `info.refreshUrls` button.
   * Triggers an immediate `urlDiscovery.collect()` (instead of the debounced schedule),
   * so the user does not wait 2 s. Then writes `false` with ack, so the button in the
   * admin UI becomes clickable again.
   */
  private async handleRefreshUrlsWrite(): Promise<void> {
    if (!this.urlDiscovery) {
      return;
    }
    // Cancel any pending debounced refresh first — otherwise an objectChange-scheduled
    // scan fires a second full broker scan ~2s after this immediate one. L3 (v1.38.0).
    this.urlDiscovery.cancelRefresh();
    try {
      const found = await this.urlDiscovery.collect();
      // A button datapoint gets no info line (krobi 2026-10-16 07:29/07:39) — the count
      // stays on debug; the dropdown itself shows what was found.
      this.log.debug(`URL list refreshed on request — ${Object.keys(found).length} dashboard(s) found`);
    } catch (err) {
      this.log.warn(`URL refresh failed: ${errText(err)}`);
    } finally {
      // I2: log a re-arm failure instead of swallowing it — a failed re-arm leaves
      // the admin button visually "pressed" (val=true) with no trace of why.
      await this.setState("info.refreshUrls", { val: false, ack: true }).catch(err =>
        this.log.debug(`refreshUrls re-arm failed: ${errText(err)}`),
      );
    }
  }

  private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    try {
      // A renewed Let's Encrypt collection reaches the running HTTPS server (K4); the named certificates restart
      // the instance through the controller itself (js-controller 7.2.5 getCertificatesAsync).
      if (id === CERTIFICATES_OBJECT_ID) {
        this.renewCollections(obj);
        return;
      }
      // v1.13.0 (H4): narrow filter — earlier EVERY objectChange in the
      // `system.adapter.*` namespace triggered a scheduleRefresh, even from an
      // adapter changing discovery-irrelevant config. Now it triggers only when the
      // changed object can change the list (isUrlSourceObjectChange: a URL-source adapter,
      // `system.config`, an instance that advertises links) OR looks like an instance
      // add/remove (obj deleted, or an instance object without a resolved host). The 2s
      // debounce coalesces bursts.
      if (!id?.startsWith("system.adapter.") && id !== SYSTEM_CONFIG_ID) {
        return;
      }
      // v1.30.0 (R2): the rule lives in url-discovery.ts alongside the actual discovery logic.
      const isUrlSourceAdapter = isUrlSourceObjectChange(id, obj);
      // Only an INSTANCE id (`system.adapter.<name>.<n>`, four segments) counts as an
      // add/remove. `!obj` alone also fired for every deleted state below a foreign
      // instance (`system.adapter.influxdb.0.memRss` on uninstall) and scheduled a full
      // discovery pass for nothing (audit 2026-09-15, D4).
      const isInstanceId = id.split(".").length === 4;
      const isAddOrRemove = isInstanceId && (!obj || (obj.type === "instance" && !obj.common?.host));
      if (isUrlSourceAdapter || isAddOrRemove) {
        this.urlDiscovery?.scheduleRefresh();
      }
    } catch (err: unknown) {
      this.log.error(`objectChange failed: ${errText(err)}`);
    }
  }

  /**
   * Hand renewed Let's Encrypt collections to the running server. A collection that cannot be used any more keeps
   * the ones in force — the server goes on with the certificate it has, and says so once.
   *
   * @param obj The new `system.certificates`.
   */
  private renewCollections(obj: ioBroker.Object | null | undefined): void {
    const tls = this.tlsSetup;
    if (!tls || tls.collectionChoice === false) {
      return;
    }
    try {
      tls.update(selectCollections(obj?.native, tls.collectionChoice));
      this.log.debug("HTTPS: certificate collections renewed");
    } catch (err) {
      this.log.warn(`HTTPS keeps its current certificate — the renewed collection cannot be used: ${errText(err)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      // First: a start that is still running checks this before it binds anything else (L4).
      this.unloading = true;
      // v1.13.0 (H10): info.connection=false first, before any cleanup — if a cleanup step
      // throws, the state still ends up false instead of staying true.
      const pending: Promise<unknown>[] = [this.setState("info.connection", { val: false, ack: true })];

      // v1.10.0 (H2): release the subscriptions explicitly before nulling the references.
      // js-controller normally cleans them up — but in compact mode, a hot remove + re-add
      // can leave a residue that then fires on an adapter instance already nulled.
      pending.push(
        this.unsubscribeStatesAsync("clients.*"),
        this.unsubscribeStatesAsync("global.*"),
        this.unsubscribeStatesAsync("info.refreshUrls"),
        this.unsubscribeForeignObjectsAsync("system.adapter.*"),
        this.unsubscribeForeignObjectsAsync(SYSTEM_CONFIG_ID),
      );
      if (this.tlsSetup && this.tlsSetup.collectionChoice !== false) {
        pending.push(this.unsubscribeForeignObjectsAsync(CERTIFICATES_OBJECT_ID));
      }
      this.tlsSetup = null;

      this.urlDiscovery?.cancelRefresh();
      this.urlDiscovery = null;

      if (this.mdnsService) {
        // shuttingDown: no managed fallback timer — adapter-core refuses those during
        // shutdown. The goodbye is awaited below instead.
        pending.push(this.mdnsService.stop(true));
        this.mdnsService = null;
      }

      if (this.webServer) {
        // v1.18.0 (G6): no double log — webServer.stop() already logs on debug internally.
        pending.push(this.webServer.stop());
        this.webServer = null;
      }

      this.registry = null;
      this.globalConfig = null;

      // Report done only once the writes landed and the mDNS goodbye left the socket.
      // Calling back first means the host tears the process down while `info.connection`
      // is still `true` and the displays keep looking for a server that is gone. No own
      // deadline needed — the host already has one (`common.stopTimeout`), and
      // `this.setTimeout` refuses during shutdown anyway. allSettled, not all: one
      // rejected write (broker already gone) must not call back while the goodbye and
      // the server stop are still running (audit 2026-09-15, B4).
      void Promise.allSettled(pending)
        .then(results => {
          for (const r of results) {
            if (r.status === "rejected") {
              this.log.error(`Shutdown error: ${errText(r.reason)}`);
            }
          }
        })
        .finally(callback);
      return;
    } catch (err) {
      this.log.error(`Shutdown error: ${errText(err)}`);
    }
    callback();
  }
}

if (require.main !== module) {
  // The class rides on the factory instead of a named export: `export class` next to a
  // `module.exports` assignment makes esbuild warn (commonjs-variable-in-esm) and leaves a
  // module shape the js-controller never reads. Tests take the class from here.
  module.exports = Object.assign((options: Partial<utils.AdapterOptions> | undefined) => new HassEmu(options), {
    HassEmu,
  });
} else {
  (() => new HassEmu())();
}
