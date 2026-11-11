// The down page now pulls its copy from admin/i18n via adapter-core I18n — mock
// it to serve the real translations from the JSON files (same as webserver.test).
vi.mock("@iobroker/adapter-core", async () => {
  // The factory is hoisted above the imports — the shared translation lookup comes in here.
  const { realI18n } = await import("../../test/unit/i18n-stub.js");
  return { I18n: realI18n() };
});

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { runPage, settle } from "../../test/unit/page-runner";
import { decidePollAction, FRONTEND_LOADED_CAP_MS, renderRedirectWrapper } from "./redirect-wrapper";

describe("redirect-wrapper", () => {
  describe("renderRedirectWrapper", () => {
    it("renders an iframe with the validated target URL", () => {
      const html = renderRedirectWrapper(
        "https://vis.example.test/vis-2/index.html?main",
        "a1b2c3",
        "en",
        "192.168.1.42",
      );
      expect(html).to.include('<iframe id="hassemu-iframe" src="https://vis.example.test/vis-2/index.html?main"');
      expect(html).to.include('id="hassemu-down"');
      // Down page is hidden by default (display:none from inline-CSS).
      expect(html).to.match(/#hassemu-down\{display:none;/);
    });

    it("renders the shared card/table CSS with the down (error-theme) colors (L21)", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      expect(html).to.include("#hassemu-down .card {");
      expect(html).to.include("max-width: 44rem;");
      expect(html).to.include("#hassemu-down th, #hassemu-down td {");
      expect(html).to.include("border-bottom: 1px solid #334155;");
      // Down page uses literal colors, no landing tokens — the app's safe-area insets are the
      // only custom properties it reads (U2).
      expect(html).to.not.match(/var\(--(?!app-safe-area-inset-)/);
    });

    it("keeps the dashboard and both cards inside the app's safe area — static first, 0px fallback (U2)", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      const iframe = /iframe\{[^}]*\}/.exec(html)![0];
      for (const side of ["top", "left", "right", "bottom"]) {
        expect(iframe, side).to.include(`var(--app-safe-area-inset-${side},0px)`);
      }
      // A browser without var() drops the second declaration and keeps the static one.
      expect(iframe.indexOf("width:100vw")).to.be.below(iframe.indexOf("width:calc("));
      for (const card of ["#hassemu-down", "#hassemu-target-down"]) {
        const rule = new RegExp(`${card}\\{[^}]*\\}`).exec(html)![0];
        expect(rule, card).to.include("bottom:var(--app-safe-area-inset-bottom,0px)");
        expect(rule, card).to.not.include("width:100vw");
      }
    });

    it("repeats the insets with the frontend's env() fallback only inside @supports — the legacy Android 7 Shelly WebViews skip it (K17)", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      const start = html.indexOf("@supports (top:env(safe-area-inset-top)){");
      expect(start).to.be.above(-1);
      // The block closes after its two rules; every env() of the page lies inside it.
      const block = html.slice(start, html.indexOf("\n}", start) + 2);
      const outside = html.slice(0, start) + html.slice(start + block.length);
      expect(outside).to.not.include("env(");
      const iframe = /\niframe\{[^}]*\}/.exec(block)![0];
      const cards = /#hassemu-down,#hassemu-target-down\{[^}]*\}/.exec(block)![0];
      for (const side of ["top", "left", "right", "bottom"]) {
        const inset = `var(--app-safe-area-inset-${side},env(safe-area-inset-${side},0px))`;
        expect(iframe, side).to.include(inset);
        expect(cards, side).to.include(inset);
      }
      // The block comes after the base rules, so it wins where the browser reads it.
      expect(start).to.be.above(html.indexOf("#hassemu-target-down{"));
    });

    it("declares viewport-fit=cover like the frontend's own viewport meta, so iOS reports the insets (K17)", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      expect(html).to.match(/<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/);
    });

    it("includes 30s polling JS with consecutive-fail threshold", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      // window.-prefixed timer keeps the repochecker W5004 regex from matching
      // this client-side <script> string (it is not an adapter timer).
      expect(html).to.match(/window\.setInterval\(/);
      expect(html).to.include("fetch('/api/redirect_check'");
      expect(html).to.include("THRESHOLD=3");
      expect(html).to.include("fails++");
      expect(html).to.include("hideDown");
      expect(html).to.include("showDown");
    });

    it("neutralizes </script> in the target so it cannot break out of the inline <script> (v1.36.0 C3)", () => {
      const html = renderRedirectWrapper("https://attacker.test/a</script><script>alert(1)</script>", "a1b2c3", "en");
      // iframe src attribute escape kills `<`/`>`/`"` — the entity-escaped copy is safe.
      expect(html).to.include("&lt;/script&gt;");
      // The inline `var current=` JS sink must NOT contain a raw `</script>`: at the
      // HTML-tokenizer level that closes the <script> regardless of JS string nesting.
      // JSON.stringify does NOT escape `<`; the `.replace(/</g, "\\u003C")` does.
      const line = html.split("\n").find(l => l.includes("var current="))!;
      expect(line).to.not.include("</script>");
      expect(line).to.include("\\u003C/script"); // `<` escaped to its JS unicode escape
    });

    it('renders the German down-page strings when language is "de"', () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "de", "10.0.0.50");
      expect(html).to.include("hassemu offline");
      expect(html).to.include("Geräte-ID");
      expect(html).to.include("IP-Adresse");
      expect(html).to.include("Jetzt neu laden");
      expect(html).to.match(/lang="de"/);
    });

    it('renders the Polish strings when language is "pl"', () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "pl", "10.0.0.50");
      expect(html).to.include("Załaduj ponownie");
      expect(html).to.include("Adres IP");
    });

    it("falls back to English when language is unknown", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "xx-XX");
      expect(html).to.include("Reload now");
      expect(html).to.include("Device ID");
      expect(html).to.match(/lang="en"/);
    });

    it("shows the IP row when ip is a non-loopback address", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en", "10.0.0.50");
      expect(html).to.include("10.0.0.50");
      expect(html).to.match(/<th scope="row">IP address<\/th><td>10\.0\.0\.50<\/td>/);
    });

    it("omits the IP row when ip is loopback / empty / null", () => {
      for (const ip of [null, "", "127.0.0.1", "127.0.0.5", "::1"]) {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en", ip);
        expect(html, `ip=${ip ?? "null"}`).not.to.match(/<th scope="row">IP address<\/th>/);
      }
    });

    it("includes the reload button with location.reload onclick", () => {
      const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
      expect(html).to.match(/<button type="button" onclick="location\.reload\(\)">/);
    });

    it("escapes the clientId to prevent injection into the down-page table", () => {
      const html = renderRedirectWrapper("https://x.test/", "<script>alert(1)</script>", "en");
      expect(html).not.to.include("<script>alert(1)</script>");
      expect(html).to.include("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    // v1.39.0: target-down card ("hassemu runs, the target does not answer").
    describe("target-down card", () => {
      it("renders the card hidden by default when the target is reachable", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include('id="hassemu-target-down"');
        expect(html).to.match(/#hassemu-target-down\{display:none;/);
        expect(html).not.to.include('<div id="hassemu-target-down" class="visible"');
        // iframe stays visible.
        expect(html).not.to.include('<iframe id="hassemu-iframe" src="https://x.test/" style="display:none"');
        // Counter starts clean.
        expect(html).to.include("var targetFails=0");
      });

      it("renders the card VISIBLE and the iframe hidden when the target is down at render time (cold boot)", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en", null, false);
        expect(html).to.include('<div id="hassemu-target-down" class="visible"');
        expect(html).to.include('<iframe id="hassemu-iframe" src="https://x.test/" style="display:none"');
        // Counter starts AT the threshold so the card stays until recovery.
        expect(html).to.include("var targetFails=2");
      });

      it("shows the target URL, device id and localized copy on the card", () => {
        const html = renderRedirectWrapper("https://vis.example.test/dash", "a1b2c3", "de", "10.0.0.50", false);
        expect(html).to.include("Weiterleitungsziel nicht erreichbar");
        expect(html).to.include("Ziel-URL");
        expect(html).to.match(/<td class="target-url"><code>https:\/\/vis\.example\.test\/dash<\/code><\/td>/);
        expect(html).to.include("Geräte-ID");
      });

      it("ships the decision function itself into the page (no hand-written twin)", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include("var TARGET_THRESHOLD=2");
        // The page calls the very function the tests below execute.
        expect(html).to.include("var decide=");
        expect(html).to.include("decide({current:current,body:j,targetFails:targetFails,");
        expect(html).to.include("showTargetDown");
      });

      it("hassemu-down recovery does NOT unhide the iframe while the target card is visible", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include("if(iframeEl && !targetDownVisible()){iframeEl.style.display='block';}");
      });

      it("card uses the shared card CSS scoped to its own id (design consistency)", () => {
        const html = renderRedirectWrapper("https://x.test/", "a1b2c3", "en");
        expect(html).to.include("#hassemu-target-down .card {");
        expect(html).to.include("#hassemu-target-down th, #hassemu-target-down td {");
        // Amber banner — distinct from the red hassemu-down banner.
        expect(html).to.include("#hassemu-target-down .banner{background:#d97706;");
        expect(html).to.include("#hassemu-down .banner{background:#dc2626;");
      });

      it("escapes a hostile target URL in the card's URL row", () => {
        const html = renderRedirectWrapper(
          'https://x.test/"><img src=x onerror=alert(1)>',
          "a1b2c3",
          "en",
          null,
          false,
        );
        expect(html).not.to.include('"><img src=x');
        expect(html).to.include("&quot;&gt;&lt;img");
      });
    });
  });

  // The poll decision RUN, not string-matched. Before this suite existed the logic
  // lived only inside the page template, so no test ever executed it — which is how
  // the null-target defect below survived five audits.
  // Every case runs twice: against the module function AND against the copy the page
  // gets (`decidePollAction.toString()` evaluated in an empty scope, exactly like the
  // browser does it). The copy has NO module around it — a reference to a module
  // constant or helper compiles, passes tsc and the module half of this table, and
  // throws a ReferenceError on the display (audit 2026-09-15, B1/F1: measured, such a
  // mutant survived 30/30 tests). The serialised half is the only thing that sees it.
  const serialise = (fn: typeof decidePollAction): typeof decidePollAction =>
    new Function(`return (${fn.toString()})`)() as typeof decidePollAction;
  const serialisedCopy = serialise(decidePollAction);
  // The display does not get the copy above: it gets the text of the PRODUCTION build,
  // which esbuild compiles with its own settings — a helper it injects into the function
  // body (`__name(...)` under keepNames, a down-levelled `??`) would throw on the display
  // while the vitest-compiled copy stays clean (audit 2026-09-25, T9). The shipped text is
  // checked whenever the build is current; a missing or stale build skips that row visibly.
  const builtPath = join(__dirname, "../../build/lib/redirect-wrapper.js");
  const builtIsCurrent =
    existsSync(builtPath) && statSync(builtPath).mtimeMs >= statSync(join(__dirname, "redirect-wrapper.ts")).mtimeMs;
  // Loaded in a bare module wrapper: its imports (i18n → adapter-core, which exits the
  // process without a js-controller) are only called at render time, never by the decision.
  const loadShipped = (): typeof decidePollAction => {
    const mod = { exports: {} as Record<string, unknown> };
    const wrapper = runInThisContext(`(function (exports, require, module) {${readFileSync(builtPath, "utf8")}\n})`, {
      filename: builtPath,
    }) as (exports: unknown, require: () => unknown, module: typeof mod) => void;
    wrapper(mod.exports, () => ({}), mod);
    return mod.exports.decidePollAction as typeof decidePollAction;
  };
  const shippedCopy = builtIsCurrent ? serialise(loadShipped()) : null;
  const forms: Array<[string, typeof decidePollAction]> = [
    ["module function", decidePollAction],
    ["serialised copy", serialisedCopy],
  ];
  if (shippedCopy) {
    forms.push(["serialised copy of the shipped build", shippedCopy]);
  }
  it.skipIf(!shippedCopy)("runs the table against the shipped build's copy too", () => {
    expect(forms.map(([form]) => form)).to.include("serialised copy of the shipped build");
  });
  describe.each(forms)("decidePollAction (%s)", (_form, decide) => {
    const base = {
      current: "https://a.test/",
      body: {} as unknown,
      targetFails: 0,
      targetThreshold: 2,
      targetDownVisible: false,
    };

    it("reloads when the target changed to a different URL", () => {
      const r = decide({ ...base, body: { target: "https://b.test/", targetReachable: true } });
      expect(r.action).to.equal("reload");
    });

    it("reloads when the target is WITHDRAWN (mode '---' / master switch off)", () => {
      // The server answers `{target:null, targetReachable:true}` once the resolver has
      // nothing to resolve. Before v1.43.0 this was silently ignored and the display
      // kept showing its old dashboard forever.
      const r = decide({ ...base, body: { target: null, targetReachable: true } });
      expect(r.action).to.equal("reload");
    });

    it("reloads when the target is withdrawn even while the target-down card is up", () => {
      const r = decide({
        ...base,
        body: { target: null, targetReachable: true },
        targetDownVisible: true,
      });
      expect(r.action).to.equal("reload");
    });

    it("does nothing while the target is unchanged and reachable", () => {
      const r = decide({ ...base, body: { target: "https://a.test/", targetReachable: true } });
      expect(r).to.deep.equal({ action: "none", targetFails: 0 });
    });

    it("does NOT reload on a body without a target key (a proxy error page must not loop)", () => {
      for (const body of [{}, { targetReachable: true }, null, "nope", 42, []]) {
        const r = decide({ ...base, body });
        expect(r.action, JSON.stringify(body)).to.equal("none");
      }
    });

    it("counts consecutive unreachable answers and shows the card at the threshold", () => {
      const first = decide({ ...base, body: { target: "https://a.test/", targetReachable: false } });
      expect(first).to.deep.equal({ action: "none", targetFails: 1 });
      const second = decide({
        ...base,
        body: { target: "https://a.test/", targetReachable: false },
        targetFails: first.targetFails,
      });
      expect(second).to.deep.equal({ action: "show-target-down", targetFails: 2 });
    });

    it("keeps the card up while the target stays unreachable", () => {
      const r = decide({
        ...base,
        body: { target: "https://a.test/", targetReachable: false },
        targetFails: 5,
        targetDownVisible: true,
      });
      expect(r).to.deep.equal({ action: "show-target-down", targetFails: 6 });
    });

    it("reloads on the first recovery so the dead iframe is re-created", () => {
      const r = decide({
        ...base,
        body: { target: "https://a.test/", targetReachable: true },
        targetFails: 2,
        targetDownVisible: true,
      });
      expect(r).to.deep.equal({ action: "reload", targetFails: 0 });
    });

    it("resets the counter after a single reachable answer below the threshold", () => {
      const r = decide({
        ...base,
        body: { target: "https://a.test/", targetReachable: true },
        targetFails: 1,
      });
      expect(r).to.deep.equal({ action: "none", targetFails: 0 });
    });

    it("treats an empty-string target like a withdrawn one", () => {
      const r = decide({ ...base, body: { target: "", targetReachable: true } });
      expect(r.action).to.equal("reload");
    });
  });

  // The copy in the page must be the SAME function, not a hand-written twin — that
  // drift is what let the page and its tests disagree for five audits.
  describe("serialised decision in the page", () => {
    it("embeds the module's own function verbatim", () => {
      const html = renderRedirectWrapper("https://a.test/", "a1b2c3", "en");
      expect(html).to.include(`var decide=${decidePollAction.toString()};`);
    });

    it("carries no second, hand-written copy of the old inline logic", () => {
      const html = renderRedirectWrapper("https://a.test/", "a1b2c3", "en");
      expect(html).not.to.include("j.targetReachable===false");
      expect(html).not.to.include("typeof j.target==='string'");
    });
  });
});

