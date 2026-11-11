import { readFileSync } from "node:fs";
import { join } from "node:path";
import type tls from "node:tls";
import {
  buildTls,
  certificateName,
  collectionChoiceOf,
  isCertificateNotFound,
  loadTls,
  selectCollections,
  type TlsAdapter,
} from "./tls";

// Test-only certificates (test/fixtures/tls/README.md) — real X.509, so the name is read the way a start reads it.
const fixture = (name: string): string => readFileSync(join(__dirname, "../../test/fixtures/tls", name), "utf8");
const NAMED = { key: fixture("named.key"), cert: fixture("named.crt") };
const CN_ONLY = { key: fixture("cn-only.key"), cert: fixture("cn-only.crt") };
const LE = { key: fixture("le.key"), cert: fixture("le.crt") };

/**
 * The context the SNI callback hands out for a name.
 *
 * @param setup The HTTPS part.
 * @param servername The name the client asks for.
 */
function contextFor(setup: ReturnType<typeof buildTls>, servername: string): tls.SecureContext | undefined {
  let got: tls.SecureContext | undefined;
  setup.options.SNICallback(servername, (_err, ctx) => {
    got = ctx;
  });
  return got;
}

describe("certificateName (K4: the name the server advertises)", () => {
  it("takes the first DNS name without a wildcard — never the IP entry", () => {
    expect(certificateName(NAMED.cert)).toBe("display-test.example");
  });

  it("falls back to the common name when the certificate carries no DNS name", () => {
    expect(certificateName(CN_ONLY.cert)).toBe("cn-only.example");
  });

  it("is undefined for something that is no certificate", () => {
    expect(certificateName("not a certificate")).toBeUndefined();
  });
});

describe("selectCollections (Let's Encrypt collections of the acme adapter)", () => {
  const native = {
    collections: {
      home: { key: LE.key, cert: LE.cert, chain: [LE.cert, NAMED.cert], domains: ["le.example", "*.le.example"] },
      broken: { key: LE.key, cert: "no pem", domains: ["x.example"] },
    },
  };

  it("false selects none", () => {
    expect(selectCollections(native, false).size).toBe(0);
  });

  it("an id selects that collection; its chain drops a repeated leaf and keeps the issuers", () => {
    const home = selectCollections(native, "home").get("home")!;
    expect(home.domains).toEqual(["le.example", "*.le.example"]);
    const blocks = home.cert.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
    expect(blocks, "leaf + one issuer, the repeated leaf dropped").toHaveLength(2);
    expect(home.cert.startsWith(LE.cert.trim().split("\n")[0])).toBe(true);
  });

  it("a chosen id that does not exist or holds no certificate is an error — the server cannot present it", () => {
    expect(() => selectCollections(native, "gone")).toThrow('the certificate collection "gone" does not exist');
    expect(() => selectCollections(native, "broken")).toThrow('"broken"');
  });

  it("true takes every usable collection and skips the rest", () => {
    expect([...selectCollections(native, true).keys()]).toEqual(["home"]);
    expect(selectCollections({}, true).size).toBe(0);
  });

  it("the setting: true, a trimmed id, or false for anything else", () => {
    expect(collectionChoiceOf(true)).toBe(true);
    expect(collectionChoiceOf(" home ")).toBe("home");
    expect(collectionChoiceOf("")).toBe(false);
    expect(collectionChoiceOf(false)).toBe(false);
    expect(collectionChoiceOf(undefined)).toBe(false);
  });
});

describe("buildTls", () => {
  it("SNI: the collection for its domain, a wildcard of it, else the named certificate", () => {
    const setup = buildTls(
      NAMED,
      selectCollections({ collections: { home: { ...LE, domains: ["le.example", "*.le.example"] } } }, "home"),
      "home",
    );
    const exact = contextFor(setup, "le.example");
    const wildcard = contextFor(setup, "panel.le.example");
    const other = contextFor(setup, "display-test.example");
    expect(exact).toBeDefined();
    expect(wildcard).toBe(exact);
    expect(other).toBeDefined();
    expect(other).not.toBe(exact);
  });

  it("advertises the collection's first plain domain, without one the named certificate's name", () => {
    const withLe = buildTls(
      NAMED,
      selectCollections({ collections: { home: { ...LE, domains: ["*.le.example", "le.example"] } } }, "home"),
      "home",
    );
    expect(withLe.name).toBe("le.example");
    expect(buildTls(NAMED, new Map(), false).name).toBe("display-test.example");
  });

  it("update swaps the collection contexts the running server hands out", () => {
    const setup = buildTls(NAMED, new Map(), true);
    const before = contextFor(setup, "le.example");
    setup.update(selectCollections({ collections: { home: { ...LE, domains: ["le.example"] } } }, true));
    expect(contextFor(setup, "le.example")).not.toBe(before);
  });

  it("a key that does not fit its certificate is refused at once, not at the first connection", () => {
    expect(() => buildTls({ key: CN_ONLY.key, cert: NAMED.cert }, new Map(), false)).toThrow();
  });
});

describe("loadTls", () => {
  function adapter(answer: () => Promise<unknown>, certificates: unknown = null): TlsAdapter & { asked: unknown[][] } {
    const asked: unknown[][] = [];
    return {
      asked,
      getCertificatesAsync: (...names: unknown[]) => {
        asked.push(names);
        return answer();
      },
      getForeignObjectAsync: () => Promise.resolve(structuredClone(certificates) as ioBroker.Object | null),
    };
  }

  it("without a chosen certificate it asks for ioBroker's default pair", async () => {
    const a = adapter(() => Promise.resolve([NAMED, false]));
    const setup = await loadTls(a, {});
    expect(a.asked).toEqual([["defaultPublic", "defaultPrivate", undefined]]);
    expect(setup.name).toBe("display-test.example");
    expect(setup.collectionChoice).toBe(false);
  });

  it("passes the chosen names on and reads the chosen collection", async () => {
    const certificates = { native: { collections: { home: { ...LE, domains: ["le.example"] } } } };
    const a = adapter(() => Promise.resolve([NAMED, true]), certificates);
    const setup = await loadTls(a, {
      certPublic: "mine",
      certPrivate: "minekey",
      certChained: "chain",
      leCollection: "home",
    });
    expect(a.asked).toEqual([["mine", "minekey", "chain"]]);
    expect(setup.name).toBe("le.example");
  });

  it("the controller's not-configured error comes through as itself — it logged the line already", async () => {
    const a = adapter(() => Promise.reject(new Error("Not exists")));
    const err = await loadTls(a, {}).catch((e: unknown) => e);
    expect(isCertificateNotFound(err)).toBe(true);
    expect(isCertificateNotFound(new Error("other"))).toBe(false);
  });
});
