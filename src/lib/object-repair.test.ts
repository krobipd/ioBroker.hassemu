import { describe, it, expect } from "vitest";
import { replaceObjectPreservingValue } from "./object-repair";

/**
 * Store-backed adapter whose `delObjectAsync` drops BOTH the object and its
 * state value — the worst case. If the value still survives the call, the
 * helper's capture-and-restore is doing its job. Structural subset of the real
 * adapter (getStateAsync/delObjectAsync/setObjectNotExistsAsync/setState).
 */
interface RepairAdapterMock {
  getStateAsync(id: string): Promise<{ val: unknown; ack: boolean } | null>;
  delObjectAsync(id: string): Promise<void>;
  setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): Promise<void>;
  setState(id: string, value: { val: unknown; ack?: boolean }): Promise<void>;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void };
}

function makeAdapter(): {
  objects: Map<string, ioBroker.SettableObject>;
  states: Map<string, { val: unknown; ack: boolean }>;
  logs: { level: string; msg: string }[];
  adapter: RepairAdapterMock;
} {
  const objects = new Map<string, ioBroker.SettableObject>();
  const states = new Map<string, { val: unknown; ack: boolean }>();
  const logs: { level: string; msg: string }[] = [];
  const adapter = {
    getStateAsync: (id: string) => Promise.resolve(states.get(id) ?? null),
    delObjectAsync: (id: string) => {
      objects.delete(id);
      states.delete(id); // worst case: delObject cascades to the value
      return Promise.resolve();
    },
    setObjectNotExistsAsync: (id: string, obj: ioBroker.SettableObject) => {
      if (!objects.has(id)) {
        objects.set(id, obj);
      }
      return Promise.resolve();
    },
    setState: (id: string, value: { val: unknown; ack?: boolean }) => {
      states.set(id, { val: value.val, ack: value.ack ?? false });
      return Promise.resolve();
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
      common: { name: "Mode", type: "mixed", role: "state", states: { 0: "---", legacyUrl: "stale option" } },
      native: {},
    } as unknown as ioBroker.SettableObject);
    states.set("clients.abc.mode", { val: "0", ack: true });

    // Caller prepares the read-back object with the stale key removed.
    const prepared = {
      type: "state",
      common: { name: "Mode", type: "mixed", role: "state", states: { 0: "---" } },
      native: {},
    } as unknown as ioBroker.SettableObject;
    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", prepared);

    // (a) the stale option is physically gone — not deep-merged back in.
    expect((objects.get("clients.abc.mode")?.common as { states: unknown }).states).toEqual({ 0: "---" });
    // (b) the user's mode selection survived the delObject.
    expect(states.get("clients.abc.mode")).toEqual({ val: "0", ack: true });
  });

  it("writes no value when the state had none (fresh object)", async () => {
    const { states, adapter } = makeAdapter();
    await replaceObjectPreservingValue(adapter as never, "clients.new.mode", {
      type: "state",
      common: { states: {} },
      native: {},
    } as unknown as ioBroker.SettableObject);
    expect(states.has("clients.new.mode")).toBe(false);
  });

  it("writes no value when the previous state carried null/undefined", async () => {
    // The datapoint existed but never held a value. Restoring `null` would
    // write an explicit null into a state whose type is `mixed` — the dropdown
    // then shows an empty selection instead of falling back to its default.
    for (const empty of [null, undefined]) {
      const { states, adapter } = makeAdapter();
      states.set("clients.abc.mode", { val: empty, ack: true });
      await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", {
        type: "state",
        common: { states: {} },
        native: {},
      } as unknown as ioBroker.SettableObject);
      expect(states.has("clients.abc.mode"), String(empty)).toBe(false);
    }
  });

  it("warns (does not throw) when the recreate fails after delObject (L2)", async () => {
    const { logs, adapter } = makeAdapter();
    // delObject has already dropped the datapoint; make the recreate fail.
    adapter.setObjectNotExistsAsync = () => {
      return Promise.reject(new Error("broker down"));
    };
    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", {
      type: "state",
      common: { states: {} },
      native: {},
    } as unknown as ioBroker.SettableObject);
    const warned = logs.some(
      l => l.level === "warn" && l.msg.includes("clients.abc.mode") && l.msg.includes("missing"),
    );
    expect(warned, "a warn surfaces the object-loss window").toBe(true);
  });
});
