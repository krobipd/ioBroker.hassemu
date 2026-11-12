# hassemu — put any web page on a display that only accepts Home Assistant

Some wall displays will only talk to a Home Assistant server. They run through the HA
onboarding, and after that they show an HA dashboard — and nothing else. hassemu answers
the parts of the HA protocol those displays ask for, so the onboarding completes, and then
sends the display to whatever web page you choose: a VIS view, an Aura dashboard, Grafana,
Node-RED, a page you wrote yourself.

It is not a Home Assistant bridge. Nothing is imported from HA, and no ioBroker states are
exposed as HA entities. The adapter emulates just enough of an HA server for the display to
accept it, and then gets out of the way.

This page is the detailed guide. The [README](../../README.md) is the short version.

## Requirements

- Node.js 22 or newer
- ioBroker js-controller 7.2.5 or newer
- ioBroker Admin 8.3.5 or newer
- The display and ioBroker on the same network

The adapter listens on port 8123 by default, the port Home Assistant uses; the Home Assistant
apps take the port from the address the server announces or the one you type in. Another port
lets hassemu run on a host where 8123 is taken already, and a second instance on the same host
needs its own port or its own interface. Several ioBroker hosts in the network may each run
one; the displays then see separate servers.

## Shelly Wall Display

The Shelly Wall Display family comes in legacy models (Stargate, X2) and modern ones (XL,
X2i, X1i, U1, D1). A display reaches hassemu in one of two ways:

- **the built-in Home Assistant page** — the original way; firmware 2.7.0 lifted its
  deprecation
- **the on-device Home Assistant app** of firmware 2.6.0 and newer — it runs the same
  onboarding as the Companion App on a phone

hassemu serves both. Firmware 2.7.0 also added _clear WebView cache_ (Settings → Home
Assistant). That deletes the cookie the display is identified by: afterwards it shows up once
under a new id and runs the onboarding again. Remove the old entry with its `remove` button.

## Setting it up

### 1. Create the instance

Install the adapter and start instance 0. In the instance settings you normally change
nothing to begin with: mDNS is on, authentication is off, and the adapter binds to all
interfaces.

If your ioBroker host has several network cards, set **Bind to Interface** to the one your
displays are on. The adapter announces itself under that address, so announcing an address
the display cannot reach is the most common reason discovery "works" but the display then
fails to connect.

### 2. Add the server on the display

On the display, add a Home Assistant server.

- **With mDNS on** the display finds the server by itself. It appears under the name in
  **Service Name** (default `ioBroker`).
