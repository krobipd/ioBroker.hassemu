import { describe, expect, it } from "vitest";
import { carryEnumMembership, type EnumCarryAdapter } from "./enum-membership";

type EnumEntry = { common: { members?: string[] } };

const OLD = "hassemu.0.global.visUrl";
const NEW = "hassemu.0.global.manualUrl";

/**
 * A broker with the part of js-controller 7.2.2 the order depends on: the store, and the
 * adapter's CACHED `this.enums` — a snapshot taken when the adapter started, which a write
 * does not reach (the real cache follows the database only through the asynchronous `enum.*`
 * subscription). `deleteOld` does what `_delForeignObject` → `removeIdFromAllEnums` does: it
 * strikes the old id from every CACHED enum that carries it and writes that list back to the
 * store (common-db `tools.ts` 2792-2806) — only when the object existed.
 *
 * @param enums Enum groups as the store holds them at start.
 * @param oldObjectExists Whether the old id still has its object (a missing one deletes nothing).
 */
function makeBroker(
  enums: Record<string, Record<string, EnumEntry>>,
  oldObjectExists = true,
): {
  adapter: EnumCarryAdapter;
  store: Map<string, EnumEntry>;
  deleteOld: () => Promise<void>;
  events: string[];
  logs: string[];
} {
  const store = new Map<string, EnumEntry>();
  for (const group of Object.values(enums)) {
    for (const [id, entry] of Object.entries(group)) {
      store.set(id, structuredClone(entry));
    }
  }
  const cache = new Map([...store].map(([id, entry]) => [id, structuredClone(entry)]));
  const events: string[] = [];
  const logs: string[] = [];
  const adapter = {
    getEnumsAsync: () => {
      events.push("read");
      const groups: Record<string, Record<string, EnumEntry>> = {};
      for (const [id, entry] of store) {
        const group = id.split(".").slice(0, 2).join(".");
        (groups[group] ??= {})[id] = structuredClone(entry);
      }
      return Promise.resolve(groups);
    },
    getForeignObjectAsync: (id: string) => {
      const entry = store.get(id);
      return Promise.resolve(entry ? structuredClone(entry) : null);
    },
    extendForeignObject: (id: string, part: { common?: { members?: string[] } }) => {
      events.push(`write ${id}`);
      store.set(id, { common: { members: [...(part.common?.members ?? [])] } });
      return Promise.resolve();
    },
    log: { debug: () => {}, info: () => {}, warn: (m: string) => void logs.push(m), error: () => {} },
  };
  const deleteOld = (): Promise<void> => {
    events.push("delete");
    if (oldObjectExists) {
      for (const [id, cached] of cache) {
        const members = cached.common.members;
        if (Array.isArray(members) && members.includes(OLD)) {
          store.set(id, { common: { members: members.filter(m => m !== OLD) } });
        }
      }
    }
    return Promise.resolve();
  };
  return { adapter: adapter as unknown as EnumCarryAdapter, store, deleteOld, events, logs };
}

describe("carryEnumMembership", () => {
  it("the successor survives the delete writing the CACHED enum back — at the old position (L5)", async () => {
    const { adapter, store, deleteOld } = makeBroker({
      "enum.rooms": {
        "enum.rooms.living": { common: { members: ["hue.0.light", OLD, "sonos.0.play"] } },
        "enum.rooms.kitchen": { common: { members: ["hue.0.kitchen"] } },
      },
      "enum.functions": { "enum.functions.displays": { common: { members: [OLD] } } },
    });

    expect(await carryEnumMembership(adapter, OLD, NEW, deleteOld)).toBe(2);

    expect(store.get("enum.rooms.living")?.common.members).toEqual(["hue.0.light", NEW, "sonos.0.play"]);
    expect(store.get("enum.functions.displays")?.common.members).toEqual([NEW]);
    expect(store.get("enum.rooms.kitchen")?.common.members).toEqual(["hue.0.kitchen"]);
  });

  it("reads first, deletes exactly once, and writes only after the delete", async () => {
    const { adapter, deleteOld, events } = makeBroker({
      "enum.rooms": { "enum.rooms.living": { common: { members: [OLD] } } },
    });
    await carryEnumMembership(adapter, OLD, NEW, deleteOld);
    expect(events).toEqual(["read", "delete", "write enum.rooms.living"]);
  });

  it("replaces the old id even when its object is gone (the delete struck nothing)", async () => {
    const { adapter, store, deleteOld } = makeBroker(
      { "enum.rooms": { "enum.rooms.living": { common: { members: ["a", OLD, "b"] } } } },
      false,
    );
    await carryEnumMembership(adapter, OLD, NEW, deleteOld);
    expect(store.get("enum.rooms.living")?.common.members).toEqual(["a", NEW, "b"]);
  });

  it("writes nothing when no enum carries the old id — the delete still runs", async () => {
    const { adapter, deleteOld, events } = makeBroker({
      "enum.rooms": { "enum.rooms.living": { common: { members: ["hue.0.light"] } } },
    });
    expect(await carryEnumMembership(adapter, OLD, NEW, deleteOld)).toBe(0);
    expect(events).toEqual(["read", "delete"]);
  });

  it("does not duplicate a successor that is already a member", async () => {
    const { adapter, store, deleteOld } = makeBroker({
      "enum.rooms": { "enum.rooms.living": { common: { members: [NEW, OLD] } } },
    });
    expect(await carryEnumMembership(adapter, OLD, NEW, deleteOld)).toBe(1);
    expect(store.get("enum.rooms.living")?.common.members).toEqual([NEW]);
  });

  it("does not re-create an enum that was removed meanwhile", async () => {
    const { adapter, store, deleteOld } = makeBroker({
      "enum.rooms": { "enum.rooms.gone": { common: { members: [OLD] } } },
    });
    const del = async (): Promise<void> => {
      await deleteOld();
      store.delete("enum.rooms.gone");
    };
    expect(await carryEnumMembership(adapter, OLD, NEW, del)).toBe(0);
    expect(store.has("enum.rooms.gone")).toBe(false);
  });

  it("tolerates enums without a member list", async () => {
    const { adapter, deleteOld, events } = makeBroker({ "enum.rooms": { "enum.rooms.empty": { common: {} } } });
    expect(await carryEnumMembership(adapter, OLD, NEW, deleteOld)).toBe(0);
    expect(events).toEqual(["read", "delete"]);
  });

  it("warns when the enum read fails — the delete still runs, the migration is not stuck", async () => {
    const { adapter, deleteOld, events, logs } = makeBroker({});
    adapter.getEnumsAsync = () => Promise.reject(new Error("broker down"));
    expect(await carryEnumMembership(adapter, OLD, NEW, deleteOld)).toBe(0);
    expect(events).toEqual(["delete"]);
    expect(logs).toEqual([`Could not read the room/function assignments of ${OLD}: broker down`]);
  });
});
