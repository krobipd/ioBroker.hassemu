/**
 * A real instance data folder per stub installation — the registry keeps the server id and each display's
 * cookie, tokens and lastSeen in `identities.json` there (client-store.ts). A real folder, not a fake: the tests see the file the adapter
 * writes, and a second registry over the same stub reads it back like a restart.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** A fresh, empty folder for one stub installation; {@link removeDataDirs} takes it away. */
export function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hassemu-instance-"));
  made.push(dir);
  return dir;
}

/** Remove every folder {@link freshDataDir} made — the test file's `afterAll`. */
export function removeDataDirs(): void {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
