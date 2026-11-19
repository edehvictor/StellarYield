import { describe, expect, it } from "vitest";
import { MIN_ANNUAL_APY_PCT, parseApyInput, parseApyRows } from "./rebalanceBacktestInputs";

describe("parseApyInput", () => {
  it.each([
    ["8", 8],
    ["12.5", 12.5],
    ["-5", -5],
    ["-0.75", -0.75],
    [" -2 ", -2],
    [".5", 0.5],
    ["-.5", -0.5],
    ["−3", -3], // Unicode minus, as pasted from spreadsheets
    ["0", 0],
    ["", 0],
    ["   ", 0],
    [String(MIN_ANNUAL_APY_PCT), MIN_ANNUAL_APY_PCT],
  ])("parses %p as %p", (text, expected) => {
    expect(parseApyInput(text)).toEqual({ ok: true, value: expected });
  });

  it("rejects a value below the annual floor", () => {
    const result = parseApyInput("-100.01");

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("-100%");
  });

  it.each(["abc", "-", "--5", "5-", "1e3", "1,5", "NaN", "Infinity", "0x10", "5%", "1.2.3"])(
    "rejects the malformed input %p",
    (text) => {
      expect(parseApyInput(text)).toMatchObject({ ok: false, error: expect.stringContaining("Enter a number") });
    },
  );

  it("treats a lone minus as incomplete rather than as zero", () => {
    expect(parseApyInput("-").ok).toBe(false);
  });
});

describe("parseApyRows", () => {
  it("parses every row in order", () => {
    expect(
      parseApyRows([
        { label: "A", apyText: "8" },
        { label: "B", apyText: "-3" },
        { label: "C", apyText: "" },
      ]),
    ).toEqual({ ok: true, values: [8, -3, 0] });
  });

  it("names the first invalid row by its label", () => {
    const result = parseApyRows([
      { label: "Good", apyText: "5" },
      { label: "Bad pool", apyText: "-500" },
      { label: "Worse", apyText: "abc" },
    ]);

    expect(result).toMatchObject({ ok: false, rowIndex: 1 });
    expect((result as { error: string }).error).toMatch(/^Bad pool: APY cannot be below -100%/);
  });

  it("falls back to a positional name for an unlabelled row", () => {
    const result = parseApyRows([{ label: "  ", apyText: "x" }]);

    expect((result as { error: string }).error).toMatch(/^Allocation 1:/);
  });
});
