import { describe, it, expect } from "vitest";
import { canSubmit, unavailableLegs, formatUsdc, type UnwindQuote } from "./unwindPreview";

function makeQuote(overrides: Partial<UnwindQuote> = {}): UnwindQuote {
  return {
    depositor: "GDEPOSITOR",
    legs: [
      { leg: "spot", status: "quoted", expectedOutputUsdc: "10000000" },
      { leg: "perp", status: "quoted", expectedOutputUsdc: "5000000" },
    ],
    totalExpectedUsdc: "15000000",
    canExecute: true,
    riskNotes: [],
    isEstimate: true,
    quotedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("canSubmit", () => {
  it("returns false for a null quote", () => {
    expect(canSubmit(null)).toBe(false);
  });

  it("returns true when canExecute is true and every leg is quoted (complete)", () => {
    expect(canSubmit(makeQuote())).toBe(true);
  });

  it("returns false when canExecute is false (unavailable/partial)", () => {
    expect(canSubmit(makeQuote({ canExecute: false }))).toBe(false);
  });

  it("returns false when any leg is unavailable even if canExecute were true", () => {
    const quote = makeQuote({
      legs: [
        { leg: "spot", status: "unavailable", reason: "Price oracle unreachable." },
        { leg: "perp", status: "quoted", expectedOutputUsdc: "5000000" },
      ],
    });
    expect(canSubmit(quote)).toBe(false);
  });
});

describe("unavailableLegs", () => {
  it("names the specific unavailable leg", () => {
    const quote = makeQuote({
      canExecute: false,
      legs: [
        { leg: "spot", status: "unavailable", reason: "Price oracle unreachable." },
        { leg: "perp", status: "quoted", expectedOutputUsdc: "5000000" },
      ],
    });
    const unavailable = unavailableLegs(quote);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].leg).toBe("spot");
    expect(unavailable[0].reason).toBe("Price oracle unreachable.");
  });

  it("returns an empty array for a fully quoted preview", () => {
    expect(unavailableLegs(makeQuote())).toEqual([]);
  });
});

describe("formatUsdc", () => {
  it("formats a raw 7-decimal USDC amount as a dollar string", () => {
    expect(formatUsdc("10000000")).toBe("$1.00");
    expect(formatUsdc("15500000")).toBe("$1.55");
  });

  it("returns an em dash for undefined", () => {
    expect(formatUsdc(undefined)).toBe("—");
  });
});
