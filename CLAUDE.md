# CLAUDE.md — ioBroker.hassemu

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HASS Emulator** — Emuliert minimalen HA-Server für Shelly Wall Displays → Redirect zu VIS Dashboard.

- **Version:** 1.0.0 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.hassemu
- **npm:** https://www.npmjs.com/package/iobroker.hassemu
- **Vorher:** homeassistant-bridge (umbenannt wegen irreführendem Namen)
- **Runtime-Deps:** `@iobroker/adapter-core`, `express` (v5), `bonjour-service`

## Shelly Wall Display — Limitationen

| Aspekt | Shelly Verhalten |
|--------|------------------|
| Protokoll | **Nur HTTP** — kein HTTPS für HA-Verbindungen |
| Discovery | mDNS (`_home-assistant._tcp`) oder manuelle IP |
| Auth | Erwartet vollständigen HA OAuth2-Flow |
| Nach Auth | Folgt 302 Redirects nativ im WebView |

## Architektur

```
src/main.ts              → Adapter (Lifecycle, UUID-Generierung)
src/lib/types.ts         → Interfaces
src/lib/constants.ts     → HA_VERSION, SESSION_TTL, LOGIN_SCHEMA
src/lib/webserver.ts     → Express 5 HTTP Server + HA API Emulation
src/lib/mdns.ts          → mDNS Broadcasting via bonjour-service
```

## Design-Entscheidungen

1. **Minimale Komplexität** — nur emulieren was Shelly braucht
2. **Shared UUID** — eine UUID in main.ts, an WebServer + mDNS durchgereicht
3. **Port 8123 fix** — Shelly-Anforderung, nicht konfigurierbar
4. **mDNS kontinuierlich** — Broadcasting solange Adapter läuft (Shelly muss jederzeit finden können)
5. **Kein HTTPS** — Shelly unterstützt es nicht für HA
6. **Kein Rate Limiting** — nur Redirects, keine schützenswerten Daten

## Auth-Flow

1. POST `/auth/login_flow` → `flow_id`
2. POST `/auth/login_flow/:flowId` → Credentials → `authorization_code`
3. POST `/auth/token` → Code → Access Token
4. GET `/` → 302 Redirect zu visUrl

## Tests (108)

```
test/testConstants.ts    → Shared Constants (10)
test/testMdns.ts         → mDNS Lifecycle (14)
test/testWebServer.ts    → HTTP Endpoints, Auth, Sessions (27)
test/package.js          → @iobroker/testing Package-Tests (57)
test/integration.js      → @iobroker/testing Integration-Tests (plain JS)
```

## Versionshistorie

| Version | Highlights |
|---------|------------|
| 1.0.0 | Umbenannt von homeassistant-bridge zu hassemu |
| 0.9.3 | Review-Fixes: Standard-Tests (plain JS), CHANGELOG.md entfernt |
| 0.9.2 | Kompakter Startup-Log, mDNS/WebServer Detail-Logs auf debug |
| 0.9.1 | Shared UUID (WebServer + mDNS konsistent), cleanup redundante Scripts |
| 0.9.0 | mDNS: Avahi durch bonjour-service ersetzt (cross-platform) |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