- **Without mDNS**, or when the display does not search, enter the address by hand:
  `http://<ip-of-your-ioBroker>:8123` (with another port, that port). With HTTPS on it is
  `https://<name in the certificate>:8123` — see
  [Authentication and your network](#authentication-and-your-network).

**Android 17 and newer:** allow _local network access_ when the Home Assistant app asks.
Without it the app neither finds hassemu nor can reach it on your network — hassemu is
LAN-only, there is no cloud fallback.

### 3. Complete the onboarding

The display now runs the HA login. With authentication off you click straight through. With
authentication on, enter the user name and password from the instance settings.

Behind that click the display and the adapter exchange a token, and the adapter stores a
cookie on the display. That cookie is the display's identity from then on: it survives
reboots, address changes and name changes, which is why a display keeps its page without being
set up again.

### 4. The display is now waiting

When onboarding finishes, the display shows a small page with a device ID on it. That page
means: connected, but no page picked yet. The ID is what identifies this display in the
object tree.

### 5. Tell the display what to show

Open the ioBroker object browser and find the display under
`hassemu.0.clients.<id>`. Set **mode**:

- pick one of the discovered dashboards from the drop-down, or
- pick `Manual URL` and put the address in **manualUrl** next to it.

The display reloads within about 30 seconds.

To give every display the same page, use `hassemu.0.global.mode` (and `global.manualUrl`)
and switch on `global.enabled` instead of setting each display separately.

## Choosing what a display shows

Every display carries its own **mode**. The adapter resolves it on each request:

| mode              | What the display gets                     |
| ----------------- | ----------------------------------------- |
| a URL             | that page                                 |
| `Manual URL`      | whatever is in this display's `manualUrl` |
| `Global URL`      | whatever `global.mode` resolves to        |
| `---` (no choice) | the waiting page with the device ID       |

`global.mode` is resolved the same way, except it cannot itself be `Global URL` — that
would point at itself, and the adapter rejects the write.

### The master switch

`global.enabled` is not a mode a display can be in; it is a bulk action on all of them:

- switching it **on** sets every display to `Global URL`
- switching it **off** sets every display back to `---`

So switching the master off does not restore what each display had before — it clears them
all. Set the displays you want individually afterwards. New displays always start at `---`,
never on a page you did not choose for them.

## What lives in the object tree

```
hassemu.0.
├── info.
│   ├── connection      the adapter is running
│   ├── serverUuid      the identity the displays remember the server by
│   └── refreshUrls     button: search for dashboards again
├── global.
│   ├── enabled         master switch (see above)
│   ├── mode            the page for every display set to Global URL
│   └── manualUrl       free address, used when global.mode is Manual URL
└── clients.
    └── <id>            one entry per display, named after the app's device name, its host name or address
        ├── mode        what this display shows
        ├── manualUrl   free address, used when mode is Manual URL
        ├── resolvedUrl the address this display was actually sent to
        ├── ip          the address this display was last seen at
        └── remove      button: forget this display
```

**serverUuid** is worth knowing about: the displays recognise the server by it. It is
created once and kept, so restarting the adapter does not look like a different server to
the display. If it changed, every display would want to be set up again.

**remove** deletes the entry, and with it the display's identity. The next time that display
connects it is a new one and starts at `---`. Use it for displays you have got rid of; the
adapter also clears entries by itself once they have not been seen for 30 days.

**resolvedUrl** is the answer to "where did this display actually end up". It is read-only and
follows every change: pick a dashboard and it holds that address, switch the display to Global URL
and it holds whatever the global setting resolves to, take the choice back and it is empty because
the display is on its landing page. Handy when a display is set to Global URL and you would
otherwise have to work through two settings to see the result.

**ip** is informational. Displays are identified by their cookie, not their address, so a
new address from your router does not create a second entry.

## The three pages a display can show

Besides your dashboard, the display may show one of three pages of the adapter's own.

**The waiting page** — a device ID and a hint. Means: connected, no page chosen. It
refreshes itself every 15 seconds, so it disappears on its own once you pick a mode.

**"hassemu offline"** — the adapter has stopped or is unreachable. The display notices
after about 1.5 minutes and offers a reload button, then returns to your dashboard by itself
once the adapter is back. One limitation: a display that starts up _while_ the adapter is
down cannot load this page and shows its own connection error instead.

**"Redirect target not reachable"** — the adapter is running, but the page you sent the
display to is not answering. Without this you would just get a black screen. The card names
the target address and offers a reload; the display returns to the dashboard by itself as
soon as the target answers again.

The adapter judges "not reachable" conservatively: _any_ HTTP answer counts as reachable,
including a login page or an error page — those mean a server is running there. Only a
refused connection or a timeout raises the card. It does not check certificates, because
self-signed certificates are normal on a home dashboard.

## Where the drop-down list comes from

The adapter searches the ioBroker host for pages worth offering:

- **VIS and VIS-2** — one entry per project, and one per view inside it, for every `web`
  instance you have
- **Aura** — one entry per running instance, using the port that instance is actually
  configured with; an Aura served by a `web` instance points there (or at Aura's own port
  while that `web` instance only listens on its own machine), and an Aura that only listens
  on its own machine gets no entry, because no display could reach it
- **Admin tiles** — the tiles the ioBroker start page shows: the devices page, Grafana,
  jarvis, material, your own web UI, and the link cards you added to the start page. A tile
  you hid on the start page stays out of the list, and two tiles with the same address are
  one entry

An address that only works on the ioBroker host itself (`127.0.0.1`, `::1`, `localhost`)
never becomes an entry, from whichever source it comes: a display is always another device,
and from there such an address reaches nothing.

The search runs at start and whenever an adapter instance is added, removed or
reconfigured, or the start page settings change. A display keeps its page even when that
page drops out of the list. After creating or renaming a VIS-2 project or view, set **info.refreshUrls**
to `true` to search again without restarting the adapter.

If something is not found, it is not lost: choose `Manual URL` and paste the address.
Addresses using `javascript:`, `data:` or `file:` are refused — those are not pages, they
are code.

## Authentication and your network

**Plain HTTP is the default**, as with Home Assistant, and without HTTPS everything on the
port is unencrypted. Two consequences worth being clear about:

- Treat the port as local to your network. Do not forward it in from the internet.
- With authentication on, the user name, password and tokens travel your network
  unencrypted. Authentication stops other devices on your network from using the HA
  interface — it is not protection against exposure to the internet.

**Use HTTPS** in the instance settings encrypts login, password and tokens with a certificate
from ioBroker. HTTPS has rules of its own:

- With HTTPS the displays reach hassemu under the name in the certificate instead of the IP address — that name must resolve on every display.
- With ioBroker's default certificate (self-signed, issued for the computer name) an Android display needs both: the certificate installed as trusted, and a network that resolves the computer name.
- A dashboard on plain HTTP cannot be shown inside an HTTPS page — choose an HTTPS address for it.
- Switching HTTPS on changes the address of hassemu: every display shows up once as a new device and must be pointed at the new address.

**Trust Reverse Proxy Headers** should stay off unless a reverse proxy really is in front of the adapter,
terminating TLS and removing the `X-Forwarded-*` headers a client sent. Switched on without
one, any device can claim a different address on every single request. The adapter then logs
the wrong addresses, and its per-address limit on new display entries no longer limits
anything. Since version 1.40.0 there is a second limit that does not depend on the address —
at most 100 new display entries per hour in total — so a misconfiguration cannot fill the
database any more. Displays keep working while that limit is in effect; they simply do not
get a stored identity until the burst is over. The limit caps the damage, it does not make
the setting safe.

## Ports

| Port       | Direction | What the adapter needs it for                                    |
| ---------- | --------- | ---------------------------------------------------------------- |
| 8123 / TCP | inbound   | the HA interface the display talks to (default port, changeable) |
| 5353 / UDP | inbound   | mDNS, so displays find the server on their own                   |

For uptime monitors and container health checks use `http://<ip-of-your-ioBroker>:8123/health`
(with HTTPS `https://`, with another port that port).
It answers without creating anything. A `GET /` is what a display sends on its first visit,
so a monitor pointed there would show up as a new display; a `HEAD /` creates nothing.

## Updating from 1.x

Version 2.0.0 gives every display a new object ID once: `clients.61c3a1` becomes
`clients.display-c3a1` — `display` followed by the last four characters of the old ID. The move
happens by itself at the first start: values, rooms, functions and aliases move along, recorded
history continues in its old series, and the display stays recognised, so nothing has to be set up
again. The log names every move. Scripts and visualisations that use the old IDs must be updated.
Do not go back to 1.x afterwards.

A display that connects for the first time gets the model its Home Assistant app reports followed
by four characters hassemu picks itself, for example `clients.pixel-tablet-02b7`; when the display
reports no model, the ID starts with `display`. An ID never changes once it is given.

Every display is named after its app's device name, its host name or its address; a name typed
into the object browser gives way to it. A display named after its host name shows its address
until it connects for the first time after the update.

## Questions that come up

**Can I run two instances?** Yes, on one host each with its own port or its own interface.
Two ioBroker hosts may each run one; the displays then see two separate servers.

**Does the display have to stay connected to the adapter?** Yes. It fetches its page through
the adapter, and the offline page and the target check depend on it. If the adapter stops,
the dashboard stays on screen for about 1.5 minutes; then the display shows the offline page
and returns to the dashboard by itself once the adapter is back.

**Can I rename a display?** The name comes from the display itself: the device name set in
its Home Assistant app, otherwise its host name in the network, otherwise its address. To
change it, rename the device in the app or give it a host name in your router. A name typed
into the object browser does not hold — the adapter writes the display's name back at the next
start or change.

**Why is there a second entry for the same display?** The display did not send back its
cookie — usually a factory reset, a cleared browser or WebView cache (Shelly firmware 2.7.0 and
newer: Settings → Home Assistant), or a privacy mode that discards cookies. Remove the old
entry with its `remove` button. The cause is on the display, not in the adapter.

**Do I need Home Assistant installed?** No. The adapter answers the HA protocol itself.
There is no Home Assistant anywhere in this setup.

**Can the display control ioBroker?** No. The connection carries the onboarding and the page
address, nothing else. No states are exposed and no commands are accepted.

## Finding out what went wrong

Set the instance log level to `debug`. The adapter then traces every decision: which display
was recognised, how the login went, which dashboards were found, and how it resolved the
mode into an address for each request. Most problems can be read straight out of that log.

If mDNS is on but the log has no `mDNS: Broadcasting` line, the announcement did not get out
— usually because something else holds port 5353. Turn mDNS off and enter the address on the
display by hand; everything else works the same.

If the Home Assistant app on Android 17 or newer finds nothing and cannot connect even with
the address entered by hand, it lacks _local network access_ — allow it in the app settings.
