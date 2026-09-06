/**
 * HA Companion App integration — device registrations and their webhook.
 *
 * Split out of `webserver.ts` in v1.43.0. This is a self-contained protocol with the HA
 * Android app: register a device, get a webhook id back, then talk through that webhook.
 * It shares nothing with the OAuth flow or the display routes except the Fastify instance
 * and the registration map it owns.
 *
 * Reached by the Shelly Wall Display FW 2.6.0+, whose on-device Companion App requires
 * these endpoints to finish device registration after the OAuth2 sign-in. Without them the
 * App refuses to proceed with a "Mobile-App-Integration nicht verfügbar" error.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { oneLine } from "./coerce";
import { evictOldest } from "./object-utils";
import { WEBHOOK_REGISTRATIONS_CAP } from "./constants";
import type { AdapterInterface, ClientRecord } from "./types";

/** Public route marker — the webhook authenticates by the secret in its own URL. */
const PUBLIC_ROUTE = { config: { public: true } } as const;

/** What the mobile-app routes need from the web server. */
export interface MobileAppDeps {
  /** Adapter surface for logging. */
  adapter: AdapterInterface;
  /**
   * webhookId → owning client id. `""` means "unowned" (a registration made while
   * `authRequired` was off, so no Bearer token identified a client).
   */
  registrations: Map<string, string>;
  /** Resolves the request's Bearer token to its client, or null. */
  clientForBearer: (authorization: unknown) => ClientRecord | null;
  /** `/api/config`-shaped object — one source shared with the REST route and the WS. */
  buildHaConfig: () => Record<string, unknown>;
}

/**
 * HA mobile_app registration response shape (home-assistant/android
 * RegisterDeviceResponse.kt): `webhookId` required, the cloud/remote/secret fields null
 * (no Nabu Casa cloud — the webhookId itself is the secret). Used by the registration
 * POST, the PUT update and the webhook `update_registration`.
 *
 * @param webhookId The issued webhook id (URL secret) to echo back to the App.
 */
export function mobileRegResponse(webhookId: string): {
  webhook_id: string;
  cloudhook_url: null;
  remote_ui_url: null;
  secret: null;
} {
  return { webhook_id: webhookId, cloudhook_url: null, remote_ui_url: null, secret: null };
}

/**
 * Register the mobile-app endpoints on `app`.
 *
 * **The registration map is in-memory by intent** and NOT persisted across adapter
 * restarts. Restart recovery relies on the `POST /api/webhook/<unknown-id>` branch
 * returning HTTP 200 with a truly EMPTY body — the HA Companion App reads that as a stale
 * webhook and re-runs `registerDevice`, which issues a fresh webhookId. (Source, verified
 * at tag 2026.4.4: home-assistant/android IntegrationRepositoryImpl.kt:167-171 — the
 * trigger is `response.code() == 200 && response.body()?.contentLength() == 0L`.)
 *
 * If a future change turns that response into a `404` or gives it any non-empty body (even
 * JSON `null`), displays break silently across adapter restarts. Keep the response shape
 * OR add real persistence.
 *
 * @param app  The Fastify instance.
 * @param deps Route dependencies.
 */