// The page RUN in node:vm with a fake V1 bridge: when the app gets `frontend/loaded` (K17). The
// apps keep their own loader up until then (constants.ts, HA_VERSION) — the dashboard must send it
// once the iframe has loaded, a card at once, and a hanging target before the apps' own 10 s.
describe("frontend/loaded from the dashboard wrapper (K17)", () => {
  const CONNECTED = { id: 1, type: "connection-status", payload: { event: "connected" } };
  const LOADED = { id: 2, type: "frontend/loaded" };
  const page = (reachable: boolean): string =>
    renderRedirectWrapper("http://192.0.2.1:8082/vis-2/index.html", "a1b2c3", "en", "192.0.2.10", reachable);

  it("sends connected at once, but loaded only when the iframe has loaded", () => {
    const run = runPage(page(true));
    expect(run.messages).toEqual([CONNECTED]);
    run.iframeLoad();
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it("a second iframe load (the target navigates) sends nothing more", () => {
    const run = runPage(page(true));
    run.iframeLoad();
    run.iframeLoad();
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it("an iframe that loaded before the scripts ran still gets loaded, once", () => {
    const run = runPage(page(true), { iframeLoadsFirst: true });
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it(`a target that never finishes loading gets loaded after the cap — ${FRONTEND_LOADED_CAP_MS} ms, below the apps' 10 s`, () => {
    expect(FRONTEND_LOADED_CAP_MS).to.be.below(10_000);
    const run = runPage(page(true));
    const cap = run.timers.find(t => t.ms === FRONTEND_LOADED_CAP_MS);
    expect(cap).to.not.equal(undefined);
    cap!.cb();
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it("the target-down card visible at render is a finished page: loaded at once", () => {
    const run = runPage(page(false));
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it("the hassemu-offline card, once shown, sends loaded", async () => {
    const run = runPage(page(true), { fetch: () => Promise.reject(new Error("down")) });
    const poll = run.intervals[0];
    for (let i = 0; i < 3; i++) {
      poll.cb();
      await settle();
    }
    expect(run.elements.get("hassemu-down")!.classes.has("visible")).to.equal(true);
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it("the target-down card, once shown by the poll, sends loaded", async () => {
    const run = runPage(page(true), {
      fetch: () =>
        Promise.resolve({
          json: () => Promise.resolve({ target: "http://192.0.2.1:8082/vis-2/index.html", targetReachable: false }),
        }),
    });
    const poll = run.intervals[0];
    for (let i = 0; i < 2; i++) {
      poll.cb();
      await settle();
    }
    expect(run.elements.get("hassemu-target-down")!.classes.has("visible")).to.equal(true);
    expect(run.messages).toEqual([CONNECTED, LOADED]);
  });

  it("in a regular browser (no bridge) nothing throws", () => {
    expect(() => runPage(page(true), { bridge: "none" }).iframeLoad()).not.toThrow();
  });
});
