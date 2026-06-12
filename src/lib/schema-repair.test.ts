import { type InstanceObjectSchema, repairGlobalSchemas, type SchemaRepairAdapter } from "./schema-repair";

const THROWS = Symbol("throws");
type ObjState = { type: string; common?: { type?: string; name?: string } } | null | typeof THROWS;

interface ExtendCall {
  id: string;
  obj: { type?: unknown; common?: unknown; native?: unknown };
  options: unknown;
}

function mockAdapter(objects: Record<string, ObjState>): {
  adapter: SchemaRepairAdapter;
  extendCalls: ExtendCall[];
  logs: string[];
} {
  const extendCalls: ExtendCall[] = [];
  const logs: string[] = [];
  const adapter = {
    namespace: "hassemu.0",
    log: { debug: (m: string) => logs.push(m), info: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => undefined,
    clearInterval: () => undefined,
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    getObjectAsync: async (id: string) => {
      const v = objects[id];
      if (v === THROWS) {
        throw new Error("broker offline");
      }
      return (v ?? null) as unknown;
    },
    extendObjectAsync: async (id: string, obj: unknown, options: unknown) => {
      extendCalls.push({ id, obj: obj as ExtendCall["obj"], options });
    },
  };
  return { adapter: adapter as unknown as SchemaRepairAdapter, extendCalls, logs };
}

const INSTANCE_OBJECTS: InstanceObjectSchema[] = [
  {
    _id: "global.mode",
    type: "state",
    common: { type: "mixed", name: "Mode", role: "state", read: true, write: true, def: 0 },
    native: {},
  },
  {
    // no `native` field on purpose — exercises the `native ?? {}` fallback
    _id: "global.manualUrl",
    type: "state",
    common: { type: "string", name: "URL", role: "url", read: true, write: true, def: "" },
  },
];

describe("schema-repair", () => {
  describe("repairGlobalSchemas", () => {
    it("skips well-formed objects (no extendObject write)", async () => {
      const { adapter, extendCalls } = mockAdapter({
        "global.mode": { type: "state", common: { type: "mixed" } },
        "global.manualUrl": { type: "state", common: { type: "string" } },
      });
      await repairGlobalSchemas(adapter, INSTANCE_OBJECTS);
      expect(extendCalls).to.have.length(0);
    });

    it("repairs a partial object (wrong/missing common.type) from the instanceObjects schema", async () => {
      const { adapter, extendCalls } = mockAdapter({
        "global.mode": { type: "state", common: {} }, // missing common.type → needs repair
        "global.manualUrl": { type: "state", common: { type: "string" } }, // ok
      });
      await repairGlobalSchemas(adapter, INSTANCE_OBJECTS);
      expect(extendCalls).to.have.length(1);
      expect(extendCalls[0].id).to.equal("global.mode");
      expect(extendCalls[0].obj.type).to.equal("state");
      expect(extendCalls[0].obj.common).to.deep.equal(INSTANCE_OBJECTS[0].common);
      expect(extendCalls[0].options).to.deep.equal({ preserve: { common: ["name"] } });
    });

    it("repairs a non-existent object (getObject → null)", async () => {
      const { adapter, extendCalls } = mockAdapter({
        "global.mode": null,
        "global.manualUrl": { type: "state", common: { type: "string" } },
      });
      await repairGlobalSchemas(adapter, INSTANCE_OBJECTS);
      expect(extendCalls.map(c => c.id)).to.deep.equal(["global.mode"]);
    });

    it("falls through to repair when getObject throws", async () => {
      const { adapter, extendCalls } = mockAdapter({
        "global.mode": THROWS,
        "global.manualUrl": { type: "state", common: { type: "string" } },
      });
      await repairGlobalSchemas(adapter, INSTANCE_OBJECTS);
      expect(extendCalls.map(c => c.id)).to.deep.equal(["global.mode"]);
    });

    it("defaults native to {} when the schema has no native field", async () => {
      const { adapter, extendCalls } = mockAdapter({
        "global.mode": { type: "state", common: { type: "mixed" } }, // ok
        "global.manualUrl": { type: "state", common: {} }, // needs repair, schema has no native
      });
      await repairGlobalSchemas(adapter, INSTANCE_OBJECTS);
      expect(extendCalls).to.have.length(1);
      expect(extendCalls[0].id).to.equal("global.manualUrl");
      expect(extendCalls[0].obj.native).to.deep.equal({});
    });

    it("skips + logs when no instanceObjects schema matches the target", async () => {
      const { adapter, extendCalls, logs } = mockAdapter({ "global.mode": { type: "state", common: {} } });
      await repairGlobalSchemas(adapter, [], [["global.mode", "mixed"]]);
      expect(extendCalls).to.have.length(0);
      expect(logs.some(l => l.includes("no instanceObjects-schema found"))).to.be.true;
    });

    it("matches the schema by namespaced _id as well", async () => {
      const { adapter, extendCalls } = mockAdapter({ "global.mode": { type: "state", common: {} } });
      const nsSchema: InstanceObjectSchema[] = [
        { _id: "hassemu.0.global.mode", type: "state", common: { type: "mixed" }, native: {} },
      ];
      await repairGlobalSchemas(adapter, nsSchema, [["global.mode", "mixed"]]);
      expect(extendCalls).to.have.length(1);
      expect(extendCalls[0].id).to.equal("global.mode");
    });

    it("swallows extendObject errors (best-effort, no throw)", async () => {
      const { adapter } = mockAdapter({ "global.mode": { type: "state", common: {} } });
      // Override extendObjectAsync to throw — repair must not propagate it.
      (adapter as unknown as { extendObjectAsync: unknown }).extendObjectAsync = async () => {
        throw new Error("write failed");
      };
      await repairGlobalSchemas(adapter, INSTANCE_OBJECTS, [["global.mode", "mixed"]]);
      // no throw = pass
    });
  });
});
