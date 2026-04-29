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

ioBroker adapter that emulates a [Home Assistant](https://www.home-assistant.io) server so displays which only accept an HA server can show any web URL on your network instead.

---

## When to use this adapter

**Use it for displays that only speak the HA dashboard protocol but should render something else** — VIS, Grafana, a Node-RED dashboard, anything served over HTTP. Examples: Shelly Wall Display, Amazon Echo Show with the HA Companion App, Android tablets running the HA app, in-wall panels with built-in HA support.

---

## Features

- **One URL per display** — each display gets its own channel under `clients.*` with a dropdown of discovered ioBroker URLs (VIS, VIS-2, Admin tiles) or a free-text URL
- **Master switch** — `global.enabled` points every display at the same URL; flip it back and each display picks up its own again
- **mDNS discovery** — displays find the adapter automatically on the LAN
- **Home Assistant OAuth2 flow** — optional username/password
- **Cookie-based identification** — displays keep their URL across restarts, IP changes and renames

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 7.0.7**
- **ioBroker Admin >= 7.7.22**
- **ioBroker web >= 8.0.0**

---

## Ports

| Port | Protocol | Purpose                                      | Configurable |
| ---- | -------- | -------------------------------------------- | ------------ |
| 8123 | TCP/HTTP | Home Assistant emulation (HA standard port)  | No — fixed   |
| 5353 | UDP      | mDNS service broadcast (only if mDNS enabled)| No           |

---

## Configuration

The Admin UI configures the server. Redirect URLs are set via the state tree (see below).

| Option | Description | Default |
|--------|-------------|---------|
| **Bind to Interface** | Network interface to listen on | 0.0.0.0 (all) |
| **Service Name** | Name broadcast via mDNS, shown as the server name on the display | `ioBroker` |
| **mDNS Enabled** | Broadcast `_home-assistant._tcp` on the LAN | `true` |
| **Auth Required** | Check credentials the display sends during login | `false` |
| **Username / Password** | Used when *Auth Required* is on (password encrypted at rest) | `admin` / — |

---

## State Tree

```
hassemu.0.
├── info.connection              — Server is running (bool)
├── global.
│   ├── enabled                  — Master switch (see below)
│   ├── mode                     — Dropdown of discovered URLs + 'manual'
│   └── manualUrl                — Free-text URL used when global.mode='manual'
└── clients.
    └── <id>                     — One channel per display. Channel name = reverse-DNS hostname if resolvable, else the IP
        ├── mode                 — Dropdown: discovered URLs + 'global' (follow master) + 'manual' (use manualUrl)
        ├── manualUrl            — Free-text URL used when mode='manual'
        ├── ip                   — Last observed client IP
        └── remove               — Button: forget this client (channel + cookie + token deleted)
```

### How the display gets its URL

The adapter reads `clients.<id>.mode` on every visit:

| `mode` value | redirect target |
|--------------|----------------|
| `global` | `global.mode` / `global.manualUrl` (same rules, one level up) |
| `manual` | `clients.<id>.manualUrl` |
| a URL | that URL |
| empty / unknown | landing page (small HTML with device ID, refreshes every 15 s) |

### Master switch

When `global.enabled` is **on**, every client's `mode` is set to `global` and all displays follow `global.mode`. When **off**, every client's `mode` is set to the first discovered URL (or `manual` if nothing was discovered). New clients pick up the same default.

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

Look at `clients.<id>.mode` (the device id is shown on the landing page, or read it from `clients.<id>.ip`):

- `global` → look at `global.mode` / `global.manualUrl`
- `manual` → look at `clients.<id>.manualUrl`
- a URL → that's where the display goes

Empty `mode` serves the landing page — pick one of the above.

### URL was changed but the display still shows the old dashboard

After the display has been redirected once, it's running on the target dashboard and doesn't ask hassemu again. Reboot the display, or use its built-in "reload" function if it has one.

### Display keeps getting a new ID

The display's WebView is dropping the cookie on restart (aggressive privacy settings). Delete stale channels via the `remove` button — there's nothing the adapter can do beyond that.

### Reverse DNS shows nothing

Reverse DNS on a home LAN depends on your router/DHCP server and often fails. The IP is used as the client's name when no hostname is available.

---

## Upgrading

- **1.1.6 → 1.2.0** — `clients.<id>.visUrl` and `global.visUrl` replaced by `mode` (dropdown) + `manualUrl` (free text). Migration runs automatically. Scripts pointing at the old `visUrl` paths need to be updated to the new datapoints in the State Tree above.
- **1.1.1 → 1.1.2** — `clients.<id>.hostname` datapoint dropped, value moves into the channel name. Migrates automatically.
- **1.0.x / 1.1.0 → 1.1.1** — existing redirect URL is moved into the state tree. 1.2.0 then migrates further as above.

---

## Changelog
### 1.2.0 (2026-04-29)

- (krobi) Redirect target now configured via `mode` (dropdown) + `manualUrl` (free text) instead of the old `visUrl`. Migration runs automatically.
- (krobi) Master switch `global.enabled` bulk-syncs every display: on → all follow the global URL, off → each display picks up its own again.
- (krobi) Idle displays without auth token are auto-removed after 30 days.
- (krobi) Security hardening of the auth flow.
- (krobi) `web` adapter declared as dependency — needed for the URL dropdown.

### 1.1.6 (2026-04-28)
- Audit cleanup against the upstream `ioBroker.example/TypeScript` full standard:
  - Test setup migrated: tests now live next to source as `src/lib/*.test.ts` and run directly via `ts-node/register`. Removed `tsconfig.test.json` + `build-test/`, added `test/mocharc.custom.json` + `test/mocha.setup.js` + `test/tsconfig.json` + `test/.eslintrc.json`
  - `@types/node` rolled back from `^25.6.0` to `^20.19.24` so type defs match `engines.node: ">=20"`
  - Dependabot now ignores major bumps for `@types/node`, `typescript`, `eslint`, `actions/checkout`, `actions/setup-node`
  - `nyc` config + `coverage` script added
  - Orphan `.github/auto-merge.yml` removed (active workflow is `automerge-dependabot.yml` using `gh pr merge`)

### 1.1.5 (2026-04-26)
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

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.hassemu/issues)

If the adapter is useful to you, consider buying me a coffee:

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
