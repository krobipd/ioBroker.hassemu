/**
 * Minimal HTML templates for the OAuth2 browser-flow at `/auth/authorize`.
 *
 * The real Home Assistant frontend renders the auth UI via a multi-MB
 * Lit/Polymer Web Component bundle. For hassemu we re-implement only the
 * subset the HA Companion App and the Shelly Wall Display app actually need:
 *
 * - `authRequired=false`: auto-submit page that calls `document.location.assign`
 *   with `redirect_uri?code=…&state=…` immediately. Matches HA's frontend
 *   redirect helper `redirectWithAuthCode` 1:1.
 * - `authRequired=true`: a minimal username/password form that POSTs to
 *   `/auth/authorize`. The handler verifies credentials and replies with
 *   the same auto-submit redirect on success, or re-renders the form with
 *   an error banner on failure.
 * - `400` error page when query parameters are malformed or the
 *   `redirect_uri` fails validation — never redirects, so an attacker
 *   cannot use the endpoint as an open redirector.
 *
 * Source: `home-assistant/frontend/src/data/auth.ts:redirectWithAuthCode` —
 * `document.location.assign(url)` with `code=<encoded>&state=<encoded>`.
 */

/**
 * Conservative HTML-attribute escape. Only the characters that matter.
 *
 * @param s Raw user-controlled string going into an `href`/`value` attribute.
 */
function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the final redirect URL with the auth code appended.
 *
 * @param redirectUri Already-validated `redirect_uri` from the OAuth2 query.
 * @param code        Auth code to deliver (will be URL-encoded).
 * @param state       Optional `state` parameter — round-tripped verbatim per OAuth2 CSRF.
 */
export function buildRedirectUrl(redirectUri: string, code: string, state: string | undefined): string {
    // Source: home-assistant/frontend/src/data/auth.ts — OAuth 2: 3.1.2 we
    // need to retain the existing query of a redirect URI.
    let url = redirectUri;
    if (!url.includes('?')) {
        url += '?';
    } else if (!url.endsWith('&') && !url.endsWith('?')) {
        url += '&';
    }
    url += `code=${encodeURIComponent(code)}`;
    if (state) {
        url += `&state=${encodeURIComponent(state)}`;
    }
    return url;
}

const STYLE = `
html,body{margin:0;padding:0;height:100%;background:#111;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.card{max-width:380px;margin:64px auto;padding:32px;background:#1c1c1c;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.5);}
h1{margin:0 0 24px;font-size:24px;font-weight:500;text-align:center;color:#03a9f4;}
.subtitle{color:#888;font-size:14px;text-align:center;margin:-16px 0 24px;}
.err{background:#3a1a1a;color:#ff8a80;padding:12px;border-radius:4px;margin-bottom:16px;font-size:14px;}
input{display:block;width:100%;padding:12px;margin:8px 0 16px;background:#2a2a2a;border:1px solid #444;color:#fff;border-radius:4px;font-size:16px;box-sizing:border-box;}
input:focus{outline:none;border-color:#03a9f4;}
button{display:block;width:100%;padding:14px;background:#03a9f4;color:#fff;border:none;border-radius:4px;font-size:16px;cursor:pointer;}
button:hover{background:#039be5;}
.loading{text-align:center;color:#888;padding:16px;}
`.trim();

/**
 * Render the auto-submit redirect page. Used when `authRequired=false` (after
 * generating an auth_code) OR after a successful POST login.
 *
 * Uses `document.location.assign(url)` to match HA's `redirectWithAuthCode`.
 * `<meta http-equiv="refresh">` as a fallback for clients without JS, though
 * the HA Companion App and Shelly Wall Display WebView both have JS enabled.
 *
 * @param target The fully-built `redirect_uri?code=…&state=…` URL.
 */
export function renderAuthorizeRedirect(target: string): string {
    const a = escAttr(target);
    const j = JSON.stringify(target); // safe for inline JS string literal
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; URL=${a}">
<title>Home Assistant</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card">
<h1>Home Assistant</h1>
<p class="loading">Signing in…</p>
</div>
<script>(function(){document.location.assign(${j});})();</script>
</body>
</html>`;
}

/**
 * Render the login form. Used on GET `/auth/authorize` when `authRequired=true`,
 * and re-used by the POST handler on credential failure with the error banner.
 *
 * Hidden fields preserve the OAuth2 query params across the form-submit so the
 * POST handler can finish the flow.
 *
 * @param params              Form context — `client_id`, `redirect_uri`, `state` (optional).
 * @param params.clientId     The OAuth2 `client_id` to round-trip in a hidden input.
 * @param params.redirectUri  Already-validated `redirect_uri` to round-trip in a hidden input.
 * @param params.state        Optional OAuth2 `state` (CSRF token) to round-trip.
 * @param errorMessage        Optional error banner text (i.e. "Invalid username or password.").
 */
export function renderAuthorizeForm(
    params: { clientId: string; redirectUri: string; state?: string },
    errorMessage?: string,
): string {
    const cid = escAttr(params.clientId);
    const ru = escAttr(params.redirectUri);
    const st = params.state ? escAttr(params.state) : '';
    const errBlock = errorMessage ? `<div class="err">${escAttr(errorMessage)}</div>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home Assistant — Sign In</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card">
<h1>Home Assistant</h1>
<p class="subtitle">Sign in to authorize this device.</p>
${errBlock}
<form method="POST" action="/auth/authorize" autocomplete="off">
<input type="hidden" name="response_type" value="code">
<input type="hidden" name="client_id" value="${cid}">
<input type="hidden" name="redirect_uri" value="${ru}">
<input type="hidden" name="state" value="${st}">
<input type="text" name="username" placeholder="Username" autofocus required>
<input type="password" name="password" placeholder="Password" required>
<button type="submit">Sign in</button>
</form>
</div>
</body>
</html>`;
}

/**
 * Render the authorization error page. Used when query params are malformed
 * or when `redirect_uri` fails validation. NEVER auto-redirects — we don't
 * want to leak codes to attacker-controlled URIs by accident.
 *
 * @param reason  Short OAuth2 error code (e.g. `invalid_request`).
 * @param detail  Human-readable explanation.
 */
export function renderAuthorizeError(reason: string, detail: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home Assistant — ${escAttr(reason)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card">
<h1>Authorization failed</h1>
<div class="err">${escAttr(detail)}</div>
<p class="subtitle">${escAttr(reason)}</p>
</div>
</body>
</html>`;
}
