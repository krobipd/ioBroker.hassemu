"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering every display shape the adapter supports
//   (feedFixtures), then dump every <adapter>.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current name/desc/role/type/unit and that removed objects are gone. The seed
//   un-normalises the two fields the dump flattens (`lastSeen`, `cookie`) — see
//   reviveSeededClient; without that the suite measures freshly created objects
//   and can prove nothing about an existing installation.
//
// hassemu-specific: the adapter IS an HTTP server, so the fixtures are HTTP requests
// carrying a display's cookie — the same path a real Shelly Wall Display takes. The
// per-display objects are seeded with FIXED ids/cookies beforehand, because the adapter
// mints a random id for an unknown display and the inventory has to be deterministic.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const http = require("node:http");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "displays.json"), "utf8"));

/** Adapter-specific config the fixtures need: loopback only, no mDNS, no auth. */
const FIXTURE_NATIVE = {
  bindAddress: "127.0.0.1",
  mdnsEnabled: false,
  authRequired: false,
  serviceName: "ioBroker",
  trustProxy: false,
};

/** The port the adapter binds — fixed at the HA standard, not configurable (design decision 3). */
const PORT = 8123;

/**
 * One HTTP GET against the running adapter, optionally carrying a display's cookie.
 *
 * @param {string} urlPath Path to request.
 * @param {string|null} cookie The display's `hassemu_client` cookie, or null for a first contact.
 * @returns {Promise<{status: number, cookie: string|null}>} Status and the cookie the adapter set, if any.
 */
function get(urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { cookie: `hassemu_client=${cookie}` } : {};
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method: "GET", headers }, res => {
      res.resume();
      res.on("end", () => {
        const setCookie = (res.headers["set-cookie"] ?? []).join("; ");
        const match = /hassemu_client=([^;]+)/.exec(setCookie);
        resolve({ status: res.statusCode, cookie: match ? match[1] : null });
      });
    });
    req.on("error", reject);
    req.end();
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
      await get("/health", "none");
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
 * Make the adapter create every object it can create.
 *
 * Each fixture display makes a cookieless first contact — exactly what a Shelly Wall
 * Display does — so the adapter runs its real identify → createClient → ensureObjects
 * path. Then the display's shape is applied (user rename, mode, manual URL) and it comes
 * back with its cookie, so the resolver and the per-client states are exercised too.
 *
 * The adapter mints a RANDOM id per display; {@link dumpObjects} maps those to stable
 * `display-N` keys in fixture order, so the inventory stays byte-identical across runs.
 * The random segment is per-installation noise, not object structure.
 *
 * `knownCookies` is what separates the two suites. Suite 1 passes nothing: every display
 * makes a cookieless first contact and IS new. Suite 2 passes the cookies it seeded, so
 * each display comes back as the display that is already in the tree — the only way the
 * run reaches the "objects already exist" path the revision stamp gates.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 * @param {Record<string, string>} knownCookies stable inventory id → cookie to come back with
 * @returns {Promise<Record<string, string>>} adapter-minted id → stable inventory id
 */
async function feedFixtures(harness, knownCookies = {}) {
  await waitForServer(30000);
  const idMap = {};
  for (const [index, display] of FIXTURES.displays.entries()) {
    const stableId = `display-${index + 1}`;
    const known = knownCookies[stableId] ?? null;
    const first = await get("/", known);
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
    // Let the state handlers land before the display comes back.
    await new Promise(r => setTimeout(r, 400));
    await get("/", cookie);
    await get("/api/redirect_check", cookie);
  }
  // Give the fire-and-forget object writes (lastSeen, auto-name) a moment to land.
  await new Promise(r => setTimeout(r, 1500));
  return idMap;
}

/**
 * Find which `clients.<id>` object carries `cookie`.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 * @param {string} cookie The cookie the adapter just handed out.
 * @returns {Promise<string>} The short client id.
 */
