/* global describe, it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": seed the surroundings a real installation has (a web
//   server, a VIS-2 project, an aura and an admin instance, one display left from 1.x),
//   start the adapter in the throwaway js-controller, drive it with fixtures covering
//   every display shape the adapter supports (feedFixtures), then dump every
//   <adapter>.0.* object to test/objects.inventory.json in the ioBroker
//   object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the same surroundings
//   and the previous objects BEFORE start, start, feed, then assert that every object
//   carries the current name/desc/role/type/unit/def/read/write/states and native, and
//   that removed objects are gone. The seed un-normalises the two fields the dump
//   flattens (`lastSeen`, `cookie`) — see reviveSeededClient; without that the suite
//   measures freshly created objects and can prove nothing about an existing
//   installation.
//
// hassemu-specific: the adapter IS an HTTP server, so the fixtures are HTTP requests
// carrying a display's cookie — the same path a real Shelly Wall Display takes. Every
// display reaches it from its own address through X-Forwarded-For (trustProxy on), and
// test/inventory-dns-hook.cjs answers the reverse lookups from the fixtures' `ptr`.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "displays.json"), "utf8"));
// Answers every reverse-DNS lookup in the adapter process from the fixtures — a PTR name
// where a fixture has one, "no PTR record" everywhere else — so the display names do not
// depend on what the runner resolves an address to (see the hook).
const HOOK = path.join(__dirname, "inventory-dns-hook.cjs");
const PTR = Object.fromEntries(FIXTURES.displays.filter(d => d.ptr).map(d => [d.ip, d.ptr]));
const ADAPTER_ENV = { NODE_OPTIONS: `--require ${HOOK}`, INVENTORY_PTR: JSON.stringify(PTR) };
const VOLATILE = ["ts", "from", "user", "acl"];
// Everything an update has to carry into an existing object. `def`/`read`/`write`/`states`
// belong here: a changed default without a CLIENT_OBJECTS_VERSION bump would otherwise stay
// green (design decision 22; audit 2026-09-25, T6).
const COMPARED = ["name", "desc", "role", "type", "unit", "def", "read", "write", "states"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );

/** The port the adapter binds — fixed at the HA standard, not configurable (design decision 3). */
const PORT = 8123;

/**
 * Adapter-specific config the fixtures need: loopback only, no mDNS, no auth, and the
 * proxy header trusted so each fixture display can arrive from its own address. Complete —
 * resetInstanceNative nulls every other key, so every key the adapter reads is here.
 */
const FIXTURE_NATIVE = {
  port: PORT,
  bind: "127.0.0.1",
  authRequired: false,
  username: "admin",
  password: "",
  mdnsEnabled: false,
  serviceName: "ioBroker",
  trustProxy: true,
};

/** The display left over from 1.x: a channel container with a legacy `visUrl`, seeded in both suites. */
const LEGACY = { id: "a1b2c3", stableId: "display-legacy", cookie: "00000000-0000-4000-8000-00000000abcd" };

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration, which expects a host restart the harness never performs. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function resetInstanceNative(harness) {
  const instance = await harness.objects.getObjectAsync(`system.adapter.${ADAPTER}.0`);
  const stale = {};
  for (const key of Object.keys(instance?.native ?? {})) {
    if (!Object.hasOwn(FIXTURE_NATIVE, key)) stale[key] = null;
  }
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...FIXTURE_NATIVE } });
}

