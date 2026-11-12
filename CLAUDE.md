# CLAUDE.md — ioBroker.hassemu

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HASS Emulator** — emuliert einen minimalen HA-Server für Geräte, die ein HA-Dashboard erwarten → leitet auf beliebige URL um.

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.hassemu
- **npm:** https://www.npmjs.com/package/iobroker.hassemu
- **Repository PR:** ioBroker/ioBroker.repositories#5793
- **Vorher:** homeassistant-bridge (umbenannt wegen irreführendem Namen)
- **Runtime-Deps:** `@iobroker/adapter-core`, `fastify`, `@fastify/cookie`, `@fastify/formbody`, `@fastify/websocket`, `bonjour-service`
- **Keine harte Adapter-Abhängigkeit** — URL-Discovery liest optional `web.*`-Instance-Konfiguration für VIS/VIS-2-URLs; ohne web bleiben nur VIS-URLs leer, Admin-Tiles/Aura/Manual funktionieren weiter.
- **Test-Setup:** Tests unter `src/lib/*.test.ts` via **vitest** (seit v1.32.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller). `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only).
- **`@types/node` an `engines.node`-Min gekoppelt:** `^22.x` weil `engines.node: ">=22"`

## HA-kompatible Geräte — Limitationen

| Aspekt    | Typisches Verhalten                                           |
| --------- | ------------------------------------------------------------- |
| Protokoll | HTTP als Vorgabe, HTTPS optional mit ioBroker-Zertifikat (K4) |
| Discovery | mDNS (`_home-assistant._tcp`) oder manuelle IP                |
| Auth      | Erwartet vollständigen HA OAuth2-Flow                         |
| Nach Auth | Folgt 302-Redirects nativ im WebView                          |

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Migration, State-Dispatch, Master-Switch, Stale-GC, refreshInstanceObjects); die Klasse ist KEIN benannter Export, sie reitet auf der Factory (`module.exports.HassEmu`, 1.46.0 — sonst warnt esbuild `commonjs-variable-in-esm`)
src/lib/types.ts             → AdapterConfig, ClientRecord, SessionData, AdapterInterface
src/lib/constants.ts         → HA_VERSION (Verhaltensschalter der Apps; 2026.8.0, ab dort warten sie auf `frontend/loaded`, K17), TTLs/Caps, HTTP-Grenzen (HTTP_CONNECTION_TIMEOUT_MS/HTTP_REQUEST_TIMEOUT_MS/HTTP_CONNECTIONS_CHECK_INTERVAL_MS), AUTH_CODE_TTL_MS, IP_CHANGE_MIN_INTERVAL_MS, MDNS_ADDRESS_CHECK_INTERVAL_MS, DEFAULT_SERVICE_NAME, DNS/WS-Windows, LOGIN_SCHEMA, MODE_-Sentinels, Drossel-Leiter (NEW_CLIENT_* per IP + GLOBAL_NEW_CLIENT_THROTTLE_PER_WINDOW)
src/lib/coerce.ts            → NUR Boundary-Validierung externer Werte (UUID/URL/Number/String/Boolean, isValidRedirectUri, isCompanionRedirect, mayAutoRedirect, describeUntrusted, oneLine, safeStringEqual) — v1.43.0 entflochten
src/lib/object-utils.ts      → ioBroker-Objekt-/State-Helfer (nameText, isBareStringName, parseAdapterStateId, getStateOrNull — ein Lesefehler wirft (K16), evictOldest, shallowStatesEqual)
src/lib/state-write-rules.ts → was ein State-SCHREIBVORGANG bedeutet (parseModeWrite/parseManualUrlWrite/decideGcAction/decideLegacyVisMigration/buildDropdownStates/isNoChoice)
src/lib/redirect-resolver.ts → „wohin geht DIESES Display" (resolveRedirect + Kette) — war in GlobalConfig, gehört dorthin nicht
src/lib/hostname-resolver.ts → Reverse-DNS mit Deadline, in-flight-Sperre + Negativ-Cache, `dispose()` — eine Antwort nach dem Stopp schreibt nichts (war in webserver.ts); je Display (Cookie) einmal je Lauf und IP (`answered`), ein Fehlschlag ruft den Sink nie — `dns.reverse` meldet Ausfall und fehlenden PTR gleich als ENOTFOUND (gemessen 2026-11-11)
src/lib/ha-websocket.ts      → `/api/websocket`: Handshake, Heartbeat, `WsSession` am Refresh-Token (`sessionAlive` vor jedem Befehl), quellenverifizierte Kommando-Tabelle (war in webserver.ts)
src/lib/mobile-app-routes.ts → HA-Companion-Registrierungen + Webhook (war in webserver.ts)
src/lib/network.ts           → getLocalIp (link-local übersprungen, virtuelle Schnittstellen `VIRTUAL_IFACE` zurückgestellt), resolveAdvertisedHost (gewählte Adresse, sonst getLocalIp), hostForUrl (IPv6 in Klammern), advertisedBaseUrl
src/lib/network-address.ts   → chosenAddress/carriesAddress/ownNets/isOwnPeer — Stufe-1-Flotten-Master (Datei + Test byte-gleich, nie lokal ändern): die gewählte Adresse und die eigenen Netze (DD 36)
src/lib/device-icon.ts       → displayIcon: `admin/icons/display.svg` als `data:image/svg+xml;base64`-URI, LF-normalisiert, einmal gelesen (Piktogramm am Gerät, D08 `device-icon`)
src/lib/mdns.ts              → mDNS Broadcasting via bonjour-service (announce/withdraw; mit gewählter Adresse nur über deren Schnittstelle (`mdnsSocketOptions`), ohne sie refreshIfAddressChanged im Minutentakt; stop() liefert ein Promise — das Goodbye muss RAUS bevor der Prozess endet)
src/lib/client-registry.ts   → Multi-Client-Store (Cookie → Record), bulkSetMode, updateHostname, NewClientModeProvider, lastSeen-Tracking, per-IP-Throttle + globale IP-unabhängige Client-Obergrenze (v1.40.0); Identitäten schreibt `persist()` als ganze Datei, synchron (DD 37); `moveToDisplayIds` zieht jedes Display der alten Id-Form einmal um (Journal `native.movingTo`, Werte, `retargetAliases`, Identität, `moveAllWithEnums`, K7); der Name ist `wantName` = App-Gerätename ?? Hostname ?? IP ?? Id, `applyName` schreibt ihn bei jeder Quellenänderung ohne den Baum zu lesen, `restoreChannel` gleicht den Baum beim Start ab (K7, krobi 2026-11-11 22:40)
src/lib/client-store.ts      → `identities.json` im Datenordner der Instanz: Server-Id und je Display-Id Cookie, Tokens, Ablauf, lastSeen, App-Gerätename, Hostname (readStore/writeStore, Grenzprüfung `storedClientFrom`, `LEGACY_NATIVE_KEYS` des Umzugs aus dem Geräte-`native`)
src/lib/display-id.ts        → Display-Id nach K7: Modell aus dem User-Agent (`modelFromUserAgent`/`modelPart`) oder `display`, dazu vier selbst gewählte Zeichen (`randomIdTail`), Zähler bei Belegung (`withCounter`); `movedDisplayId` für den Umzug der alten Form `LEGACY_DISPLAY_ID`
src/lib/tls.ts               → HTTPS-Option (K4): Zertifikat aus ioBroker (`loadTls`, `selectCollections`, `buildTls`), Name im Zertifikat für die Ansage (`certificateName`)
src/lib/data-file.ts         → Flotten-Master (Runde 173, nie in der Kopie ändern): jeder Zugriff auf den Datenordner; hassemu nutzt readDataFile/writeDataFile (Temp-Datei, fsync, dann rename, Modus 0600)
src/lib/global-config.ts     → global.mode + global.manualUrl + global.enabled, MODE_GLOBAL/MODE_MANUAL Sentinels, Resolver-Delegate
src/lib/schema-repair.ts     → repairGlobalSchemas (partial-formed global.*-Objekte aus io-package.json:instanceObjects heilen)
src/lib/object-repair.ts     → replaceObjectPreservingValue: Voll-Ersatz eines State-Objekts in EINEM Schreibvorgang (`setForeignObject` mit voller Id, seit 1.45.0 — vorher delObject→setObjectNotExists mit gerettetem Wert, das die Enum-Zuordnungen verlor) — der von ClientRegistry + GlobalConfig geteilte Weg, veraltete common.states-Schlüssel physisch loszuwerden (extendObject mischt sie zurück, setObject meldet der repochecker als S5054)
src/lib/enum-carry.ts        → moveWithEnums: Enums der alten Id lesen → löschen → Nachfolger in genau diese Enums anhängen (die drei Id-Umzüge in main.ts + legacy-migration.ts); Stufe-1-Flotten-Master, Datei + Test byte-gleich — nie lokal ändern (ersetzt 1.46.0 das eigene enum-membership.ts, das VOR dem Löschen schrieb und vom Enum-Cache überschrieben werden konnte)
src/lib/err-text.ts          → errText: der EINE Helfer, über den jeder gefangene Wert zu Text wird (Flottenregel, Prüfpaket `caught-value-text`) — nie String(err)/`${err}`/`(err as Error).message` inline
src/lib/legacy-migration.ts  → pre-1.2.0 visUrl → mode/manualUrl Upgrade-Migrationen (I10 v1.37.0, aus main.ts extrahiert, isoliert testbar); `LEGACY_URL_DROPS` entfernt `native.visUrl`/`defaultVisUrl` über den Flotten-Master erst nach gelungener Übernahme (1.46.0)
src/lib/native-key-migration.ts → Umbenennung (bindAddress → bind, 1.44.0) und Entfernen (`{drop}`/`{commonDrop}`) von Instanz-Einstellungsschlüsseln beim Start; Stufe-1-Flotten-Master (`Entwicklung/.consistency-master/src/lib/`, Datei + Test byte-gleich, seit Werkzeug-Runde 12 2026-09-17) — nie lokal ändern; der Aufrufer in main.ts reicht `errText` als dritten Parameter herein
src/lib/url-discovery.ts     → Sammelt VIS/VIS-2/Aura/Admin-URLs (collect → mode-Dropdown); die Admin-Kacheln wie die Startseite von Admin 8.3.5 (Platzhalter, eine Kachel je Adresse, ausgeblendete aus `system.config.common.intro` weg, Link-Karten `native.introLinks`), Aura über `webInstance`, Loopback ohne web = kein Ziel (K11)
src/lib/webserver.ts         → Fastify HTTP Server (per `serverFactory` mit HTTP-Grenzen, `HttpLimits`-Naht) + HA-REST-Emulation + OAuth2 (Authorize-Rückfrage `issueAuthorizeRedirect`) + Cookie-Identität + Sessions-Caps + Netz-Wache (`setupPeerGuard`: Socket-Gegenüber außerhalb der eigenen Netze → 403, DD 36) + route-config-Auth-Guard (WS/Mobile-App/DNS sind seit v1.43.0 eigene Module)
src/lib/target-health.ts     → Erreichbarkeits-Probe fürs Weiterleitungsziel (Cache + inflight-Dedupe + terminal dispose, speist die Ziel-Down-Karte; Mutationstabelle mutations_hassemu_targethealth.py, 28/28)
src/lib/auth-page.ts         → OAuth2-Browser-Flow HTML (Login-Form, Auto-Submit-Redirect in Systemsprache, „Weiter“-Seite `renderAuthorizeContinue`, Error-Page mit übersetzter Erklärung je Code `AUTHORIZE_ERRORS`, der Code bleibt darunter)
src/lib/landing-page.ts      → Seite für Displays ohne Ziel: Device-ID, Datenpunkt und eine Anleitung in drei Schritten (`pageStep1–3`), Neuladen alle 15 s
src/lib/redirect-wrapper.ts  → iframe-Wrapper + 30s-Poll-Reload + Down-Page
src/lib/html-shared.ts       → escapeHtml, jsStringLiteral, renderIpRow/renderIdRow, htmlLangFor, SUPPORTED_LANGS
src/lib/external-bridge.ts   → APP_BRIDGE_SCRIPT (connection-status an die Companion-Apps: V2 → V1 → `webkit.messageHandlers.externalBus`, einmal je Seite; `frontend/loaded` über `window.hassemuFrontendLoaded`, K17) und FRONTEND_LOADED_NOW_SCRIPT für Seiten, die sofort fertig sind
src/lib/i18n.ts              → tName, tRaw, resolveLabel, tPage, makePageTranslator: type-safe I18n wrapper (keys from admin/i18n/en.json; tRaw wickelt geräte-gelieferten Text in ein Übersetzungsobjekt)
../scripts/sync-iopackage-from-i18n.py → hält io-package.json:instanceObjects synchron mit admin/i18n (zentral)
```

