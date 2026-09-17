import { describe, expect, it } from "vitest";
import { carryEnumMembership, type EnumCarryAdapter } from "./enum-membership";

type EnumEntry = { common: { members?: string[] } };

function makeAdapter(enums: Record<string, Record<string, EnumEntry>>): {
  adapter: EnumCarryAdapter;
  writes: { id: string; members: string[] }[];
  logs: string[];
} {
  const writes: { id: string; members: string[] }[] = [];
  const logs: string[] = [];
  const adapter = {
    getEnumsAsync: () => Promise.resolve(structuredClone(enums)),
    extendForeignObject: (id: string, part: { common?: { members?: string[] } }) => {
      writes.push({ id, members: part.common?.members ?? [] });
      return Promise.resolve();
    },
    log: { debug: () => {}, info: () => {}, warn: (m: string) => void logs.push(m), error: () => {} },
  };
  return { adapter: adapter as unknown as EnumCarryAdapter, writes, logs };
}

const OLD = "hassemu.0.global.visUrl";
const NEW = "hassemu.0.global.manualUrl";

describe("carryEnumMembership", () => {
  it("replaces the old id in place in every enum that carries it — order kept", async () => {
    const { adapter, writes } = makeAdapter({
      "enum.rooms": {
        "enum.rooms.living": { common: { members: ["hue.0.light", OLD, "sonos.0.play"] } },
        "enum.rooms.kitchen": { common: { members: ["hue.0.kitchen"] } },
      },
      "enum.functions": {
        "enum.functions.displays": { common: { members: [OLD] } },
      },
    });
    expect(await carryEnumMembership(adapter, OLD, NEW)).toBe(2);
    expect(writes).toEqual([
      { id: "enum.rooms.living", members: ["hue.0.light", NEW, "sonos.0.play"] },
      { id: "enum.functions.displays", members: [NEW] },
    ]);
  });

  it("writes nothing when no enum carries the old id", async () => {
    const { adapter, writes } = makeAdapter({
      "enum.rooms": { "enum.rooms.living": { common: { members: ["hue.0.light"] } } },
    });
    expect(await carryEnumMembership(adapter, OLD, NEW)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("does not duplicate a successor that is already a member", async () => {
    const { adapter, writes } = makeAdapter({
      "enum.rooms": { "enum.rooms.living": { common: { members: [NEW, OLD] } } },
    });
    expect(await carryEnumMembership(adapter, OLD, NEW)).toBe(1);
    expect(writes).toEqual([{ id: "enum.rooms.living", members: [NEW] }]);
  });

  it("tolerates enums without a member list", async () => {
    const { adapter, writes } = makeAdapter({
      "enum.rooms": { "enum.rooms.empty": { common: {} } },
    });
    expect(await carryEnumMembership(adapter, OLD, NEW)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("warns and returns when the enum read fails — the migration is not stuck on it", async () => {
    const { adapter, logs } = makeAdapter({});
    adapter.getEnumsAsync = () => Promise.reject(new Error("broker down"));
    expect(await carryEnumMembership(adapter, OLD, NEW)).toBe(0);
    expect(logs).toEqual([`Could not carry the room/function assignments of ${OLD} to ${NEW}: broker down`]);
  });
});