/**
 * Seed what a real installation has around the adapter, so the mode dropdown carries
 * discovered dashboards: an enabled web server, a VIS-2 project with a view, an aura and an
 * admin instance. Every address is a concrete bind — a wildcard would resolve to the
 * runner's own address and make the inventory machine-dependent.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function seedEnvironment(harness) {
  const instance = (name, common, native) => ({
    _id: `system.adapter.${name}`,
    type: "instance",
    common: { name: name.split(".")[0], enabled: true, host: "inventory-host", ...common },
    native,
  });
  await harness.objects.setObjectAsync(
    "system.adapter.web.0",
    instance("web.0", {}, { port: 8082, bind: "192.0.2.10", secure: false }),
  );
  await harness.objects.setObjectAsync("system.adapter.vis-2.0", instance("vis-2.0", {}, {}));
  await harness.objects.setObjectAsync("vis-2.0", {
    _id: "vis-2.0",
    type: "meta",
    common: { type: "meta.user" },
    native: {},
  });
  await harness.objects.writeFileAsync(
    "vis-2.0",
    "main/vis-views.json",
    JSON.stringify({ ___settings: {}, Kitchen: { settings: {}, widgets: {} } }),
  );
  await harness.objects.setObjectAsync(
    "system.adapter.aura.0",
    // aura builds its URL from the runner's own address unless `customUrl` is set — the
    // custom form keeps the inventory machine-independent.
    instance("aura.0", {}, { port: 8095, secure: false, customUrl: "http://192.0.2.10:8095" }),
  );
  await harness.objects.setObjectAsync(
    "system.adapter.admin.0",
    instance(
      "admin.0",
      { localLinks: { _default: { link: "%protocol%://%bind%:%port%" } } },
      { port: 8081, bind: "192.0.2.10", secure: false },
    ),
  );
}

/**
 * Seed one display the way 1.x left it: a `channel` container with a bare-string name and a
 * legacy `visUrl` datapoint. The start has to move the container to a `device`, carry the URL
 * into `mode`/`manualUrl` and remove `visUrl` — the upgrade path an old installation takes.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function seedLegacyDisplay(harness) {
  const base = `${NS}clients.${LEGACY.id}`;
  await harness.objects.setObjectAsync(base, {
    _id: base,
    type: "channel",
    common: { name: "192.0.2.50" },
    native: { cookie: LEGACY.cookie, lastSeen: Date.now(), objectsVersion: 1 },
  });
  for (const [leaf, common] of [
    ["mode", { name: "mode", type: "string", role: "state", read: true, write: true }],
    ["visUrl", { name: "visUrl", type: "string", role: "url", read: true, write: true }],
  ]) {
    await harness.objects.setObjectAsync(`${base}.${leaf}`, {
      _id: `${base}.${leaf}`,
      type: "state",
      common,
      native: {},
    });
  }
  await harness.states.setStateAsync(`${base}.visUrl`, { val: "http://192.0.2.10:8082/vis/index.html", ack: true });
}

/**
 * One HTTP request against the running adapter, from a display's address, optionally
 * carrying its cookie.
 *
 * @param {string} method HTTP method.
 * @param {string} urlPath Path to request.
 * @param {{cookie?: string|null, ip?: string, form?: Record<string, string>}} opts Cookie, source address, form body.
 * @returns {Promise<{status: number, cookie: string|null, body: string}>} Status, the cookie the adapter set, the body.
 */