## Design-Entscheidungen

_Je Nummer der Regel-Satz. Wortlaut und Beleg von DD 1–26 bis 1.45.0: `.claude/dev-history.md`, Eintrag „2026-09-25 — Design-Entscheidungen: Belege aus CLAUDE.md verlegt“; was 1.46.0 geändert und neu entschieden hat: Eintrag „2026-09-25 — 1.46.0: Audit umgesetzt“._

1. **Minimale Komplexität** — nur emulieren, was HA-Clients tatsächlich abfragen.
2. **Eine Server-UUID** — `info.serverUuid` wird einmal erzeugt, an WebServer und mDNS gereicht und bei einem Lesefehler nicht neu erzeugt (der Start scheitert und startet neu, statt jedes Display neu einrichten zu lassen).
3. **Port 8123 fix** — HA-Standard, nicht konfigurierbar.
4. **Kein HTTPS** — HA-Clients erwarten HTTP auf 8123; der Port gehört ins LAN.
5. **Cookie-Identifikation** — `hassemu_client` (UUID v4, 10 Jahre, HttpOnly, SameSite=Lax) identifiziert das Display; Tokens kommen nur per API-Header und reichen dafür nicht.
6. **Ein eigenes Gerät (`device`) je Display** — `clients.<id>` mit Piktogramm (`admin/icons/display.svg` als Inline-URI) und `mode`, `manualUrl`, `resolvedUrl`, `ip`, `remove`; der Hostname lebt im Gerätenamen, kein eigener Datenpunkt.
7. **Master-Switch als Bulk-Sync** — nur ein ÜBERGANG von `global.enabled` setzt alle Displays per `bulkSetMode` auf `global` bzw. `---`; dieselbe Schreibung zweimal ändert nichts; die Zahl umgestellter Displays steht auf debug — ein Schalter- oder Knopf-Datenpunkt bekommt keine info-Zeile (ebenso `info.refreshUrls` und `remove`).
8. **Resolver-Delegate** — `global` → `global.mode`, `manual` → `manualUrl`, eine URL → diese URL, sonst Landing-Seite; `global.mode` darf nie `global` sein.
9. **Landing-Seite statt Fehler** — ohne URL liefert der Server eine kleine Seite mit der Device-ID, die sich alle 15 s neu lädt; die Anleitung steht in der README.
10. **Mode-Dropdown** — `common.states` aus Intro-Kacheln, VIS/VIS-2-Projekten und Aura (`url-discovery.ts`), Werttyp `string` mit Rolle `text` (`clients.<id>.mode` und `global.mode`), Werte der Einträge immer Klartext.
11. **Fastify statt Express** — eigenes Cookie-Plugin, Schema-Validierung, kleiner Fußabdruck.
12. **Boundary-Härtung** — jede externe URL/UUID/Zahl/Boolean geht durch `coerce.ts`; `javascript:`/`data:`/`file:`, Credentials und URLs über 2048 Zeichen werden abgelehnt.
13. **Auth-Flow gehärtet** — `refresh_token` wird gegen die Registry geprüft und persistiert, Access-Token laufen nach 30 min ab, Codes und Login-Flows gelten beim Einlösen 10 min (`takeFresh`), Zugangsdaten werden timing-safe verglichen.
14. **Stale-GC gegen das jüngste Display** — beim Start fällt, wer 30 Tage hinter dem zuletzt gesehenen Display liegt (gekappt auf jetzt), tokenunabhängig; nie gegen die Uhr, sonst räumt ein langer Stillstand die ganze Anlage.
15. **Legacy-Migration 1.0/1.1** — `defaultVisUrl` geht direkt nach `global.mode`/`manualUrl` mit Master an, `visUrl` wird `mode = manual`; alte Datenpunkte fallen (ohne Objekt per `delState`), alte Einstellungsschlüssel erst nach gelungener Übernahme per `{drop}`.
16. **Abschalt-Kette** — `common.supportedMessages.stopInstance` nie deklarieren; `onUnload` meldet erst nach `Promise.allSettled` über State-Write, Unsubscribes, mDNS-Goodbye und Webserver-Stopp.
17. **Ziel-Down-Karte** — die Erreichbarkeit des Weiterleitungsziels urteilt der Server (`target-health.ts`: fragt die Origin, jede HTTP-Antwort zählt, 4 s, Cache-Schlüssel bleibt die volle URL); 2× `false` → Karte, erstes `true` → `location.reload()`.
18. **Globale Client-Obergrenze** — 100 persistente Neuanlagen je Stunde über alle Adressen neben der Drossel je Adresse; darüber transient ohne Besitz; ein Adresswechsel wird höchstens einmal je Minute geschrieben, und aus `X-Forwarded-For` zählt nur eine echte IP.
19. **Namen erreichen Bestandsanlagen** — js-controller wendet `instanceObjects` bei jedem Start an, schützt aber `common.name`; `refreshInstanceObjects()` schreibt deshalb jeden Manifest-Namen (und die Beschreibung) per `extendObject`, ausgeschrieben je Id — NUR diese zwei Felder, die Form gehört dem Manifest (Prüfpaket 0.19.0).
20. **Die Reload-Entscheidung ist eine Funktion** — `decidePollAction` läuft in den Tests als Modul, als serialisierte Kopie und als Kopie aus dem gebauten Paket und wird per `toString()` in die Seite gelegt.
21. **Vor `app.close()` werden WebSockets hart beendet** — und der Server zerstört beim Schließen jeden Socket (`forceCloseConnections`); `common.stopTimeout` 2000; ein Socket-Fehler trennt nur einen OFFENEN Socket, einen, den ws selbst mit Grund schließt (1009), überlässt der eigene `errorHandler` ws.
22. **Text-Auffrischung der Client-Objekte hängt an einer Revision** — wer Name, Beschreibung, Rolle, Typ, Default oder Lese-/Schreibrecht eines Client-Objekts ändert, erhöht `CLIENT_OBJECTS_VERSION`; die Aufstiegs-Suite vergleicht auch `def`/`read`/`write`/`states` und `native`.
23. **`clients.<id>.resolvedUrl`** — read-only, die zuletzt geschickte URL, geschrieben nur bei Änderung (`setStateChangedAsync`).
24. **Listen-Port-Standard** — `native.port` (8123 fest) und `native.bind`, deklariert in `fleet.json listenPorts`; die Umbenennung `bindAddress` → `bind` läuft über den Flotten-Master `native-key-migration.ts`.
25. **Reparieren statt löschen, ein Umzug nimmt die Zuordnungen mit** — eine Reparatur ist EIN `setForeignObject`; ein echter Umzug läuft über den Flotten-Master `moveWithEnums` (Enums lesen → löschen → Nachfolger anhängen), weil das Löschen die Enums aus dem Cache zurückschreibt.
26. **Jeder gefangene Wert wird über `errText` zu Text** — Flottenform aus `CLAUDE_PATTERNS.md` (message, leer → `code`, sonst `name`, eine Ebene `cause`).
27. **Ein gescheiterter Start startet neu** — Ende mit `utils.EXIT_CODES.UNCAUGHT_EXCEPTION` (6): Neustart nach 30 s, nach drei Fehlschlägen in zehn Minuten Stopp mit Hinweis; nie 11, das js-controller 7.2.2 nie neu startet.
28. **Ein Stopp während `onReady` gewinnt** — das Feld `unloading` bricht den Start an drei Punkten ab und räumt Gestartetes ab; ein dadurch gescheiterter Start loggt nur debug und fordert keinen Neustart.
29. **Hinweise hängen nie an der Schreibreihenfolge** — „manualUrl leer“ und „global nicht auflösbar“ sind debug, weil `mode` vor `manualUrl` eine normale Reihenfolge ist.
30. **Companion-Bridge und `HA_VERSION`** — jede Seite meldet „connected“ einmal über V2 → V1 → `webkit.messageHandlers.externalBus` (als Objekt, wie das Frontend); `HA_VERSION` bleibt unter 2026.8.0, ab dort warten beide Apps auf `frontend/loaded`.
31. **Safe-Area** — Dashboard, beide Karten und die Landing-Seite bleiben über `--app-safe-area-inset-*` (statischer Vorlauf, `0px`-Rückfall) im sichtbaren Bereich; kein `env()`, kein `viewport-fit`.
32. **HTTP-Grenzen** — der Server entsteht per `serverFactory` mit `connectionTimeout`/`requestTimeout` von 30 s (Fastifys eigene `requestTimeout`-Option wirkt nicht), `forceCloseConnections: true`; HEAD legt nichts an, Monitore gehören auf `/health`.
33. **Authorize fragt vor einem fremden Ziel** — den Code bekommt ohne Rückfrage nur ein Companion-Paar oder der Host der Anfrage, sonst eine „Weiter“-Seite mit Knopf; eine Code-Flut bei `authRequired = false` ist hingenommen (die API ist dort ohnehin offen).
34. **Die WebSocket-Sitzung hängt am Refresh-Token** — wie HA core (Access-Token nur als Rückfall); nach Revoke oder `remove` endet sie, ein unangemeldeter Socket wird sofort getrennt.
35. **Beworbene Adresse** — eine gewählte Adresse wird beworben, sonst überspringt `advertisedBaseUrl` link-local, stellt Container-/VM-/VPN-Schnittstellen zurück und klammert IPv6; ohne gewählte Adresse prüft mDNS die Adresse jede Minute und kündigt bei einem Wechsel neu an.
36. **Die gewählte Adresse ist die einzige** — Lauschen, mDNS-Schnittstelle, Zielprüfung und Rückwärtsauflösung laufen über sie (Flotten-Master `network-address.ts`); trägt der Host sie nicht, alle Adressen mit genau einer Warnung; ein Gegenüber außerhalb der eigenen Netze bekommt `403` ohne Inhalt, auch bei vertrauenswürdigem Proxy zählt der Socket, nie `X-Forwarded-For`.
37. **Was hassemu je Display erzeugt oder mitschreibt, steht im Datenordner** — Cookie, Access-/Refresh-Token, Ablauf und `lastSeen` in `identities.json` (`common.dataFolder`), nicht im `native` des Geräteobjekts; ein früherer Stand wird einmal aus dem Geräte-`native` übernommen und fällt dort erst, wenn die Datei ihn hält; eine unlesbare Datei lässt den Start scheitern, ohne ein Display anzufassen (wie DD 2).

