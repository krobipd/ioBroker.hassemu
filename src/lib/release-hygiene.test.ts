import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guards for the v1.34.0 repochecker / best-practice fixes that have
// no natural runtime assertion (markdown header, workflow tag, dep floors,
// removed process handlers). They lock the fixes so a later edit can't silently
// re-introduce the warning.
const root = join(__dirname, "../..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

/**
 * Lowest version a `^x.y.z` / `~x.y.z` / `>=x.y.z` style range allows, as a
 * comparable [major, minor, patch] tuple.
 */
function rangeFloor(range: string): [number, number, number] {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    throw new Error(`unparseable semver range: ${range}`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `range`'s lowest allowed version is at or above the compatibility floor. */
function meetsFloor(range: string, floor: [number, number, number]): boolean {
  const v = rangeFloor(range);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== floor[i]) {
      return v[i] > floor[i];
    }
  }
  return true;
}

describe("release hygiene guards", () => {
  it("README 'Support Development' is a ## section, not ### (W6028)", () => {
    const readme = read("README.md");
    expect(readme).to.include("## Support Development");
    expect(readme, "stale ### header").to.not.match(/^### Support Development$/m);
  });

  it("CI uses testing-action-check@v2 (major-only, not @v2.0.0) (W3042)", () => {
    const wf = read(".github/workflows/test-and-release.yml");
    expect(wf).to.match(/ioBroker\/testing-action-check@v2\s/);
    expect(wf, "fully-pinned tag regressed").to.not.include("testing-action-check@v2.0.0");
  });

  it("runtime deps stay at or above their compatibility floor (upward bumps are fine) (W0083)", () => {
    // Lock the *minimum* each dep needs, not the exact range string. Exact
    // equality would fight Dependabot / repochecker on any legitimate range
    // bump (^1.4.0 → ^1.5.0 / ^2.0.0); only a downgrade below the floor
    // re-introduces a real bug, so that is what we guard. repochecker enforces
    // its own recommended range as a separate CI gate.
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    // bonjour-service ≥ 1.4.0: `Service` type export the mDNS code relies on (v1.33.0 compat fix).
    expect(meetsFloor(pkg.dependencies["bonjour-service"], [1, 4, 0]), "bonjour-service below 1.4.0 floor").to.be.true;
    // @fastify/websocket ≥ 11.2.0: WS plugin API used by /api/websocket (v1.35.0).
    expect(meetsFloor(pkg.dependencies["@fastify/websocket"], [11, 2, 0]), "@fastify/websocket below 11.2.0 floor").to
      .be.true;
  });

  it("main.ts installs no process-level handlers (framework owns unhandledRejection/uncaughtException)", () => {
    const main = read("src/main.ts");
    expect(main, "process-level handler re-introduced").to.not.include("process.on(");
  });
});
