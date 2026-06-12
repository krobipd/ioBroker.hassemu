import crypto from "node:crypto";
import { join } from "node:path";
import { I18n } from "@iobroker/adapter-core";
import * as utils from "@iobroker/adapter-core";
import { ClientRegistry, parseClientStateId } from "./lib/client-registry";
import { coerceSafeUrl, decideGcAction, decideLegacyVisMigration } from "./lib/coerce";
import { MODE_GLOBAL, MODE_MANUAL, STALE_CLIENT_TTL_MS } from "./lib/constants";
import { GlobalConfig, parseGlobalStateId } from "./lib/global-config";
import { MDNSService } from "./lib/mdns";
import { type InstanceObjectSchema, repairGlobalSchemas } from "./lib/schema-repair";
import { isUrlSourceAdapterEvent, UrlDiscovery } from "./lib/url-discovery";
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
   * ioBroker system language used to render the user-facing landing page
   * (HTML) in the user's language. Adapter logs themselves stay English by
   * ioBroker convention. Read in `onReady` from `system.config.language`,
   * EN-Fallback. Public so library modules can access it via the
   * `AdapterInterface` they receive.
   */
  public systemLanguage: string = "en";

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
  private makeUrlDiscovery: (onChange: ConstructorParameters<typeof UrlDiscovery>[1]) => UrlDiscovery = onChange =>
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
      await this.migrateLegacyDefaultVisUrl();
      await this.migrateVisUrlToMode();
      await repairGlobalSchemas(this, instanceObjectsList as InstanceObjectSchema[]);

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
        this.log.error(`Web server failed to start: ${String(err)}`);
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
      await this.subscribeStatesAsync("info.refresh_urls");

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
          // Use mdnsStartFailed (User-Hint) — `error` slot uses generic phrase since
          // the underlying cause was already warn'd by MDNSService itself.
          this.log.warn("mDNS failed to start — see preceding mDNS warning");
        }
      } else {
        this.log.debug("mDNS disabled — clients must enter the URL manually.");
      }

      await this.setState("info.connection", { val: true, ack: true });
      const bindAddr = this.config.bindAddress || "0.0.0.0";
      const mdnsSuffix = this.config.mdnsEnabled ? (mdnsActive ? ", mDNS active" : ", mDNS FAILED") : "";
      this.log.info(`HA emulation running on ${bindAddr}:${this.config.port}${mdnsSuffix}`);
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${String(err)}`);
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
      const val = existing?.val;
      if (typeof val === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
        this.log.debug(`Server UUID reused from info.serverUuid: ${val}`);
        return val;
      }
    } catch {
      /* state didn't exist yet — fresh install */
    }
    const fresh = crypto.randomUUID();
    await this.setStateAsync("info.serverUuid", { val: fresh, ack: true }).catch(err => {
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
   * Read the ioBroker system language (set in Admin → Main Settings).
   * Used for the landing page so the end-user sees the same language as
   * their admin UI. Falls back to `en` when `system.config` can't be read
   * or holds a language we don't translate. Read once on startup — a
   * language switch at runtime only takes effect after an adapter restart,
   * which is fine for a setup-hint page that most users see once.
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
   * Drops the legacy `defaultVisUrl`/`visUrl` keys from the instance native
   * config. Shared by both exits of {@link migrateLegacyDefaultVisUrl} —
   * the unsafe-rejected path and the successfully-migrated path clean up
   * identically. Best-effort: failures only warn.
   */
  private async cleanupLegacyNativeUrl(): Promise<void> {
    try {
      const id = `system.adapter.${this.namespace}`;
      const obj = await this.getForeignObjectAsync(id);
      if (obj?.native) {
        delete obj.native.defaultVisUrl;
        delete obj.native.visUrl;
        await this.setForeignObjectAsync(id, obj);
      }
    } catch (err) {
      this.log.warn(`Legacy config cleanup failed: ${String(err)}`);
    }
  }

  /**
   * 1.0.x / 1.1.0 → 1.1.1 migration — move the legacy `defaultVisUrl` from
   * instance native into `global.visUrl` + `global.enabled=true` and drop it
   * from native. Subsequent migrations (`migrateVisUrlToMode`) then move
   * `global.visUrl` into the mode/manualUrl model.
   */
  private async migrateLegacyDefaultVisUrl(): Promise<void> {
    const legacy = this.config as AdapterConfig & { defaultVisUrl?: string; visUrl?: string };
    const url = legacy.defaultVisUrl || legacy.visUrl;
    if (!url) {
      return;
    }
    // Defensive: validiere die legacy-URL bevor wir sie nach `global.visUrl`
    // schreiben. Malicious-Werte (`javascript:`, `data:`) sollen nicht durch
    // die Migration durchrutschen — `migrateVisUrlToMode` validiert zwar
    // nochmal, aber zwischen den Migrations-Schritten würde unsafe-Wert
    // sichtbar sein, und die native-Cleanup ist unbedingt.
    const safe = coerceSafeUrl(url);
    if (!safe) {
      this.log.warn(`Migration: legacy global URL rejected as unsafe — please set global.manualUrl manually`);
      await this.cleanupLegacyNativeUrl();
      return;
    }

    this.log.info(`Migrating legacy URL configuration to the new model`);
    // We cannot call globalConfig.handleVisUrlWrite — that method is gone in
    // v1.2.0. Write the legacy state directly so migrateVisUrlToMode picks it up.
    // Wichtig: wenn der State-Write FEHLSCHLÄGT (z.B. weil global.visUrl-Object
    // in v1.2.0+ schon weg ist), dürfen wir die native-Werte NICHT löschen —
    // sonst ist die User-URL silent verloren. Stattdessen direkt nach
    // global.mode/manualUrl schreiben (das Ziel wo migrateVisUrlToMode
    // sie sonst hingeschrieben hätte).
    let stateWritten = false;
    try {
      await this.setStateAsync("global.visUrl", { val: safe, ack: true });
      stateWritten = true;
    } catch {
      // global.visUrl-Object existiert nicht mehr → direkt ins Ziel schreiben
      try {
        if (this.globalConfig) {
          await this.globalConfig.migrationSet(MODE_MANUAL, safe);
          // Tech-Internal-Pfad: shortcut wenn global.visUrl-state fehlt — debug-only.
          this.log.debug(`Migration shortcut: global.visUrl-state missing — wrote directly to manualUrl=${safe}`);
          stateWritten = true;
        }
      } catch (err) {
        this.log.debug(`Legacy URL migration fallback failed: ${String(err)}`);
      }
    }

    if (!stateWritten) {
      // Both paths failed — keep native values as a recovery anchor for the user.
      this.log.warn(`Legacy URL preserved in instance config — neither global URL write succeeded`);
      return;
    }

    await this.cleanupLegacyNativeUrl();
  }

  /**
   * 1.x → 1.2.0 migration — move legacy per-client `visUrl`-states to the
   * `mode`/`manualUrl` model, plus the global `visUrl` to `global.mode` +
   * `global.manualUrl`. Old datapoints are removed, type of mode-states
   * upgraded to 'mixed'. Idempotent — does nothing on subsequent starts.
   */
  private async migrateVisUrlToMode(): Promise<void> {
    // v1.25.0 (J2): Decision-Logik in pure helper coerce.decideLegacyVisMigration
    // (testbar). Hier nur das I/O zum Broker.
    // 1) Global visUrl → mode + manualUrl
    try {
      const legacyGlobal = await this.getStateAsync("global.visUrl");
      const decision = decideLegacyVisMigration(legacyGlobal?.val);
      if (decision.kind === "safe-url") {
        await this.globalConfig!.migrationSet(MODE_MANUAL, decision.safe);
        this.log.info(`Migration: global URL "${decision.safe}" moved to global.manualUrl`);
      } else if (decision.kind === "unsafe-rejected") {
        await this.globalConfig!.migrationSet(MODE_MANUAL, null);
        this.log.warn(`Migration: legacy global URL rejected as unsafe — please set global.manualUrl manually`);
      }
    } catch {
      /* state didn't exist — fresh install or already migrated */
    }
    try {
      await this.delObjectAsync("global.visUrl");
    } catch {
      /* didn't exist */
    }

    // 2) Per-client visUrl → mode='manual' + manualUrl
    const records = this.registry?.listAll() ?? [];
    for (const record of records) {
      try {
        const legacy = await this.getStateAsync(`clients.${record.id}.visUrl`);
        const decision = decideLegacyVisMigration(legacy?.val);
        if (decision.kind === "safe-url") {
          record.mode = MODE_MANUAL;
          record.manualUrl = decision.safe;
          await this.setStateAsync(`clients.${record.id}.mode`, { val: MODE_MANUAL, ack: true });
          await this.setStateAsync(`clients.${record.id}.manualUrl`, { val: decision.safe, ack: true });
          this.log.info(`Migration: client ${record.id} URL "${decision.safe}" moved to manualUrl`);
        } else if (decision.kind === "unsafe-rejected") {
          this.log.warn(`Migration: client ${record.id} legacy URL rejected as unsafe — please set the URL manually`);
        }
      } catch {
        /* state didn't exist for this client */
      }
      try {
        await this.delObjectAsync(`clients.${record.id}.visUrl`);
      } catch {
        /* didn't exist */
      }
    }

    // 3) global.mode + global.manualUrl repair handled by repairGlobalSchemas()
    // (called separately in onReady so it ALSO runs for users upgrading from
    // v1.2.0/v1.3.0/v1.3.1 where the legacy visUrl is already gone but the
    // partial-formed mode-object from the v1.2.0 extendObject-bug persists).
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
      const clientParsed = this.registry ? parseClientStateId(id, this.namespace) : null;
      if (clientParsed) {
        if (clientParsed.kind === "mode") {
          await this.registry!.handleModeWrite(clientParsed.id, state.val);
          // B4: if the user picked 'global' but global resolves to nothing,
          // give them a one-shot heads-up so the cause of the empty redirect
          // is obvious without digging through the resolver code.
          const record = this.registry!.getById(clientParsed.id);
          if (record?.mode === MODE_GLOBAL && this.globalConfig!.resolveUrlFor(record) === null) {
            this.log.warn(
              `Client ${record.id}: mode is "global" but global has no resolvable URL — fill global.mode/manualUrl, or pick a different mode`,
            );
          }
        } else if (clientParsed.kind === "manualUrl") {
          await this.registry!.handleManualUrlWrite(clientParsed.id, state.val);
        } else if (clientParsed.kind === "remove" && state.val === true) {
          await this.registry!.remove(clientParsed.id);
        }
        return;
      }
      const globalParsed = this.globalConfig ? parseGlobalStateId(id, this.namespace) : null;
      if (globalParsed === "mode") {
        await this.globalConfig!.handleModeWrite(state.val);
      } else if (globalParsed === "manualUrl") {
        await this.globalConfig!.handleManualUrlWrite(state.val);
      } else if (globalParsed === "enabled") {
        await this.globalConfig!.handleEnabledWrite(state.val);
        await this.applyMasterSwitch(this.globalConfig!.isEnabled());
        return;
      }

      // info.refresh_urls — User-Trigger für manuelles Dropdown-Refresh ohne
      // Adapter-Neustart. Re-scan'd den Broker nach VIS/VIS-2-Projekten und
      // Admin-Tiles, schreibt die neuen states-Maps in alle Mode-Dropdowns.
      if (id === `${this.namespace}.info.refresh_urls` && state.val === true) {
        await this.handleRefreshUrlsWrite();
      }
    } catch (err: unknown) {
      this.log.error(`stateChange failed: ${String(err)}`);
    }
  }

  /**
   * Handler for the `info.refresh_urls` button.
   * Triggert eine sofortige `urlDiscovery.collect()` (statt Debounce-Schedule),
   * damit der User nicht 2s warten muss. Schreibt anschließend `false ack` damit
   * der Button in der Admin-UI wieder „klickbar" wird.
   */
  private async handleRefreshUrlsWrite(): Promise<void> {
    if (!this.urlDiscovery) {
      return;
    }
    try {
      await this.urlDiscovery.collect();
      this.log.info(`URL list refreshed on user request`);
    } catch (err) {
      this.log.warn(`URL refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await this.setStateAsync("info.refresh_urls", { val: false, ack: true }).catch(() => {});
    }
  }

  private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    try {
      // v1.13.0 (H4): Narrow filter — vorher feuerte JEDER objectChange
      // im `system.adapter.*`-Namespace ein scheduleRefresh, auch wenn
      // ein anderer Adapter (mit Discovery-irrelevanten Properties) eine
      // Konfiguration änderte. Jetzt nur Trigger bei:
      //  - Instance-Add/-Remove (obj=null bei delete, oder fresh _id ohne obj)
      //  - native.intro / native.welcomeScreen / native.welcomeScreenPro
      //    (Quellen für discovered URLs)
      //  - admin/web/vis/vis-2 generell (deren Available-Status entscheidet)
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
      void this.setState("info.connection", { val: false, ack: true });

      // v1.10.0 (H2): subscriptions explizit lösen bevor Refs nullen.
      // js-controller cleant das normalerweise — aber im compact-mode mit
      // hot-remove + re-add kann Residual entstehen, das dann auf eine
      // bereits genullte Adapter-Instance feuert. Sync-call (void) weil
      // onUnload synchron sein MUSS (sonst SIGKILL).
      void this.unsubscribeStatesAsync("clients.*");
      void this.unsubscribeStatesAsync("global.*");
      void this.unsubscribeStatesAsync("info.refresh_urls");
      void this.unsubscribeForeignObjectsAsync("system.adapter.*");

      this.urlDiscovery?.cancelRefresh();
      this.urlDiscovery = null;

      if (this.mdnsService) {
        this.mdnsService.stop();
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
