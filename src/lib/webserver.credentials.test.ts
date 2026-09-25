// credentialsValid must compare BOTH fields in constant time and never short-circuit — a result
// check alone cannot tell a `===` from `safeStringEqual`, or `a && b` from two unconditional
// comparisons (audit 2026-09-25, T12). `safeStringEqual` is a named ESM import, so the spy has
// to replace the module; that is why this lives in its own file.
// adapter-core outside a js-controller would end the process — the credential check needs
// none of it.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: vi.fn((key: string) => ({ en: key })), translate: vi.fn((key: string) => key) },
}));
vi.mock("./coerce", async importOriginal => {
  const actual = await importOriginal<typeof CoerceModule>();
  return { ...actual, safeStringEqual: vi.fn(actual.safeStringEqual) };
});

import type * as CoerceModule from "./coerce";
import { safeStringEqual } from "./coerce";
import { WebServer } from "./webserver";
import type { AdapterConfig } from "./types";

const config: AdapterConfig = {
  port: 0,
  bind: "127.0.0.1",
  authRequired: true,
  username: "admin",
  password: "secret",
  mdnsEnabled: false,
  serviceName: "TestServer",
};

/** A server whose collaborators are never reached — only the credential check runs. */
function server(): { credentialsValid: (u: unknown, p: unknown) => boolean } {
  const adapter = {
    namespace: "hassemu.0",
    log: { silly: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => undefined,
    clearInterval: () => undefined,
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
  };
  const s = new WebServer(adapter as never, config, {} as never, {} as never, "uuid");
  return {
    credentialsValid: (u, p) =>
      (s as unknown as { credentialsValid: (u: unknown, p: unknown) => boolean }).credentialsValid(u, p),
  };
}

describe("WebServer.credentialsValid", () => {
  beforeEach(() => {
    vi.mocked(safeStringEqual).mockClear();
  });

  it("compares both fields in constant time, even when the user name is already wrong", () => {
    expect(server().credentialsValid("wrong", "secret")).toBe(false);
    expect(vi.mocked(safeStringEqual).mock.calls).toEqual([
      ["wrong", "admin"],
      ["secret", "secret"],
    ]);
  });

  it("accepts the right pair through the same two comparisons", () => {
    expect(server().credentialsValid("admin", "secret")).toBe(true);
    expect(vi.mocked(safeStringEqual)).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty password before any comparison", () => {
    expect(server().credentialsValid("admin", "")).toBe(false);
    expect(vi.mocked(safeStringEqual)).not.toHaveBeenCalled();
  });
});
