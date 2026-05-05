# Older Changes
## 1.8.0 (2026-05-05)

- **Code-Aufräumen**: Konstanten (Cookie-TTL, Map-Caps, Mode-Sentinels, Stale-TTL) liegen jetzt zentral in `lib/constants.ts`. Verhalten unverändert.
- **Logging weniger laut**: Token-Endpunkt-Fehler (unbekannter `flow_id`, ungültiger Refresh-Token, falscher `grant_type`) jetzt `debug` statt `warn`.

## 1.7.1 (2026-05-05)

- Hotfix: drei Prettier-Format-Fehler aus v1.7.0 behoben (CI-Lint-Gate war rot, deploy hat v1.7.0 nicht auf npm gebracht). v1.7.0-Änderungen erreichen npm jetzt mit dieser Version.

## 1.7.0 (2026-05-05)

- **VIS-2-Views** stehen jetzt als eigene Einträge im Mode-Dropdown — nicht nur das Top-Level-Projekt. Pro Projekt-Folder liest der Adapter `vis-views.json` und legt für jede View eine URL `?<projekt>/<view>` an. Bei fehlender oder kaputter Datei bleibt der Top-Level-Eintrag funktional.
- **Display-Reload bei Redirect-Edit**: das Adapter-Root liefert kein 302 mehr, sondern eine kleine HTML-Seite mit `<iframe>` zum Ziel + 30-Sekunden-Polling auf den neuen Endpunkt `/api/redirect_check`. Wenn du die Mode-/manualUrl-Konfiguration änderst, lädt das Display von selbst neu — kein Soft-Reboot mehr nötig.

## 1.6.0 (2026-05-05)

- **Sicherheit**: HA-API-Endpunkte (`/api/states`, `/api/services`, `/api/events`, `/api/error_log`, `/api/config`) sind jetzt token-geschützt wenn `Auth Required` aktiv ist — vorher waren sie ohne jeden Auth-Check abrufbar (Information-Disclosure). `/api/discovery_info`, `/api/`-Heartbeat, `/health`, `/manifest.json` und der Auth-Flow bleiben offen, weil HA-Clients sie vor dem Login abfragen müssen.
- **Stabile Server-UUID**: `info.serverUuid` Datenpunkt — die UUID, die per mDNS und in `/api/discovery_info` gemeldet wird, bleibt jetzt über Adapter-Restarts gleich. HA-Clients (Companion-App, Wall-Display) cachen die Server-Identität — vorher behandelten sie jeden Restart als „neuen Server" und erzwangen erneutes Pairing inklusive Token-Verlust.

## 1.5.0 (2026-05-05)

- **Sicherheit**: `/health` liefert keine Konfigurations-Flags mehr (`mdns`/`auth` waren ohne Auth einsehbar — Reconnaissance-Risiko für netzexponierte Instanzen).
- **Sicherheit**: `requires_api_password` in `/api/discovery_info` und im mDNS-TXT spiegelt jetzt die tatsächliche `authRequired`-Konfiguration (vorher hartkodiert auf `true` — strikte HA-Clients haben den Auth-Flow auch bei deaktivierter Auth ausgelöst).
- **Speicher**: Brute-Force-Lockout-Map ist jetzt FIFO-gedeckelt (1000 IPs) und prunt veraltete Fail-Counts (älter als das Lockout-Fenster) — bisher wuchs die Map auf netzexponierten Instanzen langsam unbegrenzt.

## 1.4.1 (2026-05-05)

- CI: Deploy-Schritt nutzt jetzt Node 24 (Node 22 + `npm@latest` hatte einen `MODULE_NOT_FOUND`-Bug für `promise-retry`, dadurch kam v1.4.0 nicht auf npm).

## 1.4.0 (2026-05-05)

- Neuer Datenpunkt `info.refresh_urls` (Button) — auf `true` setzen lädt VIS/VIS-2-Projekte und Admin-Tile-URLs neu, ohne den Adapter neu zu starten. Praktisch nach einer neuen VIS-Seite, die im Mode-Dropdown erscheinen soll.
- `/auth/token` akzeptiert jetzt auch `application/x-www-form-urlencoded` Bodies (OAuth2-Spec) — manche HA-Clients senden den Token-Request urlencoded statt JSON, das Login lief sonst ins Leere.
- mDNS: Bei einem Bonjour-Startfehler wird die Service-Instanz jetzt sauber freigegeben (vorher leakte der UDP-Socket über die Adapter-Lifetime).
- Legacy-Migration (1.0.x/1.1.0 → 1.1.1) härter: ungültige Legacy-URLs werden nicht mehr durchgereicht, und Native-Cleanup passiert nur nach erfolgreichem State-Write — verhindert silent URL-Verlust auf Edge-Cases.

