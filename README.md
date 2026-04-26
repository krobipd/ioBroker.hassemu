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
- **Reverse DNS** — LAN hostname shown as the client's name in the object tree when resolvable
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

The Admin UI only configures the server itself. Redirect URLs and per-client overrides live in the state tree below.

| Option                  | Description                                                                 | Default       |
| ----------------------- | --------------------------------------------------------------------------- | ------------- |
| **Bind to Interface**   | Network interface to listen on                                              | 0.0.0.0 (all) |
| **Service Name**        | Name broadcast via mDNS, shown as the server name on the display            | `ioBroker`    |
| **mDNS Enabled**        | Broadcast `_home-assistant._tcp` on the LAN                                 | `true`        |
| **Auth Required**       | Validate the credentials the display sends during the login flow            | `false`       |
| **Username / Password** | Credentials used when *Auth Required* is on (password is encrypted at rest) | `admin` / —   |

---

## State tree

```
hassemu.0.
├── info.connection                — Server is running (bool, indicator)
├── global.
│   ├── visUrl                     — Global redirect URL (dropdown of known ioBroker URLs, free text allowed)
│   └── enabled                    — When true, every client is sent to global.visUrl
└── clients.
    └── <id>                       — One channel per display. Channel name = reverse-DNS hostname if resolvable, otherwise the IP
        ├── visUrl                 — Per-client redirect URL (same dropdown as global). Used when global.enabled = false
        ├── ip                     — Last observed client IP
        └── remove                 — Button: forget this client (channel + cookie + token deleted)
```

**Resolution per request:** `global.enabled=true` → `global.visUrl`, otherwise `clients.<id>.visUrl`, otherwise the setup page (a small HTML placeholder with the device ID and datapoint path, refreshes every 15 s).

**Client identity:** each display gets a 6-char id (e.g. `a4b9c2`) and a persistent HttpOnly cookie `hassemu_client` (UUID v4, 10 years). The cookie survives IP changes and adapter restarts. Removing a client and re-visiting creates a fresh channel with a new id. URLs must be reachable from the display — use the LAN IP of the ioBroker host, not `localhost`.

**Connection flow:** display discovers `hassemu` via mDNS (or manual URL) → runs the HA OAuth2 flow → adapter sets the cookie and creates `clients.<id>` → redirect resolves as above.

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

Reverse DNS on a home LAN often fails — it depends on your router/DHCP server. The IP is always recorded and used as the client's name when no hostname is available.

### Health check

```
http://<IP>:8123/health
```
returns the adapter's runtime state — useful to verify the server is up and see which features are active.

---

## Upgrading

- **1.1.1 → 1.1.2** — the `clients.<id>.hostname` datapoint is dropped; the hostname is moved into the channel name (visible in the Admin object browser). Nothing to do manually — the adapter migrates on first start.
- **1.0.x / 1.1.0 → 1.1.1** — any existing redirect URL is copied to `global.visUrl`, `global.enabled` is set to `true`. To switch to per-display URLs, clear `global.enabled` and fill each `clients.<id>.visUrl`.

---

## Changelog

### **WORK IN PROGRESS**
- Process-level `unhandledRejection` / `uncaughtException` handlers added as last-line-of-defence against fire-and-forget rejections.
- Stop shipping the `manual-review` release-script plugin — adapter-only consequence.
- Audit-driven boilerplate sync with the other krobi adapters (`.vscode` json5 schemas, `tsconfig.test` looser test rules).
- Min js-controller correction: was `>=7.0.0`, restored to repochecker-recommended `>=6.0.11` (Source: `ioBroker.repochecker/lib/M1000_IOPackageJson.js`).
- `@types/iobroker` bumped to `^7.1.1`.

### 1.1.4 (2026-04-23)
- Separate test-build output (`build-test/`) from production `build/` — `npm test` no longer risks leaving duplicated `build/src` + `build/test` trees in the published package. No runtime change.

### 1.1.3 (2026-04-19)

- **Fix duplicate client registration on first connect** — HA displays fire several parallel cookieless requests (`GET /`, `GET /api/`, `POST /auth/login_flow`) within milliseconds of each other. Each used to create a separate client record, leaving orphans behind. The registry now locks per IP while the first client is being created, so parallel burst requests from the same display attach to the same client and cookie.
- **Setup page redesigned** — big green OK banner so "everything's connected" is visible at a glance, responsive layout with dark-mode support, IP shown alongside the device ID, clearer step-by-step instructions.
- **Setup page localized into all 11 adapter languages** — automatically picks the ioBroker system language (set in Admin → Main Settings), falls back to English for unknown languages.

### 1.1.2 (2026-04-18)

- Client name in the object browser now shows the reverse-DNS hostname instead of the IP as soon as it's resolved
- `clients.<id>.hostname` datapoint removed — the value moved into the channel name; existing entries are migrated on first start
- Client-channel creation parallelised — new displays register noticeably faster

### 1.1.1 (2026-04-18)

- Redirect URL moved from Admin config to datapoints: `global.visUrl` + `global.enabled`, otherwise each `clients.<id>.visUrl`
- Setup page served when no URL is configured (shows device ID + datapoint path)
- `web` adapter declared as dependency
- Legacy `defaultVisUrl` migrates to `global.visUrl` + `global.enabled=true` on first start

### 1.1.0 (2026-04-18)

- **Multi-client support** — each connecting display gets its own channel in `clients.*` with an individual `visUrl`, `ip` and `remove` button
- **URL dropdown** — `clients.<id>.visUrl` is populated from all known ioBroker URLs (VIS-2, VIS, Admin intro tiles, Jarvis, …) — pick from the list or enter custom
- **Cookie-based identification** — displays are recognised across adapter restarts and IP changes
- **Fastify web server** — Express was replaced by Fastify for first-party cookie support, schema validation and a lighter runtime
- **Input hardening** — all external URLs go through a coercion layer (http/https only, length-limited, no credentials); foreign adapter metadata is fully type-guarded
- **Config migration** — `visUrl` → `defaultVisUrl` is applied automatically on first start
- **Reverse DNS** — clients are labelled with their LAN hostname when resolvable (shown as the channel name in the object browser)

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

---

*Developed with assistance from Claude.ai*
