import vm from "node:vm";
import { CONNECTION_STATUS_SCRIPT } from "./external-bridge";

// The bridge script is a string inlined into HTML; these tests EXECUTE it against fake
// bridges instead of comparing text (audit 2026-09-25, U1) — like redirect-wrapper.test.ts
// does for decidePollAction.
const body = CONNECTION_STATUS_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
const MESSAGE = { id: 1, type: "connection-status", payload: { event: "connected" } };

/**
 * Run the script with the given bridges on `window`; the three delayed calls are held.
 *
 * @param bridges Properties put on the fake `window`.
 * @returns The held timer callbacks, in order.
 */
function run(bridges: Record<string, unknown>): Array<() => void> {
  const timers: Array<() => void> = [];
  const window = {
    ...bridges,
    setTimeout: (cb: () => void): number => {
      timers.push(cb);
      return timers.length;
    },
  };
  vm.runInNewContext(body, { window, JSON });
  return timers;
}

describe("CONNECTION_STATUS_SCRIPT", () => {
  it("iOS: posts the message OBJECT to webkit.messageHandlers.externalBus", () => {
    const postMessage = vi.fn();
    run({ webkit: { messageHandlers: { externalBus: { postMessage } } } });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [arg] = postMessage.mock.calls[0] as [unknown];
    expect(typeof arg).not.toBe("string");
    expect(arg).toEqual(MESSAGE);
  });

  it("V2 wins over V1, like the frontend's else-if chain — a JSON string in an externalBus envelope", () => {
    const v2 = vi.fn();
    const v1 = vi.fn();
    run({ externalAppV2: { postMessage: v2 }, externalApp: { externalBus: v1 } });
    expect(v2).toHaveBeenCalledTimes(1);
    expect(v1).not.toHaveBeenCalled();
    expect(JSON.parse(v2.mock.calls[0][0] as string)).toEqual({ type: "externalBus", payload: MESSAGE });
  });

  it("V1 alone gets the message as a JSON string", () => {
    const v1 = vi.fn();
    run({ externalApp: { externalBus: v1 } });
    expect(JSON.parse(v1.mock.calls[0][0] as string)).toEqual(MESSAGE);
  });

  it("a regular browser (no bridge) gets nothing and nothing throws", () => {
    expect(() => run({})).not.toThrow();
  });

  it("a bridge that attaches late is served once — not on every retry", () => {
    const timers: Array<() => void> = [];
    const window = {
      setTimeout: (cb: () => void): number => {
        timers.push(cb);
        return timers.length;
      },
    } as Record<string, unknown>;
    vm.runInNewContext(body, { window, JSON });
    const v2 = vi.fn();
    window.externalAppV2 = { postMessage: v2 }; // the bridge attaches after the first attempt
    for (const t of timers) {
      t();
    }
    expect(v2).toHaveBeenCalledTimes(1);
  });
});
