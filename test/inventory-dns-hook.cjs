"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (FIXTURE_HOOKS in test/inventory.js, every start of the
// inventory run). Runs before any adapter module, so the reverse-DNS lookup the adapter
// starts for every display IP is answered here, not by the machine's resolver.
//
// Why: what a PTR lookup returns is the runner's business — for the loopback address the
// fixture displays used until 1.45.0: nothing on macOS, "ip6-localhost" on the GitHub
// ubuntu runner — and it lands asynchronously, some time after the request. The
// inventory would then carry the runner's name, and the upgrade suite would compare a
// display renamed in one run with one not yet renamed in the next (measured 2026-09-15 in
// the first CI run of the start proof: three displays "still 127.0.0.1"). The harness has
// to say what the ADAPTER creates, so every lookup ends the way a LAN client without a PTR
// record ends: with no hostname. The adapter knows neither the hook nor that it runs in
// fixture mode; the negative cache is the code path a real installation takes every day.
//
// A fixture display can still HAVE a PTR record: the `ptr` of its entry in
// test/fixtures/inventory/displays.json, read here, so the auto-naming after the
// reverse-DNS hostname is part of the inventory too (audit 2026-09-25, T8). Under
// INVENTORY_RENAME=1 — set by the fleet suite "a renamed device keeps its name" before the
// restart it plays — an entry with `renamedPtr` answers that name instead: the source renamed
// the display between two starts.
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const fs = require("node:fs");
const path = require("node:path");

/** @type {{ displays: { ip: string, ptr?: string, renamedPtr?: string }[] }} */
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "displays.json"), "utf8"));
const RENAMED = process.env.INVENTORY_RENAME === "1";
/** @type {Record<string, string>} address → PTR name */
const PTR = Object.fromEntries(
  FIXTURES.displays
    .map(d => [d.ip, RENAMED && d.renamedPtr ? d.renamedPtr : d.ptr])
    .filter(([, name]) => name)
    .map(([ip, name]) => [ip, String(name)]),
);

/**
 * The error a resolver gives for an address without a PTR record.
 *
 * @param {string} ip the address
 * @returns {NodeJS.ErrnoException & { hostname: string }} the error
 */
function noPtr(ip) {
  return Object.assign(new Error(`getHostByAddr ENOTFOUND ${ip}`), {
    code: "ENOTFOUND",
    syscall: "getHostByAddr",
    hostname: ip,
  });
}

/**
 * The fixture's answer to one reverse lookup.
 *
 * @param {string} ip the address
 * @returns {Promise<string[]>} the PTR name, or the error of an address without one
 */
const answer = ip => (PTR[ip] ? Promise.resolve([PTR[ip]]) : Promise.reject(noPtr(ip)));

dnsPromises.reverse = answer;
// With a chosen address the adapter asks through a resolver bound to it (review 2026-11-07,
// R-20) — the same answers there.
dnsPromises.Resolver.prototype.reverse = answer;
dns.reverse = (ip, callback) => {
  setImmediate(() => (PTR[ip] ? callback(null, [PTR[ip]]) : callback(noPtr(ip), [])));
};