export function registerMobileAppRoutes(app: FastifyInstance, deps: MobileAppDeps): void {
  // Source: home-assistant/android IntegrationRepositoryImpl.kt:120-159 calls
  // POST /api/mobile_app/registrations after the OAuth2 sign-in. A 404 here surfaces as
  // "Mobile-App-Integration nicht verfügbar" in the App's onboarding screen and blocks the
  // display from finishing setup.
  //
  // The Bearer-token check is already done by the auth pre-handler — this route is
  // protected by default, so by the time the handler runs the caller holds a valid
  // access_token from /auth/token.
  app.post<{
    Body: {
      app_id?: string;
      app_name?: string;
      device_name?: string;
      device_id?: string;
      manufacturer?: string;
      model?: string;
      os_name?: string;
      os_version?: string;
    };
  }>("/api/mobile_app/registrations", async (req, reply) => {
    const body = req.body ?? {};
    const client = deps.clientForBearer(req.headers.authorization);
    const ownerId = client?.id ?? "";

    const webhookId = crypto.randomUUID().replace(/-/g, "");
    evictOldest(deps.registrations, WEBHOOK_REGISTRATIONS_CAP);
    deps.registrations.set(webhookId, ownerId);

    deps.adapter.log.debug(
      `Mobile-App registration — client=${ownerId} app_id=${oneLine(body.app_id ?? "?")} device_name=${oneLine(body.device_name ?? "?")} → webhook=${webhookId.substring(0, 8)}…`,
    );

    reply.status(201);
    return mobileRegResponse(webhookId);
  });

  // PUT and DELETE on /api/mobile_app/registrations/:webhookId — the App calls PUT to
  // update its registration on token refresh or sensor re-register. PUT echoes the
  // registration for a KNOWN webhookId (200) but returns 404 for an unknown one so a stale
  // pre-restart token re-registers; DELETE drops the registration and returns 204.
  app.put<{ Params: { webhookId: string } }>("/api/mobile_app/registrations/:webhookId", async (req, reply) => {
    const id = req.params.webhookId;
    if (!deps.registrations.has(id)) {
      // v1.32.0 E1: a stale id signals that the Companion holds a token from a
      // pre-restart era — diagnostically valuable for re-registration-loop bugs.
      deps.adapter.log.debug(
        `Mobile-App PUT registration: unknown webhookId=${oneLine(id).substring(0, 8)}… — returning 404`,
      );
      reply.status(404);
      return { error: "unknown_registration" };
    }
    return mobileRegResponse(id);
  });

  app.delete<{ Params: { webhookId: string } }>("/api/mobile_app/registrations/:webhookId", async (req, reply) => {
    const id = req.params.webhookId;
    const wasPresent = deps.registrations.has(id);
    deps.registrations.delete(id);
    // v1.32.0 E2: Companion-maintenance trace.
    deps.adapter.log.debug(
      `Mobile-App DELETE registration: webhookId=${oneLine(id).substring(0, 8)}… removed (was-present=${wasPresent})`,
    );
    // Body-less 204: use `.send()`, not `return null` — the `return null` idiom serialized
    // a 4-byte JSON "null" body once already (v1.35.2). L33.
    return reply.status(204).send();
  });

  // POST /api/webhook/:webhookId — Companion-App sensor updates, location pings,
  // registration updates etc. Public by design (the URL carries the webhookId secret). HA
  // core dispatches on the `type` field in the JSON body and returns a shape per type. For
  // hassemu we accept any payload and answer the minimal-correct success per type; the
  // display use-case needs no actual state propagation, but a 200 prevents the App from
  // retrying in a loop and surfacing onboarding-failure banners.
  app.post<{
    Params: { webhookId: string };
    Body: { type?: string; data?: unknown };
  }>("/api/webhook/:webhookId", PUBLIC_ROUTE, async (req, reply) => {
    const id = req.params.webhookId;
    if (!deps.registrations.has(id)) {
      // Unknown webhookId — match HA's 200-empty for stale webhooks so the App
      // re-registers. Source (verified at tag 2026.4.4): home-assistant/android
      // IntegrationRepositoryImpl.kt:167-171 — `updateRegistration` re-runs
      // `registerDevice` ONLY when `response.code() == 200 &&
      // response.body()?.contentLength() == 0L`. The body MUST therefore be truly empty:
      // `return null` would let Fastify serialize the 4-byte JSON text "null"
      // (contentLength 4), the Companion would take the success branch and the display
      // would stay broken silently (v1.35.2 fix).
      // v1.32.0 E3: a stale id is THE symptom of a re-registration loop.
      deps.adapter.log.debug(
        `Webhook fallthrough: stale id=${oneLine(id).substring(0, 8)}… — App will trigger re-registration`,
      );
      return reply.status(200).send();
    }
    const body = req.body ?? {};
    const type = typeof body.type === "string" ? body.type : "";
    deps.adapter.log.debug(`Webhook ${oneLine(id).substring(0, 8)}… type=${type || "(no type)"}`);

    switch (type) {
      case "get_config":
        return deps.buildHaConfig();
      case "get_zones":
        return [];
      case "render_template":
        return {};
      case "update_registration":
        return mobileRegResponse(id);
      case "register_sensor":
        return { success: true };
      case "update_sensor_states":
        return {};
      default:
        // Generic success for unknown types — fire_event, call_service,
        // conversation_process, update_location, get_zones-with-data, etc. The display
        // doesn't need their semantics, just an HTTP 200 acknowledgement.
        return {};
    }
  });
}