function request(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (opts.cookie) headers.cookie = `hassemu_client=${opts.cookie}`;
    if (opts.ip) headers["x-forwarded-for"] = opts.ip;
    const body = opts.form ? new URLSearchParams(opts.form).toString() : "";
    if (opts.form) headers["content-type"] = "application/x-www-form-urlencoded";
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (text += chunk));
      res.on("end", () => {
        const setCookie = (res.headers["set-cookie"] ?? []).join("; ");
        const match = /hassemu_client=([^;]+)/.exec(setCookie);
        resolve({ status: res.statusCode, cookie: match ? match[1] : null, body: text });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Wait until the adapter answers on its port — `startAdapterAndWait` returns once the
 * instance is alive, which is before the listener is necessarily bound.
 *
 * @param {number} timeoutMs How long to keep trying.
 */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await request("GET", "/health");
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`adapter did not open ${PORT} within ${timeoutMs} ms: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

/**
 * Run the Companion app's sign-in for a display: login flow, code, token — the tokens land
 * on the device object.
 *
 * @param {string} cookie The display's cookie.
 * @param {string} ip Its address.
 */
async function onboard(cookie, ip) {
  const flow = JSON.parse((await request("POST", "/auth/login_flow", { cookie, ip, form: {} })).body);
  const done = JSON.parse((await request("POST", `/auth/login_flow/${flow.flow_id}`, { cookie, ip, form: {} })).body);
  const token = await request("POST", "/auth/token", {
    cookie,
    ip,
    form: { grant_type: "authorization_code", code: done.result },
  });
  assert.strictEqual(token.status, 200, `onboarding failed: ${token.body}`);
}

/**
 * Wait until a display's device carries the expected name — a reverse-DNS rename lands
 * asynchronously and changes no object count, so the tree-settle check cannot see it.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} realId The adapter-minted id.
 * @param {string} name The expected name.
 */
async function waitForName(harness, realId, name) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const obj = await harness.objects.getObjectAsync(`${NS}clients.${realId}`);
    const current = obj?.common?.name;
    const text = current && typeof current === "object" ? current.en : current;
    if (text === name) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`display ${realId} not renamed to ${name} (still ${JSON.stringify(current)})`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * Make the adapter create every object it can create.
 *
 * Each fixture display makes a cookieless first contact from its own address — exactly what
 * a Shelly Wall Display does — so the adapter runs its real identify → createClient →
 * ensureObjects path and names the display after its address or its reverse-DNS name. Then
 * the display's shape is applied (mode, manual URL, sign-in) and it comes back with its
 * cookie, so the resolver and the per-client states are exercised too. The legacy display
 * seeded beforehand comes back with its cookie as well.
 *
 * The adapter mints a RANDOM id per display; {@link dumpObjects} maps those to stable
 * `display-N` keys in fixture order, so the inventory stays byte-identical across runs.
 *
 * `knownCookies` is what separates the two suites. Suite 1 passes nothing: every display
 * makes a cookieless first contact and IS new. Suite 2 passes the cookies it seeded, so
 * each display the previous release had comes back as the display already in the tree —
 * the only way the run reaches the "objects already exist" path the revision stamp gates.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, string>} knownCookies stable inventory id → cookie to come back with
 * @returns {Promise<Record<string, string>>} adapter-minted id → stable inventory id
 */
async function feedFixtures(harness, knownCookies = {}) {
  await waitForServer(30000);
  const idMap = { [LEGACY.id]: LEGACY.stableId };
  await request("GET", "/", { cookie: LEGACY.cookie, ip: "192.0.2.50" });
  for (const [index, display] of FIXTURES.displays.entries()) {
    const stableId = `display-${index + 1}`;
    const known = knownCookies[stableId] ?? null;
    const first = await request("GET", "/", { cookie: known, ip: display.ip });
    // A recognised display gets no new Set-Cookie — its identity is the one we sent.
    const cookie = known ?? first.cookie;
    assert.ok(cookie, `display ${stableId}: adapter set no cookie`);
    const realId = await findClientIdByCookie(harness, cookie);
    idMap[realId] = stableId;

    await harness.states.setStateAsync(`${NS}clients.${realId}.mode`, { val: display.mode, ack: false });
    if (display.manualUrl) {
      await harness.states.setStateAsync(`${NS}clients.${realId}.manualUrl`, {
        val: display.manualUrl,
        ack: false,
      });
    }
    if (display.onboard) {
      await onboard(cookie, display.ip);
    }
    // Let the state handlers land before the display comes back.
    await new Promise(r => setTimeout(r, 400));
    await request("GET", "/", { cookie, ip: display.ip });
    await request("GET", "/api/redirect_check", { cookie, ip: display.ip });
    await waitForName(harness, realId, display.ptr ?? display.ip);
  }
  // Give the fire-and-forget object writes (lastSeen) a moment to land, then wait for the
  // tree to stop growing — the moment is a guess, the quiet window is not.
  await new Promise(r => setTimeout(r, 1500));
  await waitForStableTree(harness);
  return idMap;
}

/**
 * Wait until the object tree has stopped growing for a second. The fire-and-forget writes
 * above have no completion signal the harness could wait on; on the GitHub runner a sibling
 * harness (homewizard, 2026-09-15) dumped while such writes were still in flight and lost
 * two objects. A quiet window is the settle check beszel and govee-smart already use.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness The harness.
 */
async function waitForStableTree(harness) {
  const count = async () => (await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` })).rows.length;
  const deadline = Date.now() + 60000;
  let previous = await count();
  for (;;) {
    let stable = true;
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const now = await count();
      if (now !== previous) {
        previous = now;
        stable = false;
        break;
      }
    }
    if (stable) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`object tree did not settle (last count ${previous})`);
    }
  }
}

/**
 * Find which `clients.<id>` object carries `cookie`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} cookie The cookie the adapter just handed out.
 * @returns {Promise<string>} The short client id.
 */
async function findClientIdByCookie(harness, cookie) {
  const list = await harness.objects.getObjectList({ startkey: `${NS}clients.`, endkey: `${NS}clients.香` });
  for (const row of list.rows) {
    if (row.value?.native?.cookie === cookie) {
      return row.id.substring(`${NS}clients.`.length);
    }
  }
  throw new Error(`no client object carries cookie ${cookie}`);
}

/**
 * Is this id a `clients.<id>` container (the display itself, not one of its states)?
 *
 * @param {string} id Full object id.
 * @returns {boolean} True for exactly `<adapter>.0.clients.<id>`.
 */
function isClientContainer(id) {
  return id.startsWith(`${NS}clients.`) && id.split(".").length === 4;
}

