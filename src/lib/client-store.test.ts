import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hasLegacyNative,
  LEGACY_NATIVE_KEYS,
  readStore,
  SECRET_FIELDS,
  STORE_FILE,
  storedClientFrom,
  type StoredClient,
  writeStore,
} from "./client-store";
import { TEST_CIPHER } from "../../test/unit/cipher";

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
    expect(readStore(dir, TEST_CIPHER)).toEqual({ clients: new Map() });
  });

  it("reads back the server id and the displays, sorted by display id", () => {
    const entry: StoredClient = { cookie: COOKIE, token: null, tokenExpiresAt: null, refreshToken: null };
    writeStore(
      dir,
      TEST_CIPHER,
      SERVER,
      new Map<string, StoredClient>([
        ["b2b2b2", entry],
        ["a1a1a1", { ...entry, lastSeen: 3 }],
      ]),
    );
    const raw = JSON.parse(readFileSync(join(dir, STORE_FILE), "utf8")) as { server: string; displays: object };
    expect(raw.server).toBe(SERVER);
    expect(Object.keys(raw.displays)).toEqual(["a1a1a1", "b2b2b2"]);
    const read = readStore(dir, TEST_CIPHER);
    expect(read.server).toBe(SERVER);
    expect(read.clients).toEqual(
      new Map<string, StoredClient>([
        ["a1a1a1", { ...entry, lastSeen: 3 }],
        ["b2b2b2", entry],
      ]),
    );
  });

  it("seals the cookie and both tokens, and leaves the server id, the expiry and lastSeen as they are (S7)", () => {
    const entry: StoredClient = {
      cookie: COOKIE,
      token: TOKEN,
      tokenExpiresAt: 5,
      refreshToken: TOKEN.replace("a", "b"),
      lastSeen: 7,
    };
    writeStore(dir, TEST_CIPHER, SERVER, new Map([["a1a1a1", entry]]));
    const text = readFileSync(join(dir, STORE_FILE), "utf8");
    expect(text).not.toContain(COOKIE);
    expect(text).not.toContain(TOKEN);
    const raw = JSON.parse(text) as { server: string; displays: Record<string, Record<string, unknown>> };
    expect(raw.server).toBe(SERVER);
    const stored = raw.displays.a1a1a1;
    for (const field of SECRET_FIELDS) {
      expect(Object.keys(stored[field] as object), field).toEqual(["$encrypted"]);
    }
    expect({ tokenExpiresAt: stored.tokenExpiresAt, lastSeen: stored.lastSeen }).toEqual({
      tokenExpiresAt: 5,
      lastSeen: 7,
    });
    expect(readStore(dir, TEST_CIPHER).clients.get("a1a1a1")).toEqual(entry);
  });

  it("reads a file from before with the secrets in clear text, and writes it back sealed at once", () => {
    writeFileSync(
      join(dir, STORE_FILE),
      JSON.stringify({ server: SERVER, displays: { a1a1a1: { cookie: COOKIE, token: TOKEN, refreshToken: null } } }),
    );
    expect(readStore(dir, TEST_CIPHER).clients.get("a1a1a1")).toMatchObject({ cookie: COOKIE, token: TOKEN });
    const text = readFileSync(join(dir, STORE_FILE), "utf8");
    expect(text).not.toContain(COOKIE);
    expect(text).not.toContain(TOKEN);
  });

  it("calls a file unusable whose secret cannot be decrypted — never a file without displays", () => {
    writeStore(
      dir,
      TEST_CIPHER,
      SERVER,
      new Map([["a1a1a1", { cookie: COOKIE, token: null, tokenExpiresAt: null, refreshToken: null }]]),
    );
    const otherKey = { encrypt: TEST_CIPHER.encrypt, decrypt: (): string => "garbage" };
    const read = readStore(dir, otherKey);
    expect(read.error).toMatch(/cookie cannot be decrypted/);
    expect(read.server).toBeUndefined();
  });

  it("leaves out an entry without a usable cookie and keeps the rest", () => {
    writeFileSync(
      join(dir, STORE_FILE),
      JSON.stringify({ server: SERVER, displays: { good01: { cookie: COOKIE }, bad001: { cookie: "x" } } }),
    );
    expect([...readStore(dir, TEST_CIPHER).clients.keys()]).toEqual(["good01"]);
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
      const read = readStore(dir, TEST_CIPHER);
      expect(read.server, content).toBe(undefined);
      if (typeof error === "string") {
        expect(read.error, content).toBe(error);
      } else {
        expect(read.error, content).toMatch(error);
      }
    }
  });
});
