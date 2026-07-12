import crypto from "node:crypto";
import { join } from "node:path";
import { I18n } from "@iobroker/adapter-core";
import * as utils from "@iobroker/adapter-core";
import { ClientRegistry, parseClientStateId } from "./lib/client-registry";
import { coerceUuid, decideGcAction } from "./lib/coerce";
import { MODE_GLOBAL, STALE_CLIENT_TTL_MS } from "./lib/constants";
import { GlobalConfig, parseGlobalStateId } from "./lib/global-config";
import { migrateLegacyDefaultVisUrl, migrateVisUrlToMode } from "./lib/legacy-migration";
import { MDNSService } from "./lib/mdns";
import { type InstanceObjectSchema, repairGlobalSchemas } from "./lib/schema-repair";
import { isUrlSourceAdapterEvent, UrlDiscovery, type UrlStatesListener } from "./lib/url-discovery";
import { WebServer } from "./lib/webserver";
import type { AdapterConfig } from "./lib/types";
// v1.25.0 (F3): instanceObjects als single source of truth — repairGlobalSchemas
// liest die Object-Schemas aus dem io-package.json statt sie zu duplizieren.
// resolveJsonModule ist im tsconfig aktiv.
import iobrokerPackage from "../io-package.json";
const instanceObjectsList = (iobrokerPackage as { instanceObjects: unknown[] }).instanceObjects ?? [];

/**
 * HA emulator adapter — lifecycle, migrations, state-dispatch, master switch.
 * Exported so the orchestration unit tests can drive its handlers directly.
 */
export class HassEmu extends utils.Adapter {
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

  // Factory seams — production builds the real collaborators; the orchestration
  // unit tests (src/main.test.ts) override these fields with fakes so onReady &
  // friends can run without sockets, mDNS or a js-controller.
  private makeGlobalConfig: () => GlobalConfig = () => new GlobalConfig(this);
  private makeRegistry: () => ClientRegistry = () => new ClientRegistry(this);
  private makeUrlDiscovery: (onChange: UrlStatesListener) => UrlDiscovery = onChange =>
    new UrlDiscovery(this, onChange);
  private makeWebServer: (instanceUuid: string) => WebServer = instanceUuid =>
    new WebServer(this, this.config, this.registry!, this.globalConfig!, instanceUuid, this.systemLanguage);
  private makeMdnsService: (instanceUuid: string) => MDNSService = instanceUuid =>
    new MDNSService(this, this.config, instanceUuid);

  declare config: AdapterConfig;

