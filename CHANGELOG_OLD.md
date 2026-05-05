# Older Changes
## 1.2.0 (2026-04-29)
- **Breaking:** Redirect target now configured via `mode` (dropdown) + `manualUrl` (free text) instead of the old `visUrl`. Existing setups auto-migrated.
- Master switch `global.enabled` syncs every display (on → all follow global URL, off → each display picks up its own).
- Idle displays without auth token are auto-removed after 30 days.
- Security hardening of the auth flow.
- `web` adapter declared as dependency.

Older entries are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

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
