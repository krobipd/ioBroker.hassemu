# Older Changes

## 0.8.11 (2026-03-28)
- Add error middleware for malformed JSON requests (returns 400 instead of 500)

## 0.8.10 (2026-03-28)
- Consistent admin UI i18n keys (supportHeader)
- Add PayPal to FUNDING.yml

## 0.8.9 (2026-03-28)
- Use adapter timer methods (setInterval/clearInterval) instead of native timers
- Add Windows and macOS to CI test matrix
- README: standard license format with full MIT text
- Split old changelog entries into CHANGELOG_OLD.md

## 0.8.8 (2026-03-25)
- Simplified admin UI from tabs to single page layout
- Fixed onUnload to be synchronous (prevents SIGKILL on shutdown)
- Removed broken Ko-fi icon from donation button
- Added translate script

## v0.6.2 — JSDoc Documentation (15. März 2026)

### Verbesserungen

- **JSDoc-Dokumentation**: Vollständige JSDoc-Kommentare für alle TypeScript-Interfaces, Klassen und Methoden
- ESLint läuft jetzt ohne Warnungen (0 Errors, 0 Warnings)

---

## v0.6.1 — GitHub Actions (15. März 2026)

### Neue Features

- **GitHub Actions CI**: Automatische Tests für Node.js 20, 22, 24
- **GitHub Actions Release**: Automatische Release-Erstellung bei Tag-Push

---

## v0.6.0 — TypeScript Migration (15. März 2026)

### Major Changes

- **Vollständige TypeScript-Migration**: Gesamter Quellcode in `src/` ist jetzt TypeScript
- **TypeScript Tests**: Alle Tests migriert nach TypeScript (`test/*.ts`)
- **Strict Mode**: TypeScript `strict: true` aktiviert
- Separate `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`

### Technische Details

- Source-Files: `src/main.ts`, `src/lib/*.ts`
- Test-Files: `test/*.ts` (kompiliert nach `build/test/`)
- Build: `tsc -p tsconfig.build.json`
- Test-Build: `tsc -p tsconfig.test.json`

---

## v0.5.2 — Official ioBroker ESLint Config (14. März 2026)

### Änderungen

- **@iobroker/eslint-config**: Umstellung auf offizielle ESLint-Konfiguration
- **Prettier**: Code-Formatierung nach ioBroker-Standards
- ESM-Module für Konfigurationsdateien (`.mjs`)
- Entfernt: eigene ESLint-Konfiguration und separate Dependencies

### Neue Scripts

```bash
npm run format       # Code formatieren
npm run format:check # Formatierung prüfen
```

---

## v0.5.1 — Home Assistant 2026.3 (14. März 2026)

### Updates

- **HA_VERSION**: 2024.12.0 → 2026.3.1 (aktuelle HA-Version)
- Emulierte Version entspricht jetzt der aktuellen Home Assistant Release

---

## v0.5.0 — Express 5 & Dependencies Update (14. März 2026)

### Major Updates

- **Express**: 4.x → 5.2.1 (bessere async/await Unterstützung, modernere API)
- **ESLint**: 9.x → 10.0.3
- **@eslint/js**: 9.x → 10.0.1
- **@types/node**: 22.x → 25.5.0
- **globals**: 16.x → 17.4.0

### Kompatibilität

- Alle Dependencies auf März 2026 Versionen aktualisiert
- Express 5 Migration ohne Breaking Changes (Code war bereits kompatibel)
- Getestet und funktionsfähig mit Node.js 20+

---

## v0.4.0 — js-controller 7 & Admin 7 Update (14. März 2026)

### Breaking Changes

- **Node.js 20+** erforderlich (vorher Node.js 18+)
- **js-controller 7.0.0+** erforderlich (vorher 5.0.0+)
- **Admin 7.0.0+** erforderlich (vorher 6.0.0+)

### Neue Features

1. **jsonConfig Admin UI**
   - Moderne JSON-basierte Konfigurationsoberfläche
   - Drei Tabs: Haupteinstellungen, mDNS-Erkennung, Authentifizierung
   - Ersetzt das veraltete Materialize-Framework

