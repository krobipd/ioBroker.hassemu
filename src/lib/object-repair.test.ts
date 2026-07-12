import { describe, it, expect } from "vitest";
import { replaceObjectPreservingValue } from "./object-repair";

/**
 * Store-backed adapter whose `delObjectAsync` drops BOTH the object and its
 * state value — the worst case. If the value still survives the call, the
 * helper's capture-and-restore is doing its job. Structural subset of the real
 * adapter (getStateAsync/delObjectAsync/setObjectNotExistsAsync/setState).
 */
function makeAdapter() {
  const objects = new Map<string, ioBroker.SettableObject>();
  const states = new Map<string, { val: unknown; ack: boolean }>();
  const logs: { level: string; msg: string }[] = [];
  const adapter = {
    getStateAsync: async (id: string) => states.get(id) ?? null,
    delObjectAsync: async (id: string) => {
      objects.delete(id);
      states.delete(id); // worst case: delObject cascades to the value
    },
    setObjectNotExistsAsync: async (id: string, obj: ioBroker.SettableObject) => {
      if (!objects.has(id)) {
        objects.set(id, obj);
      }
    },
    setState: async (id: string, value: { val: unknown; ack?: boolean }) => {
      states.set(id, { val: value.val, ack: value.ack ?? false });
    },
    log: {
      debug: (m: string) => void logs.push({ level: "debug", msg: m }),
      info: (m: string) => void logs.push({ level: "info", msg: m }),
      warn: (m: string) => void logs.push({ level: "warn", msg: m }),
      error: (m: string) => void logs.push({ level: "error", msg: m }),
    },
  };
  return { objects, states, logs, adapter };
}

describe("replaceObjectPreservingValue", () => {
  it("removes stale common.states keys AND preserves the state value", async () => {
    const { objects, states, adapter } = makeAdapter();
    objects.set("clients.abc.mode", {
      type: "state",
      common: { name: "Mode", type: "mixed", role: "state", states: { "0": "---", legacyUrl: "stale option" } },
      native: {},
    } as unknown as ioBroker.SettableObject);
    states.set("clients.abc.mode", { val: "0", ack: true });

    // Caller prepares the read-back object with the stale key removed.
    const prepared = {
      type: "state",
      common: { name: "Mode", type: "mixed", role: "state", states: { "0": "---" } },
      native: {},
    } as unknown as ioBroker.SettableObject;
    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", prepared);

    // (a) the stale option is physically gone — not deep-merged back in.
    expect((objects.get("clients.abc.mode")?.common as { states: unknown }).states).toEqual({ "0": "---" });
    // (b) the user's mode selection survived the delObject.
    expect(states.get("clients.abc.mode")).toEqual({ val: "0", ack: true });
  });

  it("writes no value when the state had none (fresh object)", async () => {
    const { states, adapter } = makeAdapter();
    await replaceObjectPreservingValue(
      adapter as never,
      "clients.new.mode",
      { type: "state", common: { states: {} }, native: {} } as unknown as ioBroker.SettableObject,
    );
    expect(states.has("clients.new.mode")).toBe(false);
  });

  it("warns (does not throw) when the recreate fails after delObject (L2)", async () => {
    const { logs, adapter } = makeAdapter();
    // delObject has already dropped the datapoint; make the recreate fail.
    adapter.setObjectNotExistsAsync = async () => {
      throw new Error("broker down");
    };
    await replaceObjectPreservingValue(
      adapter as never,
      "clients.abc.mode",
      { type: "state", common: { states: {} }, native: {} } as unknown as ioBroker.SettableObject,
    );
    const warned = logs.some(l => l.level === "warn" && l.msg.includes("clients.abc.mode") && l.msg.includes("missing"));
    expect(warned, "a warn surfaces the object-loss window").toBe(true);
  });
});
