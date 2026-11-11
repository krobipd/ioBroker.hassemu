/**
 * The id of a display (K7, krobi 2026-11-11 19:51 "k7 ist ok"): the model, a hyphen and four characters hassemu
 * assigns itself — `pixel-tablet-02b7`. A display that names no model on its first visit is `display-<four>`. An id
 * already in use gets a counter (`display-c3a1-2`). Once assigned, an id never changes.
 *
 * Why this form: the fleet names a device by its model and the last four characters of its serial number. A display
 * names no serial number on its first visit, and often no model, and its id must not change afterwards — so hassemu
 * assigns the four characters itself and takes the model only when it is there on the first visit (acceptance page
 * K7, measured 2026-11-11 at the Home Assistant apps for Android 2026.11.1 and iOS 2026.10.3).
 *
 * Up to 1.46.1 a display was `clients.<six random hex characters>`; such a display moves once to
 * `display-<its last four>` ({@link movedDisplayId}).
 */
import crypto from "node:crypto";

/** The id of a display before K7: six random hex characters (1.37.0 – 1.46.1). */
export const LEGACY_DISPLAY_ID = /^[0-9a-f]{6}$/;

/** The front part of the id of a display that names no model. */
export const NO_MODEL = "display";

/** Longest model part — the id is a datapoint segment the user types in scripts. */
export const MODEL_PART_MAX = 24;

/**
 * The Android app's own part of its User-Agent: `Home Assistant/<version> (Android <release>; <model>)` —
 * `HomeAssistantApis.kt:40–41` (2026.11.1), appended to the WebView's agent (`HAWebView.kt:239`). Only this part is
 * read: the WebView's own `(Linux; Android …; K)` part carries a reduced model (Chromium's agent reduction), and a
 * wall display's built-in page has nothing but that part.
 */
const ANDROID_APP_AGENT = /Home Assistant\/\S+ \(Android [^;)]*; ([^)]+)\)/;

/**
 * The model the Android app names in its User-Agent, or null — the iOS app and a built-in page name none.
 *
 * @param userAgent The request's User-Agent header.
 */
export function modelFromUserAgent(userAgent: unknown): string | null {
  if (typeof userAgent !== "string") {
    return null;
  }
  const model = ANDROID_APP_AGENT.exec(userAgent)?.[1]?.trim();
  return model ? model : null;
}

/**
 * A model as an id part: lower-case letters and digits, every other run one hyphen, at most
 * {@link MODEL_PART_MAX} characters; empty when nothing is left.
 *
 * @param model The model as the device names it (`Pixel Tablet`, `SM-X710`).
 */
export function modelPart(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MODEL_PART_MAX)
    .replace(/-+$/, "");
}

/**
 * The first id part of a new display: its model, or {@link NO_MODEL}.
 *
 * @param userAgent The User-Agent of its first request.
 */
export function idFront(userAgent: unknown): string {
  const model = modelFromUserAgent(userAgent);
  const part = model === null ? "" : modelPart(model);
  return part === "" ? NO_MODEL : part;
}

/**
 * The candidate itself while nobody holds it, else the candidate with the first free counter from 2 on.
 *
 * @param candidate The id the rule gives.
 * @param taken     Whether an id is held already.
 */
export function withCounter(candidate: string, taken: (id: string) => boolean): string {
  if (!taken(candidate)) {
    return candidate;
  }
  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!taken(next)) {
      return next;
    }
  }
}

/** Four characters hassemu assigns itself — `crypto.randomBytes`, like cookies and tokens. */
export function randomIdTail(): string {
  return crypto.randomBytes(2).toString("hex");
}

/**
 * The id of a new display.
 *
 * @param userAgent The User-Agent of its first request.
 * @param tail      The four characters ({@link randomIdTail}).
 * @param taken     Whether an id is held already.
 */
export function newDisplayId(userAgent: unknown, tail: string, taken: (id: string) => boolean): string {
  return withCounter(`${idFront(userAgent)}-${tail}`, taken);
}

/**
 * Where a display of the old form moves: `display-<the last four characters of its old id>` — the old id never
 * held a model.
 *
 * @param oldId The old id (six hex characters).
 * @param taken Whether an id is held already.
 */
export function movedDisplayId(oldId: string, taken: (id: string) => boolean): string {
  return withCounter(`${NO_MODEL}-${oldId.slice(-4)}`, taken);
}
