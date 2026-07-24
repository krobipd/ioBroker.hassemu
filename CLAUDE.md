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

| Aspekt    | Typisches Verhalten                            |
| --------- | ---------------------------------------------- |
| Protokoll | **Nur HTTP** — kein HTTPS für HA-Verbindungen  |
| Discovery | mDNS (`_home-assistant._tcp`) oder manuelle IP |
| Auth      | Erwartet vollständigen HA OAuth2-Flow          |
| Nach Auth | Folgt 302-Redirects nativ im WebView           |

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Migration, State-Dispatch, Master-Switch, Stale-GC)
src/lib/types.ts             → AdapterConfig, ClientRecord, SessionData, AdapterInterface
src/lib/constants.ts         → HA_VERSION, TTLs/Caps, DEFAULT_SERVICE_NAME, DNS/WS-Windows, LOGIN_SCHEMA, MODE_-Sentinels
src/lib/coerce.ts            → Boundary-Validator (UUID/URL/Number/String/Boolean) + shared helpers (evictOldest, oneLine, shallowStatesEqual, isValidRedirectUri, isEmptyValue)
src/lib/network.ts           → getLocalIp, generateClientId (crypto.randomBytes), Bind-Helpers, resolveAdvertisedHost
src/lib/mdns.ts              → mDNS Broadcasting via bonjour-service
src/lib/client-registry.ts   → Multi-Client-Store (Cookie → Record), bulkSetMode, updateHostname, NewClientModeProvider, lastSeen-Tracking, per-IP-Throttle
src/lib/global-config.ts     → global.mode + global.manualUrl + global.enabled, MODE_GLOBAL/MODE_MANUAL Sentinels, Resolver-Delegate
src/lib/schema-repair.ts     → repairGlobalSchemas (partial-formed global.*-Objekte aus io-package.json:instanceObjects heilen)
src/lib/legacy-migration.ts  → pre-1.2.0 visUrl → mode/manualUrl Upgrade-Migrationen (I10 v1.37.0, aus main.ts extrahiert, isoliert testbar)
src/lib/url-discovery.ts     → Sammelt VIS/VIS-2/Aura/Admin-URLs (collect → mode-Dropdown)
src/lib/webserver.ts         → Fastify HTTP Server + HA API Emulation + Cookie-Handling + Sessions-Caps + timing-safe Credentials + WS + route-config-Auth-Guard
src/lib/auth-page.ts         → OAuth2-Browser-Flow HTML (Login-Form, Auto-Submit-Redirect, Error-Page)
src/lib/landing-page.ts      → Minimales HTML für Displays ohne konfigurierte URL (keine Anleitung — siehe README)
src/lib/redirect-wrapper.ts  → iframe-Wrapper + 30s-Poll-Reload + Down-Page
src/lib/html-shared.ts       → escapeHtml, jsStringLiteral, renderIpRow/renderIdRow, htmlLangFor, SUPPORTED_LANGS
src/lib/external-bridge.ts   → CONNECTION_STATUS_SCRIPT (HA-Companion-WebView connection-status Bridge)
src/lib/i18n.ts              → tName, resolveLabel, tPage, makePageTranslator: type-safe I18n wrapper (keys from admin/i18n/en.json)
../scripts/sync-iopackage-from-i18n.py → hält io-package.json:instanceObjects synchron mit admin/i18n (zentral)
```

## Design-Entscheidungen

1. **Minimale Komplexität** — nur das emulieren, was HA-Clients tatsächlich abfragen
2. **Shared UUID** — eine UUID in main.ts, an WebServer und mDNS durchgereicht
3. **Port 8123 fix** — HA-Standard, nicht konfigurierbar
4. **Kein HTTPS** — HA-Clients erwarten HTTP auf Port 8123
5. **Cookie-Identifikation** — `hassemu_client` (UUID v4, 10 Jahre, HttpOnly, SameSite=Lax). Browser senden den Cookie automatisch auf jeder Navigation; Tokens kommen nur per API-Header und reichen daher zur Identifikation nicht aus.
6. **Per-Client mode + manualUrl** (seit v1.2.0) — eigener Channel `clients.<id>` mit `mode` (Dropdown: discovered URLs + `'global'` + `'manual'`), `manualUrl` (Freitext, role:url), `ip`, `remove`. Hostname lebt in `common.name` des Channels — kein eigener Datenpunkt.
7. **Master-Switch via Bulk-Sync** (seit v1.2.0) — `global.enabled` triggert kein Resolver-Pfad mehr, sondern `bulkSetMode` auf der Registry: `true` → alle clients `mode='global'`; `false` → alle clients `'0'` (no-choice → Landing-Page, seit v1.26.0; vorher erste discovered URL). `applyMasterSwitch` in main.ts. Resolver bleibt clean ohne Master-Branch.
8. **Resolver-Delegate** — `client.mode='global'` → `resolveGlobalMode()`. `'manual'` → `record.manualUrl`. URL-string → diese URL. Sonst → null = landing-page. `global.mode` darf NICHT `'global'` sein (self-referential, von handleModeWrite rejected).
9. **Landing-Seite statt Fehler** — ist keine URL gesetzt, liefert der Server ein kleines HTML (`landing-page.ts`) mit der Device-ID und dem Datenpunkt-Pfad. Display refresht alle 15 s automatisch. Anleitungs-Inhalt lebt in der README, nicht hier.
10. **Mode-Dropdown** — `common.states` auf `global.mode` (URLs + `'manual'`) UND `clients.<id>.mode` (URLs + `'global'` + `'manual'`). Werte aus Intro-Tiles (`localLinks`, `welcomeScreen`, `welcomeScreenPro`) und VIS/VIS-2-Projekten via `url-discovery.ts`. `type:'mixed'` future-proofs gegen js-controller strict-type-cast (govee-smart v1.11.0 Pattern).
11. **Fastify statt Express** — First-party Cookie-Plugin, Schema-Validierung, leichterer Runtime-Fußabdruck.
12. **Boundary-Härtung** — jede externe URL / UUID / Zahl / Boolean geht durch `coerce.ts`. Unsichere URLs (js:, data:, file:, mit Credentials, >2048 Zeichen) werden abgelehnt.
13. **Sicherheits-Härtung Auth-Flow** — refresh_token wird gegen `registry.byRefreshToken` validiert (vorher: jeder String akzeptiert) und in `clients.<id>.native.refreshToken` persistiert (langlebig, Companion bleibt über Restart authentifiziert; die frühere `webserver.refreshTokens`-Map ist seit v1.31.0 weg). Access-Token laufen nach 30 min ab (`tokenExpiresAt`, persistiert + in `getByToken`/`restore` erzwungen, v1.36.0 S5). `sessions`/`codeSessions`-Maps FIFO-capped (S2-Split). Credential-Vergleich via `crypto.timingSafeEqual` (gegen Timing-Attacks); leeres Passwort wird abgelehnt.
14. **Stale-Client-GC** (seit v1.2.0) — bei jedem `identifyOrCreate`-Hit wird `native.lastSeen` throttled (1×/h) aktualisiert. Beim Adapter-Start: clients ohne Token + `lastSeen` älter als 30 Tagen werden auto-removed.
15. **Migration 1.x → 1.2.0** — `migrateLegacyDefaultVisUrl` (1.0.x → 1.1.1) bleibt; neu `migrateVisUrlToMode` mappt `clients.<id>.visUrl` → `mode='manual'` + `manualUrl`, plus `global.visUrl` analog. Alte Datapunkte per `delObjectAsync` weg, mode-Type-Upgrade auf `'mixed'` via `extendObjectAsync`.

## Auth-Flow

1. Display macht GET `/` → Cookie wird gesetzt (neuer Client) oder erkannt (bekannter Client)
2. POST `/auth/login_flow` → `flow_id`, Session an clientId gebunden (sessions-Map FIFO-capped 100)
3. POST `/auth/login_flow/:flowId` → Credentials (timing-safe geprüft) → `authorization_code`
4. POST `/auth/token` mit `grant_type=authorization_code` → Access Token + Refresh Token. Beide werden am Client-Record persistiert (`clients.<id>.native.token`/`refreshToken`, in `registry.byToken`/`byRefreshToken` indiziert), Persist VOR Response-Build. Access Token trägt `tokenExpiresAt` (30 min).
5. POST `/auth/token` mit `grant_type=refresh_token` → Refresh Token wird in `registry.byRefreshToken` gelookupped; unbekannt → 400 invalid_grant; bekannt → neuer Access Token (Refresh Token bleibt, keine Rotation — Companion-Kompat).
6. GET `/` → Resolver-Reihenfolge (kein Master-Branch — der Master-Switch wird beim Toggle in `bulkSetMode` umgesetzt):
   1. `clients.<id>.mode = 'global'` → delegate `global.mode` (`'manual'` → `global.manualUrl`; URL → URL)
   2. `clients.<id>.mode = 'manual'` → `clients.<id>.manualUrl`
   3. `clients.<id>.mode = <URL>` → diese URL
   4. sonst → 200 HTML mit der Landing-Seite

## Tests (592 unit + 57 package + 1 integration = 650)

Tests leben seit v1.1.6 neben dem Source als `src/lib/*.test.ts` und laufen direkt via **vitest** (seit v1.32.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller). Seit v1.35.2 mit ehrlicher Coverage (`coverage.include: src/**` — main.ts inkludiert).

## Befehle

```bash
npm run build        # Production (esbuild via @iobroker/adapter-dev)
npm run check        # tsc --noEmit type-check
npm test             # vitest run + mocha package tests
npm run test:unit    # vitest run (der Alias, den die CI-testing-action triggert)
npm run coverage     # vitest --coverage
npm run lint         # ESLint + Prettier
```
