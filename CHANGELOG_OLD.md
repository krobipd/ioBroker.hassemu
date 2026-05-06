# Older Changes
## 1.27.0 (2026-05-06)

- Bugfix: VIS-2 URLs in the mode dropdown are now correct (`vis-2/index.html#<view>`, no `.0` suffix, no project path segment). Source is the VIS-2 adapter's `io-package.json` (`localLinks.Runtime.link`).
- VIS-1 (classic) fully supported: one `?<project>` entry per project in the dropdown plus sub-views as `?<project>#<view>`. Source is `visEdit.js:2225`.
- Logs in system language: `info`/`warn`/`error` are now localized via `system.config.language` (11 languages), `debug` stays English. Tech internals like `mode='X'` and module prefixes were dropped.

## 1.26.0 (2026-05-06)

- **VIS-2-URLs im Mode-Dropdown nach echtem VIS-2-Routing**: Projekt als Pfad-Segment, View als Hash-Fragment (`#<view>`). Vorher `?<projekt>` als Query — Deep-Links liefen ins Leere.
- **Default-Mode für neue Clients = no-choice-Eintrag** → Landing-Page bis der User im Dropdown eine URL wählt. Vorher fiel der Default auf die erste discovered URL, Landing war praktisch nie sichtbar.
- **iframe-Wrapper ohne sichtbaren Rahmen**: `display:block` + `position:fixed` + `100vw/100vh` — kein schwarzer Streifen mehr unten/rechts auf WebView-Displays.

## 1.25.0 (2026-05-06)

- **Reverse-Proxy-Support** (optional, Default aus): neuer Config-Toggle „Trust Reverse Proxy Headers". `req.ip`/`req.protocol` aus `X-Forwarded-*`, Cookies `Secure` bei `X-Forwarded-Proto=https`.
- **Schema-Repair via instanceObjects**: `repairGlobalSchemas` liest jetzt aus `io-package.json:instanceObjects` statt zu duplizieren — kein stille Drift mehr.
- **Test-Coverage** (+11 Tests): `decideGcAction` (Stale-GC), `decideLegacyVisMigration` (Legacy-URL-Migration), mDNS async-publish-error.

## 1.24.0 (2026-05-05)

- **Test-Coverage**: 2 neue Unit-Tests für den v1.17.0 NAT-Cookie-Schutz — unterschiedliche User-Agents auf derselben IP bekommen distinct Clients, gleiche UA collapsed parallele Bursts.

## 1.23.0 (2026-05-05)

- **Interne Aufräumung**: `parseModeWrite`-Helper in `coerce.ts` — beide `handleModeWrite`-Handler (`client-registry` + `global-config`) delegieren jetzt an einen Validator statt ~80% der Logik zu duplizieren.

## 1.22.0 (2026-05-05)

- **Interne Aufräumung**: `safeStringEqual` (timing-safe Credentials-Vergleich) ist von `webserver.ts` nach `coerce.ts` umgezogen — generischer Crypto-Helper. Plus 5 neue Unit-Tests.

## 1.21.0 (2026-05-05)

- **Pending-Create-Errors diagnostizierbar**: schlägt das parallele Erst-Anlegen eines Clients fehl, kommt der Fehler jetzt einmalig im Log statt als unhandled rejection.
- **Docker-Bridge-IPs nicht mehr ins mDNS**: `getLocalIp` deprioritisiert `172.17.x.x`/`172.18.x.x` gegenüber LAN-IPs — kein unreachable Container-Advertise mehr.

## 1.20.0 (2026-05-05)

- **Interne Aufräumung**: drei Helpers nach `coerce.ts` extrahiert — `buildDropdownStates`, `parseAdapterStateId`, `safeGetState`. `client-registry` und `global-config` teilen sie statt zu duplizieren.

## 1.19.1 (2026-05-05)

- **Test-Coverage**: 7 neue Unit-Tests für v1.19.0-Features — `seedLastSeen`-Pfad und Per-IP-Burst-Erkennung (Schwelle, Cooldown, per-IP-unabhängig, FIFO-Cap).

## 1.19.0 (2026-05-05)