  /** @param options Adapter options forwarded to the ioBroker base class. */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "hassemu" });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  private async onReady(): Promise<void> {
    try {
      // v1.14.0 (H7): defensive bei onReady-Re-Run ohne unload (sollte nicht
      // passieren, aber js-controller-Edge-Cases). Vorhandene Refs sauber
      // entsorgen, sonst orphaned Server + Listeners.
      if (this.webServer) {
        await this.webServer.stop().catch(() => {});
        this.webServer = null;
      }
      if (this.mdnsService) {
        this.mdnsService.stop();
        this.mdnsService = null;
      }
      this.urlDiscovery?.cancelRefresh();
      this.urlDiscovery = null;

      await I18n.init(join(this.adapterDir, "admin"), this);

      await this.setState("info.connection", { val: false, ack: true });

      // System-Sprache lesen — wird an WebServer durchgereicht für die
      // user-facing Landing-Seite (HTML). Adapter-Logs sind Englisch.
      this.systemLanguage = await this.readSystemLanguage();

      this.globalConfig = this.makeGlobalConfig();
      await this.globalConfig.restore();

      this.registry = this.makeRegistry();
      await this.registry.restore();

      // Migrations run before subscriptions / webserver — first the legacy
      // 1.0.x-style native config, then the visUrl → mode/manualUrl move,
      // then a defensive schema repair for users upgrading from v1.2.0+
      // (where the partial-formed mode-object from the v1.2.0 extend-bug
      // persists since `legacy.visUrl` is already gone and migrate doesn't trigger).
      // These three target pre-1.2.0 → v1.2.0 upgrades; they run once and are
      // idempotent (cheap no-op on already-migrated installs). Removable in a
      // future major once pre-1.2.0 upgrades are no longer plausible — until then
      // dropping them would silently break those upgrade paths.
      await migrateLegacyDefaultVisUrl(this, this.config, this.globalConfig);
      // globalConfig was constructed + restored above (control-flow keeps it non-null
      // here), so it satisfies migrateVisUrlToMode's non-null contract — its writes
      // have no null-safe fallback, unlike the nullable registry. L5.
      await migrateVisUrlToMode(this, this.globalConfig, this.registry);
      await repairGlobalSchemas(this, instanceObjectsList as InstanceObjectSchema[]);

      // L59 (v1.37.0): the manual-refresh button was renamed info.refresh_urls →
      // info.refreshUrls. Delete the old state once on upgrade so it doesn't linger
      // as an orphan beside the new one — js-controller does not auto-remove states
      // dropped from instanceObjects. Guarded like the visUrl cleanups (I5): no
      // wasted delObject round-trip once it's gone.
      if (await this.getObjectAsync("info.refresh_urls")) {
        await this.delObjectAsync("info.refresh_urls").catch(() => {
          /* raced with another delete — already gone */
        });
      }

      // Garbage-collect stale clients (no token + lastSeen older than 30 days).
      await this.gcStaleClients();

      // HA-Server-UUID stabil über Restarts halten — sonst behandeln HA-Clients
      // (Companion-App, Wall-Display, ...) jeden Adapter-Restart als „neuer Server"
      // → Re-Onboarding, Token-Invalidation, History-Verlust. Persistierung in
      // einem normalen State (NICHT via extendForeignObjectAsync auf
      // system.adapter.X.native — das triggert Restart-Loops, govee-smart-Lesson
      // v2.1.3, Memory `feedback_unhandled_rejection_crash_loop` / `reference_iobroker_partial_object_repair`).
      const instanceUuid = await this.getOrCreateServerUuid();
      this.log.debug(
        `Config: port=${this.config.port}, auth=${this.config.authRequired}, mdns=${this.config.mdnsEnabled}`,
      );

      this.urlDiscovery = this.makeUrlDiscovery(async states => {
        await this.globalConfig?.syncUrlDropdown(states);
        await this.registry?.syncUrlDropdown(states);
      });
      // v1.13.0 (H5): Provider VOR collect() setzen — sonst läuft das
      // erste collect() mit dem Default-Provider (`() => MODE_GLOBAL`),
      // der nicht den Resolver-Output für neue Clients widerspiegelt.
      this.registry.setNewClientModeProvider(() => this.computeNewClientMode());
      await this.urlDiscovery.collect();

      try {
        this.webServer = this.makeWebServer(instanceUuid);
        await this.webServer.start();
      } catch (err) {
        // webServer.start() already logged a friendly, actionable error (EADDRINUSE /
        // generic startup) at error level, so keep only a debug echo of the raw error
        // here — otherwise the same failure prints two error lines. I5 (v1.38.0).
        this.log.debug(`Web server failed to start: ${String(err)}`);
        // v1.10.0 (B4): nicht stumm zurückkehren — der Adapter wäre sonst
        // zombie (info.connection=false, kein Server, keine Subscriptions,
        // kein Restart-Signal an js-controller). terminate() signalisiert
        // explizit Failure mit code 11 → js-controller restartet nach
        // Backoff. Bei EADDRINUSE (Port belegt) ist das die einzig sinnvolle
        // Reaktion: warten + retry, statt unsichtbar idle zu sitzen.
        // v1.13.0 (H6): subscriptions waren noch nicht angelegt (jetzt nach
        // diesem Block) — daher kein cleanup nötig. Falls ein Refactor
        // subscriptions VORZIEHT: hier explizit unsubscribe.
        this.terminate(11);
        return;
      }

      // v1.13.0 (D11+H6): Subscriptions NACH webServer.start() — vorher
      // hätte ein State-Write zwischen subscribe und start einen Handler
      // ausgelöst der auf einen noch-nicht-laufenden Server zugriff. Plus:
      // wenn webServer.start() throwt, sind Subscriptions noch nicht angelegt
      // (kein Cleanup-Pfad nötig im catch-Block oben).
      await this.subscribeForeignObjectsAsync("system.adapter.*");
      await this.subscribeStatesAsync("clients.*");
      await this.subscribeStatesAsync("global.*");
      await this.subscribeStatesAsync("info.refreshUrls");

      let mdnsActive = false;
      if (this.config.mdnsEnabled) {
        this.mdnsService = this.makeMdnsService(instanceUuid);
        this.mdnsService.start();
        // v1.10.0 (H1): mdns.start() catched intern und setzt active=false
        // bei Fehler — vorher wurde info.connection=true unabhängig gesetzt
        // und der User hatte den Eindruck Discovery funktioniert. Jetzt
        // führen wir die Information sichtbar im Log + im Suffix der
        // running-Meldung.
        mdnsActive = this.mdnsService.isActive();
        if (!mdnsActive) {
          // Generic warn — MDNSService already logged the underlying cause.
          this.log.warn("mDNS failed to start — see preceding mDNS warning");
        }
      } else {
        this.log.debug("mDNS disabled — clients must enter the URL manually.");
      }

      await this.setState("info.connection", { val: true, ack: true });
      const bindAddr = this.config.bindAddress || "0.0.0.0";
      // "started" (not "active"): isActive() is read synchronously right after start(),
      // before an asynchronous bonjour publish error could fire — so the headline must
      // not over-claim; a later publish failure surfaces as its own mDNS warn. I6 (v1.38.0).
      const mdnsSuffix = this.config.mdnsEnabled ? (mdnsActive ? ", mDNS started" : ", mDNS FAILED") : "";
      this.log.info(`HA emulation running on ${bindAddr}:${this.config.port}${mdnsSuffix}`);
    } catch (err: unknown) {
      // M2: don't sit idle as a zombie (info.connection=false, server maybe up but
      // no state subscriptions, no restart signal) if any onReady step other than
      // webServer.start() throws. Mirror the B4 server-start-fail path: stop a
      // partially-started server and terminate so js-controller restarts with backoff.
      this.log.error(`onReady failed: ${String(err)}`);
      await this.webServer?.stop().catch(() => {});
      this.terminate(11);
    }
  }

  /**
   * Liefert die persistente Server-UUID. Beim ersten Start wird sie generiert und in
   * `info.serverUuid` geschrieben; bei späteren Starts kommt der gleiche Wert raus.
   *
   * Warum nicht `extendForeignObjectAsync(system.adapter.X, native: { serverUuid })`?
   * Schreibt man auf den eigenen `system.adapter.X`-Objekt, triggert js-controller
   * einen Adapter-Restart — bei jedem Start ein Restart-Loop. govee-smart hatte das
   * in v2.1.3 (`extendForeignObjectAsync` für `mqttCredentials`-native) und musste
   * auf state-based persistence migrieren.
   */
  private async getOrCreateServerUuid(): Promise<string> {
    try {
      const existing = await this.getStateAsync("info.serverUuid");
      // L19: reuse the shared coerceUuid instead of an inline copy of the regex.
      const reused = coerceUuid(existing?.val);
      if (reused) {
        this.log.debug(`Server UUID reused from info.serverUuid: ${reused}`);
        return reused;
      }
    } catch {
      /* state didn't exist yet — fresh install */
    }
    const fresh = crypto.randomUUID();
    await this.setState("info.serverUuid", { val: fresh, ack: true }).catch(err => {
      // info.serverUuid is an instanceObject — should always exist. Falls
      // doch nicht: log + fortfahren mit der frischen UUID, sie wird beim
      // nächsten Start erneut generiert (kein bleibender Schaden).
      this.log.warn(`Could not save server UUID: ${String(err)}`);
    });
    this.log.info(`Server UUID generated and saved: ${fresh}`);
    return fresh;
  }

  /**
   * Default mode for newly registered clients. Respects the master switch:
   * - `global.enabled=true`  → `'global'` (follow master)
   * - sonst                  → `'0'` (no-choice) → Resolver returnt null →
   *   Landing-Page bis der User im Mode-Dropdown explizit eine URL wählt.
   *   Pre-v1.26.0 fiel der Default auf die erste discovered URL — das hat
   *   die Landing-Page für neue Displays praktisch unsichtbar gemacht und
   *   den User mit einer ungewollten Auto-Wahl überrascht.
   */
  private computeNewClientMode(): string {
    if (this.globalConfig?.isEnabled()) {
      return MODE_GLOBAL;
    }
    return "0";
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
   * Removes clients that are clearly stale: `native.lastSeen` older than
   * {@link STALE_CLIENT_TTL_MS}.
   *
   * Clients without `lastSeen` (pre-1.2.0) get the timestamp seeded on this run
   * — GC kicks in only on subsequent restarts.
   *
   * v1.11.0 (C9): vorher übersprang GC alle token-haltenden Clients (`if record.token`).
   * Effekt: über Jahre wuchs die Liste mit „authenticated, but never seen again"-
   * Clients (Display weg/refurbished/Bridge-Reset etc.). Jetzt: lastSeen-basiert
   * unabhängig vom Token. Access-Token sind ohnehin nur 30min gültig — wenn
   * lastSeen 30 Tage zurückliegt, ist der Token längst abgelaufen.
   */
  private async gcStaleClients(): Promise<void> {
    const now = Date.now();
    const records = this.registry?.listAll() ?? [];
    if (records.length > 0) {
      const ttlDays = Math.round(STALE_CLIENT_TTL_MS / (24 * 60 * 60 * 1000));
      this.log.debug(`gcStaleClients: scanning ${records.length} client(s) for staleness (TTL=${ttlDays}d)`);
    }
    // v1.28.3 (M5): GC-Pass parallel statt sequentiell. Bei vielen Clients
    // (Display-Farm) summierten sich die Broker-Round-Trips beim Adapter-
    // Start zur spürbaren Pause vor `webServer.start()`. Pro-Client-try-catch
    // bleibt — ein einzelner getObject-Fehler darf den GC-Pass nicht
    // abbrechen. Counter ist ein primitive number unter Promise.all sicher.
    const results: number[] = await Promise.all(
      records.map(async (record): Promise<number> => {
        try {
          const obj = await this.getObjectAsync(`clients.${record.id}`);
          const native = (obj?.native as { lastSeen?: number } | undefined) ?? {};
          // v1.25.0 (J1): Decision-Logik in pure helper coerce.decideGcAction
          // (testbar). Hier nur das I/O zum Broker.
          const action = decideGcAction(native.lastSeen, now, STALE_CLIENT_TTL_MS);
          if (action === "seed") {
            await this.registry!.seedLastSeen(record.id, now);
            return 0;
          }
          if (action === "stale") {
            await this.registry!.remove(record.id);
            return 1;
          }
          return 0;
        } catch (err) {
          this.log.debug(`Stale-GC: failed for ${record.id}: ${String(err)}`);
          return 0;
        }
      }),
    );
    const removed = results.reduce((acc, n) => acc + n, 0);
    if (removed > 0) {
      this.log.info(`Removed ${removed} inactive client(s) (idle longer than 30 days)`);
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
    if (enabled) {
      this.log.debug(`applyMasterSwitch: enabled=true → propagating mode='global' to all clients`);
      await this.registry.bulkSetMode(MODE_GLOBAL);
      return;
    }
    // Master aus → alle Clients auf no-choice. Ohne explizite User-Wahl
    // zeigt jedes Display die Landing-Page (statt automatisch auf irgendeine
    // discovered URL umzuswitchen, die der User vielleicht gar nicht meinte).
    this.log.debug(`applyMasterSwitch: enabled=false → propagating mode='0' (no-choice) to all clients`);
    await this.registry.bulkSetMode("0");
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
          // B4: if the user picked 'global' but global resolves to nothing,
          // give them a one-shot heads-up so the cause of the empty redirect
          // is obvious without digging through the resolver code.
          const record = registry.getById(clientParsed.id);
          if (record?.mode === MODE_GLOBAL && globalConfig?.resolveUrlFor(record) === null) {
            this.log.warn(
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
          await globalConfig.handleEnabledWrite(state.val);
          // A non-boolean write reverts (no change), so bulkSetMode sees an unchanged
          // value and no-ops — harmless. A real toggle propagates.
          await this.applyMasterSwitch(globalConfig.isEnabled());
        }
        // I7 (v1.38.0): every global.* write is fully handled here — return so it
        // can't fall through to the info.refreshUrls check (symmetry with the client
        // block above; the ids never collide, so this is clarity, not a bug fix).
        return;
      }

      // info.refreshUrls — User-Trigger für manuelles Dropdown-Refresh ohne
      // Adapter-Neustart. Re-scan'd den Broker nach VIS/VIS-2-Projekten und
      // Admin-Tiles, schreibt die neuen states-Maps in alle Mode-Dropdowns.
      if (id === `${this.namespace}.info.refreshUrls` && state.val === true) {
        await this.handleRefreshUrlsWrite();
      }
    } catch (err: unknown) {
      this.log.error(`stateChange failed: ${String(err)}`);
    }
  }

  /**
   * Handler for the `info.refreshUrls` button.
   * Triggert eine sofortige `urlDiscovery.collect()` (statt Debounce-Schedule),
   * damit der User nicht 2s warten muss. Schreibt anschließend `false ack` damit
   * der Button in der Admin-UI wieder „klickbar" wird.
   */
  private async handleRefreshUrlsWrite(): Promise<void> {
    if (!this.urlDiscovery) {
      return;
    }
    // Cancel any pending debounced refresh first — otherwise an objectChange-scheduled
    // scan fires a second full broker scan ~2s after this immediate one. L3 (v1.38.0).
    this.urlDiscovery.cancelRefresh();
    try {
      await this.urlDiscovery.collect();
      // I3: success on debug — the visible feedback is the refreshed dropdown +
      // the re-armed button, so no "success" line belongs on info.
      this.log.debug(`URL list refreshed on user request`);
    } catch (err) {
      this.log.warn(`URL refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // I2: log a re-arm failure instead of swallowing it — a failed re-arm leaves
      // the admin button visually "pressed" (val=true) with no trace of why.
      await this.setState("info.refreshUrls", { val: false, ack: true }).catch(err =>
        this.log.debug(`refreshUrls re-arm failed: ${String(err)}`),
      );
    }
  }

  private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    try {
      // v1.13.0 (H4): narrow filter — earlier EVERY objectChange in the
      // `system.adapter.*` namespace triggered a scheduleRefresh, even from an
      // adapter changing discovery-irrelevant config. Now it triggers only when the
      // changed object belongs to a URL-source adapter (isUrlSourceAdapterEvent)
      // OR looks like an instance add/remove (obj deleted, or an instance object
      // without a resolved host). The 2s debounce coalesces bursts.
      if (!id?.startsWith("system.adapter.")) {
        return;
      }
      // v1.30.0 (R2): adapter prefix list lives in url-discovery.ts
      // alongside the actual discovery logic. Single source of truth —
      // adding a new URL-source adapter only requires updating the
      // exported `URL_SOURCE_PREFIXES` (plus `collect()`).
      const isUrlSourceAdapter = isUrlSourceAdapterEvent(id);
      const isAddOrRemove = !obj || (obj.type === "instance" && !obj.common?.host);
      if (isUrlSourceAdapter || isAddOrRemove) {
        this.urlDiscovery?.scheduleRefresh();
      }
    } catch (err: unknown) {
      this.log.error(`objectChange failed: ${String(err)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      // v1.13.0 (H10): info.connection=false zuerst, vor jedem cleanup —
      // wenn ein cleanup-Step throws, bleibt der State mindestens als
      // false ack'd statt als true hängen.
      // L8: `void` marks the promise as intentionally not awaited (onUnload MUST
      // stay synchronous, or SIGKILL), but it does NOT handle a rejection — a
      // broker write that rejects during shutdown would be an unhandledRejection.
      // `.catch(() => {})` makes each fire-and-forget explicit and safe (webServer
      // .stop() below already does this).
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {});

      // v1.10.0 (H2): subscriptions explizit lösen bevor Refs nullen.
      // js-controller cleant das normalerweise — aber im compact-mode mit
      // hot-remove + re-add kann Residual entstehen, das dann auf eine
      // bereits genullte Adapter-Instance feuert.
      void this.unsubscribeStatesAsync("clients.*").catch(() => {});
      void this.unsubscribeStatesAsync("global.*").catch(() => {});
      void this.unsubscribeStatesAsync("info.refreshUrls").catch(() => {});
      void this.unsubscribeForeignObjectsAsync("system.adapter.*").catch(() => {});

      this.urlDiscovery?.cancelRefresh();
      this.urlDiscovery = null;

      if (this.mdnsService) {
        // synchronous: onUnload must not arm a managed fallback timer (I1).
        this.mdnsService.stop(true);
        this.mdnsService = null;
      }

      if (this.webServer) {
        // v1.18.0 (G6): kein doppeltes log — webServer.stop() loggt
        // intern bereits auf debug. Hier nur silent-catch.
        this.webServer.stop().catch(() => {});
        this.webServer = null;
      }

      this.registry = null;
      this.globalConfig = null;
    } catch (error) {
      const err = error as Error;
      this.log.error(`Shutdown error: ${err.message}`);
    } finally {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HassEmu(options);
} else {
  (() => new HassEmu())();
}
