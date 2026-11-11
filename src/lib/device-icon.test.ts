// The display pictogram (review 2026-11-07, R-19) against the fleet pattern CLAUDE_PATTERNS.md
// § "Geräte-Piktogramme im Objektbaum": inline URI of the file bytes, LF-normalised, monochrome,
// drawn with path/circle/g only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPLAY_ICON_FILE, ICON_URI_PREFIX, displayIcon, iconUri, normaliseLineEndings } from "./device-icon";

const decode = (uri: string): string => Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");

describe("device-icon", () => {
  const svg = readFileSync(DISPLAY_ICON_FILE, "utf8");

  it("the value is the file itself as an inline data URI, never a path", () => {
    const uri = displayIcon();
    expect(uri?.startsWith(ICON_URI_PREFIX)).to.equal(true);
    expect(decode(uri ?? "")).to.equal(normaliseLineEndings(svg));
  });

  it("gives the same value on every call", () => {
    expect(displayIcon()).to.equal(displayIcon());
  });

  it("a CRLF checkout gives the same bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "hassemu-icon-"));
    try {
      const crlf = join(dir, "display.svg");
      writeFileSync(crlf, normaliseLineEndings(svg).replace(/\n/g, "\r\n"));
      expect(iconUri(crlf)).to.equal(iconUri(DISPLAY_ICON_FILE));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable file gives undefined — the field stays as it is", () => {
    expect(iconUri(join(tmpdir(), "hassemu-no-such-icon.svg"))).to.equal(undefined);
  });

  it("paints only with currentColor or none", () => {
    const paints = [...svg.matchAll(/\b(fill|stroke)\s*[=:]\s*["']?([^"';\s>]+)/g)].map(m => m[2]);
    expect(paints.length).to.be.greaterThan(0);
    expect(paints.filter(p => p !== "currentColor" && p !== "none")).to.deep.equal([]);
  });

  it("draws with path, circle and g only — the admin's cell CSS sets every other shape to width 0", () => {
    const tags = [...svg.matchAll(/<\s*([A-Za-z][\w:-]*)/g)].map(m => m[1]);
    expect(tags[0]).to.equal("svg");
    expect(tags.slice(1).filter(t => !["path", "circle", "g"].includes(t))).to.deep.equal([]);
  });
});
