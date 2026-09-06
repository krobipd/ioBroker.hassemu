/**
 * Boundary coercion helpers for external input.
 *
 * hassemu receives data from HTTP clients, cookies, foreign adapter objects
 * and user writes on states. TypeScript types only guarantee compile-time
 * shape — these helpers guard runtime reality.
 */

import crypto from "node:crypto";

/**
 * IndieAuth-style redirect_uri validation + HA Companion App whitelist.
 *
 * Three accept paths (matches home-assistant/core/homeassistant/components/auth/indieauth.py:30-55):
 * 1. Same scheme + netloc as client_id (default IndieAuth).
 * 2. Hardcoded whitelist for HA Companion iOS/Android apps — needed because
 *    they use custom URI scheme `homeassistant://` which can never pass rule (1).
 * 3. IndieAuth 4.2.2 — fetch client_id URL, parse `<link rel="redirect_uri">`
 *    tags. NOT implemented here — LAN emulation can't rely on internet fetch.
 *
 * Beyond the whitelist, only `http:`/`https:` redirect URIs are accepted: the
 * scheme is checked on the URL parsed by `new URL()`, so dangerous schemes
 * (javascript:, data:, vbscript:, file:, …) are rejected even when obfuscated
 * with leading/embedded tab/newline/CR that a raw-string prefix check misses.
 *
 * @param clientId    Untrusted `client_id` from OAuth2 query (an absolute URL).
 * @param redirectUri Untrusted `redirect_uri` from OAuth2 query.
 */
export function isValidRedirectUri(clientId: string, redirectUri: string): boolean {
  if (typeof clientId !== "string" || typeof redirectUri !== "string") {
    return false;
  }
  if (clientId.length === 0 || redirectUri.length === 0) {
    return false;
  }
  if (redirectUri.length > 2048 || clientId.length > 2048) {
    return false;
  }
  // (2) HA Companion App whitelist — must be checked before (1) because
  // these apps use `homeassistant://` which has no http(s) netloc to match.
  // Source: home-assistant/core indieauth.py:39-50.
  if (clientId === "https://home-assistant.io/iOS" && redirectUri === "homeassistant://auth-callback") {
    return true;
  }
  if (
    clientId === "https://home-assistant.io/android" &&
    (redirectUri === "homeassistant://auth-callback" ||
      redirectUri === "https://wear.googleapis.com/3p_auth/io.homeassistant.companion.android" ||
      redirectUri === "https://wear.googleapis-cn.com/3p_auth/io.homeassistant.companion.android")
  ) {
    return true;
  }

  // (1) Default IndieAuth rule — same scheme + netloc, evaluated on the PARSED
  // URLs. Checking the normalized `protocol` (not a raw-string prefix) is what
  // makes the dangerous-scheme rejection robust: `new URL()` strips tab/newline/
  // CR anywhere in the input, so a `"\tjavascript:…"` that would slip past a raw
  // `startsWith("javascript:")` blacklist still normalizes to
  // `protocol === "javascript:"` here and is rejected by the http(s)-only gate.
  try {
    const cid = new URL(clientId);
    const ru = new URL(redirectUri);
    if (ru.protocol !== "http:" && ru.protocol !== "https:") {
      return false;
    }
    return cid.protocol === ru.protocol && cid.host === ru.host;
  } catch {
    return false;
  }
}

/**
 * v1.22.0 (F5): vormals in webserver.ts. Constant-time string comparison
 * for credential checks. Length-leak-resistant via SHA-256-Digest-Vergleich:
 * beide Inputs werden auf eine fixe 32-Byte-Länge gehasht, dann timing-safe
 * verglichen.
 *
 * v1.16.0 (C6): vorher `if (ab.length !== bb.length) return false` VOR
 * timingSafeEqual — die Längen-Differenz war über Response-Timing
 * erschnüffelbar.
 *
 * @param a First string to compare.
 * @param b Second string to compare.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a, "utf8").digest();
  const bh = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * True when a value represents "no value set" — empty string, null or undefined.
 * The shared predicate behind the manualUrl / legacy-migration / restore blank
 * checks (was written out inline in four places).
 *
 * @param value Untrusted input.
 */
