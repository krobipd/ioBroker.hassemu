# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.hassemu@main/admin/hassemu.svg" width="48" align="top" /> ioBroker.hassemu

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.hassemu)](https://www.npmjs.com/package/iobroker.hassemu) ![stable](https://iobroker.live/badges/hassemu-stable.svg) ![Installations](https://iobroker.live/badges/hassemu-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.hassemu)](https://www.npmjs.com/package/iobroker.hassemu)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.hassemu/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.hassemu/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Emulates a Home Assistant server so displays that only accept an HA dashboard show any web URL instead.

---

## What it's for

The display completes the HA onboarding, then shows whatever web URL you point it at — VIS, VIS-2, Aura, Grafana, Node-RED, anything HTTP.

Typical clients: the Shelly Wall Display family (legacy models Stargate and X2, modern models XL, X2i, X1i, U1 and D1) — through its built-in Home Assistant page or the on-device Home Assistant app of firmware 2.6.0 and newer; firmware 2.7.0 lifted the deprecation of the built-in page — and the Home Assistant Companion App (Android wall panels, sideloaded apps, iOS). Anything that uses the same HA onboarding flow should work — if yours doesn't, open an issue with the failing endpoint trace.

---

## Features

- One URL per display, or one global URL for all
- Auto-discovery via mDNS, plus auto-detect of every VIS / VIS-2 / Aura instance installed on the host (see [Supported dashboards](#supported-dashboards) below)
- Two HA login flows in parallel — the classic JSON `login_flow` for older clients, plus the browser-OAuth2 flow of the Home Assistant app (also the one built into Shelly Wall Display firmware 2.6.0 and newer)
- Mobile-App registration emulation so the HA Companion App finishes onboarding
- Cookie-based: displays keep their URL across reboots, IP changes, renames

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting is active by default. It stays off when the ioBroker diagnostics setting is `none` (`diag` in the system configuration), when data reporting is disabled for this instance or its host (`disableDataReporting`), and on CI systems. A report contains the error with its stack trace and technical context such as versions and platform, plus an anonymous installation ID.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

---

## Supported dashboards

The mode dropdown auto-discovers what's installed on your ioBroker host. You always have the option to paste any other HTTP URL as `manual`.

| Source                          | What gets discovered                                                                                                    | Notes                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ioBroker VIS** (`vis.0`+)     | One entry per project, plus one entry per view inside each project                                                      | Works with every `web.*` instance — multiple web instances get a `(web.X)` suffix on the label                                                                               |
| **ioBroker VIS-2** (`vis-2.0`+) | Same — one entry per project, one per view                                                                              | Project + view encoded into the URL (`?<project>#<view>`); deep links work                                                                                                   |
| **ioBroker Aura** (`aura.0`+)   | One entry per running aura instance, pointing at its frontend                                                           | Reads the actual `native.port` configured in aura (default 8095, ignores the hardcoded value in aura's `localLinks` template) — works with `https` and `customUrl` overrides |
| **Admin tiles**                 | Anything an adapter advertises via `common.localLinks` / `common.welcomeScreen` (jarvis, material, grafana, custom UI…) | Resolves `%ip%`, `%port%`, `%protocol%`, `%bind%`, and cross-instance refs like `%web.0_port%`                                                                               |
| **Manual URL**                  | A free-text URL of your choice — Grafana, Node-RED, custom HTML, anything HTTP/HTTPS                                    | Set the display's `mode` to `manual` and the URL in `manualUrl`. `javascript:`, `data:`, `file:` are rejected for safety                                                     |

Want to add a URL the adapter doesn't auto-detect? Set `manual` and paste it.

---

## Requirements

- Node.js ≥ 22
- ioBroker js-controller ≥ 7.2.2
- ioBroker Admin ≥ 8.0.11

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

---

## Ports

| Port       | Use                                 |
| ---------- | ----------------------------------- |
| 8123 / TCP | HA emulation (fixed, HA standard)   |
| 5353 / UDP | mDNS broadcast (only if mDNS is on) |

Port 8123 is fixed by the HA clients, so each ioBroker host normally runs one instance — a second one on the same host only works when each is bound to its own interface. Several ioBroker hosts in the LAN may each run one; the displays then see separate servers.

**Monitoring:** point uptime monitors and container health checks at `http://<ioBroker-IP>:8123/health` — it answers without creating a display entry. A `GET /` counts as a display's first visit; a `HEAD /` creates nothing.

**All traffic is plain HTTP** — HA clients do not support HTTPS on this flow. Treat port 8123 as LAN-only and never forward it to the internet. With authentication on, the username, password and tokens travel unencrypted over your LAN, so Auth guards the HA API against other LAN devices — it is not internet-exposure protection.

---

## First steps

1. Start the hassemu instance in ioBroker.
2. On the display, add a Home Assistant server. With mDNS on it appears automatically; otherwise enter `http://<ioBroker-IP>:8123` by hand.

   > **Android 17 and newer:** allow _local network access_ when the Home Assistant app asks. Without it the app neither finds hassemu nor can reach it on your network — hassemu is LAN-only, there is no cloud fallback.

3. Complete the HA onboarding on the display. With Auth off you can click through the login; with Auth on, enter the username and password from the instance settings.
4. The display now shows the **landing page** with its own device ID — that means it is connected and waiting for a URL.
5. In ioBroker, open the Object Browser and set `hassemu.0.clients.<id>.mode` for that device: pick a discovered URL from the dropdown, or choose `manual` and put any URL in `clients.<id>.manualUrl`.
6. The display reloads within ~30 seconds and shows your URL.

Want the same URL on every display? Set `global.mode` (plus `global.manualUrl` for a free URL) and turn on the `global.enabled` master switch instead of configuring each client.

---

## Configuration

| Option              | What                                                                              | Default   |
| ------------------- | --------------------------------------------------------------------------------- | --------- |
| Port                        | Fixed at 8123 — every HA client expects it; the form warns if another instance holds it | 8123      |
| Bind to Interface           | Network interface                                                                       | 0.0.0.0   |
| Service Name                | Name the display sees                                                                   | ioBroker  |
| Enable mDNS Discovery       | LAN auto-discovery. Off → set `http://<ioBroker-IP>:8123` on the display by hand.       | on        |
| Require Authentication      | Login required (guards the HA API on the LAN; credentials travel in plain HTTP)         | off       |
| Username / Password         | When authentication is on                                                               | admin / — |
| Trust Reverse Proxy Headers | Only behind a trusted reverse proxy that terminates TLS and strips X-Forwarded-*        | off       |

Leave _Trust Reverse Proxy Headers_ off unless that proxy really exists: without it any client can fake its address on every request. Since 1.40.0 a global per-hour ceiling on new display entries limits the damage, but it does not make the setting safe.

---

## State tree

```
hassemu.0.
├── info.
│   ├── connection      — server is running
│   ├── serverUuid      — server identity (read-only)
│   └── refreshUrls     — re-scan URL list (button, set to true)
├── global.
│   ├── enabled         — master switch
│   ├── mode            — URL choice used by every client whose mode is `global`
│   └── manualUrl       — free-text URL, used when global.mode = `manual`
└── clients.
    └── <id>            — one device per display (named after its hostname or IP)
        ├── mode        — per-client URL choice
        ├── manualUrl   — free-text URL, used when mode = `manual`
        ├── resolvedUrl — the URL this display was actually sent to (read-only)
        ├── ip          — last seen client IP
        └── remove      — forget this client (button, set to true)
```

### Which URL does the display get?

| `mode`        | URL               |
| ------------- | ----------------- |
| `global`      | use `global.mode` |
| `manual`      | use `manualUrl`   |
| a URL         | that URL          |
| empty (`---`) | landing page      |

Master switch:

- **on** — all displays follow `global.mode`
- **off** — all displays go back to `---`
- new displays always start at `---`

---

## Refresh

The display reloads itself within ~30 seconds after a URL change.

After adding or renaming a VIS-2 project or view, set `info.refreshUrls` to `true` so it shows up in the dropdown.

If hassemu goes offline while a display is running, the display switches to a clear offline page with a reload button after ~1.5 minutes and returns to your dashboard automatically once hassemu is back. Limitation: a display that cold-boots _while_ hassemu is down can't load that page and shows a connection error until the adapter is running again.

If the redirect **target** (your VIS/Aura/manual URL) stops answering while hassemu keeps running, the display shows a "Redirect target not reachable" card with the target URL instead of a black screen — after about a minute, or immediately when the display opens while the target is already down. Any HTTP answer counts as reachable (a login page or an error page is still a running server); only connection failures and timeouts trigger the card. Once the target answers again, the display reloads its dashboard automatically.

---

## Troubleshooting

Set the instance log level to `debug` first — since v1.31.1 the adapter traces every decision point (identify, OAuth2, URL discovery, resolver chain, mobile-app webhooks, master switch). Most symptoms are triage-able from that log alone.

**Display can't find the server** — with mDNS on, the log should show `mDNS: Broadcasting`. If that line is missing, mDNS failed to bind (port 5353/UDP). Workaround: turn mDNS off in the instance config and point the display at `http://<ioBroker-IP>:8123` by hand.

**Display shows the wrong URL or the landing page** — open Object Browser, check `clients.<id>.mode` (and `manualUrl` if mode is `manual`). At `mode='global'`, also check `global.mode` / `global.manualUrl`. `clients.<id>.resolvedUrl` shows where the display was actually sent, so you can see the outcome without following the mode chain yourself. The device id is shown on the landing page — it is the `<id>` in `clients.<id>`. The debug log shows the full resolver chain (`chain=global→manual→…`) per request.

**Display lost its identity (new id on every visit)** — the display is not persisting the cookie. Common causes: aggressive privacy mode, factory reset, browser cache flush. Clearing the WebView cache (Shelly firmware 2.7.0 and newer: Settings → Home Assistant) deletes the cookie as well: the display comes back once under a new id and has to run the onboarding again. The old `clients.<id>` entries can be removed via their `remove` button; the root cause is on the display side, not in hassemu.

**Home Assistant app on Android 17 or newer finds nothing and cannot connect** — the app needs _local network access_; allow it when asked, or in the Android app settings. Without it the app cannot reach hassemu at all, not even with the address entered by hand.

**Log warns "More than 100 new clients within an hour across all IPs"** — something is creating display entries far faster than any real setup does. Typical cause: _Trust Reverse Proxy Headers_ is on without a sanitising reverse proxy in front, so a device can fake a different address on every request and slips past the per-address limit. Turn _Trust Reverse Proxy Headers_ off (or put a real proxy in front). Displays keep working meanwhile; the adapter just stops persisting new entries until the burst is over.

**HA Companion App says "Server is not Home Assistant"** — point the app at `http://<ioBroker-IP>:8123`, not at the ioBroker Admin port. If a reverse proxy is in front of hassemu, make sure `/manifest.json` is passed through unmodified — the App parses `name === "Home Assistant"` to verify the server.

**Aura entry in the dropdown points at the wrong port** — `native.port` of the Aura instance must match its actually-listening port. Trigger `info.refreshUrls = true` to re-run discovery after fixing the Aura config.

---

## Upgrade

Migration runs automatically when the adapter starts.

Got scripts that still write to `visUrl`? Update them — write to `manualUrl` instead and set `mode` to `manual`.

**Coming from a Shelly Wall Display on firmware 2.6.0 or newer?** Make sure you're on hassemu **≥ 1.29.2**. The on-device HA app introduced in firmware 2.6.0 needs a server-identity probe, a mobile-app registration step and a WebView "connected" signal — all three came in with v1.29.0–v1.29.2. After upgrading, run the display through the on-device HA onboarding once more. Firmware 2.7.0 lifted the deprecation of the built-in Home Assistant page, so both ways are supported again; hassemu serves both.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- Fixed: a start that fails (port briefly in use, database not up yet) now restarts after 30 seconds instead of leaving the instance off until someone starts it by hand
- Fixed: displays are no longer all removed after the adapter or its host was off for more than 30 days — the cleanup now counts from the most recently seen display
- Fixed: an update from 1.0 or 1.1 no longer resets the global URL choice on every start — the URL you had set before the update stays in place for good
- Fixed: on iOS the Home Assistant app no longer keeps its loading screen over the dashboard, and on Android the bottom of the dashboard no longer hides behind the navigation bar
- Fixed: uptime monitors and container health checks no longer create display entries, and the adapter settings name the /health address meant for them
- Fixed: stopping the adapter no longer waits on open connections or hangs while a display is mid-request, and a stop during the start no longer brings the server up
- Fixed: room and function assignments move along reliably when an old datapoint is replaced, and a read error no longer gives the server a new identity
- Changed: the sign-in hands its code to an unknown address only after a click on Continue, and a signed-in app is disconnected when its display is removed
- Improved: mDNS announces an address the displays can reach — no link-local, container or VPN address — and announces again when the host's address changes
- Improved: the reverse proxy option in the settings and the offline card on the display explain themselves in plain words, in all eleven languages

### 1.45.0 (2026-09-17) — stable

- Fixed: refreshing the dashboard list no longer removes a display's mode datapoint from its rooms and functions, and the datapoint no longer disappears for a moment while it is rewritten
- Fixed: a failed request or migration now names its cause instead of "[object Object]", and an unexpected error inside the web server no longer breaks its own error answer to the display
- Improved: when updating from a version before 1.37.0, the room and function assignments of the renamed URL datapoints move to their successors instead of being lost

### 1.44.0 (2026-09-15)

- Fixed: writing the master switch with the value it already has (a script re-asserting it) no longer resets every display's own choice — only a real change reaches the displays
- Fixed: a disabled web instance no longer adds dashboard entries pointing at a port nobody listens on, and labels get an instance suffix only when more than one web server runs
- Fixed: a display that signed in while the new-display throttle was active got a login that failed on its next request — the sign-in is now refused and works once the throttle lifts
- Improved: a restart no longer rewrites every display's last-seen stamp and target address, and an instance with many displays comes up faster
- Changed: the listen address moved to the standard setting key; an existing value is carried over automatically and the instance restarts once after the update
- Changed: the instance settings now show the fixed port 8123, so the admin can warn when another instance on the same host already holds it

### 1.43.1 (2026-09-07)

- Changed: the button that removes a display now carries a description — it deletes the display's folder and all its states, and the display returns as a new entry on its next request

### 1.43.0 (2026-09-06)

- Fixed: taking a display's choice back (mode `---`, or turning the master switch off) now reaches the display — until now it kept the dashboard it had until someone reloaded it by hand
- Fixed: a display that lost power no longer holds up the adapter's shutdown for 30 seconds
- Fixed: VIS projects are found on every VIS instance, not only on `vis.0` / `vis-2.0`
- Fixed: upgrading from a pre-1.1.1 version no longer overwrites the whole instance configuration while removing the old URL setting
- New: every display now shows the address it was actually sent to, so you can see at a glance where a display landed without walking through the global and per-display settings yourself
- Changed: `info.serverUuid` and `global.enabled` carry clearer labels, and the per-display manual URL now has a description

### 1.42.0 (2026-09-04)

- Fixed: a leftover setting from older versions is now removed from the instance completely instead of only being switched off — switched off, it stayed behind for good

[Older changelogs can be found there](CHANGELOG_OLD.md)

## Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

<!-- prettier-ignore -->
*Developed with assistance from Claude.ai*