## Auth-Flow

1. Display macht GET `/` → Cookie wird gesetzt (neuer Client) oder erkannt (bekannter Client)
2. POST `/auth/login_flow` → `flow_id`, Session an clientId gebunden (sessions-Map FIFO-capped 100)
3. POST `/auth/login_flow/:flowId` → Credentials (timing-safe geprüft) → `authorization_code`
4. POST `/auth/token` mit `grant_type=authorization_code` → Access Token + Refresh Token. Beide werden am Client-Record persistiert (`identities.json` im Datenordner, DD 37; in `registry.byToken`/`byRefreshToken` indiziert), Persist VOR Response-Build — eine nicht schreibbare Datei lässt den Grant scheitern. Access Token trägt `tokenExpiresAt` (30 min).
5. POST `/auth/token` mit `grant_type=refresh_token` → Refresh Token wird in `registry.byRefreshToken` gelookupped; unbekannt → 400 invalid_grant; bekannt → neuer Access Token (Refresh Token bleibt, keine Rotation — Companion-Kompat).
6. GET `/` → Resolver-Reihenfolge (kein Master-Branch — der Master-Switch wird beim Toggle in `bulkSetMode` umgesetzt):
   1. `clients.<id>.mode = 'global'` → delegate `global.mode` (`'manual'` → `global.manualUrl`; URL → URL)
   2. `clients.<id>.mode = 'manual'` → `clients.<id>.manualUrl`
   3. `clients.<id>.mode = <URL>` → diese URL
   4. sonst → 200 HTML mit der Landing-Seite

