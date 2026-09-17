import { describe, expect, it } from "vitest";
import { errText } from "./err-text";

describe("errText — every thrown value becomes readable text", () => {
  it("an Error contributes its message, not its stack", () => {
    expect(errText(new Error("broker down"))).toBe("broker down");
    expect(errText(new TypeError("bad type"))).toBe("bad type");
  });

  it("a thrown string is returned as it is", () => {
    expect(errText("plain text")).toBe("plain text");
  });

  it("primitives that are not strings are stringified — including a symbol", () => {
    expect(errText(42)).toBe("42");
    expect(errText(true)).toBe("true");
    expect(errText(10n)).toBe("10");
    expect(errText(Symbol("boom"))).toBe("Symbol(boom)");
  });

  it("null and undefined name themselves instead of crashing", () => {
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });

  it("a thrown plain object is rendered as JSON, never as [object Object]", () => {
    expect(errText({ code: "ECONNRESET", syscall: "read" })).toBe('{"code":"ECONNRESET","syscall":"read"}');
    expect(errText([1, "two"])).toBe('[1,"two"]');
  });

  it("a cyclic object falls back to the type tag instead of throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(errText(cyclic)).toBe("[object Object]");
  });

  it("an object JSON cannot represent falls back to the type tag", () => {
    // toJSON returning undefined makes JSON.stringify return undefined (not a string).
    const opaque = { toJSON: () => undefined };
    expect(errText(opaque)).toBe("[object Object]");
  });
});
