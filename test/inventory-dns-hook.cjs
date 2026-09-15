"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (the harness passes `env`
// through to it). Runs before any adapter module, so the reverse-DNS lookup the adapter
// starts for every display IP is answered here, not by the machine's resolver.
//
// Why: the fixture displays connect from 127.0.0.1, and what a PTR lookup of the loopback
// address returns is the runner's business — nothing on macOS, "ip6-localhost" on the
// GitHub ubuntu runner — and it lands asynchronously, some time after the request. The
// inventory would then carry the runner's name, and the upgrade suite would compare a
// display renamed in one run with one not yet renamed in the next (measured 2026-09-15 in
// the first CI run of the start proof: three displays "still 127.0.0.1"). The harness has
// to say what the ADAPTER creates, so every lookup ends the way a LAN client without a PTR
// record ends: with no hostname. The adapter knows neither the hook nor that it runs in
// fixture mode; the negative cache is the code path a real installation takes every day.
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");

function noPtr(ip) {
  const err = new Error(`getHostByAddr ENOTFOUND ${ip}`);
  err.code = "ENOTFOUND";
  err.syscall = "getHostByAddr";
  err.hostname = ip;
  return err;
}

dnsPromises.reverse = ip => Promise.reject(noPtr(ip));
dns.reverse = (ip, callback) => {
  setImmediate(() => callback(noPtr(ip)));
};