- **Burst-Erkennung für broken Cookies**: erzeugt ein Display mehr als 3 neue Clients innerhalb einer Stunde (= der Cookie wird nicht persistiert), kommt einmaliger `warn`-Hinweis mit Diagnose-Pfad.
- **README**: Hinweis dass nur eine hassemu-Instance pro Host laufen kann (Port 8123 fix).
- **`lastSeen`-Update-Pfad konsolidiert**: GC und Throttle nutzen jetzt denselben `registry.seedLastSeen()`-Helper.

## 1.18.0 (2026-05-05)

- **Logging-Hygiene Login-Floods**: `Invalid credentials` kommt pro IP nur bis zur Lockout-Schwelle als `warn` ins Log, danach auf `debug`. Brute-Force füllt das Log nicht mehr.
- **Stop-Error nicht mehr doppelt**: bei intended shutdown loggt `webServer.stop()` selbst auf `debug`, der Caller in `onUnload` cleant silent. Vorher zwei Einträge im Log.
- **`non-string mode`-Rejection auf `debug`**: das ist UI-Echo (Dropdown-Klicks o.ä.) und kein Server-Concern — vorher fälschlich als `warn`.

## 1.17.0 (2026-05-05)

- **NAT-Cookie-Schutz**: zwei Displays hinter derselben NAT-IP teilten sich beim parallelen Erst-Connect Cookie + Token + Mode. Jetzt: Bucket-Key kombiniert IP + User-Agent-Hash.
- **`/api/discovery_info` nutzt bind-Address**, nicht den `Host`-Header. Vorher konnte ein Angreifer mit `Host: attacker.lan` andere HA-Clients zur falschen URL umleiten.
- **VIS-Discovery iteriert alle `web.*`-Instances**: User mit `web.1` (zweite Web-Instance) hatten vorher keine VIS-Projekte im Mode-Dropdown.

## 1.16.0 (2026-05-05)

- **Sicherheit Credentials-Vergleich**: `safeStringEqual` hashed beide Seiten via SHA-256 vor dem timing-safe Vergleich — vorher waren Username-/Password-Längen über Response-Timing leakbar.
- **Landing-Page versteckt Loopback-IPs**: `127.0.0.1` / `::1` / `0.0.0.0` werden nicht mehr als Display-IP angezeigt — verwirrte User bei Reverse-Proxy-Setups.
- **`coerceSafeUrlReason`-Helper**: rejected URLs liefern jetzt den Grund (`bad-scheme:javascript:`, `credentials-in-url`, `unparseable`, `too-long`, …) für gezielte Log-Nachvollziehbarkeit.
- **README-Upgrading aktualisiert**: Eintrag „1.2.0 → 1.15.x" hinzugefügt, plus Hinweis auf den v1.3.2-Schema-Repair bei leerem Mode-Dropdown nach Upgrade.
- **Config-Hinweis bei mDNS=off**: die Configuration-Tabelle erklärt jetzt explizit dass Displays manuell konfiguriert werden müssen wenn mDNS deaktiviert ist.

## 1.15.0 (2026-05-05)

- **IPv6-LAN-Fallback**: `getLocalIp` nimmt jetzt die erste non-internal IPv6-Adresse statt `127.0.0.1` wenn keine IPv4 verfügbar ist. mDNS broadcastet damit eine reachable Adresse statt Loopback.
- **mDNS async-Bind-Fehler gefangen**: bonjour wirft Port-5353-belegt-Fehler asynchron in dgram-Sockets. Ein `error`-Listener setzt jetzt `active=false` + warnt im Log.

## 1.14.0 (2026-05-05)

- **Schema-Repair überspringt Check** wenn `global.mode`/`global.manualUrl` schon korrekt sind — spart 2 Broker-Round-Trips pro Start. Repair-Pfad bleibt für pre-v1.3.2-Bug.
- **Defensives Cleanup bei `onReady`-Re-Run**: webServer/mDNS/urlDiscovery werden vorher sauber gestoppt falls js-controller `onReady` ohne `unload` zweimal triggert.
- **Test-Injects schneller**: `inject` einmalig im Constructor gebunden statt pro Property-Access — weniger GC-Druck in Test-Loops.
- **Cleanup-Timer defensive**: bei doppeltem `start()` (Refactor-Edge) wird der vorherige Timer gecleared statt zu leaken.

## 1.13.0 (2026-05-05)

