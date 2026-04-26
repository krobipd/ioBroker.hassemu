# CLAUDE.md — ioBroker.hassemu

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HASS Emulator** — emuliert einen minimalen HA-Server für Geräte, die ein HA-Dashboard erwarten → leitet auf beliebige URL um.

- **Version:** 1.1.5 (2026-04-26 — process.on defense + Konsistenz-Cleanup + js-controller >=6.0.11)
- **GitHub:** https://github.com/krobipd/ioBroker.hassemu
- **npm:** https://www.npmjs.com/package/iobroker.hassemu
- **Repository PR:** ioBroker/ioBroker.repositories#5793
- **Vorher:** homeassistant-bridge (umbenannt wegen irreführendem Namen)
- **Runtime-Deps:** `@iobroker/adapter-core`, `fastify`, `@fastify/cookie`, `bonjour-service`
- **Adapter-Abhängigkeit:** `web >=6.0.0` (dependencies in io-package.json) — ohne web kein VIS

## HA-kompatible Geräte — Limitationen

| Aspekt     | Typisches Verhalten                                  |
| ---------- | ---------------------------------------------------- |
| Protokoll  | **Nur HTTP** — kein HTTPS für HA-Verbindungen        |
| Discovery  | mDNS (`_home-assistant._tcp`) oder manuelle IP       |
| Auth       | Erwartet vollständigen HA OAuth2-Flow                |
| Nach Auth  | Folgt 302-Redirects nativ im WebView                 |

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Legacy-Migration, State-Dispatch)
src/lib/types.ts             → AdapterConfig, ClientRecord, AdapterInterface
src/lib/constants.ts         → HA_VERSION, SESSION_TTL, LOGIN_SCHEMA
src/lib/coerce.ts            → Boundary-Validator (UUID/URL/Number/String/Boolean)
src/lib/network.ts           → getLocalIp, generateClientId, Bind-Helpers
src/lib/mdns.ts              → mDNS Broadcasting via bonjour-service
src/lib/client-registry.ts   → Multi-Client-Store (Cookie → Record, ioBroker-Objekte)
src/lib/global-config.ts     → global.visUrl + global.enabled (Override-Schalter)
src/lib/url-discovery.ts     → Sammelt VIS/VIS-2/Admin-URLs für visUrl-Dropdown
src/lib/setup-page.ts        → Minimales HTML für Displays ohne konfigurierte URL
src/lib/webserver.ts         → Fastify HTTP Server + HA API Emulation + Cookie-Handling
```

## Design-Entscheidungen

1. **Minimale Komplexität** — nur das emulieren, was HA-Clients tatsächlich abfragen
2. **Shared UUID** — eine UUID in main.ts, an WebServer und mDNS durchgereicht
3. **Port 8123 fix** — HA-Standard, nicht konfigurierbar
4. **Kein HTTPS** — HA-Clients erwarten HTTP auf Port 8123
5. **Cookie-Identifikation** — `hassemu_client` (UUID v4, 10 Jahre, HttpOnly, SameSite=Lax). Browser senden den Cookie automatisch auf jeder Navigation; Tokens kommen nur per API-Header und reichen daher zur Identifikation nicht aus.
6. **Per-Client visUrl** — eigener Channel `clients.<id>` mit `visUrl`, `ip`, `remove`. Hostname lebt in `common.name` des Channels (sichtbar als Client-Name im Objektbrowser) — kein eigener Datenpunkt. `remove` = vergessen (kein Blocklist — ein zurückkehrender Client wird neu registriert).
7. **Global-Override via Datenpunkt** — `global.visUrl` + `global.enabled`. Ist `enabled=true`, wird jede Verbindung zur globalen URL gelenkt; sonst greift die Client-URL. Umgesetzt in `global-config.ts`.
8. **Setup-Seite statt Fehler** — ist keine URL gesetzt, liefert der Server ein kleines HTML (`setup-page.ts`) mit der Device-ID und dem Datenpunkt-Pfad. Display refresht alle 15 s automatisch.
9. **visUrl-Dropdown** — `common.states` auf `global.visUrl` UND jedem `clients.<id>.visUrl`. Werte aus Intro-Tiles (`localLinks`, `welcomeScreen`, `welcomeScreenPro`) und VIS/VIS-2-Projekten. Freitext bleibt möglich.
10. **Fastify statt Express** — First-party Cookie-Plugin, Schema-Validierung, leichterer Runtime-Fußabdruck.
11. **Boundary-Härtung** — jede externe URL / UUID / Zahl / Boolean geht durch `coerce.ts`. Unsichere URLs (js:, data:, file:, mit Credentials, >2048 Zeichen) werden abgelehnt.
12. **Legacy-Migration** — `visUrl` / `defaultVisUrl` aus nativer Config wandern beim ersten Start nach `global.visUrl` + `global.enabled=true`; danach sind die alten Felder weg.

## Auth-Flow

1. Display macht GET `/` → Cookie wird gesetzt (neuer Client) oder erkannt (bekannter Client)
2. POST `/auth/login_flow` → `flow_id`, Session an clientId gebunden
3. POST `/auth/login_flow/:flowId` → Credentials → `authorization_code`
4. POST `/auth/token` → Code → Access Token, wird am Client-Record persistiert
5. GET `/` → Redirect-Reihenfolge:
   1. `global.enabled=true` → 302 auf `global.visUrl`
   2. sonst 302 auf `clients.<id>.visUrl`
   3. sonst 200 HTML mit der Setup-Seite

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
