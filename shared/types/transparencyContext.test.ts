import { describe, expect, it } from "vitest";
import {
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
  TRANSPARENCY_SCHEMA_VERSION,
  checkTransparencyContext,
  decideTransparencySnapshot,
  normalizeTransparencyNetwork,
  parseTransparencyContext,
  parseTransparencyExpectation,
  type TransparencyContext,
} from "./transparencyContext";

const ctx = (overrides: Partial<TransparencyContext> = {}): TransparencyContext => ({
  network: "testnet",
  ledger: 1000,
  version: TRANSPARENCY_SCHEMA_VERSION,
  ...overrides,
});

describe("normalizeTransparencyNetwork", () => {
  it("maps passphrases and labels", () => {
    expect(normalizeTransparencyNetwork(MAINNET_PASSPHRASE)).toBe("mainnet");
    expect(normalizeTransparencyNetwork(TESTNET_PASSPHRASE)).toBe("testnet");
    expect(normalizeTransparencyNetwork("Test SDF Future Network ; October 2022")).toBe("futurenet");
    expect(normalizeTransparencyNetwork(" PUBLIC ")).toBe("mainnet");
    expect(normalizeTransparencyNetwork("Standalone Network ; February 2017")).toBe("local");
  });

  it("returns null instead of guessing", () => {
    for (const value of ["", "moonnet", 42, null, undefined]) {
      expect(normalizeTransparencyNetwork(value)).toBeNull();
    }
  });
});

describe("parseTransparencyContext", () => {
  it("accepts a valid context and normalizes the network", () => {
    expect(parseTransparencyContext({ network: TESTNET_PASSPHRASE, ledger: 7, version: " 1 " })).toEqual({
      network: "testnet",
      ledger: 7,
      version: "1",
    });
  });

  it.each([
    ["not an object", null],
    ["unknown network", { network: "x", ledger: 1, version: "1" }],
    ["negative ledger", { network: "testnet", ledger: -1, version: "1" }],
    ["fractional ledger", { network: "testnet", ledger: 1.5, version: "1" }],
    ["string ledger", { network: "testnet", ledger: "1", version: "1" }],
    ["empty version", { network: "testnet", ledger: 1, version: "" }],
  ])("rejects %s", (_label: string, raw: unknown) => {
    expect(() => parseTransparencyContext(raw)).toThrow(
      expect.objectContaining({ code: "INVALID_TRANSPARENCY_CONTEXT" }),
    );
  });
});

describe("checkTransparencyContext", () => {
  it("passes when nothing or everything matches", () => {
    expect(checkTransparencyContext(ctx(), {})).toEqual({ ok: true });
    expect(
      checkTransparencyContext(ctx(), { network: "testnet", version: TRANSPARENCY_SCHEMA_VERSION, minLedger: 1000 }),
    ).toEqual({ ok: true });
  });

  it("reports network and version mismatches as final and a lagging ledger as retryable", () => {
    const network = checkTransparencyContext(ctx(), { network: "mainnet" });
    expect(network.ok || network.error).toMatchObject({ code: "TRANSPARENCY_NETWORK_MISMATCH", retryable: false });

    const version = checkTransparencyContext(ctx(), { version: "2" });
    expect(version.ok || version.error).toMatchObject({ code: "TRANSPARENCY_VERSION_MISMATCH", retryable: false });

    const behind = checkTransparencyContext(ctx(), { minLedger: 1001 });
    expect(behind.ok || behind.error).toMatchObject({ code: "TRANSPARENCY_LEDGER_BEHIND", retryable: true });
  });
});

describe("decideTransparencySnapshot", () => {
  it("accepts the first snapshot for the expected network", () => {
    expect(decideTransparencySnapshot(null, ctx(), { network: "testnet" })).toEqual({ action: "accept" });
  });

  it("accepts the same or a newer ledger", () => {
    expect(decideTransparencySnapshot(ctx(), ctx()).action).toBe("accept");
    expect(decideTransparencySnapshot(ctx(), ctx({ ledger: 1001 })).action).toBe("accept");
  });

  it("keeps the current snapshot for an older ledger", () => {
    const decision = decideTransparencySnapshot(ctx(), ctx({ ledger: 999 }));
    expect(decision).toMatchObject({ action: "keep-current", error: { code: "TRANSPARENCY_LEDGER_REGRESSION" } });
  });

  it("never switches networks or versions as a side effect of a response", () => {
    expect(decideTransparencySnapshot(ctx(), ctx({ network: "mainnet", ledger: 5000 }))).toMatchObject({
      action: "keep-current",
      error: { code: "TRANSPARENCY_NETWORK_MISMATCH" },
    });
    expect(decideTransparencySnapshot(null, ctx({ network: "mainnet" }), { network: "testnet" }).action).toBe(
      "keep-current",
    );
    expect(decideTransparencySnapshot(ctx(), ctx({ version: "2", ledger: 2000 })).action).toBe("keep-current");
  });
});

describe("parseTransparencyExpectation", () => {
  it("parses query or header strings", () => {
    expect(parseTransparencyExpectation({ network: "testnet", version: "1", minLedger: "42" })).toEqual({
      network: "testnet",
      version: "1",
      minLedger: 42,
    });
    expect(parseTransparencyExpectation({ network: "", minLedger: undefined })).toEqual({});
  });

  it.each([{ network: "moonnet" }, { minLedger: "-1" }, { minLedger: "1e3" }, { minLedger: "9007199254740993" }])(
    "rejects %o",
    (raw: Record<string, unknown>) => {
      expect(() => parseTransparencyExpectation(raw)).toThrow(
        expect.objectContaining({ code: "INVALID_TRANSPARENCY_CONTEXT" }),
      );
    },
  );
});