async function findClientIdByCookie(harness, cookie) {
  const list = await harness.objects.getObjectList({ startkey: `${NS}clients.`, endkey: `${NS}clients.\u9999` });
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
 * Undo, for ONE seeded display, the two normalisations {@link dumpObjects} applies —
 * without them the upgrade suite proves nothing (measured 2026-09-07):
 *
 * * `lastSeen` is written as a FIXED 2023-11-14, which is far past the 30-day TTL, so
 *   `gcStaleClients` deletes every seeded display at start ("Removed 3 inactive
 *   client(s)"). Nothing of the previous release survives to be measured.
 * * every cookie is collapsed to ONE constant, so the seeded displays share an identity
 *   and the fixtures cannot come back AS one of them. They would mint new ids, and a
 *   freshly created object always carries the current texts — which is why a forgotten
 *   CLIENT_OBJECTS_VERSION bump passed this suite green.
 *
 * @param {Record<string, unknown>} obj    The seeded object from the previous inventory.
 * @param {string} cookie                  The identity this display comes back with.
 * @returns {Record<string, unknown>} The object to seed.
 */
function reviveSeededClient(obj, cookie) {
  return { ...obj, native: { ...(obj.native ?? {}), cookie, lastSeen: Date.now() } };
}

/**
 * A distinct cookie per seeded display. Any UUID `coerceUuid` accepts will do — a
 * channel whose cookie does not parse is deleted as an orphan by `restore()`.
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
 * @param {import("@iobroker/testing").TestHarness} harness
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
    // Per-installation noise, not structure: a client's random id, its cookie, the
    // timestamps. Normalising them is what makes two runs byte-identical while the
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
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let idMap = {};
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        // Start once so the manifest objects exist and the DB is settled, THEN seed
        // the fixture displays and restart: the harness resets the database around
        // its own start, so a seed placed before it does not survive. The restart is
        // also the honest path — it is `restore()` that has to pick these displays
        // up, exactly as it does after an ioBroker restart.
        await harness.startAdapterAndWait();
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
        for (let i = 1; i <= FIXTURES.displays.length; i++) {
          for (const leaf of ["", ".mode", ".manualUrl", ".ip", ".remove"]) {
            const id = `${NS}clients.display-${i}${leaf}`;
            assert.ok(objects[id], `missing ${id} — the inventory would not see this object class`);
          }
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
            .filter(isClientContainer)
            .sort()
            .map((id, i) => [id.substring(`${NS}clients.`.length), seededCookie(i)]),
        );
        before(async function () {
          this.timeout(120000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
          // Seed the PREVIOUS release's objects, then start on top of them — the
          // upgrade an existing installation actually performs. The harness's own
          // before() runs ahead of this one, so the seed survives into the start.
          for (const [id, obj] of Object.entries(previous)) {
            const shortId = id.substring(`${NS}clients.`.length);
            await harness.objects.setObjectAsync(
              id,
              isClientContainer(id) ? reviveSeededClient(obj, cookieByDisplay[shortId]) : obj,
            );
          }
          await harness.startAdapterAndWait();
          idMap = await feedFixtures(harness, cookieByDisplay);
        });

        it("restores the seeded displays instead of creating new ones", function () {
          // The guard that keeps this suite from going blind. A display that comes back
          // without its cookie gets a NEW id, and every object under it is freshly
          // created — freshly created objects always carry the current texts, so the
          // comparison below would pass whatever the adapter does to an installation
          // that already exists. That is the only thing this suite is for.
          const created = Object.entries(idMap)
            .filter(([realId, stableId]) => realId !== stableId)
            .map(([realId, stableId]) => `${stableId} came back as ${realId}`);
          assert.deepStrictEqual(
            created,
            [],
            `the run created new displays instead of restoring the seeded ones — this suite would measure nothing:\n${created.join("\n")}`,
          );
        });

        it("every current object carries the current texts and roles", async function () {
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
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
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
