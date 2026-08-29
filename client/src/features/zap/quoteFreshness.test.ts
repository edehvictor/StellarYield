import { describe, it, expect } from "vitest";
import {
  ZAP_QUOTE_TTL_MS,
  buildZapQuoteRequestKey,
  isZapQuoteExpired,
  quoteAgeSeconds,
  recalculateMinOut,
} from "./quoteFreshness";
import { minAmountAfterSlippage } from "./slippage";

describe("isZapQuoteExpired", () => {
  it("returns false before expiresAt", () => {
    const now = 1_700_000_000_000;
    const quote = {
      quotedAt: new Date(now - 30_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    };
    expect(isZapQuoteExpired(quote, now)).toBe(false);
  });

  it("returns true one millisecond after expiresAt", () => {
    const expiresAt = 1_700_000_000_000;
    const quote = {
      quotedAt: new Date(expiresAt - 60_000).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    expect(isZapQuoteExpired(quote, expiresAt)).toBe(false);
    expect(isZapQuoteExpired(quote, expiresAt + 1)).toBe(true);
  });

  it("falls back to quotedAt + TTL when expiresAt is missing", () => {
    const quotedAt = 1_700_000_000_000;
    const quote = { quotedAt: new Date(quotedAt).toISOString() };
    expect(isZapQuoteExpired(quote, quotedAt + ZAP_QUOTE_TTL_MS)).toBe(false);
    expect(isZapQuoteExpired(quote, quotedAt + ZAP_QUOTE_TTL_MS + 1)).toBe(true);
  });
});

describe("buildZapQuoteRequestKey", () => {
  it("changes when source asset changes", () => {
    const base = {
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "1000000",
      slippageTolerance: 0.5,
    };
    const xlmKey = buildZapQuoteRequestKey(base);
    const usdcKey = buildZapQuoteRequestKey({ ...base, inputTokenContract: "CUSDC" });
    expect(xlmKey).not.toBe(usdcKey);
  });

  it("changes when slippage tolerance changes", () => {
    const base = {
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "1000000",
      slippageTolerance: 0.5,
    };
    expect(buildZapQuoteRequestKey(base)).not.toBe(
      buildZapQuoteRequestKey({ ...base, slippageTolerance: 1.0 }),
    );
  });
});

describe("recalculateMinOut", () => {
  it("recomputes min output when slippage changes", () => {
    const expectedOut = 10_000_000n;
    const atHalf = recalculateMinOut(expectedOut, 0.5, minAmountAfterSlippage);
    const atOne = recalculateMinOut(expectedOut, 1.0, minAmountAfterSlippage);
    expect(atHalf).not.toBeNull();
    expect(atOne).not.toBeNull();
    expect(atOne!).toBeLessThan(atHalf!);
  });
});

describe("quoteAgeSeconds", () => {
  it("returns zero at quote time", () => {
    const now = 1_700_000_000_000;
    expect(quoteAgeSeconds(new Date(now).toISOString(), now)).toBe(0);
  });
});
