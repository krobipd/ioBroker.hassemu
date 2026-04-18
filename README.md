# ioBroker.hassemu

[![npm version](https://img.shields.io/npm/v/iobroker.hassemu)](https://www.npmjs.com/package/iobroker.hassemu)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.hassemu)](https://www.npmjs.com/package/iobroker.hassemu)
![Installations](https://iobroker.live/badges/hassemu-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.hassemu/main/admin/hassemu.svg" width="100" />

Emulates a minimal [Home Assistant](https://www.home-assistant.io) server so devices expecting a Home Assistant dashboard can be redirected to any URL inside your network — without running Home Assistant Core.

Typical use: wall tablets and display devices (Shelly Wall Display, Amazon Echo Show in HA mode, cheap Android tablets with the HA app, …) that only accept a Home Assistant server as their data source, but you want them to show VIS / VIS-2 / Grafana / your own dashboard instead.

> Previously known as `ioBroker.homeassistant-bridge`. Renamed to better reflect that this adapter emulates, not bridges.

---

## Features

- **Per-client redirect URLs** — each display gets its own channel under `clients.*` with an independent URL
- **Optional global override** — one switch sends every client to the same URL
- **URL dropdown** — every URL datapoint suggests the known ioBroker URLs (VIS/VIS-2 projects, Admin tiles, Jarvis, …); free text is allowed
- **Cookie-based identification** — displays are recognised across adapter restarts and IP changes
- **mDNS discovery** — `_home-assistant._tcp` on the LAN, cross-platform, no avahi required
- **Home Assistant OAuth2 flow** — optional credential check
- **Reverse DNS** — LAN hostname per client when resolvable
- **Input hardening** — URLs are restricted to http/https, no credentials, 2048 char cap

---

## Requirements

- **Node.js ≥ 20**
- **ioBroker js-controller ≥ 7.0.0**
- **ioBroker web adapter ≥ 6.0.0**
- **ioBroker Admin ≥ 7.6.20**

---

## Ports

| Port | Protocol | Purpose                                      | Configurable |
| ---- | -------- | -------------------------------------------- | ------------ |
| 8123 | TCP/HTTP | Home Assistant emulation (HA standard port)  | No — fixed   |
| 5353 | UDP      | mDNS service broadcast (only if mDNS enabled)| No           |

Port 8123 is mandatory. Any HA-style display hard-codes that port number, so the adapter cannot run on a different one.

---

## Configuration

Redirect URLs live in datapoints (see below), not in the Admin UI.

| Option                  | Description                                                                 | Default       |
| ----------------------- | --------------------------------------------------------------------------- | ------------- |
| **Bind to Interface**   | Network interface to listen on                                              | 0.0.0.0 (all) |
| **Service Name**        | Name broadcast via mDNS, shown as the server name on the display            | `ioBroker`    |
| **mDNS Enabled**        | Broadcast `_home-assistant._tcp` on the LAN                                 | `true`        |
| **Auth Required**       | Validate the credentials the display sends during the login flow            | `false`       |
| **Username / Password** | Credentials used when *Auth Required* is on (password is encrypted at rest) | `admin` / —   |

---

## Redirect URLs

Two places, both datapoints with a dropdown of all known ioBroker URLs. Free text works too.

- **`hassemu.0.clients.<id>.visUrl`** — per-client URL.
- **`hassemu.0.global.visUrl`** + **`hassemu.0.global.enabled`** — global override. When `enabled` is `true`, every client is sent to `global.visUrl` regardless of the per-client value.

If neither is set, hassemu serves a setup page with the client's device ID and the datapoint to fill in. The page refreshes every 15 s.

URLs must be reachable from the display — use the LAN IP of the ioBroker host, not `localhost`.

---

## Multi-client

As soon as a display connects the first time, a channel is created:

```
hassemu.0.clients.<id>
├── visUrl    — per-client URL (empty = use global or setup page)
├── ip        — last observed IP
├── hostname  — reverse-DNS name (may be empty on some LANs)
└── remove    — button: forget this client
```

- **`remove`** forgets the client — channel, cookie, token, all gone. A returning display is re-registered with a new ID.
- The client ID is a short 6-char string (e.g. `a4b9c2`). Identity is kept via an HttpOnly `hassemu_client` cookie (UUID v4, 10 years).

---

## Redirect flow

1. Display starts → mDNS lookup → finds `hassemu` on port 8123
2. Display performs the HA OAuth2 flow against the adapter
3. On first request the adapter sets a cookie and creates `clients.<id>`
4. Resolution order for the redirect:
   1. `global.enabled = true` → `global.visUrl`
   2. otherwise `clients.<id>.visUrl`
   3. otherwise the setup page
5. Next time the display connects, the cookie maps it back to the same channel

---

## State tree

```
hassemu.0.
├── info.connection          — Server is running (bool, indicator)
├── global.
│   ├── visUrl               — Global redirect URL (dropdown)
│   └── enabled              — Apply global URL to all clients (switch)
└── clients.
    └── <id>.
        ├── visUrl           — Per-client redirect URL (dropdown)
        ├── ip               — Last seen client IP
        ├── hostname         — Reverse-DNS hostname (may be empty)
        └── remove           — Button: forget this client
```

---

## Troubleshooting

### Display cannot find the server

The adapter broadcasts `_home-assistant._tcp` via mDNS. If the display does not find the server automatically:

1. Check the adapter log for `mDNS: Broadcasting`.
2. Verify the service is visible from another host:
   ```bash
   # macOS
   dns-sd -B _home-assistant._tcp
   # Linux (with avahi-utils)
   avahi-browse _home-assistant._tcp -r -t
   ```
3. Make sure UDP 5353 is not blocked by a firewall.
4. If mDNS is not usable on your LAN, set the URL manually on the display: `http://<ioBroker-IP>:8123`.

### Display is redirected to the wrong dashboard

If the global override is on, it wins — check `global.enabled` and `global.visUrl` first. Otherwise the per-client `clients.<id>.visUrl` applies. Empty on both sides means the setup page is served.

### Display keeps getting a new ID

That means the cookie is not being sent back. Check the display's browser/WebView — some devices with aggressive privacy settings delete cookies on restart. Nothing the adapter can do about it; worst case is a new channel per boot. Delete stale channels with the `remove` button.

### Reverse DNS shows nothing

Reverse DNS on a home LAN often fails — it depends on your router/DHCP server. The IP is always recorded; the hostname is best-effort.

### Health check

```
http://<IP>:8123/health
```
returns the adapter's runtime state — useful to verify the server is up and see which features are active.

---

## Upgrading

- **1.0.x / 1.1.0 → 1.1.1** — any existing redirect URL is copied to `global.visUrl`, `global.enabled` is set to `true`. To switch to per-display URLs, clear `global.enabled` and fill each `clients.<id>.visUrl`.

---

## Changelog

### 1.1.1 (2026-04-18)

- Redirect URL moved from Admin config to datapoints: `global.visUrl` + `global.enabled`, otherwise each `clients.<id>.visUrl`
- Setup page served when no URL is configured (shows device ID + datapoint path)
- `web` adapter declared as dependency
- Legacy `defaultVisUrl` migrates to `global.visUrl` + `global.enabled=true` on first start

### 1.1.0 (2026-04-18)

- **Multi-client support** — each connecting display gets its own channel in `clients.*` with an individual `visUrl`, `ip`, `hostname` and `remove` button
- **URL dropdown** — `clients.<id>.visUrl` is populated from all known ioBroker URLs (VIS-2, VIS, Admin intro tiles, Jarvis, …) — pick from the list or enter custom
- **Cookie-based identification** — displays are recognised across adapter restarts and IP changes
- **Fastify web server** — Express was replaced by Fastify for first-party cookie support, schema validation and a lighter runtime
- **Input hardening** — all external URLs go through a coercion layer (http/https only, length-limited, no credentials); foreign adapter metadata is fully type-guarded
- **Config migration** — `visUrl` → `defaultVisUrl` is applied automatically on first start
- **Reverse DNS** — clients are labelled with their LAN hostname when resolvable

### 1.0.4 (2026-04-12)
- DRY: remove duplicate NativeConfig interface and redundant config mapping
- Fix: log spam when redirect URL is not configured (now logged once at startup)
- Tighten `createSession` visibility to private

### 1.0.3 (2026-04-12)
- Remove unused devDependencies, add `no-floating-promises` lint rule, remove redundant CI checkout

### 1.0.2 (2026-04-08)
- Remove `build/` from git tracking, fix `.gitignore`, clean up keywords and metadata

### 1.0.0 (2026-04-08)
- Renamed from homeassistant-bridge to hassemu

Older entries are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

---

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.hassemu/issues)

### Support development

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
