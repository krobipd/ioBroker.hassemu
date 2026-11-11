import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasLegacyNative,
  LEGACY_NATIVE_KEYS,
  readStore,
  STORE_FILE,
  storedClientFrom,
  type StoredClient,
  writeStore,
} from "./client-store";

const COOKIE = "11111111-2222-4333-8444-555555555555";
const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SERVER = "99999999-8888-4777-8666-555555555555";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hassemu-clients-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("storedClientFrom — the boundary of the file and of an earlier version's native", () => {
  it("takes a full entry as it is", () => {
    expect(
      storedClientFrom({ cookie: COOKIE, token: TOKEN, tokenExpiresAt: 5, refreshToken: TOKEN, lastSeen: 7 }),
    ).toEqual({ cookie: COOKIE, token: TOKEN, tokenExpiresAt: 5, refreshToken: TOKEN, lastSeen: 7 });
  });

  it("is no entry without a usable cookie — the cookie is the identity", () => {
    expect(storedClientFrom({ token: TOKEN })).toBeNull();
    expect(storedClientFrom({ cookie: "not-a-uuid" })).toBeNull();
    expect(storedClientFrom(null)).toBeNull();
    expect(storedClientFrom([COOKIE])).toBeNull();
  });

  it("reads a broken token field as none, and an expiry only beside a token and only as a number", () => {
    expect(storedClientFrom({ cookie: COOKIE, token: 42, tokenExpiresAt: 5 })).toEqual({
      cookie: COOKIE,
      token: null,
      tokenExpiresAt: null,
      refreshToken: null,
    });
    expect(storedClientFrom({ cookie: COOKIE, token: TOKEN, tokenExpiresAt: "5" })?.tokenExpiresAt).toBeNull();
    expect(storedClientFrom({ cookie: COOKIE, token: TOKEN })?.tokenExpiresAt).toBeNull();
  });

  it("keeps lastSeen only as a finite number, and leaves it out otherwise", () => {
    expect(storedClientFrom({ cookie: COOKIE, lastSeen: Number.NaN })).not.toHaveProperty("lastSeen");
    expect(storedClientFrom({ cookie: COOKIE, lastSeen: "7" })).not.toHaveProperty("lastSeen");
  });

  it("normalises the cookie to lower case, like every cookie the server reads", () => {
    expect(storedClientFrom({ cookie: COOKIE.toUpperCase() })?.cookie).toBe(COOKIE);
  });
});

describe("hasLegacyNative", () => {
  it("sees every key an earlier version stored, and nothing else", () => {
    for (const key of LEGACY_NATIVE_KEYS) {
      expect(hasLegacyNative({ [key]: null })).toBe(true);
    }
    expect(hasLegacyNative({ objectsVersion: 4 })).toBe(false);
  });
});

describe("readStore / writeStore", () => {
  it("reads nothing before the first write", () => {
    expect(readStore(dir)).toEqual({ clients: new Map() });
  });

  it("reads back the server id and the displays, sorted by display id", () => {
    const entry: StoredClient = { cookie: COOKIE, token: null, tokenExpiresAt: null, refreshToken: null };
    writeStore(
      dir,
      SERVER,
      new Map<string, StoredClient>([
        ["b2b2b2", entry],
        ["a1a1a1", { ...entry, lastSeen: 3 }],
      ]),
    );
    const raw = JSON.parse(readFileSync(join(dir, STORE_FILE), "utf8")) as { server: string; displays: object };
    expect(raw.server).toBe(SERVER);
    expect(Object.keys(raw.displays)).toEqual(["a1a1a1", "b2b2b2"]);
    const read = readStore(dir);
    expect(read.server).toBe(SERVER);
    expect(read.clients).toEqual(
      new Map<string, StoredClient>([
        ["a1a1a1", { ...entry, lastSeen: 3 }],
        ["b2b2b2", entry],
      ]),
    );
  });

  it("leaves out an entry without a usable cookie and keeps the rest", () => {
    writeFileSync(
      join(dir, STORE_FILE),
      JSON.stringify({ server: SERVER, displays: { good01: { cookie: COOKIE }, bad001: { cookie: "x" } } }),
    );
    expect([...readStore(dir).clients.keys()]).toEqual(["good01"]);
  });

  it("names why a file it cannot use is unusable — a file without a valid server id too (design decision 2)", () => {
    const cases: Array<[string, string | RegExp]> = [
      ["{ broken", /^no JSON: /],
      ["[]", "no object in it"],
      [JSON.stringify({ displays: {} }), "no valid server id in it"],
      [JSON.stringify({ server: "not-a-uuid", displays: {} }), "no valid server id in it"],
      [JSON.stringify({ server: SERVER, displays: [] }), "no object of displays in it"],
    ];
    for (const [content, error] of cases) {
      writeFileSync(join(dir, STORE_FILE), content);
      const read = readStore(dir);
      expect(read.server, content).toBe(undefined);
      if (typeof error === "string") {
        expect(read.error, content).toBe(error);
      } else {
        expect(read.error, content).toMatch(error);
      }
    }
  });
});
