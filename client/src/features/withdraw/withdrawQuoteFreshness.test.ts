import { describe, it, expect } from "vitest";
import {
  WITHDRAW_QUOTE_TTL_MS,
  isWithdrawQuoteStale,
  withdrawQuoteAgeSeconds,
} from "./withdrawQuoteFreshness";

describe("isWithdrawQuoteStale (#1308)", () => {
  it("returns false before expiresAt", () => {
    const now = 1_700_000_000_000;
    const quote = {
      quotedAt: new Date(now - 30_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    };
    expect(isWithdrawQuoteStale(quote, now)).toBe(false);
  });

  it("returns true after expiresAt", () => {
    const expiresAt = 1_700_000_000_000;
    const quote = {
      quotedAt: new Date(expiresAt - 60_000).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    expect(isWithdrawQuoteStale(quote, expiresAt)).toBe(false);
    expect(isWithdrawQuoteStale(quote, expiresAt + 1)).toBe(true);
  });

  it("falls back to quotedAt + TTL when expiresAt is missing", () => {
    const quotedAt = 1_700_000_000_000;
    const quote = { quotedAt: new Date(quotedAt).toISOString() };
    expect(isWithdrawQuoteStale(quote, quotedAt + WITHDRAW_QUOTE_TTL_MS)).toBe(
      false,
    );
    expect(
      isWithdrawQuoteStale(quote, quotedAt + WITHDRAW_QUOTE_TTL_MS + 1),
    ).toBe(true);
  });
});

describe("withdrawQuoteAgeSeconds (#1308)", () => {
  it("returns zero at quote time", () => {
    const now = 1_700_000_000_000;
    expect(withdrawQuoteAgeSeconds(new Date(now).toISOString(), now)).toBe(0);
  });
});
