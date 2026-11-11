import vm from "node:vm";
import { APP_BRIDGE_SCRIPT, FRONTEND_LOADED_NOW_SCRIPT } from "./external-bridge";

// The bridge script is a string inlined into HTML; these tests EXECUTE it against fake
// bridges instead of comparing text (audit 2026-09-25, U1) — like redirect-wrapper.test.ts
// does for decidePollAction.
const body = APP_BRIDGE_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
const CONNECTED = { id: 1, type: "connection-status", payload: { event: "connected" } };
const LOADED = { id: 2, type: "frontend/loaded" };

interface Page {
  window: Record<string, unknown> & { hassemuFrontendLoaded?: () => void };
  timers: Array<() => void>;
}

/**
 * Run the script with the given properties on `window`; the delayed calls are held.
 *
 * @param props Properties put on the fake `window` before the script runs.
 * @returns The fake window and the held timer callbacks, in order.
 */
function run(props: Record<string, unknown>): Page {
  const timers: Array<() => void> = [];
  const window: Page["window"] = {
    ...props,
    setTimeout: (cb: () => void): number => {
      timers.push(cb);
      return timers.length;
    },
  };
  vm.runInNewContext(body, { window, JSON });
  return { window, timers };
}

/**
 * Messages a V1 bridge received, parsed.
 *
 * @param fn The V1 `externalBus` mock.
 */
function v1Messages(fn: ReturnType<typeof vi.fn>): unknown[] {
  return fn.mock.calls.map(c => JSON.parse(c[0] as string) as unknown);
}

describe("APP_BRIDGE_SCRIPT", () => {
  it("iOS: posts the message OBJECTS to webkit.messageHandlers.externalBus — connected, then loaded on request", () => {
    const postMessage = vi.fn();
    const page = run({ webkit: { messageHandlers: { externalBus: { postMessage } } } });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(typeof postMessage.mock.calls[0][0]).not.toBe("string");
    expect(postMessage.mock.calls[0][0]).toEqual(CONNECTED);
    page.window.hassemuFrontendLoaded!();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0]).toEqual(LOADED);
  });

  it("V2 wins over V1, like the frontend's else-if chain — a JSON string in an externalBus envelope", () => {
    const v2 = vi.fn();
    const v1 = vi.fn();
    const page = run({ externalAppV2: { postMessage: v2 }, externalApp: { externalBus: v1 } });
    page.window.hassemuFrontendLoaded!();
    expect(v1).not.toHaveBeenCalled();
    expect(v2.mock.calls.map(c => JSON.parse(c[0] as string) as unknown)).toEqual([
      { type: "externalBus", payload: CONNECTED },
      { type: "externalBus", payload: LOADED },
    ]);
  });

  it("V1 alone gets each message as a JSON string", () => {
    const v1 = vi.fn();
    const page = run({ externalApp: { externalBus: v1 } });
    page.window.hassemuFrontendLoaded!();
    expect(v1Messages(v1)).toEqual([CONNECTED, LOADED]);
  });

  it("does not send loaded before the page asks for it", () => {
    const v1 = vi.fn();
    const page = run({ externalApp: { externalBus: v1 } });
    for (const t of page.timers) {
      t();
    }
    expect(v1Messages(v1)).toEqual([CONNECTED]);
  });

  it("a regular browser (no bridge) gets nothing and nothing throws, also not the loaded request", () => {
    const page = run({});
    expect(() => page.window.hassemuFrontendLoaded!()).not.toThrow();
  });

  it("a bridge that attaches late is served once — not on every retry", () => {
    const page = run({});
    const v2 = vi.fn();
    page.window.externalAppV2 = { postMessage: v2 }; // the bridge attaches after the first attempt
    for (const t of page.timers) {
      t();
    }
    expect(v2).toHaveBeenCalledTimes(1);
  });

  it("loaded asked for before the bridge attached goes out after connected, in the same attempt", () => {
    const page = run({});
    page.window.hassemuFrontendLoaded!(); // no bridge yet: nothing can go out
    const v1 = vi.fn();
    page.window.externalApp = { externalBus: v1 };
    page.timers[0]();
    expect(v1Messages(v1)).toEqual([CONNECTED, LOADED]);
  });

  it("each message goes out once per page, however often loaded is asked for", () => {
    const v1 = vi.fn();
    const page = run({ externalApp: { externalBus: v1 } });
    page.window.hassemuFrontendLoaded!();
    page.window.hassemuFrontendLoaded!();
    for (const t of page.timers) {
      t();
    }
    expect(v1Messages(v1)).toEqual([CONNECTED, LOADED]);
  });

  it("an iframe that loaded before the script ran (flag set) gets loaded at start, exactly once", () => {
    const v1 = vi.fn();
    const page = run({ externalApp: { externalBus: v1 }, hassemuIframeLoaded: true });
    expect(v1Messages(v1)).toEqual([CONNECTED, LOADED]);
    for (const t of page.timers) {
      t();
    }
    expect(v1).toHaveBeenCalledTimes(2);
  });

  it("loaded never goes out before connected — not even when the first send fails", () => {
    const got: unknown[] = [];
    let calls = 0;
    const page = run({
      externalApp: {
        externalBus: (json: string): void => {
          calls++;
          if (calls === 1) {
            throw new Error("bridge not ready");
          }
          got.push(JSON.parse(json));
        },
      },
      hassemuIframeLoaded: true, // loaded is wanted in the very attempt whose connected fails
    });
    page.timers[0]();
    expect(got).toEqual([CONNECTED, LOADED]);
  });

  it("a bridge that throws is treated like no bridge and nothing escapes", () => {
    const page = run({
      externalApp: {
        externalBus: (): never => {
          throw new Error("boom");
        },
      },
    });
    expect(() => page.window.hassemuFrontendLoaded!()).not.toThrow();
  });
});

describe("FRONTEND_LOADED_NOW_SCRIPT", () => {
  it("asks the bridge for loaded at once", () => {
    const v1 = vi.fn();
    const page = run({ externalApp: { externalBus: v1 } });
    vm.runInNewContext(FRONTEND_LOADED_NOW_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, ""), {
      window: page.window,
    });
    expect(v1Messages(v1)).toEqual([CONNECTED, LOADED]);
  });
});