export function isEmptyValue(value: unknown): boolean {
  return value === "" || value === null || value === undefined;
}

/**
 * Coerce to a finite number, or null. Rejects NaN, Infinity, non-numeric strings.
 *
 * @param value Untrusted input.
 */
// v1.9.0 (E8): nur dezimale Zahlen — `Number()` würde sonst auch
// '0x1FBB' (HEX) und '8.123e3' (Exponential) akzeptieren. In url-discovery
// für Port-Felder wäre HEX-Acceptance Schaden-Vektor.
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Coerce to a finite number, or null. Rejects NaN, Infinity, non-decimal
 * strings (HEX, exponential, scientific notation).
 *
 * @param value Untrusted input.
 */
export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && DECIMAL_NUMBER_RE.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce to a non-empty string, or null.
 *
 * @param value Untrusted input.
 */
export function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

/**
 * Coerce to a boolean. Only accepts actual `true` / `false`.
 *
 * @param value Untrusted input.
 */
export function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

/**
 * Guard for plain objects (not arrays, not null).
 *
 * @param value Untrusted input.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerce to a UUID string, or null. Accepts any UUID variant.
 *
 * @param value Untrusted input.
 */
export function coerceUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return UUID_REGEX.test(value) ? value.toLowerCase() : null;
}

/**
 * Characters `new URL()` silently strips before parsing: ASCII tab, LF and CR, plus
 * leading/trailing C0 control characters and spaces. A value containing them parses as one
 * URL but is stored as another — see {@link coerceSafeUrl}.
 */
const URL_STRIPPED_CHARS = /[\t\n\r]/;

/**
 * Coerce to a safe redirect URL, or null.
 *
 * Requirements:
 * - http:// or https:// scheme (no javascript:, data:, file:, etc.)
 * - Parseable by URL()
 * - No embedded credentials (user:pass@host)
 * - Max 2048 chars
 * - The string as given IS what was parsed — no characters the URL parser removes
 *
 * That last rule closes a gap this function had since it was written: it validated the
 * PARSED url and then returned the RAW string. `new URL()` removes tab/LF/CR anywhere in
 * the input and trims leading/trailing control characters and spaces, so
 * `"http://ok.test/\n"` or `"htt\np://ok.test/"` passed every check above and was then
 * stored, logged and rendered in that exact form — a different string from the one the
 * checks were applied to. No exploit was reachable through it (every dangerous scheme
 * still normalises into `protocol` and is rejected), but "validated X, kept Y" is the
 * shape a boundary validator exists to prevent.
 *
 * Rejecting rather than normalising is deliberate: `url.href` would rewrite legitimate
 * stored values (`http://host:8081` → `http://host:8081/`) and those values are the KEYS
 * of the mode dropdown, so every existing selection would need a migration to keep
 * matching. No real dashboard URL contains a tab or a line break.
 *
 * @param value Untrusted input.
 */
export function coerceSafeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  // Reject before parsing: what is checked below has to be the string that is kept.
  if (URL_STRIPPED_CHARS.test(value) || value.trim() !== value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// v1.20.0 (Phase F-DRY): generische Helpers, die in client-registry und
// global-config bisher dupliziert waren.
// ---------------------------------------------------------------------------

/**
 * Collapse runs of line-breaking / control whitespace in an untrusted string to
 * a single space before it is interpolated into a log line — prevents log
 * injection (a forged second log line) from client-controlled values
 * (redirect_uri, client_id, app_id, device_name, reverse-DNS hostname, …).
 * v1.36.0 (S4); v1.37.0 widened to the full parcelapp set (adds NUL, VT, FF and
 * the Unicode line separators U+2028/U+2029) for fleet parity.
 *
 * @param value Untrusted string to flatten for single-line logging.
 */
export function oneLine(value: string): string {
  return value.replace(/[\r\n\t\0\v\f\u2028\u2029]+/g, " ");
}
