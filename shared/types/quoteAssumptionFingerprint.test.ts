import { describe, it, expect } from "vitest";
import {
  canonicalizeQuoteAssumptions,
  computeQuoteAssumptionFingerprint,
  detectAssumptionDrift,
  formatShortFingerprint,
  sha256Pure,
  verifyQuoteAssumptionFingerprint,
  type QuoteAssumptions,
} from "./quoteAssumptionFingerprint";

function makeMockAssumptions(overrides: Partial<QuoteAssumptions> = {}): QuoteAssumptions {
  return {
    inputTokenContract: "CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D1",
    inputTokenSymbol: "USDC",
    vaultTokenContract: "CVLTFAKECONTRACTIDFORLOCALBUILDONLY",
    vaultTokenSymbol: "yUSDC",
    amountInStroops: "100000000",
    expectedAmountOutStroops: "99500000",
    minAmountOutStroops: "99000000",
    slippageTolerancePct: 0.5,
    routeHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    path: ["CB64D3G7AW2Z64V6B3H6Y5A5LGBY2QW6K3V6W7G3E2D1", "CVLTFAKECONTRACTIDFORLOCALBUILDONLY"],
    source: "router_simulation",
    assetConfigVersion: "v1-active-stable-config",
    quotedAt: "2026-10-18T12:00:00.000Z",
    expiresAt: "2026-10-18T12:01:00.000Z",
    protocol: "soroswap",
    reserveSafe: true,
    ...overrides,
  };
}

