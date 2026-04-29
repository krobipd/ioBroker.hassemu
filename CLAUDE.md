# CLAUDE.md — ioBroker.hassemu

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HASS Emulator** — emuliert einen minimalen HA-Server für Geräte, die ein HA-Dashboard erwarten → leitet auf beliebige URL um.

- **Version:** 1.2.0 (in progress — Datenmodell-Rework: visUrl → mode/manualUrl + Master-Switch + Sicherheits-Härtung)
- **GitHub:** https://github.com/krobipd/ioBroker.hassemu
- **npm:** https://www.npmjs.com/package/iobroker.hassemu
- **Repository PR:** ioBroker/ioBroker.repositories#5793
- **Vorher:** homeassistant-bridge (umbenannt wegen irreführendem Namen)
- **Runtime-Deps:** `@iobroker/adapter-core`, `fastify`, `@fastify/cookie`, `bonjour-service`
- **Adapter-Abhängigkeit:** `web` (deklariert als globalDependency in io-package.json) — Audit hält Version auf latest-stable. Ohne web läuft die URL-Discovery leer (Dropdown bleibt leer).
- **Test-Setup:** offizieller ioBroker.example/TypeScript-Standard — Tests unter `src/lib/*.test.ts` direkt mit `ts-node/register`
- **`@types/node` an `engines.node`-Min gekoppelt:** `^20.x` weil `engines.node: ">=20"`

## HA-kompatible Geräte — Limitationen

