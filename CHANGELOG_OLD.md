# Older Changes
## 1.32.3 (2026-05-17)

- Internal cleanup. No user-facing changes.

## 1.32.2 (2026-05-16)

- Internal cleanup. No user-facing changes.

## 1.32.1 (2026-05-16)

- If the adapter goes offline while the display is running, the display now switches to a clear offline page with a reload button instead of just stopping to update.

## 1.32.0 (2026-05-16)

- Two state descriptions in the object tree are now complete again. Internal cleanup, no further user-facing changes.

## 1.31.1 (2026-05-13)

- Improved debug logging for easier issue analysis.

## 1.31.0 (2026-05-13)

- Companion apps now stay signed in across adapter restarts (ioBroker update, network glitch, power cut). Existing paired apps will sign in once after the update, then stay signed in.
- Removed an internal brute-force-lockout layer that occasionally locked out legitimate companions after multiple quick restarts.

## 1.30.0 (2026-05-12)

- Adding or reconfiguring an Aura adapter now refreshes the URL dropdown automatically. Internal cleanup.

## 1.29.3 (2026-05-12)

- The "Connection to Home Assistant failed" popup on Shelly Wall Display 2.6.0+ also stays away when the landing page is shown (no URL configured yet). v1.29.2 only suppressed it when a target URL was set.
- Replaced the landing-page emblem with the real ioBroker brand mark (power-button "i" inside a ring).

## 1.29.2 (2026-05-12)

- Shelly Wall Display on firmware 2.6.0+ no longer shows the connection-error popup after the page has loaded.
- The mode dropdown now auto-discovers Aura instances (frontend at the configured port).
- The landing page now carries the ioBroker logo, and the README has a clear table of every dashboard source the adapter recognizes.

## 1.29.1 (2026-05-12)

- Shelly Wall Display onboarding under firmware 2.6.0 and newer now completes — the on-device Home Assistant app needs a device-registration step that the adapter now provides.

## 1.29.0 (2026-05-12)

- Shelly Wall Displays running firmware 2.6.0 and newer connect again. The new on-device Home Assistant app uses a browser sign-in flow and a server identity check that the previous adapter version did not answer.

## 1.28.4 (2026-05-12)

- The mode dropdowns in admin (global and per-client) no longer crash with "Error in GUI" when opened.

## 1.28.3 (2026-05-10)

- Adapter starts faster on installations with many displays, and a single broken client entry no longer keeps the others from being restored. Plus a security tighten-up around the HA login flow.

## 1.28.2 (2026-05-09)

- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names, descriptions and dropdown labels (11 languages) are unchanged. The user-facing HA landing page also remains localized.

## 1.28.1 (2026-05-06)

- Documentation: changelog entries (v1.27.x–v1.28.0) restored to English — a few bullets had been left in German. No code changes.

## 1.28.0 (2026-05-06)

- Multi-language: state names, descriptions and dropdown labels are now in your ioBroker system language (11 languages).

## 1.27.3 (2026-05-06)

- Docs: README rewritten in plain user voice — shorter, direct, no implementation trivia. No code changes.

## 1.27.2 (2026-05-06)

- Bugfix: dropdown `common.states` is now fully replaced on each URL-refresh instead of merged — stale URLs from earlier format versions are now removed.

## 1.27.1 (2026-05-06)

- Bugfix: VIS-2 dropdown now lists each project separately via a `?<project>` query plus sub-views as `?<project>#<view>`. Pre-v1.27.1 only the active project was reachable.

## 1.27.0 (2026-05-06)

- VIS-2 URLs in the mode dropdown now work correctly — deep links reach the right page.
- VIS-1 (classic) fully supported: each project and its views appear as separate entries in the dropdown.
- Log messages now use the system language (11 languages) for info, warning and error levels.

## 1.26.0 (2026-05-06)

- VIS-2 deep links in the mode dropdown now work correctly. Previously, project views could not be reached via the dropdown.
- New clients now start with a landing page until you select a URL in the dropdown. Previously, the first discovered URL was selected automatically.
- Displays no longer show a thin black border around the page content.

## 1.25.0 (2026-05-06)

- Added optional reverse proxy support — new config toggle to trust forwarded headers. Useful when running behind nginx or Traefik.
- Internal cleanup. No further user-facing changes.

## 1.24.0 (2026-05-05)

- Internal cleanup. No user-facing changes.

## 1.23.0 (2026-05-05)

- Internal cleanup. No user-facing changes.

## 1.22.0 (2026-05-05)

- Internal cleanup. No user-facing changes.

## 1.21.0 (2026-05-05)

- Client creation errors now appear in the log instead of crashing silently.
- Docker users: the adapter no longer advertises unreachable container IPs via mDNS — LAN IPs are now preferred.

## 1.20.0 (2026-05-05)

- Internal cleanup. No user-facing changes.

## 1.19.1 (2026-05-05)

- Internal cleanup. No user-facing changes.

## 1.19.0 (2026-05-05)

- The adapter now warns if a display creates too many new clients in a short time, which usually means its cookie storage is broken.
- Only one hassemu instance per host — documented in README.

## 1.18.0 (2026-05-05)

- Repeated failed login attempts no longer flood the log — the warning appears once per IP, then drops to debug level.
- Cleaner shutdown log — no more duplicate entries when the adapter stops.
- UI-triggered mode echoes no longer produce unnecessary warnings in the log.

## 1.17.0 (2026-05-05)

