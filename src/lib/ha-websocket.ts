/**
 * The HA WebSocket endpoint (`/api/websocket`).
 *
 * Split out of `webserver.ts` in v1.43.0. It is a protocol of its own — an in-band
 * handshake, a keep-alive heartbeat and a command table verified against
 * home-assistant/core — that lived next to the REST routes only because the same Fastify
 * instance serves both. Nothing in here reads or writes HTTP.
 *
 * Why it exists at all: the HA Companion App's `registerDevice` makes best-effort
 * `get_config` and `auth/current_user` WS calls after the REST registration to store the
 * server version and the username (home-assistant/android IntegrationRepositoryImpl.kt:157
 * at tag 2026.9.0). Without an endpoint those calls throw and the registration logs "Unable
 * to save device registration".
 *
 * A session is bound to the display's REFRESH token, like HA core (websocket_api/auth.py:116-117
 * at tag 2026.9.3 closes the socket when that token is revoked): a revoke, or removing the display,
 * ends the connection at the next frame or heartbeat. Not the access token — it rotates on
 * every refresh, and binding to it would cut every connection after 30 minutes (audit
 * 2026-09-25, H9).
 */

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { isPlainObject } from "./coerce";
import { HA_VERSION, WS_AUTH_TIMEOUT_MS, WS_HEARTBEAT_INTERVAL_MS } from "./constants";
import { errText } from "./err-text";
import type { AdapterInterface, ClientRecord } from "./types";

/** Public route marker — the WS authenticates in-band, so the HTTP guard must let it through. */
const PUBLIC_ROUTE = { config: { public: true } } as const;

/** What an authenticated connection is bound to. */
export interface WsSession {
  /** The display that authenticated. */
  clientId: string;
  /** Its refresh token at that moment, or null when it had none. */
  refreshToken: string | null;
  /** The access token it authenticated with. */
  accessToken: string;
}

/** What the WS endpoint needs from its surroundings — deliberately not the whole server. */
export interface HaWebSocketDeps {
  /** Adapter surface for logging and managed timers. */
  adapter: AdapterInterface;
  /** Resolves an access token to its client, or null when unknown/expired. */
  clientForToken: (token: string) => ClientRecord | null;
  /** Whether an authenticated session still stands (display known, token not revoked). */
  sessionAlive: (session: WsSession) => boolean;
  /** Stable server UUID, reported as the current user's id. */
  instanceUuid: string;
  /** Configured user name, or the service name when none is set. */
  userName: () => string;
  /** `/api/config`-shaped object — one source shared with the REST route and the webhook. */
  buildHaConfig: () => Record<string, unknown>;
}

/**
 * Safely serialize + send a WS frame; swallows errors from an already-closed socket.
 *
 * @param socket  The client WebSocket to write to.
 * @param payload Plain object serialized to a JSON text frame.
 */
export function wsSend(socket: WebSocket, payload: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* socket closing/closed — drop the frame */
  }
}

/**
 * Send a last frame, then drop the TCP connection once it is flushed. `close()` starts the
 * closing handshake and waits for the peer — a client that never answers held the socket for
 * ws's 30-s close timeout, and nothing capped how many of those piled up (audit 2026-09-25, H9).
 *
 * @param socket  The client WebSocket.
 * @param payload The last frame.
 */
function wsSendAndTerminate(socket: WebSocket, payload: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify(payload), () => socket.terminate());
  } catch {
    socket.terminate();
  }
}

/**
 * Normalise every `RawData` variant ws can deliver to a UTF-8 string. Text frames arrive
 * as a Buffer by default; without this an object's default stringification would be
 * parsed instead of the payload.
 *
 * @param raw The frame as handed over by ws.
 */
function frameToText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