## Tests

**Objekt-Inventar in der CI (seit 2026-09-15, Gate-Job `adapter-inventory`, seit 1.46.0 rot bei veraltetem `test/objects.inventory.json`):** `test/inventory.js` läuft bei jedem Push auf dem ubuntu-Runner. Fünf Fixture-Displays (`test/fixtures/inventory/displays.json`) kommen je von einer eigenen Adresse aus 192.0.2.0/24 (`X-Forwarded-For`, `trustProxy` an) — Auto-Name nach Adresse und nach PTR, Modus global/manual/`---`/direkte URL, eins mit Anmeldung; dazu ein 1.x-Display als `channel` mit `visUrl` und die Umgebung einer echten Anlage (web, VIS-2-Projekt mit View, aura mit `customUrl`, admin mit `%bind%`), sodass das Dropdown im Inventar steht. `test/inventory-dns-hook.cjs` (per `NODE_OPTIONS=--require` im Adapterprozess) beantwortet jede Rückwärtsauflösung aus `INVENTORY_PTR`, alles andere wie ohne PTR-Eintrag — der Runner löst sonst selbst auf, asynchron nach dem Abzug. Der Abzug wartet auf die Umbenennung und darauf (`waitForStableTree`), dass der Objektsatz 4×250 ms nicht mehr wächst. Die Aufstiegs-Suite sät das Vorgänger-Inventar samt `.ip`-Wert (sonst gilt der alte Name als Hostname) und prüft den Wächter nur für Displays, die der Vorgänger hatte.

**Broker-Attrappe (seit 1.46.0):** `test/unit/broker-stub.ts` bildet `extendObject` (`brokerExtend`: tief, Arrays indexweise, `preserve`, vorher geleerte Listen) und `delObject` (`brokerDelObject`: nur Vorhandenes, State nur bei `type: state`) wie js-controller 7.2.2 nach — die Test-Attrappen mischten vorher flach und machten den Dropdown-Schutz unmessbar.

Tests leben seit v1.1.6 neben dem Source als `src/lib/*.test.ts` und laufen direkt via **vitest** (seit v1.32.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller). Seit v1.35.2 mit ehrlicher Coverage (`coverage.include: src/**` — main.ts inkludiert).