/**
 * Undo, for ONE seeded display, the normalisations {@link dumpObjects} applies — without
 * them the upgrade suite proves nothing (measured 2026-09-07):
 *
 * * `lastSeen` is written as a FIXED 2023-11-14, which is far past the 30-day TTL, so
 *   `gcStaleClients` deletes every seeded display at start ("Removed 3 inactive
 *   client(s)"). Nothing of the previous release survives to be measured.
 * * every cookie is collapsed to ONE constant, so the seeded displays share an identity
 *   and the fixtures cannot come back AS one of them. They would mint new ids, and a
 *   freshly created object always carries the current texts — which is why a forgotten
 *   CLIENT_OBJECTS_VERSION bump passed this suite green.
 * * the token fields are constants too, the same refresh token on every display that had
 *   one — set to `null`, the state the adapter itself writes for a display that never
 *   signed in (deleting the keys instead left an object shape no installation has).
 *
 * @param {Record<string, unknown>} obj    The seeded object from the previous inventory.
 * @param {string} cookie                  The identity this display comes back with.
 * @returns {Record<string, unknown>} The object to seed.
 */
function reviveSeededClient(obj, cookie) {
  const native = { ...(obj.native ?? {}), cookie, lastSeen: Date.now() };
  for (const key of ["token", "refreshToken", "tokenExpiresAt"]) {
    if (key in native) {
      native[key] = null;
    }
  }
  return { ...obj, native };
}

/**
 * The address a seeded display had under the previous release. The seed writes objects
 * only, but an installation also holds the `.ip` VALUE — and the adapter decides on it
 * whether the name is still the auto-assigned address it may follow to a new one. Without
 * it the old name reads as a hostname and the display keeps it after an address change,
 * which no real installation does. An auto-named display is named after that address;
 * one named after its reverse-DNS answer had the address its fixture gives it.
 *
 * @param {Record<string, any>} obj The seeded display container.
 * @param {string} stableId         Its `display-N` key.
 * @returns {string} The address to seed into `.ip`.
 */
function previousIp(obj, stableId) {
  const name = obj.common?.name;
  const text = name && typeof name === "object" ? name.en : name;
  if (typeof text === "string" && net.isIP(text)) {
    return text;
  }
  return FIXTURES.displays[Number(stableId.substring("display-".length)) - 1]?.ip ?? "";
}

/**
 * A distinct cookie per seeded display. Any UUID `coerceUuid` accepts will do — a
 * container whose cookie does not parse is deleted as an orphan by `restore()`.
 *
 * @param {number} index Position among the seeded displays.
 * @returns {string} `00000000-0000-4000-8000-<index+1 padded>`.
 */
function seededCookie(index) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

/**
 * Dump every object below the adapter's namespace in the bot's format.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, string>} idMap adapter-minted id → stable inventory id
 */
