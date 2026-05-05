/**
 * Boundary coercion helpers for external input.
 *
 * hassemu receives data from HTTP clients, cookies, foreign adapter objects
 * and user writes on states. TypeScript types only guarantee compile-time
 * shape — these helpers guard runtime reality.
 */

/**
 * „No-choice"-Marker: User hat den Default-Eintrag `0='---'` (oder eine seiner
 * Repräsentationen) gewählt. Behandelt sowohl die numerische `0` (Admin-UI
 * mit `type: mixed` Dropdowns), die String-Variante `'0'` und den leeren String.
 *
 * Wird in beiden Mode-Handlers (client-registry, global-config) gleich behandelt
 * — vor v1.8.0 war die Logik 4× dupliziert. Jeder andere Wert ist ein „echter"
 * User-Input und muss validiert werden.
 *
 * @param value Untrusted input vom Mode-State (numeric 0 / string '0' / '' / URL / sentinel).
 */
export function isNoChoice(value: unknown): boolean {
    return value === 0 || value === '0' || value === '';
}

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coerce to a UUID string, or null. Accepts any UUID variant.
 *
 * @param value Untrusted input.
 */
export function coerceUuid(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    return UUID_REGEX.test(value) ? value.toLowerCase() : null;
}

/** Result of {@link parseManualUrlWrite}. */
export type ManualUrlWriteResult = { ok: true; safe: string | null } | { ok: false };

/**
 * Validates a write to a `manualUrl` state. Empty / null / undefined → clear
 * (`safe: null`). Otherwise must pass {@link coerceSafeUrl}; if not → `ok: false`
 * so the caller can reject + revert. Centralises the validation that both
 * `ClientRegistry.handleManualUrlWrite` and `GlobalConfig.handleManualUrlWrite`
 * share — caller still owns logging + setState because the prefixes/state-IDs
 * differ.
 *
 * @param rawValue Value written to the state.
 */
export function parseManualUrlWrite(rawValue: unknown): ManualUrlWriteResult {
    const empty = rawValue === '' || rawValue === null || rawValue === undefined;
    if (empty) {
        return { ok: true, safe: null };
    }
    const safe = coerceSafeUrl(rawValue);
    if (!safe) {
        return { ok: false };
    }
    return { ok: true, safe };
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
