# ioBroker.hassemu

[![npm version](https://img.shields.io/npm/v/iobroker.hassemu)](https://www.npmjs.com/package/iobroker.hassemu)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.hassemu)](https://www.npmjs.com/package/iobroker.hassemu)
![Installations](https://iobroker.live/badges/hassemu-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.hassemu/main/admin/hassemu.svg" width="100" />

Emulates a Home Assistant server so displays that only accept an HA dashboard show any web URL instead.

---

## What it's for

Some smart displays are hardwired to "I only speak Home Assistant". hassemu pretends to be that Home Assistant — the display connects, completes its onboarding, and then shows whatever web URL you choose (VIS, VIS-2, Aura, Grafana, Node-RED, anything HTTP).

### Tested displays and clients

| Device / client | Firmware / version | Status |
| --- | --- | --- |
| Shelly Wall Display XL (SAWD-3A1XE10EU2, 10") | 1.x – 2.5.x | works (built-in HA page) |
| Shelly Wall Display XL | **2.6.0+** | works since hassemu 1.29.2 (on-device HA app: browser OAuth2 + mobile-app registration + WebView connection signal) |
| Shelly Wall Display (SAWD1, 4") | 1.x – 2.5.x | works (built-in HA page) |
| Shelly Wall Display X2 / X2i (6.95") | 1.x – 2.5.x | works |
| Home Assistant Companion App (Android) | 2024.x+ | works since hassemu 1.29.x — sideload onto any Android-based wall panel or tablet |
| HA Companion-style WebView (Sonoff NSPanel Pro, generic Android wall panels) | — | works since 1.29.x |

Other HA-Dashboard-only clients should work too. If you run one that doesn't, open an issue with the failing endpoint trace.

---

## Features

- One URL per display, or one global URL for all
- Auto-discovery via mDNS, plus auto-detect of every VIS / VIS-2 / Aura instance installed on the host (see [Supported dashboards](#supported-dashboards) below)
- Two HA login flows in parallel — the classic JSON `login_flow` for older clients, plus the browser-OAuth2 flow used by the on-device HA app on Shelly Wall Display 2.6.0+
- Mobile-App registration emulation so the HA Companion App finishes onboarding
- Cookie-based: displays keep their URL across reboots, IP changes, renames

---

## Supported dashboards

The mode dropdown auto-discovers what's installed on your ioBroker host. You always have the option to paste any other HTTP URL as `manual`.

| Source | What gets discovered | Notes |
| --- | --- | --- |
| **ioBroker VIS** (`vis.0`+) | One entry per project, plus one entry per view inside each project | Works with every `web.*` instance — multiple web instances get a `(web.X)` suffix on the label |
| **ioBroker VIS-2** (`vis-2.0`+) | Same — one entry per project, one per view | Project + view encoded into the URL (`?<project>#<view>`); deep links work |
| **ioBroker Aura** (`aura.0`+) | One entry per running aura instance, pointing at its frontend | Reads the actual `native.port` configured in aura (default 8095, ignores the hardcoded value in aura's `localLinks` template) — works with `https` and `customUrl` overrides |
| **Admin tiles** | Anything an adapter advertises via `common.localLinks` / `common.welcomeScreen` (jarvis, material, grafana, custom UI…) | Resolves `%ip%`, `%port%`, `%protocol%`, `%bind%`, and cross-instance refs like `%web.0_port%` |
| **Manual URL** | A free-text URL of your choice — Grafana, Node-RED, custom HTML, anything HTTP/HTTPS | Set the display's `mode` to `manual` and the URL in `manualUrl`. `javascript:`, `data:`, `file:` are rejected for safety |

Want to add a URL the adapter doesn't auto-detect? Set `manual` and paste it.

---

## Requirements

- Node.js ≥ 22
- ioBroker js-controller ≥ 7.0.7
- ioBroker Admin ≥ 7.8.23
- ioBroker web ≥ 8.0.0

---

## Ports

| Port | Use |
| --- | --- |
| 8123 / TCP | HA emulation (fixed, HA standard) |
| 5353 / UDP | mDNS broadcast (only if mDNS is on) |

One instance per host. Port 8123 is HA-fixed. With multiple ioBroker hosts on the same LAN, only one of them runs hassemu.

---

## Configuration

| Option | What | Default |
| --- | --- | --- |
| Bind | Network interface | 0.0.0.0 |
| Service Name | Name the display sees | ioBroker |
| mDNS | LAN auto-discovery. Off → set `http://<ioBroker-IP>:8123` on the display by hand. | on |
| Auth | Login required | off |
| Username / Password | When Auth is on | admin / — |

---

## State tree

```
hassemu.0.
├── info.
│   ├── connection      — server is running
│   ├── serverUuid      — server identity (read-only)
│   └── refresh_urls    — re-scan URL list (button, set to true)
├── global.
│   ├── enabled         — master switch
│   ├── mode            — URL choice used by every client whose mode is `global`
│   └── manualUrl       — free-text URL, used when global.mode = `manual`
└── clients.
    └── <id>            — one channel per display (channel name = hostname or IP)
        ├── mode        — per-client URL choice
        ├── manualUrl   — free-text URL, used when mode = `manual`
        ├── ip          — last seen client IP
        └── remove      — forget this client (button, set to true)
```

### Which URL does the display get?

| `mode`        | URL                            |
| ------------- | ------------------------------ |
| `global`      | use `global.mode`              |
| `manual`      | use `manualUrl`                |
| a URL         | that URL                       |
| empty (`---`) | landing page                   |

Master switch:
- **on** — all displays follow `global.mode`
- **off** — all displays go back to `---`
- new displays always start at `---`

---

## Refresh

The display reloads itself within ~30 seconds after a URL change.

After adding or renaming a VIS-2 project or view, set `info.refresh_urls` to `true` so it shows up in the dropdown.

---

## When something is off

**Display can't find the server** — check the log for `mDNS: Broadcasting`. If mDNS doesn't work on your LAN, set `http://<ioBroker-IP>:8123` on the display by hand.

**Display shows the wrong page** — check `clients.<id>.mode`. The device id is on the landing page (or in `clients.<id>.ip`).

**URL changed, display still shows the old one** — the auto-reload takes up to 30 seconds. After that, reboot the display.

**Display gets a new ID every time** — display isn't keeping its cookie. Delete stale channels via the `remove` button.

**Shelly Wall Display 2.6.0+ shows a "Connection to Home Assistant failed" popup** (the on-device language may say it differently — same root cause) — upgrade hassemu to **≥ 1.29.2**. The on-device HA app introduced in firmware 2.6.0 needs a server-identity probe, a mobile-app registration step, and a WebView "connected" signal that earlier hassemu versions didn't answer. After the upgrade, take the display through the on-device HA onboarding once more.

**HA Companion App says "Server is not Home Assistant"** — make sure you point the app at `http://<ioBroker-IP>:8123`, not the ioBroker admin port. hassemu's `/manifest.json` reports `"name": "Home Assistant"` as the app expects; if the probe still fails, your reverse proxy (if any) is probably stripping that path.

**The Aura entry in the dropdown points at the wrong port** — make sure aura's `native.port` matches what the adapter is actually listening on. The adapter ignores aura's hardcoded `localLinks` template; the value comes from `native.port` directly.

---

## Upgrade

Migration runs automatically when the adapter starts.

Got scripts that still write to `visUrl`? Update them — write to `manualUrl` instead and set `mode` to `manual`.

---

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 1.29.2 (2026-05-12)

- Shelly Wall Display on firmware 2.6.0+ no longer shows the connection-error popup after the page has loaded.
- The mode dropdown now auto-discovers Aura instances (frontend at the configured port).
- The landing page now carries the ioBroker logo, and the README has a clear table of every dashboard source the adapter recognizes.

### 1.29.1 (2026-05-12)

- Shelly Wall Display onboarding under firmware 2.6.0 and newer now completes — the on-device Home Assistant app needs a device-registration step that the adapter now provides.

### 1.29.0 (2026-05-12)

- Shelly Wall Displays running firmware 2.6.0 and newer connect again. The new on-device Home Assistant app uses a browser sign-in flow and a server identity check that the previous adapter version did not answer.

### 1.28.4 (2026-05-12)

- The mode dropdowns in admin (global and per-client) no longer crash with "Error in GUI" when opened.

### 1.28.3 (2026-05-10)

- Adapter starts faster on installations with many displays, and a single broken client entry no longer keeps the others from being restored. Plus a security tighten-up around the HA login flow.

Older entries are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.hassemu/issues)

### Support Development

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

*Developed with assistance from Claude.ai*