/**
 * Handle one authenticated WS command. hassemu emulates an empty-but-valid HA server with
 * only the components it advertises (http/api/frontend/homeassistant/mobile_app).
 * Responses use only shapes that are either source-verified or trivially correct for an
 * empty server:
 * - data queries → the correct empty shape (`[]` / `{}`),
 * - subscriptions → an ack that never emits (a shim has no entities or events),
 * - everything hassemu does NOT implement (call_service on a service-less server,
 *   conversation, Matter/Thread, assist_pipeline, …) → `unknown_command`, which is exactly
 *   what real HA returns for an unregistered command type.
 *
 * The command SET is verified against home-assistant/android WebSocketRepositoryImpl at
 * tag 2026.9.0 and home-assistant/iOS HATypedRequest+App.swift at release/2026.9.2; the
 * shapes and error codes against home-assistant/core at tag 2026.9.3 (websocket_api/const.py:38
 * ERR_NOT_FOUND, :42 ERR_UNKNOWN_COMMAND). Commands the apps may send but hassemu deliberately
 * leaves unanswered with `unknown_command`: subscribe_trigger, render_template,
 * assist_pipeline/run. No speculative response shapes are emitted.
 *
 * @param socket The authenticated client WebSocket.
 * @param msg    The parsed incoming command frame (`{ id, type, ... }`).
 * @param deps   Endpoint dependencies.
 */
function handleWsCommand(socket: WebSocket, msg: Record<string, unknown>, deps: HaWebSocketDeps): void {
  const id = msg.id;
  const type = typeof msg.type === "string" ? msg.type : "";
  const result = (r: unknown): void => wsSend(socket, { id, type: "result", success: true, result: r });
  switch (type) {
    case "ping":
      wsSend(socket, { id, type: "pong" });
      return;
    case "auth/current_user":
      // CurrentUserResponse.kt @2026.9.0: { id, name, isOwner, isAdmin } — the HA wire
      // format is snake_case (is_owner / is_admin).
      result({
        id: deps.instanceUuid,
        name: deps.userName(),
        is_owner: true,
        is_admin: true,
      });
      return;
    case "get_config":
      result(deps.buildHaConfig());
      return;
    case "get_states":
      result([]);
      return;
    case "get_services":
      result({});
      return;
    // Registries on an entity-less emulated server → empty lists; floor_registry/list per
    // core config/floor_registry.py:25-39 @2026.9.3 is a list of floors too (U5).
    case "config/area_registry/list":
    case "config/device_registry/list":
    case "config/entity_registry/list":
    case "config/floor_registry/list":
      result([]);
      return;
    // core config/entity_registry.py:68-93 @2026.9.3: the category index map is fixed
    // (helpers/entity_registry.py:86 → EntityCategory config, diagnostic), no entities (U5).
    case "config/entity_registry/list_for_display":
      result({ entity_categories: { 0: "config", 1: "diagnostic" }, entities: [] });
      return;
    // core config/entity_registry.py:114-117 @2026.9.3: an unknown entity is `not_found` —
    // on a server without entities every one is unknown (audit 2026-09-25, NH12).
    case "config/entity_registry/get":
      wsSend(socket, { id, type: "result", success: false, error: { code: "not_found", message: "Entity not found" } });
      return;
    // Valid subscriptions on an empty server — they ack but never emit. Plus
    // supported_features, which is a client capability handshake (not a subscription) that
    // likewise just needs an ack. mobile_app/* is an advertised component, so both its WS
    // commands ack consistently. unsubscribe_events is the counterpart of the subscriptions
    // (core websocket_api/commands.py:250-261) — acked like them instead of `unknown_command`
    // (audit 2026-09-25, NH11).
    case "subscribe_events":
    case "unsubscribe_events":
    case "subscribe_entities":
    case "supported_features":
    case "mobile_app/push_notification_channel":
    case "mobile_app/push_notification_confirm":
      result(null);
      return;
    default:
      // hassemu doesn't implement this command (call_service has no services; conversation
      // / matter / thread / assist_pipeline are integrations it doesn't advertise). Real HA
      // returns ERR_UNKNOWN_COMMAND for an unregistered command type — a reply (no hang),
      // honest (no fake success), and grounded (no guessed response shape).
      wsSend(socket, {
        id,
        type: "result",
        success: false,
        error: { code: "unknown_command", message: `Command "${type}" is not supported by this server` },
      });
      return;
  }
}

