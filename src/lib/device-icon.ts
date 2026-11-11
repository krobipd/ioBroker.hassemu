/**
 * The display's pictogram in the object tree (`common.icon` on `clients.<id>`), fleet pattern
 * `CLAUDE_PATTERNS.md` § "Geräte-Piktogramme im Objektbaum" (gate D08 `device-icon`): the file itself
 * as an inline `data:image/svg+xml;base64,…` URI — the admin draws only that form inline, so the
 * `currentColor` strokes follow the theme; a path would land in a bare `<img>` and stay one colour.
 * hassemu knows one kind of device, so there is one file and no type map.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The URI prefix of every icon value. */
export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

/** build/lib and src/lib both sit two levels below the adapter root; `admin/` ships in the package. */
export const DISPLAY_ICON_FILE = join(__dirname, "..", "..", "admin", "icons", "display.svg");

let cached: { uri: string | undefined } | undefined;

/**
 * LF only: the Windows runner checks out with CRLF, and the same file would give a second URI.
 *
 * @param svg the file text
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * The inline URI of an icon file, or undefined when it cannot be read — the field then stays as it is.
 *
 * @param file path of the SVG file
 */
export function iconUri(file: string): string | undefined {
  try {
    return `${ICON_URI_PREFIX}${Buffer.from(normaliseLineEndings(readFileSync(file, "utf8"))).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** The display pictogram, read once per process. */
export function displayIcon(): string | undefined {
  cached ??= { uri: iconUri(DISPLAY_ICON_FILE) };
  return cached.uri;
}
