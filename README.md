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

- **Node.js >= 22**
- **ioBroker js-controller >= 7.0.7**
- **ioBroker Admin >= 7.7.22**
- **ioBroker web >= 8.0.0**

---

## Ports

| Port | Protocol | Purpose                                       | Configurable |
| ---- | -------- | --------------------------------------------- | ------------ |
| 8123 | TCP/HTTP | Home Assistant emulation (HA standard port)   | No — fixed   |
| 5353 | UDP      | mDNS service broadcast (only if mDNS enabled) | No           |

---

## Configuration

The Admin UI configures the server. Redirect URLs are set via the state tree (see below).

| Option                  | Description                                                      | Default       |
| ----------------------- | ---------------------------------------------------------------- | ------------- |
| **Bind to Interface**   | Network interface to listen on                                   | 0.0.0.0 (all) |
| **Service Name**        | Name broadcast via mDNS, shown as the server name on the display | `ioBroker`    |
| **mDNS Enabled**        | Broadcast `_home-assistant._tcp` on the LAN                      | `true`        |
| **Auth Required**       | Check credentials the display sends during login                 | `false`       |
| **Username / Password** | Used when _Auth Required_ is on (password encrypted at rest)     | `admin` / —   |

---

## State Tree

```
hassemu.0.
├── info.
│   ├── connection               — Server is running (bool)
│   ├── serverUuid               — Stable server identity reported via mDNS / discovery_info (read-only, persists across restarts)
│   └── refresh_urls             — Button: re-scan VIS / VIS-2 / Admin URLs without restarting the adapter (set to true)
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

| `mode` value    | redirect target                                                |
| --------------- | -------------------------------------------------------------- |
| `global`        | `global.mode` / `global.manualUrl` (same rules, one level up)  |
| `manual`        | `clients.<id>.manualUrl`                                       |
| a URL           | that URL                                                       |
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

Since v1.7.0 the adapter wraps the target URL in an HTML page that polls `/api/redirect_check` every 30 seconds — on a `mode` or `manualUrl` change the display reloads itself within ~30s, no soft-reboot needed.

If a display is still stuck on the old URL after that, it was probably wired to the target dashboard directly (bypassing the adapter) or it's caching aggressively. Reboot the display, or use its built-in "reload" function if it has one.

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
### **WORK IN PROGRESS**

- **Adapter beendet sich bei Server-Start-Fehler** (Port belegt etc.) jetzt mit Exit-Code 11 — js-controller startet ihn nach Backoff neu, statt zombie idle zu sitzen.
- **mDNS-Broadcast-Fehler ist jetzt sichtbar**: `warn`-Meldung im Log + `mDNS FAILED` im running-Status (vorher still).
- **Compact-Mode**: `unhandledRejection`/`uncaughtException`-Handler nur einmal pro Node-Prozess (Module-Level-Flag), nicht pro Instance.
- **onUnload löst Subscriptions explizit auf** vor dem Null-Set — verhindert Residual-Calls auf genullte Instance bei hot-remove.

### 1.9.1 (2026-05-05)

- **Interne Aufräumung**: 5xx-Error-Cooldown-Map (eingeführt in v1.9.0) nutzt jetzt denselben FIFO-Eviction-Helper wie alle anderen gedeckelten Maps im Server — vorher inline-inkonsistent.
- **Test-Coverage**: 5 neue Unit-Tests für die Cooldown-Logik (erste Beobachtung, Window-Wiederholung, Window-Ablauf, unabhängige Keys, FIFO-Cap).

### 1.9.0 (2026-05-05)

- **Weniger Log-Spam unter Attacke**: 5xx-Fehler werden pro Message nur beim ersten Auftritt als `warn` geloggt (60s-Cooldown), Wiederholungen fallen auf `debug`.
- **Adapter-Start ~4× schneller bei vielen Displays**: `restore()` liest die vier Datenpunkte pro Client parallel statt sequenziell.
- **Kleinere Härtung**: Landing-Page-Übersetzungen `as const satisfies` (immutable), Port-Felder lehnen Hex/Exponential ab, `MDNSService.active` extern read-only.

### 1.8.1 (2026-05-05)

- **Master-Switch schneller**: `global.enabled`-Toggle schreibt das `mode` aller Clients jetzt parallel statt sequenziell (vorher N Broker-Round-Trips). Spürbar auf Instanzen mit vielen Displays.
- **Mode-Dropdown bleibt gefüllt** wenn der Broker beim Lesen der `vis-2.0`/`web.0`-Objekte kurz nicht antwortet — der zuletzt funktionierende Stand wird gehalten statt mit `{}` überschrieben.
- **Reverse-DNS-Lookup hat 5s-Timeout**: ein langsamer/blockierter LAN-Nameserver hängt den HA-Auth-Flow nicht mehr.

### 1.8.0 (2026-05-05)

- **Code-Aufräumen**: Konstanten (Cookie-TTL, Map-Caps, Mode-Sentinels, Stale-TTL) liegen jetzt zentral in `lib/constants.ts`. Verhalten unverändert.
- **Logging weniger laut**: Token-Endpunkt-Fehler (unbekannter `flow_id`, ungültiger Refresh-Token, falscher `grant_type`) jetzt `debug` statt `warn`.

### 1.7.1 (2026-05-05)

- Hotfix: drei Prettier-Format-Fehler aus v1.7.0 behoben (CI-Lint-Gate war rot, deploy hat v1.7.0 nicht auf npm gebracht). v1.7.0-Änderungen erreichen npm jetzt mit dieser Version.

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
