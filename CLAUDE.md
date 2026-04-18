# CLAUDE.md — ioBroker.hassemu

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HASS Emulator** — emuliert einen minimalen HA-Server für Geräte, die ein HA-Dashboard erwarten → leitet auf beliebige URL um.

- **Version:** 1.1.0 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.hassemu
- **npm:** https://www.npmjs.com/package/iobroker.hassemu
- **Repository PR:** ioBroker/ioBroker.repositories#5793
- **Vorher:** homeassistant-bridge (umbenannt wegen irreführendem Namen)
- **Runtime-Deps:** `@iobroker/adapter-core`, `fastify`, `@fastify/cookie`, `bonjour-service`

## HA-kompatible Geräte — Limitationen

| Aspekt     | Typisches Verhalten                                  |
| ---------- | ---------------------------------------------------- |
| Protokoll  | **Nur HTTP** — kein HTTPS für HA-Verbindungen        |
| Discovery  | mDNS (`_home-assistant._tcp`) oder manuelle IP       |
| Auth       | Erwartet vollständigen HA OAuth2-Flow                |
| Nach Auth  | Folgt 302-Redirects nativ im WebView                 |

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Config-Migration, State-Hooks)
src/lib/types.ts             → AdapterConfig, ClientRecord, AdapterInterface
src/lib/constants.ts         → HA_VERSION, SESSION_TTL, LOGIN_SCHEMA
src/lib/coerce.ts            → Boundary-Validator (UUID/URL/Number/String)
src/lib/network.ts           → getLocalIp, generateClientId, Bind-Helpers
src/lib/mdns.ts              → mDNS Broadcasting via bonjour-service
src/lib/client-registry.ts   → Multi-Client-Store (Cookie → Record, ioBroker-Objekte)
src/lib/url-discovery.ts     → Sammelt VIS/VIS-2/Admin-URLs für visUrl-Dropdown
src/lib/webserver.ts         → Fastify HTTP Server + HA API Emulation + Cookie-Handling
```

## Design-Entscheidungen

1. **Minimale Komplexität** — nur das emulieren, was HA-Clients tatsächlich abfragen
2. **Shared UUID** — eine UUID in main.ts, an WebServer und mDNS durchgereicht
3. **Port 8123 fix** — HA-Standard, nicht konfigurierbar
4. **Kein HTTPS** — HA-Clients erwarten HTTP auf Port 8123
5. **Cookie-Identifikation** — `hassemu_client` (UUID v4, 10 Jahre, HttpOnly, SameSite=Lax). Browser senden den Cookie automatisch auf jeder Navigation; Tokens kommen nur per API-Header und reichen daher zur Identifikation nicht aus.
6. **Per-Client visUrl** — eigener Channel `clients.<id>` mit `visUrl`, `ip`, `hostname`, `remove`. `remove` = vergessen (kein Blocklist — ein zurückkehrender Client wird neu registriert).
7. **visUrl-Dropdown** — `common.states` auf dem visUrl-Datenpunkt. Werte werden aus Intro-Tiles (`localLinks`, `welcomeScreen`, `welcomeScreenPro`) und VIS/VIS-2-Projekten zusammengestellt. Freitext bleibt möglich.
8. **Fastify statt Express** — First-party Cookie-Plugin, Schema-Validierung, leichterer Runtime-Fußabdruck.
9. **Boundary-Härtung** — jede externe URL / UUID / Zahl geht durch `coerce.ts`. Unsichere URLs (js:, data:, file:, mit Credentials, >2048 Zeichen) werden abgelehnt.
10. **Config-Migration** — `visUrl` → `defaultVisUrl` passiert automatisch in `onReady`, die Instanz bleibt dafür nicht stehen.

## Auth-Flow

1. Display macht GET `/` → Cookie wird gesetzt (neuer Client) oder erkannt (bekannter Client)
2. POST `/auth/login_flow` → `flow_id`, Session an clientId gebunden
3. POST `/auth/login_flow/:flowId` → Credentials → `authorization_code`
4. POST `/auth/token` → Code → Access Token, wird am Client-Record persistiert
5. GET `/` → 302-Redirect auf `clients.<id>.visUrl` (oder `defaultVisUrl`)

## Tests (181)

```
test/testConstants.ts         → Shared Constants
test/testCoerce.ts            → Boundary-Validator
test/testMdns.ts              → mDNS Lifecycle
test/testUrlDiscovery.ts      → URL Discovery (Intro-Tiles + VIS-Projekte)
test/testClientRegistry.ts    → Multi-Client Registry
test/testWebServer.ts         → HTTP-Endpoints, Cookie-Flow, Multi-Client via app.inject()
test/package.js               → @iobroker/testing Package-Tests
test/integration.js           → @iobroker/testing Integration-Tests
```

## Versionshistorie

| Version | Highlights                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------- |
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
