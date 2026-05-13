import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
    HA_VERSION,
    SESSION_TTL_MS,
    CLEANUP_INTERVAL_MS,
    LOGIN_SCHEMA,
    OAUTH_ACCESS_TOKEN_TTL_S,
    SESSIONS_CAP,
    WEBHOOK_REGISTRATIONS_CAP,
    REQUEST_ERROR_COOLDOWN_MS,
    REQUEST_ERROR_COOLDOWN_CAP,
    COOKIE_MAX_AGE_S,
} from './constants';
import { coerceString, coerceUuid, isValidRedirectUri, safeStringEqual } from './coerce';
import { buildRedirectUrl, renderAuthorizeError, renderAuthorizeForm, renderAuthorizeRedirect } from './auth-page';
import { CONNECTION_STATUS_SCRIPT } from './external-bridge';
import type { ClientRegistry } from './client-registry';
import type { GlobalConfig } from './global-config';
import { renderLandingPage } from './landing-page';
import { getLocalIp, isWildcardBind } from './network';
import type { AdapterConfig, AdapterInterface, ClientRecord, SessionData } from './types';

// v1.22.0 (F5): `safeStringEqual` ist nach `coerce.ts` verschoben — generischer
// crypto-Helper, kein webserver-spezifischer Belang.

/** Adapter surface the WebServer depends on — adds `namespace` for the setup page. */
export type WebServerAdapter = AdapterInterface & Pick<ioBroker.Adapter, 'namespace'>;

/**
 * HTML-Wrapper statt 302-Redirect (A3 / v1.7.0). Display lädt das HTML einmal,
 * sieht den Target im iframe, polled `/api/redirect_check` alle 30s. Bei
 * Target-Wechsel (User edit) macht es `location.reload()` und bekommt das
 * neue iframe-Target.
 *
 * `target` muss bereits durch `coerceSafeUrl` validiert sein (Resolver garantiert
 * das). Der Wrapper escaped trotzdem — defense in depth.
 *
 * @param target Vom Resolver gelieferte Ziel-URL
 */
function renderRedirectWrapper(target: string): string {
    // Conservative HTML-attribute escape: minimal set to make the URL safe in
    // the `src` attribute and the JS string literal below. Sicherheits-relevant
    // weil target letztlich aus user-konfigurierten States stammt.
    const escAttr = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const escJs = JSON.stringify(target); // safe for inline JS string literal
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>ioBroker HASS Emulator</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}
/* display:block kills the inline-baseline gap below the iframe; position:fixed +
   100vw/100vh nimmt das Display sicher voll aus, auch wenn ein WebView die
   100%-Berechnung subpixel-falsch macht (Shelly Wall Display zeigte sonst
   einen schwarzen Streifen rechts/unten). */