2. **Verschlüsseltes Passwort**
   - `encryptedNative` für das Passwort-Feld
   - Passwort wird verschlüsselt in der Datenbank gespeichert
   - `protectedNative` verhindert Auslesen über API

3. **supportedMessages**
   - `stopInstance: true` für sauberes Herunterfahren

4. **Adapter-Icon**
   - SVG-Icon für den Adapter hinzugefügt

### Updates

- **@iobroker/adapter-core**: 3.2.2 → 3.3.2
- **HA_VERSION**: 2024.1.0 → 2024.12.0
- **Dependencies**: @eslint/js, globals, @iobroker/types hinzugefügt
- **ESLint 9**: Flat Config Format (`eslint.config.js`)
- **LICENSE**: MIT-Lizenz-Datei hinzugefügt
- **Repository URLs**: Korrigiert auf krobipd/iobroker.homeassistant-bridge

### Code-Qualität & Refactoring

- **lib/constants.js**: Neue Datei für gemeinsame Konstanten (DRY)
- **Platzhalter entfernt**: UUID wird jetzt pro Instanz generiert (war `00000000-...`)
- **visUrl Fallback entfernt**: Kein irreführender localhost-Default mehr
- **Session Cleanup Logging**: Debug-Ausgabe wenn Sessions aufgeräumt werden
- **Fehlerbehandlung verbessert**: Redirect ohne URL gibt JSON-Fehler statt Crash
- **ESLint-Konfiguration** hinzugefügt
- `tier: 3` in io-package.json gesetzt

---

## v0.3.0 — Code-Cleanup & Bug-Fixes (18. Februar 2026)

### Bug-Fixes

1. **mdns.js — XML Closing Tag (KRITISCH)**
   - `</n>` → `</name>` — Avahi konnte die Service-Datei nicht parsen
   - Service wurde nie korrekt registriert, mDNS-Discovery war dadurch unmöglich

2. **webserver.js — requires_api_password in /api/discovery_info**
   - War dynamisch an `authRequired` gebunden statt hardcoded `true`
   - Display übersprang bei `false` den Auth-Flow über diesen Endpoint

3. **webserver.js — Token Refresh**
   - `grant_type: refresh_token` wurde nicht unterstützt → Display verlor Verbindung nach Token-Ablauf

### Optimierungen (DRY / KISS)

- **Dependencies reduziert:** `uuid` und `body-parser` entfernt
  - `crypto.randomUUID()` (Node 18+ built-in) ersetzt `uuid`
  - `express.json()` / `express.urlencoded()` (Express 4.16+ built-in) ersetzt `body-parser`
- **Konstanten extrahiert:** `HA_VERSION`, `LOGIN_SCHEMA`, `SESSION_TTL_MS` — keine Magic Values mehr
- **Session-Cleanup:** Timer räumt abgelaufene Sessions alle 5 Min auf (vorher: nie)
- **Log-Level:** Request-Logging auf `debug` statt `info` — Production-Logs sind sauber
- **Route-Setup modularisiert:** `setupApiRoutes()`, `setupAuthRoutes()`, `setupMiscRoutes()`
- **serviceName Getter:** Eliminiert `this.config.serviceName || 'ioBroker'` Wiederholungen
- **main.js:** `setStateAsync` statt `setState`, `finally` Block in `onUnload`
- **mdns.js:** `buildServiceXml()` als eigene Methode, `reloadAvahi()` DRY
- **io-package.json:** `visUrl` Default auf leer statt `localhost` (verhindert Fehlkonfiguration)
- **Encoding fix:** `°C` statt `Â°C` in unit_system

---

## v0.2.0 — Vereinfachung (Februar 2026)

- Proxy-Funktion entfernt
- Nur noch Avahi für mDNS (kein Bonjour/multicast-dns)
- CORS entfernt

---

## v0.1.0 — Erstveröffentlichung (Februar 2026)

- Initiale Version
- Home Assistant API Emulation
- OAuth2-ähnlicher Authentifizierungsflow
- mDNS Service Discovery
- Redirect zu konfigurierbarer URL