/**
 * Register `/api/websocket` on `app`.
 *
 * Auth happens in-band: the server sends `auth_required`, the client replies with an
 * `auth` frame, and the access token is validated against the registry. FAIL-FAST — a
 * missing/invalid token, or no `auth` frame within {@link WS_AUTH_TIMEOUT_MS}, closes the
 * socket, so the WS never hangs the App's call (which previously failed fast against a
 * clean 404).
 *
 * @param app  The Fastify instance (`@fastify/websocket` must already be registered).
 * @param deps Endpoint dependencies.
 */
export function registerHaWebSocket(app: FastifyInstance, deps: HaWebSocketDeps): void {
  app.get("/api/websocket", { websocket: true, ...PUBLIC_ROUTE }, (socket: WebSocket) => {
    let authed = false;
    let session: WsSession | null = null;
    let alive = true;
    let authTimer: ioBroker.Timeout | undefined;
    let heartbeatTimer: ioBroker.Interval | undefined;
    // Both connection timers live in this closure and are torn down together in the single
    // close handler — no timer can outlive the socket. v1.37.0 (L7).
    const clearTimers = (): void => {
      if (authTimer) {
        deps.adapter.clearTimeout(authTimer);
        authTimer = undefined;
      }
      if (heartbeatTimer) {
        deps.adapter.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    authTimer =
      deps.adapter.setTimeout(() => {
        if (!authed) {
          deps.adapter.log.debug("WS: no auth frame within timeout — closing");
          wsSendAndTerminate(socket, { type: "auth_invalid", message: "Authentication timed out" });
        }
      }, WS_AUTH_TIMEOUT_MS) ?? undefined;

    wsSend(socket, { type: "auth_required", ha_version: HA_VERSION });

    socket.on("message", raw => {
      // L5: top-level try/catch — an uncaught throw in this synchronous ws listener would
      // crash the adapter (uncaughtException → js-controller terminate → restart loop).
      // Defense-in-depth on top of the per-site guards.
      try {
        const text = frameToText(raw);
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return; // ignore non-JSON frames
        }
        // A valid-JSON frame that is not an object (`null`, a primitive, an array) would
        // deref to a TypeError below (`null.access_token`). Drop it.
        if (!isPlainObject(msg)) {
          return;
        }
        if (!authed) {
          const token = typeof msg.access_token === "string" ? msg.access_token : "";
          const client = msg.type === "auth" && token ? deps.clientForToken(token) : null;
          if (client) {
            authed = true;
            session = { clientId: client.id, refreshToken: client.refreshToken, accessToken: token };
            if (authTimer) {
              deps.adapter.clearTimeout(authTimer);
              authTimer = undefined;
            }
            wsSend(socket, { type: "auth_ok", ha_version: HA_VERSION });
            // L7: keep-alive heartbeat. ws 8.x does not ping server-side on its own, so a
            // display power-cut without a clean close would otherwise leave the socket + FD
            // alive until the adapter restarts. Each tick terminates the peer if the
            // previous ping went unanswered, else pings.
            alive = true;
            heartbeatTimer =
              deps.adapter.setInterval(() => {
                if (!alive || (session !== null && !deps.sessionAlive(session))) {
                  socket.terminate();
                  return;
                }
                alive = false;
                socket.ping();
              }, WS_HEARTBEAT_INTERVAL_MS) ?? undefined;
          } else {
            deps.adapter.log.debug("WS: auth_invalid — unknown or missing access token");
            wsSendAndTerminate(socket, { type: "auth_invalid", message: "Invalid access token" });
          }
          return;
        }
        if (session !== null && !deps.sessionAlive(session)) {
          deps.adapter.log.debug("WS: session revoked or display removed — closing");
          socket.terminate();
          return;
        }
        handleWsCommand(socket, msg, deps);
      } catch (err) {
        deps.adapter.log.debug(`WS message handler error: ${errText(err)}`);
      }
    });

    socket.on("pong", () => {
      alive = true;
    });

    socket.on("error", () => {
      // Client vanished mid-stream — the socket is gone; timers cleared on close.
    });

    socket.on("close", () => {
      clearTimers();
    });
  });
}
