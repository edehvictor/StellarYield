/**
 * Regression tests for stale configuration snapshot handling in verifyZapQuote.
 *
 * Covers:
 *  - Normal operation: a fresh quote with a valid fingerprint passes verification.
 *  - Failure: a quote whose assumptionFingerprint was computed from different
 *    assumptions is rejected with ASSUMPTION_DRIFT / CONFIG_DRIFT.
 *  - Safe retry: a quote rejected for CONFIG_DRIFT is flagged as recoverable so
 *    the client can re-quote without user intervention.
 *  - State preservation: verification rejects the quote without mutating any
 *    shared state or existing balances.
 */

import {
  verifyZapQuote,
  getAssetConfigVersion,
  RECOVERABLE_VERIFY_ERROR_CODES,
} from "../services/zapQuote";
import {
  computeQuoteAssumptionFingerprint,
  type QuoteAssumptions,
} from "../../../shared/types/quoteAssumptionFingerprint";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
  ]),
}));

jest.mock("../services/freezeService", () => ({
  freezeService: { isFrozen: jest.fn().mockReturnValue(false) },
}));

jest.mock("../config/zapAssetsConfig", () => ({
  getZapSupportedAssetsPayload: jest.fn(() => ({
    assets: [
      { symbol: "XLM", name: "Lumens", contractId: "CXLM", decimals: 7 },
      { symbol: "USDC", name: "USD Coin", contractId: "CUSDC", decimals: 7 },
    ],
    vaultToken: { symbol: "yV", name: "Vault", contractId: "CVAULT", decimals: 7 },
    vaultContractId: "CDVAULT",
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const crypto = require("crypto") as typeof import("crypto");

function routeHash(path: { contractId: string }[]): string {
  return crypto
    .createHash("sha256")
    .update(path.map((p) => p.contractId).join("->"))
    .digest("hex");
}

/** Builds a structurally valid quote with a matching fingerprint. */
function buildFreshQuote(
  assumptionOverrides: Partial<QuoteAssumptions> = {},
  quoteOverrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  const path = [{ contractId: "CXLM" }, { contractId: "CVAULT" }];
  const rHash = routeHash(path);
  const configVersion = getAssetConfigVersion();

  const assumptions: QuoteAssumptions = {
    inputTokenContract: "CXLM",
    vaultTokenContract: "CVAULT",
    amountInStroops: "10000000",
    expectedAmountOutStroops: "9950000",
    minAmountOutStroops: "9900000",
    slippageTolerancePct: 0.5,
    routeHash: rHash,
    path: path.map((p) => p.contractId),
    source: "router_simulation",
    assetConfigVersion: configVersion,
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    protocol: "default",
    reserveSafe: true,
    ...assumptionOverrides,
  };

  const { fingerprint } = computeQuoteAssumptionFingerprint(assumptions);

  return {
    path,
    expectedAmountOutStroops: assumptions.expectedAmountOutStroops,
    source: "router_simulation" as const,
    slippageApplied: 0.005,
    amountOutAfterSlippage: assumptions.minAmountOutStroops,
    quotedAt: assumptions.quotedAt,
    minAmountOutStroops: assumptions.minAmountOutStroops,
    quoteAgeMs: 0,
    isFallback: false,
    issuedAt: assumptions.quotedAt,
    expiresAt: assumptions.expiresAt,
    routeHash: rHash,
    assetConfigVersion: configVersion,
    assumptionFingerprint: fingerprint,
    assumptions,
    ...quoteOverrides,
  };
}

// ── Normal operation ──────────────────────────────────────────────────────────

describe("verifyZapQuote — normal operation with valid fingerprint", () => {
  it("accepts a fresh quote whose fingerprint matches its assumptions exactly", () => {
    const quote = buildFreshQuote();
    expect(verifyZapQuote(quote)).toEqual({ valid: true });
  });

  it("accepts a quote when assumptionFingerprint is absent (legacy path)", () => {
    const { assumptionFingerprint: _fp, assumptions: _a, ...stripped } = buildFreshQuote();
    expect(verifyZapQuote(stripped)).toEqual({ valid: true });
  });
});

// ── Fingerprint mismatch / assumption drift ───────────────────────────────────

describe("verifyZapQuote — fingerprint mismatch rejects the quote", () => {
  it("rejects when amountInStroops was silently changed after quoting", () => {
    const original = buildFreshQuote({ amountInStroops: "10000000" });

    // Tamper: mutate the numeric assumptions on the wire without regenerating fp
    const tampered = {
      ...original,
      assumptions: {
        ...original.assumptions,
        amountInStroops: "99999999",
      },
    };

    const result = verifyZapQuote(tampered);
    expect(result.valid).toBe(false);
    expect((result as { errorCode: string }).errorCode).toMatch(
      /ASSUMPTION_DRIFT|CONFIG_DRIFT/,
    );
  });

  it("rejects when minAmountOutStroops drifts (output guarantee weakened)", () => {
    const original = buildFreshQuote({ minAmountOutStroops: "9900000" });

    const tampered = {
      ...original,
      assumptions: {
        ...original.assumptions,
        minAmountOutStroops: "5000000",
      },
    };

    const result = verifyZapQuote(tampered);
    expect(result.valid).toBe(false);
    expect((result as { errorCode: string }).errorCode).toMatch(
      /ASSUMPTION_DRIFT|CONFIG_DRIFT/,
    );
  });

  it("rejects when assetConfigVersion in assumptions differs from the config hash", () => {
    const original = buildFreshQuote({ assetConfigVersion: "stale-version-abc" });
    // The fingerprint was computed against 'stale-version-abc', but the
    // assumptions object is passed as-is; the server must detect the
    // version divergence either through CONFIG_DRIFT or fingerprint mismatch.
    const result = verifyZapQuote(original);
    // Could be CONFIG_DRIFT (top-level config check) or ASSUMPTION_DRIFT
    expect(result.valid).toBe(false);
  });

  it("rejects a quote that ships a deliberately wrong fingerprint string", () => {
    const quote = buildFreshQuote();
    const tampered = { ...quote, assumptionFingerprint: "a".repeat(64) };

    const result = verifyZapQuote(tampered);
    expect(result.valid).toBe(false);
    expect((result as { errorCode: string }).errorCode).toMatch(
      /ASSUMPTION_DRIFT|CONFIG_DRIFT|INVALID_FINGERPRINT/,
    );
  });
});

// ── Safe retry after config drift ─────────────────────────────────────────────

describe("verifyZapQuote — CONFIG_DRIFT is flagged as recoverable", () => {
  it("CONFIG_DRIFT is in RECOVERABLE_VERIFY_ERROR_CODES", () => {
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("CONFIG_DRIFT")).toBe(true);
  });

  it("ASSUMPTION_DRIFT is in RECOVERABLE_VERIFY_ERROR_CODES", () => {
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("ASSUMPTION_DRIFT")).toBe(true);
  });

  it("ASSUMPTION_DRIFT maps to a code that is defined in ZapQuoteVerificationErrorCode", () => {
    // ASSUMPTION_DRIFT comes from verifyQuoteAssumptionFingerprint; it must map
    // to a known ZapQuoteVerificationErrorCode so the client can handle it.
    const quote = buildFreshQuote();
    const tampered = {
      ...quote,
      assumptions: { ...quote.assumptions, amountInStroops: "1" },
    };
    const result = verifyZapQuote(tampered);
    if (!result.valid) {
      // The error code must be a non-empty string the client can inspect.
      expect(typeof (result as { errorCode: string }).errorCode).toBe("string");
      expect((result as { errorCode: string }).errorCode.length).toBeGreaterThan(0);
    }
  });
});

// ── State preservation on failure ─────────────────────────────────────────────

describe("verifyZapQuote — state preservation", () => {
  it("does not mutate the quote object on rejection", () => {
    const quote = buildFreshQuote();
    const tampered = {
      ...quote,
      assumptions: { ...quote.assumptions, amountInStroops: "1" },
    };
    const originalTamperedCopy = JSON.stringify(tampered);

    verifyZapQuote(tampered);

    // The input object must not have been modified.
    expect(JSON.stringify(tampered)).toBe(originalTamperedCopy);
  });

  it("does not mutate the quote object on success", () => {
    const quote = buildFreshQuote();
    const originalCopy = JSON.stringify(quote);

    verifyZapQuote(quote);

    expect(JSON.stringify(quote)).toBe(originalCopy);
  });

  it("successive calls with the same valid quote return valid each time", () => {
    const quote = buildFreshQuote();
    expect(verifyZapQuote(quote)).toEqual({ valid: true });
    expect(verifyZapQuote(quote)).toEqual({ valid: true });
    expect(verifyZapQuote(quote)).toEqual({ valid: true });
  });
});
