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

Emulates a minimal [Home Assistant](https://www.home-assistant.io) server so that devices expecting a Home Assistant dashboard can be redirected to any custom web URL — without running a real Home Assistant Core.

> Previously known as `ioBroker.homeassistant-bridge`. Renamed to better reflect that this adapter emulates, not bridges.

---

## Features

- **Home Assistant Emulation** — minimal HA API for devices expecting a Home Assistant dashboard
- **mDNS Discovery** — automatic detection via `_home-assistant._tcp` (cross-platform)
- **OAuth2-like Auth Flow** — full login flow emulation, optional credential validation
- **Flexible Redirect** — send the display to any ioBroker VIS, VIS-2, or custom web URL
- **Modern Admin UI** — JSON-Config for easy configuration

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 7.0.0**
- **ioBroker Admin >= 7.6.20**

---

## Ports

| Port | Protocol | Purpose | Configurable |
|------|----------|---------|--------------|
| 8123 | TCP/HTTP | Home Assistant emulation (HA standard port) | No — fixed |

---

## Configuration

Configuration is done via the Admin UI (jsonConfig):

| Option | Description | Default |
|--------|-------------|---------|
| **Bind to Interface** | Network interface to listen on | 0.0.0.0 (all) |
| **Redirect URL** | Target URL for the display (e.g., VIS) | *must be set* |
| **mDNS Enabled** | mDNS Service Discovery | enabled |
| **Service Name** | Name in the network | "ioBroker" |
| **Auth Required** | Validate credentials | disabled |
| **Username** | Login name (if auth enabled) | "admin" |
| **Password** | Login password (stored encrypted) | - |

> **Important: Port 8123 is mandatory.** The adapter always listens on port 8123 — this is the standard Home Assistant port and cannot be changed. Make sure port 8123 is not already in use on your ioBroker server.

**Important:** The redirect URL must be a network-accessible address, e.g.:
```
http://192.168.1.100:8082/vis/index.html
```

`localhost` will not work because the display calls the URL!

---

## State Tree

```
hassemu.0.
└── info.connection      — Server is running (bool)
```

---

## Troubleshooting

### Display cannot find the server (mDNS)

The adapter broadcasts a `_home-assistant._tcp` mDNS service. If the display does not find the server automatically, configure it manually:

```
IP:   <ioBroker-IP>
Port: 8123
```

1. Check if the adapter log shows "mDNS: Broadcasting" on startup.

2. Verify the service is visible on the network:
   ```bash
   # macOS
   dns-sd -B _home-assistant._tcp
   # Linux (if avahi-utils installed)
   avahi-browse _home-assistant._tcp -r -t
   ```

3. Make sure mDNS port 5353/UDP is not blocked by a firewall.

4. If mDNS doesn't work, use manual configuration on the display with the ioBroker server's IP address.

### Health Check

The adapter provides a health endpoint:
```
http://<IP>:8123/health
```

---

## Changelog

### 1.0.2 (2026-04-08)
- Remove build/ from git tracking, fix .gitignore, clean up keywords and metadata

### 1.0.0 (2026-04-08)
- Renamed from homeassistant-bridge to hassemu

Older changelog: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)

---

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
