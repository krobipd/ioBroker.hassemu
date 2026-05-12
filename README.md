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

Displays that speak only the HA dashboard protocol — Shelly Wall Display, Echo Show with the HA Companion App, Android tablets running the HA app, in-wall HA panels. The adapter pretends to be HA; the display ends up showing whatever URL you set (VIS, Grafana, Node-RED, anything HTTP).

---

## Features

- One URL per display, or one global URL for all
- Auto-discovery via mDNS
- Optional login (HA OAuth2 flow)
- Cookie-based: displays keep their URL across reboots, IP changes, renames

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
### 1.28.4 (2026-05-12)

- The mode dropdowns in admin (global and per-client) no longer crash with "Error in GUI" when opened.

### 1.28.3 (2026-05-10)

- Adapter starts faster on installations with many displays, and a single broken client entry no longer keeps the others from being restored. Plus a security tighten-up around the HA login flow.

### 1.28.2 (2026-05-09)

- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names, descriptions and dropdown labels (11 languages) are unchanged. The user-facing HA landing page also remains localized.

### 1.28.1 (2026-05-06)

- Documentation: changelog entries (v1.27.x–v1.28.0) restored to English — a few bullets had been left in German. No code changes.

### 1.28.0 (2026-05-06)

- Multi-language: state names, descriptions and dropdown labels are now in your ioBroker system language (11 languages).

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