async function dumpObjects(harness, idMap = {}) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows) {
    const obj = { ...row.value };
    for (const key of VOLATILE) {
      delete obj[key];
    }
    // Per-installation noise, not structure: a client's random id, its cookie, its tokens,
    // the timestamps. Normalising them is what makes two runs byte-identical while the
    // object STRUCTURE — names, descriptions, roles, types — stays exactly as written.
    let id = row.id;
    for (const [realId, stableId] of Object.entries(idMap)) {
      id = id.replace(`clients.${realId}`, `clients.${stableId}`);
    }
    if (obj._id) {
      obj._id = id;
    }
    if (obj.native && typeof obj.native === "object") {
      const native = { ...obj.native };
      if ("cookie" in native) {
        native.cookie = "00000000-0000-4000-8000-000000000000";
      }
      if ("lastSeen" in native) {
        native.lastSeen = 1700000000000;
      }
      for (const key of ["token", "refreshToken"]) {
        if (typeof native[key] === "string") {
          native[key] = "00000000-0000-4000-8000-00000000000f";
        }
      }
      if (typeof native.tokenExpiresAt === "number") {
        native.tokenExpiresAt = 1700000000000;
      }
      obj.native = native;
    }
    out[id] = obj;
  }
  // Sort AFTER renaming so the file order follows the stable ids.
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map(k => [k, out[k]]),
  );
}

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let idMap = {};
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        await resetInstanceNative(harness);
        // The harness registers its own before() (fresh DB) ahead of this one, so the seed
        // survives into the start — `restore()` has to pick the legacy display up, exactly
        // as it does after an ioBroker restart.
        await seedEnvironment(harness);
        await seedLegacyDisplay(harness);
        await harness.startAdapterAndWait(false, ADAPTER_ENV);
        idMap = await feedFixtures(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness, idMap);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("covers the dynamic per-display objects no manifest declares", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness, idMap);
        const stableIds = [...FIXTURES.displays.map((_d, i) => `display-${i + 1}`), LEGACY.stableId];
        for (const stableId of stableIds) {
          for (const leaf of ["", ".mode", ".manualUrl", ".ip", ".remove", ".resolvedUrl"]) {
            const id = `${NS}clients.${stableId}${leaf}`;
            assert.ok(objects[id], `missing ${id} — the inventory would not see this object class`);
          }
        }
      });

      it("the 1.x display was moved: a device, its URL carried over, visUrl gone", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness, idMap);
        const base = `${NS}clients.${LEGACY.stableId}`;
        assert.strictEqual(objects[base].type, "device");
        assert.ok(!objects[`${base}.visUrl`], "legacy visUrl still there");
        const manualUrl = await harness.states.getStateAsync(`${NS}clients.${LEGACY.id}.manualUrl`);
        assert.strictEqual(manualUrl?.val, "http://192.0.2.10:8082/vis/index.html");
        const mode = await harness.states.getStateAsync(`${NS}clients.${LEGACY.id}.mode`);
        assert.strictEqual(mode?.val, "manual");
      });

      it("the mode dropdown carries the discovered dashboards", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness, idMap);
        const states = objects[`${NS}global.mode`].common.states;
        for (const url of [
          "http://192.0.2.10:8082/vis-2/index.html?main",
          "http://192.0.2.10:8082/vis-2/index.html?main#Kitchen",
          "http://192.0.2.10:8081",
          "http://192.0.2.10:8095/",
        ]) {
          assert.ok(url in states, `${url} not in the dropdown: ${Object.keys(states).join(", ")}`);
        }
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let idMap = {};
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        // One cookie per seeded display, in inventory order — the identity the fixtures
        // come back with, so the adapter RESTORES these displays instead of minting new
        // ones. See reviveSeededClient for why the seeded values cannot be used as-is.
        const cookieByDisplay = Object.fromEntries(
          Object.keys(previous)
            .filter(id => isClientContainer(id) && !id.endsWith(`.${LEGACY.stableId}`))
            .sort()
            .map((id, i) => [id.substring(`${NS}clients.`.length), seededCookie(i)]),
        );
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await resetInstanceNative(harness);
          await seedEnvironment(harness);
          await seedLegacyDisplay(harness);
          // Seed the PREVIOUS release's objects, then start on top of them — the
          // upgrade an existing installation actually performs. The legacy display is
          // seeded as 1.x left it (above), never from the previous inventory.
          for (const [id, obj] of Object.entries(previous)) {
            if (id.includes(`.${LEGACY.stableId}`)) {
              continue;
            }
            const shortId = id.substring(`${NS}clients.`.length);
            await harness.objects.setObjectAsync(
              id,
              isClientContainer(id) ? reviveSeededClient(obj, cookieByDisplay[shortId]) : obj,
            );
            if (isClientContainer(id)) {
              await harness.states.setStateAsync(`${id}.ip`, { val: previousIp(obj, shortId), ack: true });
            }
          }
          await harness.startAdapterAndWait(false, ADAPTER_ENV);
          idMap = await feedFixtures(harness, cookieByDisplay);
        });

        it("restores the seeded displays instead of creating new ones", function () {
          // The guard that keeps this suite from going blind. A display the previous
          // release had that comes back without its cookie gets a NEW id, and every object
          // under it is freshly created — freshly created objects always carry the current
          // texts, so the comparison below would pass whatever the adapter does to an
          // installation that already exists. Displays the previous release did not have
          // are new by definition.
          const created = Object.entries(idMap)
            .filter(([realId, stableId]) => stableId in cookieByDisplay && realId !== stableId)
            .map(([realId, stableId]) => `${stableId} came back as ${realId}`);
          assert.deepStrictEqual(
            created,
            [],
            `the run created new displays instead of restoring the seeded ones — this suite would measure nothing:\n${created.join("\n")}`,
          );
        });

        it("every current object carries the current texts, roles, defaults and native", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness, idMap);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            for (const f of COMPARED) {
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            if (canonical(got.native) !== canonical(obj.native)) {
              stale.push(`${id}: native still ${JSON.stringify(got.native)}`);
            }
            // The KIND of the object (state/channel/device/folder/meta) sits one level
            // ABOVE `common`; the `type` in COMPARED is the VALUE type (string/number/
            // boolean) — same name, different thing. Without this comparison a type
            // migration that does not take on an EXISTING installation stays green: every
            // text matches while the container is still declared wrong. For hassemu the
            // channel→device move (I22) is exercised by the legacy display, seeded as a
            // `channel` container in both suites.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness, idMap);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