## 1.3.3 (2026-05-01)
- Documentation: rewrote release notes for v1.1.4–v1.3.2 in user-friendly style across all languages.

## 1.3.2 (2026-04-30)
- Fix: dropdown default `---` now applied correctly on upgrades from older v1.1.x clients (was empty after migration).

## 1.3.1 (2026-04-30)
- Fix: legacy v1.1.x clients without `mode`/`manualUrl` objects now get migrated correctly on first start.
- Mode dropdown gains a `0 = "---"` no-choice fallback — new displays start without a target until a real choice is made.

## 1.3.0 (2026-04-30)
- Security: brute-force lockout on login (5 failed attempts → IP blocked for 15 min, successful login resets the counter).
- Emulated Home Assistant version bumped to 2026.4.0.

## 1.2.0 (2026-04-29)
- **Breaking:** Redirect target now configured via `mode` (dropdown) + `manualUrl` (free text) instead of the old `visUrl`. Existing setups auto-migrated.
- Master switch `global.enabled` syncs every display (on → all follow global URL, off → each display picks up its own).
- Idle displays without auth token are auto-removed after 30 days.
- Security hardening of the auth flow.
- `web` adapter declared as dependency.

## 1.1.6 (2026-04-28)
- Internal cleanup. No user-facing changes.

## 1.1.5 (2026-04-26)
- Crash defense: process-level error handlers.
- Min `js-controller` restored to `>=6.0.11` (was incorrectly `>=7.0.0`).

## 1.1.4 (2026-04-23)
- Internal cleanup. No user-facing changes.

## 1.1.3 (2026-04-19)
- Fix: parallel cookieless requests on first connect no longer create duplicate client records.
- Setup page redesigned with status banner, dark mode, and translations into all 11 languages.

## 1.1.2 (2026-04-18)
- Hostname is now shown as the channel name (instead of a separate datapoint).
- Faster client registration on first connect.

## 1.1.1 (2026-04-18)
- Redirect URL moved from Admin config to datapoints (`global.visUrl` + `global.enabled`).
- Setup page served when no URL is configured.
- `web` adapter declared as dependency.

## 1.1.0 (2026-04-18)
- **Multi-client support** — each display gets its own channel under `clients.*` with individual `visUrl`, IP, and remove button.
- URL dropdown populated from all known ioBroker URLs (VIS-2, VIS, Admin intro tiles).
- Cookie-based identification: displays are recognised across restarts and IP changes.
- Switched to Fastify, hardened all external URL inputs.

## 1.0.4 (2026-04-12)
- Internal cleanup. No user-facing changes.

## 1.0.3 (2026-04-12)
- Internal cleanup. No user-facing changes.

## 1.0.2 (2026-04-08)
- Internal cleanup. No user-facing changes.

## 1.0.0 (2026-04-08)
- Renamed from `homeassistant-bridge` to `hassemu`.

---

## 0.8.11 (2026-03-28)
- Fix: malformed JSON requests now return 400 instead of 500.

## 0.8.10 (2026-03-28)
- Internal cleanup.

## 0.8.9 (2026-03-28)
- Adapter-managed timers; Windows + macOS in CI.

## 0.8.8 (2026-03-25)
- Admin UI simplified to single page. Fix: synchronous `onUnload` (prevents SIGKILL on shutdown).

## 0.6.2 (2026-03-15)
- Internal: JSDoc complete, ESLint clean.

## 0.6.1 (2026-03-15)
- Internal: GitHub Actions CI + automatic release on tag push.

## 0.6.0 (2026-03-15)
- Internal: full TypeScript migration with strict mode.

## 0.5.2 (2026-03-14)
- Internal: migrated to @iobroker/eslint-config + Prettier.

## 0.5.1 (2026-03-14)
- Emulated Home Assistant version updated from 2024.12.0 to 2026.3.1.

## 0.5.0 (2026-03-14)
- Internal: Express 5, ESLint 10, all dependencies updated.

## 0.4.0 (2026-03-14)
- **Breaking:** Node.js 20+, js-controller 7.0.0+, Admin 7.0.0+ required.
- jsonConfig Admin UI (replaces Materialize). Encrypted password storage.

## 0.3.0 (2026-02-18)
- Fix: mDNS discovery (XML tag bug).
- Fix: token refresh (grant_type=refresh_token).
- Internal: session cleanup timer.

## 0.2.0 (2026-02-01)
- Removed proxy function. Avahi-only for mDNS. CORS removed.

## 0.1.0 (2026-02-01)
- Initial release. Home Assistant API emulation, OAuth2-like auth flow, mDNS service discovery.