describe("sha256Pure", () => {
  it("matches standard test vectors", () => {
    expect(sha256Pure("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Pure("hello world")).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(sha256Pure("StellarYield")).toBe("1cbbf1ddde8de1f74a9beaae201348d6bfc2c94e4e3daeb4a4386f3f56b3ccd8");
  });
});

describe("canonicalizeQuoteAssumptions", () => {
  it("normalizes case and trims whitespace", () => {
    const raw = makeMockAssumptions({
      inputTokenContract: "  CAAA123  ",
      vaultTokenContract: "CBBB456 ",
      protocol: "  SOROSWAP  ",
    });
    const canonical = canonicalizeQuoteAssumptions(raw);
    expect(canonical.inputTokenContract).toBe("caaa123");
    expect(canonical.vaultTokenContract).toBe("cbbb456");
    expect(canonical.protocol).toBe("soroswap");
  });
});

describe("computeQuoteAssumptionFingerprint", () => {
  it("computes deterministic 64-char hex digest", () => {
    const assumptions = makeMockAssumptions();
    const res1 = computeQuoteAssumptionFingerprint(assumptions);
    const res2 = computeQuoteAssumptionFingerprint(assumptions);

    expect(res1.fingerprint).toHaveLength(64);
    expect(res1.fingerprint).toBe(res2.fingerprint);
    expect(res1.shortFingerprint).toMatch(/^qaf-[a-f0-9]{6}…[a-f0-9]{4}$/);
  });

  it("produces distinct fingerprints when economic amount changes", () => {
    const a1 = makeMockAssumptions({ amountInStroops: "100000000" });
    const a2 = makeMockAssumptions({ amountInStroops: "200000000" });

    const f1 = computeQuoteAssumptionFingerprint(a1);
    const f2 = computeQuoteAssumptionFingerprint(a2);
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });

  it("produces distinct fingerprints when slippage tolerance changes", () => {
    const a1 = makeMockAssumptions({ slippageTolerancePct: 0.5 });
    const a2 = makeMockAssumptions({ slippageTolerancePct: 1.0 });

    const f1 = computeQuoteAssumptionFingerprint(a1);
    const f2 = computeQuoteAssumptionFingerprint(a2);
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });

  it("produces distinct fingerprints when route or config version drifts", () => {
    const a1 = makeMockAssumptions({ assetConfigVersion: "config-v1" });
    const a2 = makeMockAssumptions({ assetConfigVersion: "config-v2" });

    const f1 = computeQuoteAssumptionFingerprint(a1);
    const f2 = computeQuoteAssumptionFingerprint(a2);
    expect(f1.fingerprint).not.toBe(f2.fingerprint);
  });
});

describe("formatShortFingerprint", () => {
  it("formats short badges cleanly", () => {
    const hash = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    expect(formatShortFingerprint(hash)).toBe("qaf-b94d27…cde9");
  });

  it("handles malformed or empty hashes safely", () => {
    expect(formatShortFingerprint("")).toBe("qaf-invalid");
    expect(formatShortFingerprint(null as unknown as string)).toBe("qaf-invalid");
  });
});

describe("verifyQuoteAssumptionFingerprint", () => {
  it("verifies matching assumptions within valid timestamp", () => {
    const assumptions = makeMockAssumptions({
      quotedAt: "2026-10-18T12:00:00.000Z",
      expiresAt: "2026-10-18T12:01:00.000Z",
    });
    const { fingerprint } = computeQuoteAssumptionFingerprint(assumptions);

    const result = verifyQuoteAssumptionFingerprint(assumptions, fingerprint, {
      nowMs: new Date("2026-10-18T12:00:30.000Z").getTime(),
    });

    expect(result.valid).toBe(true);
    expect(result.status).toBe("verified");
    expect(result.code).toBe("FINGERPRINT_VERIFIED");
  });

  it("rejects expired quotes with STALE_QUOTE", () => {
    const assumptions = makeMockAssumptions({
      quotedAt: "2026-10-18T12:00:00.000Z",
      expiresAt: "2026-10-18T12:01:00.000Z",
    });
    const { fingerprint } = computeQuoteAssumptionFingerprint(assumptions);

    const result = verifyQuoteAssumptionFingerprint(assumptions, fingerprint, {
      nowMs: new Date("2026-10-18T12:01:05.000Z").getTime(),
    });

    expect(result.valid).toBe(false);
    expect(result.status).toBe("expired");
    expect(result.code).toBe("STALE_QUOTE");
    expect(result.message).toContain("Quote has expired");
  });

  it("detects parameter drift when claimed fingerprint does not match", () => {
    const assumptions = makeMockAssumptions({
      minAmountOutStroops: "99000000",
    });
    const tampered = makeMockAssumptions({
      minAmountOutStroops: "80000000", // altered min output
    });
    const { fingerprint: originalFp } = computeQuoteAssumptionFingerprint(assumptions);

    const result = verifyQuoteAssumptionFingerprint(tampered, originalFp, {
      nowMs: new Date("2026-10-18T12:00:10.000Z").getTime(),
    });

    expect(result.valid).toBe(false);
    expect(result.status).toBe("drifted");
    expect(result.code).toBe("ASSUMPTION_DRIFT");
    expect(result.driftReasons).toBeDefined();
  });

  it("rejects missing fingerprint with INVALID_FINGERPRINT", () => {
    const assumptions = makeMockAssumptions();
    const result = verifyQuoteAssumptionFingerprint(assumptions, "");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_FINGERPRINT");
  });

  it("rejects excessive slippage tolerance > 15%", () => {
    const dangerousAssumptions = makeMockAssumptions({
      slippageTolerancePct: 16,
    });
    const { fingerprint } = computeQuoteAssumptionFingerprint(dangerousAssumptions);

    const result = verifyQuoteAssumptionFingerprint(dangerousAssumptions, fingerprint, {
      nowMs: new Date("2026-10-18T12:00:10.000Z").getTime(),
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe("SLIPPAGE_EXCEEDED");
  });
});

describe("detectAssumptionDrift", () => {
  it("reports no drift when assumptions match", () => {
    const a1 = makeMockAssumptions();
    const a2 = makeMockAssumptions();
    const res = detectAssumptionDrift(a1, a2);
    expect(res.hasDrift).toBe(false);
    expect(res.differences).toHaveLength(0);
  });

  it("enumerates specific field discrepancies", () => {
    const a1 = makeMockAssumptions({
      amountInStroops: "100",
      slippageTolerancePct: 0.5,
    });
    const a2 = makeMockAssumptions({
      amountInStroops: "200",
      slippageTolerancePct: 1.0,
    });
    const res = detectAssumptionDrift(a1, a2);
    expect(res.hasDrift).toBe(true);
    expect(res.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Input amount changed"),
        expect.stringContaining("Slippage tolerance changed"),
      ]),
    );
  });
});
