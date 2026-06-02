import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guards for the v1.34.0 repochecker / best-practice fixes that have
// no natural runtime assertion (markdown header, workflow tag, dep ranges,
// removed process handlers). They lock the fixes so a later edit can't silently
// re-introduce the warning.
const root = join(__dirname, "../..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

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

  it("runtime deps are declared at repochecker-current ranges (W0083)", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["bonjour-service"]).to.equal("^1.4.0");
    expect(pkg.dependencies["@fastify/websocket"]).to.equal("^11.2.0");
  });

  it("main.ts installs no process-level handlers (framework owns unhandledRejection/uncaughtException)", () => {
    const main = read("src/main.ts");
    expect(main, "process-level handler re-introduced").to.not.include("process.on(");
  });
});
