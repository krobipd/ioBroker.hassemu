"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (FIXTURE_HOOKS in test/inventory.js, every start of the
// inventory run). Runs before any adapter module.
//
// What it routes: the one connection hassemu opens itself — the reachability probe of a display's redirect target
// (src/lib/target-health.ts, a GET to the target's origin, sent when a display asks /api/redirect_check). Every target
// of the fixtures lies on the seeded surroundings in 192.0.2.0/24 (TEST-NET-1, RFC 5737, never routed). Without this
// hook the probe went out to that address and waited for its timeout — a connection that left the machine (the
// resource probe's `.lands`). Here it reaches the fixture dashboard server the test process runs on 127.0.0.1, which
// answers every request like a web server does; the port stands in the file INVENTORY_DASHBOARD_FILE names, written
// once that server listens. Without the file (the server not yet up) the connection is refused, as by a host with
// nothing listening — never sent into the network.
//
// Only an options-form connect to an address in 192.0.2.0/24 is touched. Everything else — the states and objects
// databases, the displays' sockets, a path — goes on exactly as it came in. The adapter knows neither the hook nor
// that it runs against fixtures.
const fs = require("node:fs");
const net = require("node:net");

const FIXTURE_NET = /^192\.0\.2\.\d{1,3}$/;

/**
 * The port of the fixture dashboard server, or undefined while it does not listen yet.
 *
 * @returns {number | undefined} the port
 */
function dashboardPort() {
  const file = process.env.INVENTORY_DASHBOARD_FILE;
  if (!file || !fs.existsSync(file)) {
    return undefined;
  }
  const port = JSON.parse(fs.readFileSync(file, "utf8")).port;
  return Number.isInteger(port) ? port : undefined;
}

/**
 * The error a host with nothing listening gives.
 *
 * @param {string} target what was addressed
 * @returns {NodeJS.ErrnoException} an ECONNREFUSED error
 */
function refusal(target) {
  const error = /** @type {NodeJS.ErrnoException} */ (
    new Error(`connect ECONNREFUSED ${target} (the inventory dashboard server does not listen yet)`)
  );
  error.code = "ECONNREFUSED";
  return error;
}

const realConnect = net.Socket.prototype.connect;
/**
 * `net.Socket.prototype.connect`, with every connection to the fixture network sent to the fixture dashboard server.
 *
 * @param {...unknown} args the arguments of connect
 * @returns {net.Socket} the socket
 */
net.Socket.prototype.connect = function connect(...args) {
  // net.connect(options) hands Node's normalised [options, callback] array through as ONE argument, marked with an
  // internal symbol — it is changed in place, a new array would be refused (ERR_MISSING_ARGS).
  const normalised = /** @type {unknown[]} */ (Array.isArray(args[0]) ? args[0] : args);
  const options = /** @type {{ host?: unknown, port?: unknown } | null} */ (normalised[0]);
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.host !== "string" ||
    !FIXTURE_NET.test(options.host)
  ) {
    return Reflect.apply(realConnect, this, args);
  }
  const port = dashboardPort();
  if (port === undefined) {
    const target = `${options.host}:${String(options.port)}`;
    setImmediate(() => this.destroy(refusal(target)));
    return this;
  }
  normalised[0] = { ...options, host: "127.0.0.1", port };
  return Reflect.apply(realConnect, this, args);
};