iframe{display:block;border:0;margin:0;padding:0;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;}
</style>
</head>
<body>
<iframe src="${escAttr}" allow="autoplay; fullscreen; geolocation; microphone; camera"></iframe>
${CONNECTION_STATUS_SCRIPT}
<script>
(function(){
  var current=${escJs};
  setInterval(function(){
    fetch('/api/redirect_check',{cache:'no-store',credentials:'same-origin'})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j&&typeof j.target==='string'&&j.target&&j.target!==current){
          location.reload();
        }
      })
      .catch(function(){/* silent — broker hiccup, retry next tick */});
  },30000);
})();
</script>
</body>
</html>`;
}

/** Browser cookie name. Client identity lives here — auto-sent on every page navigation. */
export const CLIENT_COOKIE = 'hassemu_client';

/**
 * Fastify web server emulating the HA REST API.
 *
 * Each incoming request is identified by cookie → {@link ClientRegistry} entry; new clients
 * get a channel created on first hit. Express was swapped for Fastify in 1.1.0 for first-party
 * cookie support, schema validation and a lighter runtime.
 */
export class WebServer {
    private readonly adapter: WebServerAdapter;
    private readonly config: AdapterConfig;
    private readonly registry: ClientRegistry;
    private readonly globalConfig: GlobalConfig;
    private readonly app: FastifyInstance;
    public readonly sessions: Map<string, SessionData> = new Map();
    /**
     * Mobile-App webhook registrations from `POST /api/mobile_app/registrations`
     * (v1.29.1). Key = webhookId (URL secret), Value = owning client cookie id.
     * Subsequent `POST /api/webhook/<id>` requests are validated against this
     * map. FIFO-capped at {@link WEBHOOK_REGISTRATIONS_CAP}.
     *
     * Reused for Shelly Wall Display FW 2.6.0+ onboarding — the on-device HA
     * Companion App requires this endpoint to complete device registration
     * after the OAuth2 sign-in. Without it the App refuses to proceed with a
     * "Mobile-App-Integration nicht verfügbar" error.
     *
     * **Design — in-memory only, by intent.** The map is NOT persisted across
     * adapter restarts. Restart-recovery relies on the
     * `POST /api/webhook/<unknown-id>` branch returning HTTP 200 with an
     * empty body — the HA Companion App reads that as a stale webhook and
     * re-runs `update_registration`, which on hassemu issues a fresh
     * webhookId. (Source: home-assistant/android
     * IntegrationRepositoryImpl.kt:170 — `200 with empty body triggers
     * maybeReregisterDeviceOnFailedUpdate`.)
     *
     * If a future refactor changes the unknown-webhookId response from
     * `200 empty` to `404`, displays will silently break across adapter
     * restarts. Keep that response shape OR add real persistence here.
     */
    public readonly webhookRegistrations: Map<string, string> = new Map();
    private cleanupTimer: ioBroker.Interval | null = null;
    /**
     * v1.14.0 (H8): bind once im Constructor statt bei jedem Property-Access
     * via getter — vorher allokierte jeder `s.inject({...})`-Call eine neue
     * gebundene Funktion. Tests rufen das in Loops auf — unnötiger GC-Druck.
     */
    public readonly inject!: FastifyInstance['inject'];
    public readonly instanceUuid: string;
    /** ioBroker system language for the setup page — resolved on startup. */
    public readonly systemLanguage: string;
    /** Set of IPs whose reverse DNS lookup is already in-flight — prevents duplicate work. */
    private readonly dnsInFlight = new Set<string>();
    /**
     * Per-message cooldown timestamps for 5xx error logging. First occurrence
     * of a unique message logs at warn; repeats within {@link REQUEST_ERROR_COOLDOWN_MS}
     * fall to debug to prevent log-spam under attack/probe traffic.
     */
    private readonly errorLogCooldown: Map<string, number> = new Map();

    /**
     * @param adapter        Adapter instance used for logging, timers and namespace.
     * @param config         Resolved runtime config.
     * @param registry       Multi-client registry.
     * @param globalConfig   Global redirect override.
     * @param instanceUuid   Stable UUID shared with the mDNS advert.
     * @param systemLanguage ioBroker system language (`en`, `de`, …) used for the setup page.
     */
    constructor(
        adapter: WebServerAdapter,
        config: AdapterConfig,
        registry: ClientRegistry,
        globalConfig: GlobalConfig,
        instanceUuid: string,
        systemLanguage: string = 'en',
    ) {
        this.adapter = adapter;
        this.config = config;
        this.registry = registry;
        this.globalConfig = globalConfig;
        this.instanceUuid = instanceUuid;
        this.systemLanguage = systemLanguage;
        // v1.25.0 (C11): trustProxy ist Opt-In über config — nur aktivieren
        // wenn der Adapter HINTER einem trusted Reverse-Proxy mit TLS-
        // Termination läuft. Mit trustProxy=true holt Fastify `req.ip` aus
        // `X-Forwarded-For` (statt aus dem Socket), `req.protocol` aus
        // `X-Forwarded-Proto` etc. — Voraussetzung: der Proxy bereinigt diese
        // Header (sonst kann jeder Client den Lockout umgehen).
        this.app = Fastify({ logger: false, trustProxy: this.config.trustProxy === true });
        // v1.14.0 (H8): inject einmal binden, nicht pro Getter-Access.
        (this as { inject: FastifyInstance['inject'] }).inject = this.app.inject.bind(this.app);
    }

    /** Human-readable service name advertised in responses and mDNS. */
    get serviceName(): string {
        return this.config.serviceName || 'ioBroker';
    }

    /** Resolved listener address once `start()` has completed, or null otherwise. */
    get boundAddress(): { address: string; port: number } | null {
        const addr = this.app.server.address();
        if (!addr || typeof addr === 'string') {
            return null;
        }
        return { address: addr.address, port: addr.port };
    }

    // --- lifecycle ---

    /** Registers plugins and starts the HTTP listener. */
    async start(): Promise<void> {
        // v1.14.0 (H9): defensive — wenn start() jemals doppelt gerufen wird
        // (Refactor, Test-Setup-Bug), Timer aus dem Vorlauf clearen statt zu
        // leaken.
        if (this.cleanupTimer) {
            this.adapter.clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        await this.app.register(fastifyCookie);
        // OAuth2-Spec verlangt `application/x-www-form-urlencoded` für `/auth/token`.
        // Echte HA-Reference-Clients (frontend/Wall Display SDK) folgen dem.
        // Fastify hat by-default nur einen JSON-Bodyparser — ohne diesen Plugin
        // beantwortet `/auth/token` mit form-Body 415 und der Login bleibt komplett
        // hängen. Tests via `app.inject({payload:{...}})` serialisieren zu JSON
        // und maskieren das.
        await this.app.register(fastifyFormbody);
        this.setupAuthGuard();
        this.setupErrorHandler();
        this.setupRoutes();

        const bindAddress = this.config.bindAddress || '0.0.0.0';
        try {
            await this.app.listen({ port: this.config.port, host: bindAddress });
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            const msg =
                e.code === 'EADDRINUSE'
                    ? `Port ${this.config.port} is already in use — another service is bound to it`
                    : `Server error during startup: ${e.message}`;
            this.adapter.log.error(msg);
            throw err;
        }
        this.adapter.log.debug(`Web server listening on ${bindAddress}:${this.config.port}`);

        this.cleanupTimer = this.adapter.setInterval(() => this.cleanupSessions(), CLEANUP_INTERVAL_MS) ?? null;
    }

    /** Stops the listener and cancels the session cleanup timer. */
    async stop(): Promise<void> {
        if (this.cleanupTimer) {
            this.adapter.clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        try {
            await this.app.close();
            this.adapter.log.debug('Web server stopped');
        } catch (err) {
            // v1.18.0 (G6+G8): debug statt error — bei intended shutdown
            // (onUnload) ist ein close-error meist ein "already-closed"-Race
            // ohne Konsequenz. Caller (main.ts onUnload) loggt nicht doppelt.
            this.adapter.log.debug(`Web server stop error: ${String(err)}`);
        }
        // v1.28.3 (HW1): drop in-flight DNS markers so a slow reverse-lookup
        // started just before stop() doesn't keep an IP entry pinned for the
        // whole process lifetime. The Promise.race(timeout) finally-handler
        // would do that eventually, but only after up to 5s — racy if the
        // adapter is restarted during that window.
        this.dnsInFlight.clear();
    }

    // v1.14.0 (H8): `inject` ist jetzt ein readonly Field (oben deklariert,
    // im Constructor einmalig gebunden). Der frühere Getter allokierte bei
    // jedem Access eine neue Funktion.

    /** Periodic cleanup of expired in-flight auth sessions and stale lockouts. */
    public cleanupSessions(): void {
        const now = Date.now();
        let cleanedSessions = 0;
        for (const [key, session] of this.sessions) {
            if (now - session.created > SESSION_TTL_MS) {
                this.sessions.delete(key);
                cleanedSessions++;
            }
        }
        if (cleanedSessions > 0) {
            this.adapter.log.debug(`Session cleanup: removed ${cleanedSessions} expired sessions`);
        }
    }

    /**
     * Drops the oldest entry of a Map if it would exceed `cap` after the next insert.
     * Map iteration order in JS is insertion order, so `keys().next()` is the oldest.
     *
     * @param map Map to evict from.
     * @param cap Hard cap; when `map.size >= cap`, the oldest entry is removed.
     */
    /**
     * Cooldown-Decision für 5xx-Error-Logging. Liefert `true` für die erste
     * Beobachtung pro `key` innerhalb {@link REQUEST_ERROR_COOLDOWN_MS} und
     * markiert den Eintrag — Wiederholungen liefern `false` bis das Fenster
     * abgelaufen ist. Map ist FIFO-gedeckelt auf {@link REQUEST_ERROR_COOLDOWN_CAP}.
     *
     * @param key Eindeutiger Error-Identifier (üblicherweise `error.message`).
     * @param now Aktuelle Zeit in ms (testbar).
     */
    public shouldEmitRequestErrorWarn(key: string, now: number): boolean {
        const lastSeen = this.errorLogCooldown.get(key) ?? 0;
        if (lastSeen !== 0 && now - lastSeen <= REQUEST_ERROR_COOLDOWN_MS) {
            return false;
        }
        if (!this.errorLogCooldown.has(key)) {
            WebServer.evictOldest(this.errorLogCooldown, REQUEST_ERROR_COOLDOWN_CAP);
        }
        this.errorLogCooldown.set(key, now);
        return true;
    }

    private static evictOldest<V>(map: Map<string, V>, cap: number): void {
        // v1.9.0 (E9): while-loop statt single if. Single Eviction reicht
        // wenn der Caller VOR jedem Insert evictet (heute der Fall), aber
        // ein while ist defensiv robust falls cap mal nachträglich gesenkt
        // wird oder ein Caller bulk-inserts macht.
        while (map.size >= cap) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) {
                return;
            }
            map.delete(oldest);
        }
    }

    /**
     * Inserts a session, dropping the oldest entry if {@link SESSIONS_CAP} is exceeded.
     *
     * @param key  Session key (flow id or auth code).
     * @param data Session payload.
     */
    private storeSession(key: string, data: SessionData): void {
        WebServer.evictOldest(this.sessions, SESSIONS_CAP);
        this.sessions.set(key, data);
    }

    // --- client identification ---

    /**
     * v1.15.0 (F6): zentraler Extract `req.ip → coerced string|null`. Vorher
     * 3× inline `coerceString(req.ip)` in identify/login/token-Handlern.
     *
     * @param req Fastify request (uses `req.ip`).
     */
    private static getClientIp(req: FastifyRequest): string | null {
        return coerceString(req.ip);
    }

    private async identify(req: FastifyRequest, reply: FastifyReply): Promise<ClientRecord> {
        const cookie = coerceUuid(req.cookies?.[CLIENT_COOKIE]);
        const ip = WebServer.getClientIp(req);
        // v1.17.0 (C8): UA durchreichen damit NAT-Co-Located Displays nicht
        // im selben Pending-Lock landen (siehe identifyOrCreate-Kommentar).
        const userAgent = coerceString(req.headers['user-agent']);
        const record = await this.registry.identifyOrCreate(cookie, ip, null, userAgent);
        if (cookie !== record.cookie) {
            // v1.25.0 (C11): Cookie `secure: true` wenn TLS — Browser sendet
            // den Cookie dann nur über HTTPS. Bei trustProxy=true kommt
            // `req.protocol` aus `X-Forwarded-Proto`-Header. Default ohne
            // trustProxy: `req.protocol === 'http'` (Adapter ist HTTP only),
            // also Cookie nicht-secure — sonst würde der Browser ihn nie senden.
            const useSecure = req.protocol === 'https';
            reply.setCookie(CLIENT_COOKIE, record.cookie, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: useSecure,
                maxAge: COOKIE_MAX_AGE_S,
            });
        }
        if (ip) {
            this.resolveHostnameAsync(record, ip);
        }
        return record;
    }

    private resolveHostnameAsync(record: ClientRecord, ip: string): void {
        if (record.hostname || this.dnsInFlight.has(ip)) {
            return;
        }
        this.dnsInFlight.add(ip);
        // v1.8.1 (D5): DNS-Lookup mit hartem 5s-Timeout. Default-Node-DNS hat
        // KEIN Timeout — bei broken Resolver (Captive-Portal, Misconfig) blieb
        // der Promise unendlich pending → IP für Adapter-Lifetime in dnsInFlight
        // blockiert, hostname auf record.ip gefroren.
        const timeout = new Promise<string[]>((_, reject) =>
            setTimeout(() => reject(new Error('dns reverse-lookup timeout')), 5_000),
        );
        Promise.race([dns.reverse(ip), timeout])
            .then(names => {
                const name = names[0];
                if (name) {
                    this.registry.identifyOrCreate(record.cookie, ip, name).catch(() => {
                        /* registry itself logs */
                    });
                }
            })
            .catch(() => {
                // Reverse DNS often fails on LAN or times out — intentionally silent.
            })
            .finally(() => {
                this.dnsInFlight.delete(ip);
            });
    }

    // --- auth guard ---

    /**
     * Pre-handler hook der `/api/*`-Routen schützt wenn `authRequired=true`.
     *
     * Vorher: `/api/states`, `/api/services`, `/api/events`, `/api/error_log`,
     * `/api/discovery_info` lieferten unauthenticated alle ihre Daten —
     * pure Information-Disclosure. Echte HA verlangt `Authorization: Bearer
     * <token>` für alle `/api/*` außer dem `/api/`-Heartbeat.
     *
     * Whitelist (kein Auth nötig):
     *   - `/`, `/manifest.json`, `/health`, `/api/` — public Endpoints (Heartbeat, PWA)
     *   - `/api/discovery_info` — HA-Clients fragen das VOR dem Auth-Flow ab um
     *     zu erkennen ob `requires_api_password` true ist (Spec-Verhalten)
     *   - `/auth/*` — der Auth-Flow selbst
     *
     * Bei `authRequired=false`: Hook macht nichts (no-op), bestehender Verhalten.
     */
    private setupAuthGuard(): void {
        this.app.addHook('preHandler', async (req, reply) => {
            if (!this.config.authRequired) {
                return;
            }
            const path = (req.url ?? '/').split('?')[0];
            // Public endpoints — explicitly allowed
            if (
                path === '/' ||
                path === '/api/' ||
                path === '/api/discovery_info' ||
                path === '/manifest.json' ||
                path === '/health' ||
                path.startsWith('/auth/') ||
                // v1.29.1: Mobile-App webhooks carry the secret in the URL
                // (`webhookId`) — HA core also serves these unauthenticated.
                // Source: home-assistant/core/.../mobile_app/webhook.py.
                path.startsWith('/api/webhook/')
            ) {
                return;
            }
            // From here on: protected (`/api/*` apart from `/api/`)
            const authHeader = req.headers.authorization;
            if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
                this.adapter.log.debug(`Auth required for ${path} — missing Bearer token`);
                reply.status(401).send({ error: 'unauthorized' });
                return;
            }
            const token = authHeader.substring('Bearer '.length).trim();
            const client = this.registry.getByToken(token);
            if (!client) {
                this.adapter.log.debug(`Auth required for ${path} — unknown Bearer token`);
                reply.status(401).send({ error: 'invalid_token' });
                return;
            }
            // OK — handler runs
        });
    }

    // --- error handling ---

    private setupErrorHandler(): void {
        this.app.setErrorHandler((err, _req, reply) => {
            const error = err as Error & { validation?: unknown; statusCode?: number };
            if (error.validation) {
                this.adapter.log.debug(`Validation error: ${error.message}`);
                reply.status(400).send({ error: 'Invalid request', details: error.message });
                return;
            }
            // Fastify body-parsing / client errors already set statusCode in 4xx range
            const code = typeof error.statusCode === 'number' ? error.statusCode : 500;
            if (code >= 400 && code < 500) {
                this.adapter.log.debug(`Client error ${code}: ${error.message}`);
                reply.status(code).send({ error: error.message });
                return;
            }
            // 5xx: ein attacker kann mit malformed paths/oversized bodies viele
            // 500er triggern. Per-Message-Dedup-Map mit 60s-Cooldown — das erste
            // Auftreten pro unique message kommt als warn, alle Wiederholungen
            // im 60s-Fenster auf debug. Memory `feedback_no_log_spam`.
            const key = error.message || 'unknown';
            if (this.shouldEmitRequestErrorWarn(key, Date.now())) {
                this.adapter.log.warn(`Request error: ${error.message}`);
            } else {
                this.adapter.log.debug(`Request error (repeat): ${error.message}`);
            }
            reply.status(500).send({ error: 'Internal server error' });
        });
    }

    // --- routes ---

    private setupRoutes(): void {
        this.setupApiRoutes();
        this.setupAuthRoutes();
        this.setupMiscRoutes();
        this.setupNotFound();
    }

    private setupApiRoutes(): void {
        // CRITICAL: trailing slash — HA clients check this endpoint for discovery
        this.app.get('/api/', () => ({ message: 'API running.' }));

        this.app.get('/api/config', () => ({
            // `mobile_app` advertises the integration the HA Companion App
            // probes for during onboarding (v1.29.1, Shelly FW 2.6.0+).
            components: ['http', 'api', 'frontend', 'homeassistant', 'mobile_app'],
            config_dir: '/config',
            elevation: 0,
            latitude: 0,
            longitude: 0,
            location_name: this.serviceName,
            time_zone: 'UTC',
            unit_system: { length: 'km', mass: 'g', temperature: '°C', volume: 'L' },
            version: HA_VERSION,
            whitelist_external_dirs: [],
        }));

        this.app.get('/api/discovery_info', () => {
            // v1.17.0 (E11): NICHT mehr `req.hostname` — der Host-Header ist
            // client-controlled und ein Angreifer könnte mit `Host: attacker.lan`
            // andere HA-Clients zur falschen URL umleiten. Stattdessen die
            // tatsächlich gebundene Adresse: bindAddress (ggf. wildcard) oder
            // ersten lokalen non-internal IPv4 via getLocalIp.
            const isWildcard = !this.config.bindAddress || isWildcardBind(this.config.bindAddress);
            const host = isWildcard ? getLocalIp() : this.config.bindAddress;
            const baseUrl = `http://${host}:${this.config.port}`;
            return {
                base_url: baseUrl,
                external_url: null,
                internal_url: baseUrl,
                location_name: this.serviceName,
                // Vorher hardcoded `true` unabhängig von authRequired — strict HA-Clients
                // versuchten Auth auch bei authRequired=false und scheiterten am leeren Login-Flow.
                requires_api_password: this.config.authRequired,
                uuid: this.instanceUuid,
                version: HA_VERSION,
            };
        });

        for (const path of ['/api/states', '/api/services', '/api/events']) {
            this.app.get(path, () => []);
        }
        this.app.get('/api/error_log', () => '');

        // ---- Mobile-App integration (HA Companion + Shelly FW 2.6.0+) ----
        //
        // Source: home-assistant/android IntegrationRepositoryImpl.kt:120-159
        // calls POST /api/mobile_app/registrations after the OAuth2 sign-in.
        // A 404 here surfaces as „Mobile-App-Integration nicht verfügbar" in
        // the App's onboarding screen and blocks the display from finishing
        // setup. Detail in Ressourcen/hassemu/oauth2-browser-flow-shelly-fw26.md.
        //
        // The Bearer-token check is already done by the existing auth
        // pre-handler — `/api/mobile_app/registrations` is protected by
        // default, so by the time the handler runs we know the caller has
        // a valid access_token from /auth/token.
        this.app.post<{
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
        }>('/api/mobile_app/registrations', async (req, reply) => {
            const body = req.body ?? {};
            // Identify by Bearer token — the pre-handler already validated it.
            const authHeader = (req.headers.authorization as string) ?? '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
            const client = this.registry.getByToken(token);
            const ownerId = client?.id ?? '';

            const webhookId = crypto.randomUUID().replace(/-/g, '');
            WebServer.evictOldest(this.webhookRegistrations, WEBHOOK_REGISTRATIONS_CAP);
            this.webhookRegistrations.set(webhookId, ownerId);

            this.adapter.log.debug(
                `Mobile-App registration — client=${ownerId} app_id=${body.app_id ?? '?'} device_name=${body.device_name ?? '?'} → webhook=${webhookId}`,
            );

            // Response shape: home-assistant/android RegisterDeviceResponse.kt
            //   cloudhookUrl: String? (null — no Nabu Casa cloud)
            //   remoteUiUrl:  String? (null — no remote-UI)
            //   secret:       String? (null — webhookId itself is the secret)
            //   webhookId:    String  (required, non-null)
            reply.status(201);
            return {
                webhook_id: webhookId,
                cloudhook_url: null,
                remote_ui_url: null,
                secret: null,
            };
        });

        // PUT and DELETE on /api/mobile_app/registrations/:webhookId — the App
        // calls PUT to update its registration on token refresh or sensor
        // re-register. We treat both as no-ops that return success so the
        // Companion App doesn't show registration-failure banners.
        this.app.put<{ Params: { webhookId: string } }>(
            '/api/mobile_app/registrations/:webhookId',
            async (req, reply) => {
                const id = req.params.webhookId;
                if (!this.webhookRegistrations.has(id)) {
                    reply.status(404);
                    return { error: 'unknown_registration' };
                }
                return { webhook_id: id, cloudhook_url: null, remote_ui_url: null, secret: null };
            },
        );

        this.app.delete<{ Params: { webhookId: string } }>(
            '/api/mobile_app/registrations/:webhookId',
            async (req, reply) => {
                this.webhookRegistrations.delete(req.params.webhookId);
                reply.status(204);
                return null;
            },
        );

        // POST /api/webhook/:webhookId — Companion-App sensor updates,
        // location pings, registration updates etc. Public by design (URL
        // contains the webhookId secret). HA core dispatches on `type` field
        // in the JSON body and returns shape per type. For hassemu we accept
        // any payload and respond with the minimal-correct success per type;
        // the display use-case doesn't need actual state propagation, but
        // returning 200 prevents the App from re-trying in a loop and
        // surfacing onboarding-failure banners.
        this.app.post<{
            Params: { webhookId: string };
            Body: { type?: string; data?: unknown };
        }>('/api/webhook/:webhookId', async (req, reply) => {
            const id = req.params.webhookId;
            if (!this.webhookRegistrations.has(id)) {
                // Unknown webhookId — match HA's 200-empty for stale webhooks
                // so the App falls back to `update_registration` (which on
                // hassemu re-issues a new registration). Source:
                // home-assistant/android IntegrationRepositoryImpl.kt:170 —
                // 200 with empty body triggers `maybeReregisterDeviceOnFailedUpdate`.
                reply.status(200);
                return null;
            }
            const body = req.body ?? {};
            const type = typeof body.type === 'string' ? body.type : '';
            this.adapter.log.debug(`Webhook ${id.substring(0, 8)}… type=${type || '(no type)'}`);

            switch (type) {
                case 'get_config':
                    return {
                        components: ['http', 'api', 'frontend', 'homeassistant', 'mobile_app'],
                        latitude: 0,
                        longitude: 0,
                        elevation: 0,
                        unit_system: { length: 'km', mass: 'g', temperature: '°C', volume: 'L' },
                        location_name: this.serviceName,
                        time_zone: 'UTC',
                        version: HA_VERSION,
                    };
                case 'get_zones':
                    return [];
                case 'render_template':
                    return {};
                case 'update_registration':
                    return { webhook_id: id, cloudhook_url: null, remote_ui_url: null, secret: null };
                case 'register_sensor':
                    return { success: true };
                case 'update_sensor_states':
                    return {};
                default:
                    // Generic success for unknown types — fire_event,
                    // call_service, conversation_process, update_location,
                    // get_zones-with-data, etc. The display doesn't need
                    // their semantics, just an HTTP 200 acknowledgement.
                    return {};
            }
        });
    }

    /**
     * Issue a fresh authorization code and persist it in the sessions map.
     *
     * Single source for both the JSON login flow (`/auth/login_flow/<flowId>`
     * → `create_entry`) and the browser OAuth2 flow (`/auth/authorize` →
     * 302). The code is exchanged for tokens at `/auth/token` (`grant_type =
     * authorization_code`); the existing token-view consumes the same map.
     *
     * @param clientId Identity cookie value of the requesting display, or
     *                 undefined for headless OAuth2-only flows.
     */
    private issueAuthorizationCode(clientId: string | null): string {
        const code = crypto.randomUUID();
        this.storeSession(code, { created: Date.now(), clientId });
        return code;
    }

    private setupAuthRoutes(): void {
        this.app.get('/auth/providers', () => [{ name: 'Home Assistant Local', type: 'homeassistant', id: null }]);

        // Browser-OAuth2 flow at GET/POST /auth/authorize. Needed by the
        // HA Companion Android App (Shelly Wall Display FW 2.6.0+ embeds
        // the Companion App). Source-verified flow:
        //   home-assistant/android UrlUtil.kt:buildAuthenticationUrl
        //   home-assistant/core indieauth.py:verify_redirect_uri
        //   home-assistant/frontend src/data/auth.ts:redirectWithAuthCode
        // Detail: Ressourcen/hassemu/oauth2-browser-flow-shelly-fw26.md
        this.app.get<{
            Querystring: { response_type?: string; client_id?: string; redirect_uri?: string; state?: string };
        }>('/auth/authorize', async (req, reply) => {
            const { response_type, client_id, redirect_uri, state } = req.query ?? {};

            if (response_type !== 'code') {
                reply.status(400).type('text/html');
                return renderAuthorizeError(
                    'unsupported_response_type',
                    'This authorization server supports `response_type=code` only.',
                );
            }
            if (typeof client_id !== 'string' || typeof redirect_uri !== 'string') {
                reply.status(400).type('text/html');
                return renderAuthorizeError(
                    'invalid_request',
                    'Missing or invalid `client_id` or `redirect_uri` parameter.',
                );
            }
            if (!isValidRedirectUri(client_id, redirect_uri)) {
                this.adapter.log.debug(
                    `Authorize rejected: redirect_uri "${redirect_uri}" not allowed for client_id "${client_id}"`,
                );
                reply.status(400).type('text/html');
                return renderAuthorizeError(
                    'invalid_redirect_uri',
                    'The `redirect_uri` parameter is not on the allowlist for this client.',
                );
            }

            const client = await this.identify(req, reply);

            // No auth required → issue the code right away and redirect.
            if (!this.config.authRequired) {
                const code = this.issueAuthorizationCode(client.id);
                const target = buildRedirectUrl(redirect_uri, code, state);
                this.adapter.log.debug(`Authorize auto-grant — client ${client.id}`);
                reply.type('text/html');
                return renderAuthorizeRedirect(target);
            }

            reply.type('text/html');
            return renderAuthorizeForm({ clientId: client_id, redirectUri: redirect_uri, state });
        });

        this.app.post<{
            Body: {
                response_type?: string;
                client_id?: string;
                redirect_uri?: string;
                state?: string;
                username?: string;
                password?: string;
            };
        }>('/auth/authorize', async (req, reply) => {
            const { response_type, client_id, redirect_uri, state, username, password } = req.body ?? {};

            if (response_type !== 'code') {
                reply.status(400).type('text/html');
                return renderAuthorizeError('unsupported_response_type', 'Only `response_type=code` is supported.');
            }
            if (typeof client_id !== 'string' || typeof redirect_uri !== 'string') {
                reply.status(400).type('text/html');
                return renderAuthorizeError(
                    'invalid_request',
                    'Missing or invalid `client_id` or `redirect_uri` parameter.',
                );
            }
            if (!isValidRedirectUri(client_id, redirect_uri)) {
                reply.status(400).type('text/html');
                return renderAuthorizeError(
                    'invalid_redirect_uri',
                    'The `redirect_uri` parameter is not on the allowlist for this client.',
                );
            }

            const client = await this.identify(req, reply);

            // No auth required → straight to redirect even on POST.
            if (!this.config.authRequired) {
                const code = this.issueAuthorizationCode(client.id);
                const target = buildRedirectUrl(redirect_uri, code, state);
                reply.type('text/html');
                return renderAuthorizeRedirect(target);
            }

            const ip = WebServer.getClientIp(req);
            const userOk = typeof username === 'string' && safeStringEqual(username, this.config.username);
            const passOk = typeof password === 'string' && safeStringEqual(password, this.config.password);
            if (!userOk || !passOk) {
                const ipSuffix = ip ? ` (IP ${ip})` : '';
                this.adapter.log.warn(`Invalid credentials${ipSuffix}`);
                reply.status(401).type('text/html');
                return renderAuthorizeForm(
                    { clientId: client_id, redirectUri: redirect_uri, state },
                    'Invalid username or password.',
                );
            }

            const code = this.issueAuthorizationCode(client.id);
            const target = buildRedirectUrl(redirect_uri, code, state);
            this.adapter.log.debug(`Authorize grant — client ${client.id}`);
            reply.type('text/html');
            return renderAuthorizeRedirect(target);
        });

        this.app.post('/auth/login_flow', async (req, reply) => {
            const client = await this.identify(req, reply);
            const flowId = crypto.randomUUID();
            this.storeSession(flowId, { created: Date.now(), clientId: client.id });
            this.adapter.log.debug(`Auth flow created: ${flowId} for client ${client.id}`);

            return {
                type: 'form',
                flow_id: flowId,
                handler: ['homeassistant', null],
                step_id: 'init',
                data_schema: LOGIN_SCHEMA,
                description_placeholders: null,
                errors: null,
            };
        });

        this.app.post<{
            Params: { flowId: string };
            Body: { username?: string; password?: string };
        }>(
            '/auth/login_flow/:flowId',
            {
                schema: {
                    params: {
                        type: 'object',
                        properties: { flowId: { type: 'string', minLength: 1 } },
                        required: ['flowId'],
                    },
                },
            },
            async (req, reply) => {
                const flowId = req.params.flowId;
                const session = this.sessions.get(flowId);
                if (!session) {
                    // v1.8.0: nach Session-TTL (10 min) feuert das bei jedem
                    // legit returning user — nicht actionable. debug, nicht warn.
                    this.adapter.log.debug(`Unknown flow_id: ${flowId}`);
                    reply.status(400);
                    return { type: 'abort', flow_id: flowId, reason: 'unknown_flow' };
                }

                if (this.config.authRequired) {
                    const ip = WebServer.getClientIp(req);
                    const { username, password } = req.body ?? {};
                    const userOk = typeof username === 'string' && safeStringEqual(username, this.config.username);
                    const passOk = typeof password === 'string' && safeStringEqual(password, this.config.password);
                    if (!userOk || !passOk) {
                        const ipSuffix = ip ? ` (IP ${ip})` : '';
                        this.adapter.log.warn(`Invalid credentials${ipSuffix}`);
                        reply.status(400);
                        return {
                            type: 'form',
                            flow_id: flowId,
                            handler: ['homeassistant', null],
                            step_id: 'init',
                            data_schema: LOGIN_SCHEMA,
                            errors: { base: 'invalid_auth' },
                            description_placeholders: null,
                        };
                    }
                }

                this.sessions.delete(flowId);
                const code = crypto.randomUUID();
                this.storeSession(code, { created: Date.now(), clientId: session.clientId });
                this.adapter.log.debug('Auth flow completed — code issued');

                return {
                    version: 1,
                    type: 'create_entry',
                    flow_id: flowId,
                    handler: ['homeassistant', null],
                    result: code,
                    description: null,
                    description_placeholders: null,
                };
            },
        );

        this.app.post<{ Body: { code?: string; grant_type?: string; refresh_token?: string } }>(
            '/auth/token',
            async (req, reply) => {
                const { code, grant_type, refresh_token } = req.body ?? {};

                if (grant_type === 'authorization_code' && code && this.sessions.has(code)) {
                    const session = this.sessions.get(code)!;
                    this.sessions.delete(code);
                    const token = crypto.randomUUID();
                    const refreshToken = crypto.randomUUID();
                    if (session.clientId) {
                        // Persist VOR Response-Build: ein Crash zwischen Issue + Persist
                        // würde sonst dem Client einen Token in der Hand lassen, den der
                        // Server nicht kennt — beim ersten Refresh dann invalid_grant.
                        await this.registry.setToken(session.clientId, token);
                        await this.registry.setRefreshToken(session.clientId, refreshToken);
                        this.adapter.log.debug(`Display authenticated — client ${session.clientId}`);
                    }
                    return {
                        access_token: token,
                        token_type: 'Bearer',
                        refresh_token: refreshToken,
                        expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
                    };
                }

                if (grant_type === 'refresh_token') {
                    // Validate the refresh token against issued ones — was previously
                    // accepting any string and minting a new access_token (security fix v1.2.0).
                    const incoming = typeof refresh_token === 'string' ? refresh_token : '';
                    const ownerRecord = incoming ? this.registry.getByRefreshToken(incoming) : null;
                    if (!ownerRecord) {
                        this.adapter.log.debug('Refresh token rejected — unknown or missing');
                        reply.status(400);
                        return { error: 'invalid_grant', error_description: 'Invalid refresh token' };
                    }
                    // v1.31.0: refresh_token bleibt valid (NICHT mehr rotated). HA Core
                    // selbst (homeassistant/components/auth/__init__.py:334-348) liefert
                    // beim refresh-grant nie einen neuen refresh_token, nur access_token
                    // + token_type + expires_in. HA Android Companion
                    // (AuthenticationRepositoryImpl.kt:147) speichert beim Refresh den
                    // GESENDETEN refresh_token (Function-Parameter), ignoriert den in der
                    // Response zurückgegebenen — Companion behält daher immer ihren
                    // initialen refresh_token. v1.28.3 (HW5) Rotation war RFC 6819
                    // §5.2.2.3-konform aber inkompatibel mit dem Companion-Datenmodell:
                    // Server-Rotation killte den Companion-Token beim ersten Refresh.
                    const newAccess = crypto.randomUUID();
                    await this.registry.setToken(ownerRecord.id, newAccess);
                    return {
                        access_token: newAccess,
                        token_type: 'Bearer',
                        refresh_token: incoming,
                        expires_in: OAUTH_ACCESS_TOKEN_TTL_S,
                    };
                }

                // v1.8.0: „wrong grant_type" ist ein Client-Format-Fehler,
                // nicht ein Server-Concern — debug. KEIN Lockout-Counter
                // (legitimer Client-Bug soll nicht zu IP-Sperre führen).
                this.adapter.log.debug(`Token exchange failed: grant_type=${String(grant_type)}`);
                reply.status(400);
                return { error: 'invalid_request', error_description: 'Invalid or expired code' };
            },
        );
    }

    private setupMiscRoutes(): void {
        // Liveness only — no config leak. Earlier versions exposed the global
        // redirect URL via /health which is unauthenticated; removed in v1.2.0.
        // v1.5.0: auch der `config: { mdns, auth }`-Block raus — Auth-Status leakte
        // unauthenticated und ließ sich von einem Network-Attacker zur Reconnaissance
        // nutzen (auth-disabled Instances quickly mappen).
        this.app.get('/health', () => ({
            status: 'ok',
            adapter: 'hassemu',
            version: HA_VERSION,
        }));

        this.app.get('/manifest.json', () => ({
            // `name` MUST be "Home Assistant" exactly — the HA Companion App
            // verifies the server identity by parsing this field. Source:
            // home-assistant/android DefaultConnectivityChecker.kt:isHomeAssistant
            // checks `name === "Home Assistant"`. Anything else (e.g. `serviceName`
            // = "ioBroker") fails the onboarding probe with "Server ist nicht
            // Home Assistant". Detail in Ressourcen/hassemu/oauth2-browser-flow-shelly-fw26.md.
            name: 'Home Assistant',
            short_name: 'Home Assistant',
            start_url: '/',
            display: 'standalone',
            background_color: '#ffffff',
            theme_color: '#03a9f4',
        }));

        // Root — HTML-Wrapper (iframe + auto-reload), oder Landing-Page wenn keine URL.
        //
        // v1.7.0 (A3): statt 302 liefern wir ein iframe-HTML + 30s-poll auf
        // /api/redirect_check. Wenn die Mode-/URL-Config sich ändert (User edit
        // im Adapter), pollt das Display den Wechsel und macht `location.reload()`
        // — ohne Soft-Reboot des Displays. Vorher musste der User das Display
        // manuell rebooten.
        //
        // WebViews wie Shelly Wall Display rendern iframes + JavaScript korrekt.
        // Falls ein User direkten 302-Redirect will (Browser-Test, Bookmarklet
        // etc.), kann er die Target-URL direkt eingeben — der Wrapper läuft nur
        // beim Aufruf von `/`.
        this.app.get('/', async (req, reply) => {
            const client = await this.identify(req, reply);
            const url = this.globalConfig.resolveUrlFor(client);
            if (!url) {
                this.adapter.log.debug(`No redirect URL for client ${client.id} — serving landing page`);
                return reply
                    .status(200)
                    .type('text/html; charset=utf-8')
                    .send(renderLandingPage(client.id, this.adapter.namespace, this.systemLanguage, client.ip));
            }
            this.adapter.log.debug(`Serving wrapper for client ${client.id} → ${url}`);
            return reply.status(200).type('text/html; charset=utf-8').send(renderRedirectWrapper(url));
        });

        // /api/redirect_check — Display polled das alle 30s; wenn der target
        // sich geändert hat (User edit), gibt der Wrapper `location.reload()`
        // ab. Cookie-basiert — Display schickt seinen `hassemu_client`-Cookie
        // automatisch mit.
        this.app.get('/api/redirect_check', async (req, reply) => {
            const client = await this.identify(req, reply);
            const url = this.globalConfig.resolveUrlFor(client);
            return { target: url ?? null };
        });
    }

    private setupNotFound(): void {
        this.app.setNotFoundHandler((req, reply) => {
            this.adapter.log.debug(`404: ${req.method} ${req.url}`);
            reply.status(404).send({ error: 'Not Found', path: req.url });
        });
    }
}
