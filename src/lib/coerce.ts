/**
 * Boundary coercion helpers for external input.
 *
 * hassemu receives data from HTTP clients, cookies, foreign adapter objects
 * and user writes on states. TypeScript types only guarantee compile-time
 * shape — these helpers guard runtime reality.
 */

/**
 * Coerce to a finite number, or null. Rejects NaN, Infinity, non-numeric strings.
 *
 * @param value Untrusted input.
 */
export function coerceFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.length > 0) {
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
    if (typeof value === 'string' && value.length > 0) {
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
    if (typeof value === 'boolean') {
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
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerce to a UUID string, or null. Accepts any UUID variant by default.
 *
 * @param value    Untrusted input.
 * @param strictV4 If true, only RFC 4122 v4 UUIDs are accepted.
 */
export function coerceUuid(value: unknown, strictV4 = false): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const regex = strictV4 ? UUID_V4_REGEX : UUID_ANY_REGEX;
    return regex.test(value) ? value.toLowerCase() : null;
}

/**
 * Coerce to a safe redirect URL, or null.
 *
 * Requirements:
 * - http:// or https:// scheme (no javascript:, data:, file:, etc.)
 * - Parseable by URL()
 * - No embedded credentials (user:pass@host)
 * - Max 2048 chars
 *
 * @param value Untrusted input.
 */
export function coerceSafeUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    if (url.username.length > 0 || url.password.length > 0) {
        return null;
    }
    return value;
}
