"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (the harness passes `env`
// through to it). Runs before any adapter module, so the reverse-DNS lookup the adapter
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
// A fixture display can still HAVE a PTR record: INVENTORY_PTR carries a JSON map
// address → name (set by test/inventory.js from the fixtures), so the auto-naming after the
// reverse-DNS hostname is part of the inventory too (audit 2026-09-25, T8).
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");

// address → PTR name
const PTR = (() => {
  try {
    return JSON.parse(process.env.INVENTORY_PTR || "{}");
  } catch {
    return {};
  }
})();

function noPtr(ip) {
  const err = new Error(`getHostByAddr ENOTFOUND ${ip}`);
  err.code = "ENOTFOUND";
  err.syscall = "getHostByAddr";
  err.hostname = ip;
  return err;
}

dnsPromises.reverse = ip => (PTR[ip] ? Promise.resolve([PTR[ip]]) : Promise.reject(noPtr(ip)));
dns.reverse = (ip, callback) => {
  setImmediate(() => (PTR[ip] ? callback(null, [PTR[ip]]) : callback(noPtr(ip))));
};