- **URL-Dropdown-Refresh schmaler**: feuert nur noch bei Adapter-Add/Remove oder Änderungen an `admin`/`web`/`vis`/`vis-2` — vorher bei jedem `system.adapter.*`-Object-Change im ganzen Host.
- **Subscriptions nach Server-Start**: vermeidet Race-Window in dem ein State-Write zwischen Subscribe und Server-Listen einen Handler auf nicht-laufenden Server feuert.
- **Lifecycle-Härtung**: `info.connection=false` in `onUnload` zuerst (nicht nach Refs-Null), `setNewClientModeProvider` vor `collect()` (statt danach), klarer Code-Pfad bei WebServer-Start-Fail.

## 1.12.0 (2026-05-05)

- **Brute-Force-Lockout-Härtung**: IPv6-mapped IPv4 (`::ffff:1.2.3.4`) und `null`-IP teilen jetzt einen Bucket mit raw IPv4 — vorher konnten Angreifer durch Adress-Form-Wechsel den Counter umgehen.
- **Legacy-URL-Migration validiert** via `coerceSafeUrl`: alte `javascript:`/`data:`-URLs aus v1.0.x-Config fallen auf Manual-Mode statt unsafe geschrieben zu werden.

## 1.11.0 (2026-05-05)

- **Sicherheit Refresh-Token-Brute-Force**: `/auth/token` mit `grant_type=refresh_token` hat jetzt denselben Brute-Force-Lockout wie `/auth/login_flow` — 5 ungültige Grants pro IP → 15min HTTP 429.
- **Stale-Client-GC erfasst auch Token-Clients**: Clients mit `lastSeen > 30 Tage` werden jetzt entfernt, auch wenn sie einen Token haben (vorher übersprungen).

## 1.10.0 (2026-05-05)

- **Adapter beendet sich bei Server-Start-Fehler** (Port belegt etc.) jetzt mit Exit-Code 11 — js-controller startet ihn nach Backoff neu, statt zombie idle zu sitzen.
- **mDNS-Broadcast-Fehler ist jetzt sichtbar**: `warn`-Meldung im Log + `mDNS FAILED` im running-Status (vorher still).
- **Compact-Mode**: `unhandledRejection`/`uncaughtException`-Handler nur einmal pro Node-Prozess (Module-Level-Flag), nicht pro Instance.
- **onUnload löst Subscriptions explizit auf** vor dem Null-Set — verhindert Residual-Calls auf genullte Instance bei hot-remove.

## 1.9.1 (2026-05-05)

- **Interne Aufräumung**: 5xx-Error-Cooldown-Map (eingeführt in v1.9.0) nutzt jetzt denselben FIFO-Eviction-Helper wie alle anderen gedeckelten Maps im Server — vorher inline-inkonsistent.
- **Test-Coverage**: 5 neue Unit-Tests für die Cooldown-Logik (erste Beobachtung, Window-Wiederholung, Window-Ablauf, unabhängige Keys, FIFO-Cap).

## 1.9.0 (2026-05-05)

- **Weniger Log-Spam unter Attacke**: 5xx-Fehler werden pro Message nur beim ersten Auftritt als `warn` geloggt (60s-Cooldown), Wiederholungen fallen auf `debug`.
- **Adapter-Start ~4× schneller bei vielen Displays**: `restore()` liest die vier Datenpunkte pro Client parallel statt sequenziell.
- **Kleinere Härtung**: Landing-Page-Übersetzungen `as const satisfies` (immutable), Port-Felder lehnen Hex/Exponential ab, `MDNSService.active` extern read-only.

## 1.8.1 (2026-05-05)

- **Master-Switch schneller**: `global.enabled`-Toggle schreibt das `mode` aller Clients jetzt parallel statt sequenziell (vorher N Broker-Round-Trips). Spürbar auf Instanzen mit vielen Displays.
- **Mode-Dropdown bleibt gefüllt** wenn der Broker beim Lesen der `vis-2.0`/`web.0`-Objekte kurz nicht antwortet — der zuletzt funktionierende Stand wird gehalten statt mit `{}` überschrieben.
- **Reverse-DNS-Lookup hat 5s-Timeout**: ein langsamer/blockierter LAN-Nameserver hängt den HA-Auth-Flow nicht mehr.

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
