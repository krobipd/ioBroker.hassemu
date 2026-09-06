/**
 * Where does THIS display go?
 *
 * The adapter's central question, and until v1.43.0 it was answered by `GlobalConfig` —
 * the class that holds the global override. So the web server asked
 * `globalConfig.resolveUrlForWithChain(client)` to find out where a per-client mode
 * points, which reads backwards and put the resolution rules in the one place a reader
 * would not look for them.
 *
 * The rules themselves are unchanged. `GlobalConfig` is now just one of the two inputs.
 */

import { coerceSafeUrl } from "./coerce";
import { MODE_GLOBAL, MODE_MANUAL } from "./constants";
import { isNoChoice } from "./state-write-rules";
import type { ClientRecord } from "./types";

/** The global override as the resolver sees it — a snapshot, not the class. */
export interface GlobalRedirect {
  /** `global.mode`: `'manual'`, a URL, or a no-choice value. Never `'global'`. */
  mode: string;
  /** `global.manualUrl`, used when {@link mode} is `'manual'`. */
  manualUrl: string | null;
}

/** A resolved redirect plus the chain that produced it (debug anchor). */
export interface RedirectResolution {
  /** The URL to send the display to, or null for the landing page. */
  url: string | null;
  /**
   * How the answer was reached — the triage anchor a maintainer needs to see WHY this
   * display got this URL, without reading the resolver:
   * - `direct→{url}` — the client's own mode is a URL
   * - `manual→{url}` — client mode `'manual'` plus its manualUrl
   * - `global→direct→{url}` — client mode `'global'`, global mode is a URL
   * - `global→manual→{url}` — client mode `'global'`, global mode `'manual'`
   * - `global→landing` — client delegates, global resolves to nothing
   * - `landing` — no choice made
   */
  chain: string;
}

/**
 * Resolve one (mode, manualUrl) pair. The shared tail of the client level and the global
 * level — they differ only in whether `'global'` is a legal mode, which the caller settles
 * before delegating here. I16 (v1.37.0).
 *
 * @param mode      A `mode` value (`'manual'`, a URL, or a no-choice sentinel).
 * @param manualUrl The `manualUrl` paired with `mode === 'manual'`.
 */
function resolveOne(mode: unknown, manualUrl: string | null): RedirectResolution {
  // Deliberately without its own test: removing this shortcut changes nothing observable
  // — a no-choice value is not a safe URL either, so the tail below returns the same
  // `{ url: null, chain: "landing" }` (measured as an equivalent mutant in the 2026-08-22
  // test audit). It stays because it names the case a reader is looking for.
  if (isNoChoice(mode)) {
    return { url: null, chain: "landing" };
  }
  if (mode === MODE_MANUAL) {
    return { url: manualUrl, chain: manualUrl ? `manual→${manualUrl}` : "manual→landing" };
  }
  const safe = coerceSafeUrl(mode);
  return { url: safe, chain: safe ? `direct→${safe}` : "landing" };
}

/**
 * Resolve the redirect for one display, with the chain that produced it.
 *
 * `'global'` recurses into the global override; every other mode value resolves the same
 * way at both levels.
 *
 * @param record Client to resolve for.
 * @param global The global override's current values.
 */
export function resolveRedirectWithChain(record: ClientRecord, global: GlobalRedirect): RedirectResolution {
  if (record.mode === MODE_GLOBAL) {
    const inner = resolveOne(global.mode, global.manualUrl);
    return { url: inner.url, chain: `global→${inner.chain}` };
  }
  return resolveOne(record.mode, record.manualUrl);
}

/**
 * Resolve the redirect for one display.
 *
 * @param record Client to resolve for.
 * @param global The global override's current values.
 */
export function resolveRedirect(record: ClientRecord, global: GlobalRedirect): string | null {
  // One resolution path — the chain version holds the logic and this drops the (cheap)
  // chain string, so the two can never drift apart.
  return resolveRedirectWithChain(record, global).url;
}