| Aspekt     | Typisches Verhalten                                  |
| ---------- | ---------------------------------------------------- |
| Protokoll  | **Nur HTTP** — kein HTTPS für HA-Verbindungen        |
| Discovery  | mDNS (`_home-assistant._tcp`) oder manuelle IP       |
| Auth       | Erwartet vollständigen HA OAuth2-Flow                |
| Nach Auth  | Folgt 302-Redirects nativ im WebView                 |

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Migration, State-Dispatch, Master-Switch, Stale-GC)
src/lib/types.ts             → AdapterConfig, ClientRecord (mode + manualUrl), AdapterInterface
src/lib/constants.ts         → HA_VERSION, SESSION_TTL, LOGIN_SCHEMA
src/lib/coerce.ts            → Boundary-Validator (UUID/URL/Number/String/Boolean)
src/lib/network.ts           → getLocalIp, generateClientId (crypto.randomBytes), Bind-Helpers
src/lib/mdns.ts              → mDNS Broadcasting via bonjour-service
src/lib/client-registry.ts   → Multi-Client-Store (Cookie → Record), bulkSetMode, NewClientModeProvider, lastSeen-Tracking
src/lib/global-config.ts     → global.mode + global.manualUrl + global.enabled, MODE_GLOBAL/MODE_MANUAL Sentinels, Resolver-Delegate
src/lib/url-discovery.ts     → Sammelt VIS/VIS-2/Admin-URLs, getFirstDiscoveredUrl
src/lib/landing-page.ts      → Minimales HTML für Displays ohne konfigurierte URL (keine Anleitung — siehe README)
src/lib/webserver.ts         → Fastify HTTP Server + HA API Emulation + Cookie-Handling + Sessions/RefreshToken-Caps + timing-safe Credentials
```

## Design-Entscheidungen

1. **Minimale Komplexität** — nur das emulieren, was HA-Clients tatsächlich abfragen
2. **Shared UUID** — eine UUID in main.ts, an WebServer und mDNS durchgereicht
3. **Port 8123 fix** — HA-Standard, nicht konfigurierbar
4. **Kein HTTPS** — HA-Clients erwarten HTTP auf Port 8123
5. **Cookie-Identifikation** — `hassemu_client` (UUID v4, 10 Jahre, HttpOnly, SameSite=Lax). Browser senden den Cookie automatisch auf jeder Navigation; Tokens kommen nur per API-Header und reichen daher zur Identifikation nicht aus.
6. **Per-Client mode + manualUrl** (seit v1.2.0) — eigener Channel `clients.<id>` mit `mode` (Dropdown: discovered URLs + `'global'` + `'manual'`), `manualUrl` (Freitext, role:url), `ip`, `remove`. Hostname lebt in `common.name` des Channels — kein eigener Datenpunkt.
7. **Master-Switch via Bulk-Sync** (seit v1.2.0) — `global.enabled` triggert kein Resolver-Pfad mehr, sondern `bulkSetMode` auf der Registry: `true` → alle clients `mode='global'`; `false` → erste discovered URL (oder `'manual'`). `applyMasterSwitch` in main.ts. Resolver bleibt clean ohne Master-Branch.
8. **Resolver-Delegate** — `client.mode='global'` → `resolveGlobalMode()`. `'manual'` → `record.manualUrl`. URL-string → diese URL. Sonst → null = landing-page. `global.mode` darf NICHT `'global'` sein (self-referential, von handleModeWrite rejected).
9. **Landing-Seite statt Fehler** — ist keine URL gesetzt, liefert der Server ein kleines HTML (`landing-page.ts`) mit der Device-ID und dem Datenpunkt-Pfad. Display refresht alle 15 s automatisch. Anleitungs-Inhalt lebt in der README, nicht hier.
10. **Mode-Dropdown** — `common.states` auf `global.mode` (URLs + `'manual'`) UND `clients.<id>.mode` (URLs + `'global'` + `'manual'`). Werte aus Intro-Tiles (`localLinks`, `welcomeScreen`, `welcomeScreenPro`) und VIS/VIS-2-Projekten via `url-discovery.ts`. `type:'mixed'` future-proofs gegen js-controller strict-type-cast (govee-smart v1.11.0 Pattern).
11. **Fastify statt Express** — First-party Cookie-Plugin, Schema-Validierung, leichterer Runtime-Fußabdruck.
12. **Boundary-Härtung** — jede externe URL / UUID / Zahl / Boolean geht durch `coerce.ts`. Unsichere URLs (js:, data:, file:, mit Credentials, >2048 Zeichen) werden abgelehnt.
13. **Sicherheits-Härtung Auth-Flow** (seit v1.2.0) — refresh_token wird gegen `webserver.refreshTokens`-Map validiert (vorher: jeder String akzeptiert). Sessions-Map und refreshTokens-Map FIFO-capped. Credential-Vergleich via `crypto.timingSafeEqual` (gegen Timing-Attacks).
14. **Stale-Client-GC** (seit v1.2.0) — bei jedem `identifyOrCreate`-Hit wird `native.lastSeen` throttled (1×/h) aktualisiert. Beim Adapter-Start: clients ohne Token + `lastSeen` älter als 30 Tagen werden auto-removed.
15. **Migration 1.x → 1.2.0** — `migrateLegacyDefaultVisUrl` (1.0.x → 1.1.1) bleibt; neu `migrateVisUrlToMode` mappt `clients.<id>.visUrl` → `mode='manual'` + `manualUrl`, plus `global.visUrl` analog. Alte Datapunkte per `delObjectAsync` weg, mode-Type-Upgrade auf `'mixed'` via `extendObjectAsync`.

## Auth-Flow

1. Display macht GET `/` → Cookie wird gesetzt (neuer Client) oder erkannt (bekannter Client)
2. POST `/auth/login_flow` → `flow_id`, Session an clientId gebunden (sessions-Map FIFO-capped 100)
3. POST `/auth/login_flow/:flowId` → Credentials (timing-safe geprüft) → `authorization_code`
4. POST `/auth/token` mit `grant_type=authorization_code` → Access Token + Refresh Token. Refresh Token wird in `webserver.refreshTokens` gespeichert (FIFO-capped 200), Access Token am Client-Record persistiert.
5. POST `/auth/token` mit `grant_type=refresh_token` → Refresh Token wird in der Map gelookupped; unbekannt → 400 invalid_grant; bekannt → neuer Access Token wird ausgestellt.
6. GET `/` → Resolver-Reihenfolge (kein Master-Branch — der Master-Switch wird beim Toggle in `bulkSetMode` umgesetzt):
   1. `clients.<id>.mode = 'global'` → delegate `global.mode` (`'manual'` → `global.manualUrl`; URL → URL)
   2. `clients.<id>.mode = 'manual'` → `clients.<id>.manualUrl`
   3. `clients.<id>.mode = <URL>` → diese URL
   4. sonst → 200 HTML mit der Landing-Seite

## Tests (215 + 57 package)

```
test/testConstants.ts         → Shared Constants
test/testCoerce.ts            → Boundary-Validator
test/testMdns.ts              → mDNS Lifecycle
test/testUrlDiscovery.ts      → URL Discovery (Intro-Tiles + VIS-Projekte)
test/testClientRegistry.ts    → Multi-Client Registry
test/testGlobalConfig.ts      → global.visUrl + global.enabled Handler
test/testWebServer.ts         → HTTP-Endpoints, Cookie-Flow, Setup-Page, Global-Override
test/package.js               → @iobroker/testing Package-Tests
test/integration.js           → @iobroker/testing Integration-Tests
```

## Versionshistorie

| Version | Highlights                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------- |
| 1.1.4 | tsconfig.test.json → outDir `./build-test` (verhindert `build/src`+`build/test` Duplikate im veröffentlichten Paket), prebuild:test + .gitignore + eslint-ignore. Kein Runtime-Change. |
| 1.1.3   | Race-Fix: parallele cookieless Requests desselben Displays landen bei einem Client (Pending-Lock per IP). Setup-Seite neu: grünes OK-Banner, Dark-Mode, i18n in allen 11 Adapter-Sprachen via `system.config.language` |
| 1.1.2   | Hostname als Channel-Name (kein eigener Datenpunkt mehr), createObjects parallelisiert, Legacy-Migration |
| 1.1.1   | Redirect-URL raus aus Admin → global.visUrl/enabled + Setup-Seite, web als Dependency                |
| 1.1.0   | Multi-Client, Cookie-Identifikation, visUrl-Dropdown, Fastify, Boundary-Härtung, Config-Migration    |
| 1.0.4   | DRY: NativeConfig + Config-Mapping entfernt, Log-Spam-Fix, createSession private                     |
| 1.0.3   | Unused Deps entfernt, no-floating-promises, CI checkout entfernt                                     |
| 1.0.2   | build/ aus Git entfernt, .gitignore fix, Keywords bereinigt                                          |
| 1.0.0   | Umbenannt von homeassistant-bridge zu hassemu                                                        |
| 0.9.3   | Review-Fixes: Standard-Tests (plain JS), CHANGELOG.md entfernt                                       |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