- Two displays behind the same router (NAT) no longer share the same session — each display now gets its own cookie and mode.
- Security: the discovery endpoint no longer trusts the browser-supplied host header, preventing potential redirect attacks.
- VIS projects from all web adapter instances now appear in the mode dropdown (previously only the first instance was scanned).

## 1.16.0 (2026-05-05)

- Security: credential comparison hardened against timing attacks.
- The landing page no longer shows loopback addresses as display IPs — less confusion for reverse proxy setups.
- Rejected URLs now include a clear reason in the log.
- README updated with upgrade notes and mDNS-off configuration hint.

## 1.15.0 (2026-05-05)

- IPv6-only networks: displays can now discover the adapter via mDNS even without an IPv4 address.
- mDNS port conflicts now produce a clear warning instead of failing silently.

## 1.14.0 (2026-05-05)

- Faster adapter startup — unnecessary checks skipped when datapoints are already correct.
- Improved stability when js-controller triggers a restart without clean shutdown.

## 1.13.0 (2026-05-05)

- The URL dropdown now only refreshes when relevant adapters change, not on every system event — less CPU usage on busy hosts.
- Improved stability during adapter startup and shutdown.

## 1.12.0 (2026-05-05)

- Security: brute-force lockout now also covers IPv6-mapped IPv4 addresses — address form switching can no longer bypass the counter.
- Unsafe legacy URLs from v1.0.x configurations are now rejected during migration instead of being kept.

## 1.11.0 (2026-05-05)

- Security: token refresh is now also protected by brute-force lockout (5 invalid attempts → 15 min block).
- Clients idle for more than 30 days are now cleaned up even if they still hold a token.

## 1.10.0 (2026-05-05)

- The adapter now restarts automatically when the server port is already in use, instead of sitting idle.
- mDNS failures are now visible in the log and the running status.
- Improved stability in compact mode and during adapter removal.

## 1.9.1 (2026-05-05)

- Internal cleanup. No user-facing changes.

## 1.9.0 (2026-05-05)

- Server errors no longer flood the log — each unique error is warned once per minute, repeats drop to debug.
- Faster adapter startup on installations with many displays.
- Internal hardening.

## 1.8.1 (2026-05-05)

- The global on/off switch now applies to all displays much faster.
- The mode dropdown no longer goes empty if the broker is briefly unreachable.
- A slow DNS server on your LAN no longer blocks the login flow (5 s timeout added).

## 1.8.0 (2026-05-05)

- Internal cleanup. Token-related errors no longer produce unnecessary warnings in the log.

## 1.7.1 (2026-05-05)

- Hotfix: v1.7.0 did not reach npm due to a build issue — this version includes all v1.7.0 changes.

## 1.7.0 (2026-05-05)

- Individual VIS-2 views now appear as separate entries in the mode dropdown — not just the top-level project.
- Displays now reload automatically when you change the URL in the mode dropdown — no more soft-reboot needed.

## 1.6.0 (2026-05-05)

- Security: API endpoints are now token-protected when authentication is enabled — previously accessible without any check.
- Stable server identity: the server UUID now persists across restarts. Companion apps and wall displays no longer require re-pairing after an adapter restart.

## 1.5.0 (2026-05-05)

- Security: the health endpoint no longer exposes configuration details to unauthenticated users.
- The auth-required flag now reflects the actual configuration — companion apps no longer force a login when auth is disabled.
- Memory: the brute-force lockout table is now capped and auto-cleaned, preventing slow memory growth on internet-exposed instances.

## 1.4.1 (2026-05-05)

- Hotfix: v1.4.0 did not reach npm due to a build infrastructure issue — this version includes all v1.4.0 changes.

## 1.4.0 (2026-05-05)

- New datapoint: set "Refresh URL discovery" to true to reload VIS/VIS-2 projects without restarting the adapter — useful after creating a new VIS page.
- Some companion apps that send login data in a different format now work correctly.
- mDNS startup errors no longer leak resources.
- Legacy migration from v1.0.x/v1.1.0 hardened — invalid URLs are no longer carried over silently.

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

- **Breaking:** Redirect target now configured via mode dropdown + manual URL instead of the old single URL field. Existing setups auto-migrated.
- Master switch syncs every display (on → all follow global URL, off → each display picks up its own).
- Idle displays without auth token are auto-removed after 30 days.
- Security hardening of the auth flow.

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

- Redirect URL moved from Admin config to datapoints for easier scripting.
- Setup page served when no URL is configured.

## 1.1.0 (2026-04-18)

- **Multi-client support** — each display gets its own channel with individual URL, IP, and remove button.
- URL dropdown populated from all known ioBroker URLs (VIS-2, VIS, Admin intro tiles).
- Displays are recognised across restarts and IP changes.
- Hardened all external URL inputs.

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

- Internal cleanup. No user-facing changes.

## 0.8.8 (2026-03-25)

- Admin UI simplified to single page. Fixed adapter shutdown behavior.

## 0.6.2 (2026-03-15)

- Internal cleanup. No user-facing changes.

## 0.6.1 (2026-03-15)

- Internal cleanup. No user-facing changes.

## 0.6.0 (2026-03-15)

- Internal cleanup. No user-facing changes.

## 0.5.2 (2026-03-14)

- Internal cleanup. No user-facing changes.

## 0.5.1 (2026-03-14)

- Emulated Home Assistant version updated from 2024.12.0 to 2026.3.1.

## 0.5.0 (2026-03-14)

- Internal cleanup. All dependencies updated.

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
