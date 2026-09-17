import { describe, it, expect } from "vitest";
import { replaceObjectPreservingValue } from "./object-repair";

/**
 * Store-backed adapter modelled on what js-controller-adapter 7.2.2 does: `setForeignObject`
 * writes the object under the FULL id it is given (no namespace prefixing) and touches
 * neither the state value nor the enums; `delObjectAsync` — the path this helper used
 * until v1.44.0 — would drop the value and strike the id from every enum. The mock keeps
 * the delete as a tripwire: the repair must never call it.
 */
interface RepairAdapterMock {
  namespace: string;
  setForeignObject(fullId: string, obj: ioBroker.SettableObject): Promise<void>;
  delObjectAsync(id: string): Promise<void>;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void };
}

function makeAdapter(): {
  objects: Map<string, ioBroker.SettableObject>;
  states: Map<string, { val: unknown; ack: boolean }>;
  enumMembers: string[];
  writes: string[];
  logs: { level: string; msg: string }[];
  adapter: RepairAdapterMock;
} {
  const objects = new Map<string, ioBroker.SettableObject>();
  const states = new Map<string, { val: unknown; ack: boolean }>();
  const enumMembers = ["hassemu.0.clients.abc.mode"];
  const writes: string[] = [];
  const logs: { level: string; msg: string }[] = [];
  const adapter: RepairAdapterMock = {
    namespace: "hassemu.0",
    setForeignObject: (fullId: string, obj: ioBroker.SettableObject) => {
      writes.push(fullId);
      objects.set(fullId, structuredClone(obj));
      return Promise.resolve();
    },
    delObjectAsync: (id: string) => {
      objects.delete(id);
      states.delete(id);
      enumMembers.splice(0, enumMembers.length);
      return Promise.reject(new Error(`delObjectAsync(${id}) must never be called by the repair`));
    },
    log: {
      debug: (m: string) => void logs.push({ level: "debug", msg: m }),
      info: (m: string) => void logs.push({ level: "info", msg: m }),
      warn: (m: string) => void logs.push({ level: "warn", msg: m }),
      error: (m: string) => void logs.push({ level: "error", msg: m }),
    },
  };
  return { objects, states, enumMembers, writes, logs, adapter };
}

const FULL_ID = "hassemu.0.clients.abc.mode";

describe("replaceObjectPreservingValue", () => {
  it("removes stale common.states keys with ONE full write under the full id", async () => {
    const { objects, writes, adapter } = makeAdapter();
    objects.set(FULL_ID, {
      type: "state",
      common: { name: "Mode", type: "mixed", role: "state", states: { 0: "---", legacyUrl: "stale option" } },
      native: {},
    } as unknown as ioBroker.SettableObject);

    // Caller prepares the read-back object with the stale key removed.
    const prepared = {
      type: "state",
      common: { name: "Mode", type: "mixed", role: "state", states: { 0: "---" } },
      native: {},
    } as unknown as ioBroker.SettableObject;
    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", prepared);

    // (a) the stale option is physically gone — not deep-merged back in.
    expect((objects.get(FULL_ID)?.common as { states: unknown }).states).toEqual({ 0: "---" });
    // (b) exactly one write, addressed with the namespace — setForeignObject takes the full id.
    expect(writes).toEqual([FULL_ID]);
  });

  it("leaves the state value and the enum memberships alone (no delete, no value write)", async () => {
    const { objects, states, enumMembers, adapter } = makeAdapter();
    objects.set(FULL_ID, {
      type: "state",
      common: { states: { 0: "---", legacyUrl: "stale option" } },
      native: {},
    } as unknown as ioBroker.SettableObject);
    states.set(FULL_ID, { val: "0", ack: true });

    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", {
      type: "state",
      common: { states: { 0: "---" } },
      native: {},
    } as unknown as ioBroker.SettableObject);

    // Until v1.44.0 the delete+recreate pair restored only the value; the room and
    // function assignments (enum members) were gone after every dropdown refresh.
    expect(states.get(FULL_ID)).toEqual({ val: "0", ack: true });
    expect(enumMembers).toEqual([FULL_ID]);
  });

  it("carries the prepared object verbatim — the caller's common.custom survives", async () => {
    const { objects, adapter } = makeAdapter();
    const prepared = {
      type: "state",
      common: { states: { 0: "---" }, custom: { "influxdb.0": { enabled: true } } },
      native: {},
    } as unknown as ioBroker.SettableObject;
    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", prepared);
    expect(objects.get(FULL_ID)).toEqual(prepared);
  });

  it("warns (does not throw) when the write fails, and the stored object is unchanged", async () => {
    const { objects, logs, adapter } = makeAdapter();
    const stored = {
      type: "state",
      common: { states: { 0: "---", legacyUrl: "stale option" } },
      native: {},
    } as unknown as ioBroker.SettableObject;
    objects.set(FULL_ID, structuredClone(stored));
    adapter.setForeignObject = () => Promise.reject(new Error("broker down"));

    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", {
      type: "state",
      common: { states: { 0: "---" } },
      native: {},
    } as unknown as ioBroker.SettableObject);

    const warned = logs.some(
      l =>
        l.level === "warn" &&
        l.msg.includes("clients.abc.mode") &&
        l.msg.includes("unchanged") &&
        l.msg.includes("broker down"),
    );
    expect(warned, "a warn names the datapoint and the cause").toBe(true);
    // No delete window: the old object is still there, stale key and all.
    expect(objects.get(FULL_ID)).toEqual(stored);
  });

  it("renders a rejected plain object readably in the warn (not [object Object])", async () => {
    const { logs, adapter } = makeAdapter();
    // The type says Error, the runtime value is a plain object — exactly the mismatch a
    // third-party rejection produces and the reason the text goes through errText.
    const rejection = { code: "ECONNRESET" } as unknown as Error;
    adapter.setForeignObject = () => Promise.reject(rejection);
    await replaceObjectPreservingValue(adapter as never, "clients.abc.mode", {
      type: "state",
      common: {},
      native: {},
    } as unknown as ioBroker.SettableObject);
    expect(logs[0]?.msg).toContain('{"code":"ECONNRESET"}');
  });
});
