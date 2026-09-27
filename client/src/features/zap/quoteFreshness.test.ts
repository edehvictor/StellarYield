import { describe, it, expect } from "vitest";
import {
  ZAP_QUOTE_TTL_MS,
  ZAP_QUOTE_EXPIRED_MESSAGE,
  buildZapQuoteRequestKey,
  evaluateZapQuoteInvalidation,
  isZapQuoteExpired,
  quoteAgeSeconds,
  recalculateMinOut,
  zapQuoteDeadlineSeconds,
} from "./quoteFreshness";
import { minAmountAfterSlippage } from "./slippage";

describe("evaluateZapQuoteInvalidation", () => {
  const now = 1_700_000_000_000;

  it("reports a fresh quote as valid with remaining time", () => {
    const quote = {
      quotedAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 50_000).toISOString(),
    };
    const result = evaluateZapQuoteInvalidation(quote, now);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.remainingMs).toBe(50_000);
      expect(result.ageMs).toBe(10_000);
    }
  });

  it("invalidates one millisecond after expiresAt with expiredForMs", () => {
    const quote = {
      quotedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now).toISOString(),
    };
    expect(evaluateZapQuoteInvalidation(quote, now).status).toBe("valid");
    const expired = evaluateZapQuoteInvalidation(quote, now + 1);
    expect(expired.status).toBe("expired");
    if (expired.status === "expired") {
      expect(expired.expiredForMs).toBe(1);
    }
  });

  it("falls back to quotedAt + TTL when expiresAt is missing", () => {
    const quote = { quotedAt: new Date(now).toISOString() };
    expect(evaluateZapQuoteInvalidation(quote, now + ZAP_QUOTE_TTL_MS).status).toBe("valid");
    expect(
      evaluateZapQuoteInvalidation(quote, now + ZAP_QUOTE_TTL_MS + 1).status,
    ).toBe("expired");
  });

  it("falls back to quotedAt + TTL when expiresAt is unparseable", () => {
    const quote = {
      quotedAt: new Date(now).toISOString(),
      expiresAt: "not-a-timestamp",
    };
    expect(evaluateZapQuoteInvalidation(quote, now + ZAP_QUOTE_TTL_MS).status).toBe("valid");
    expect(
      evaluateZapQuoteInvalidation(quote, now + ZAP_QUOTE_TTL_MS + 1).status,
    ).toBe("expired");
  });

  it("fails closed when quotedAt itself is unparseable", () => {
    const result = evaluateZapQuoteInvalidation(
      { quotedAt: "not-a-timestamp" },
      now,
    );
    expect(result.status).toBe("expired");
  });

  it("isZapQuoteExpired agrees with the typed evaluation", () => {
    const quote = {
      quotedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now).toISOString(),
    };
    expect(isZapQuoteExpired(quote, now)).toBe(false);
    expect(isZapQuoteExpired(quote, now + 1)).toBe(true);
  });
});

describe("ZAP_QUOTE_EXPIRED_MESSAGE", () => {
  it("is the deterministic user-facing expiry copy", () => {
    expect(ZAP_QUOTE_EXPIRED_MESSAGE).toBe("Quote expired. Refresh and try again.");
  });
});

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

describe("zapQuoteDeadlineSeconds", () => {
  const NOW = Date.parse("2026-09-24T12:00:00.000Z");

  it("uses expiresAt, floored to whole seconds", () => {
    expect(
      zapQuoteDeadlineSeconds({ quotedAt: "2026-09-24T12:00:00.000Z", expiresAt: "2026-09-24T12:01:00.999Z" }, NOW),
    ).toBe(BigInt(Math.floor(Date.parse("2026-09-24T12:01:00.000Z") / 1000)));
  });

  it("falls back to quotedAt + TTL when expiresAt is missing or unparseable", () => {
    const expected = BigInt((Date.parse("2026-09-24T11:59:30.000Z") + ZAP_QUOTE_TTL_MS) / 1000);
    expect(zapQuoteDeadlineSeconds({ quotedAt: "2026-09-24T11:59:30.000Z" }, NOW)).toBe(expected);
    expect(
      zapQuoteDeadlineSeconds({ quotedAt: "2026-09-24T11:59:30.000Z", expiresAt: "garbage" }, NOW),
    ).toBe(expected);
  });

  it("falls back to now + TTL without a usable quote", () => {
    const expected = BigInt((NOW + ZAP_QUOTE_TTL_MS) / 1000);
    expect(zapQuoteDeadlineSeconds(null, NOW)).toBe(expected);
    expect(zapQuoteDeadlineSeconds({ quotedAt: "garbage" }, NOW)).toBe(expected);
  });

  it("never exceeds the preview's own expiry instant", () => {
    const quote = { quotedAt: "2026-09-24T12:00:00.000Z", expiresAt: "2026-09-24T12:01:00.400Z" };
    const deadlineMs = Number(zapQuoteDeadlineSeconds(quote, NOW)) * 1000;
    expect(evaluateZapQuoteInvalidation(quote, deadlineMs).status).toBe("valid");
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
