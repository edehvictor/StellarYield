import {
  I128_MAX,
  StroopsMathError,
  applySlippageFloor,
  mulDivFloor,
  parseStroopsAmount,
  sanitizeSlippageFraction,
} from "../services/stroopsMath";
import { getZapQuote } from "../services/zapQuote";
import { validateZapQuote } from "../middleware/validation";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([{ protocolName: "default", tvl: 10_000_000 }]),
}));
jest.mock("../services/freezeService", () => ({
  freezeService: { isFrozen: jest.fn().mockReturnValue(false) },
}));

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof StroopsMathError ? e.code : "OTHER";
  }
  return undefined;
};

describe("parseStroopsAmount (checked parsing)", () => {
  it("accepts the minimum (1) and maximum (i128 max)", () => {
    expect(parseStroopsAmount("1")).toBe(BigInt(1));
    expect(parseStroopsAmount(I128_MAX.toString())).toBe(I128_MAX);
  });

  it("rejects zero", () => {
    expect(code(() => parseStroopsAmount("0"))).toBe("AMOUNT_NOT_POSITIVE");
    expect(code(() => parseStroopsAmount("000"))).toBe("AMOUNT_NOT_POSITIVE");
  });

  it("rejects one above the maximum", () => {
    expect(code(() => parseStroopsAmount((I128_MAX + BigInt(1)).toString()))).toBe("AMOUNT_OVERFLOW");
  });

  it.each(["-1", "1.5", "1e3", " 1", "1 ", "", "0x10", "+5", "abc"])(
    "rejects malformed input %p",
    (raw) => {
      expect(code(() => parseStroopsAmount(raw))).toBe("INVALID_AMOUNT");
    },
  );

  it("rejects non-strings", () => {
    expect(code(() => parseStroopsAmount(5))).toBe("INVALID_AMOUNT");
    expect(code(() => parseStroopsAmount(null))).toBe("INVALID_AMOUNT");
  });
});

describe("applySlippageFloor (documented rounding)", () => {
  it("is zero at zero", () => {
    expect(applySlippageFloor(BigInt(0), 0.05)).toBe(BigInt(0));
  });

  it("does not lose a unit to float noise (1 - 0.07 === 0.9299999999999999)", () => {
    // Legacy Math.floor((1 - 0.07) * 10000) gave 9299 -> 9299 here would be wrong.
    expect(applySlippageFloor(BigInt(10_000), 0.07)).toBe(BigInt(9_300));
  });

  it("rounds the minimum output down", () => {
    // 3 * 0.995 = 2.985 -> 2
    expect(applySlippageFloor(BigInt(3), 0.005)).toBe(BigInt(2));
    // 1 stroop at 0.1% slippage -> 0 (never rounds up in the user's favour)
    expect(applySlippageFloor(BigInt(1), 0.001)).toBe(BigInt(0));
  });

  it("handles 0% and 100% slippage", () => {
    expect(applySlippageFloor(BigInt(12345), 0)).toBe(BigInt(12345));
    expect(applySlippageFloor(BigInt(12345), 1)).toBe(BigInt(0));
  });

  it("is exact at i128 max (no precision loss)", () => {
    expect(applySlippageFloor(I128_MAX, 0)).toBe(I128_MAX);
    const out = applySlippageFloor(I128_MAX, 0.005);
    expect(out).toBe((I128_MAX * BigInt(995_000)) / BigInt(1_000_000));
    expect(out <= I128_MAX).toBe(true);
  });

  it("never exceeds the expected output, for any clamped slippage", () => {
    for (const s of [-1, 0, 1e-9, 0.001, 0.15, 0.9999999, 1, 5, NaN, Infinity]) {
      const out = applySlippageFloor(BigInt(1_000_000), sanitizeSlippageFraction(s, 0));
      expect(out >= BigInt(0) && out <= BigInt(1_000_000)).toBe(true);
    }
  });

  it("rejects negative or oversized expected output", () => {
    expect(code(() => applySlippageFloor(BigInt(-1), 0.01))).toBe("INVALID_AMOUNT");
    expect(code(() => applySlippageFloor(I128_MAX + BigInt(1), 0.01))).toBe("AMOUNT_OVERFLOW");
  });
});

describe("mulDivFloor", () => {
  it("returns null on zero denominator rather than dividing by zero", () => {
    expect(mulDivFloor(BigInt(10), BigInt(1), BigInt(0))).toBeNull();
  });
  it("floors", () => {
    expect(mulDivFloor(BigInt(10), BigInt(1), BigInt(3))).toBe(BigInt(3));
  });
  it("throws when the product exceeds i128", () => {
    expect(code(() => mulDivFloor(I128_MAX, BigInt(2), BigInt(1)))).toBe("AMOUNT_OVERFLOW");
  });
});

describe("getZapQuote boundary behaviour", () => {
  const base = {
    inputTokenContract: "SAME",
    vaultTokenContract: "SAME",
    inputDecimals: 7,
    vaultDecimals: 7,
  };

  beforeEach(() => {
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  });

  it("rejects a zero amount", async () => {
    await expect(getZapQuote({ ...base, amountInStroops: "0" })).rejects.toThrow(/greater than zero/);
  });

  it("rejects a negative amount", async () => {
    await expect(getZapQuote({ ...base, amountInStroops: "-5" })).rejects.toThrow(/non-negative integer/);
  });

  it("rejects an amount above i128 max", async () => {
    await expect(
      getZapQuote({ ...base, amountInStroops: (I128_MAX + BigInt(1)).toString() }),
    ).rejects.toThrow(/maximum/);
  });

  it("minimum amount (1 stroop) never yields a min-out above the expected out", async () => {
    const q = await getZapQuote({ ...base, amountInStroops: "1", slippageTolerance: 0.005 });
    expect(BigInt(q.minAmountOutStroops) <= BigInt(q.expectedAmountOutStroops)).toBe(true);
    expect(q.minAmountOutStroops).toBe(q.amountOutAfterSlippage);
  });

  it("falls back to model slippage when tolerance is NaN (no NaN in output)", async () => {
    const q = await getZapQuote({ ...base, amountInStroops: "1000000", slippageTolerance: NaN });
    expect(Number.isFinite(q.slippageApplied)).toBe(true);
    expect(q.minAmountOutStroops).toMatch(/^\d+$/);
  });

  it("clamps oversized tolerance to 15%", async () => {
    const q = await getZapQuote({ ...base, amountInStroops: "1000000", slippageTolerance: 9 });
    expect(q.slippageApplied).toBeLessThanOrEqual(0.15 + 1e-12);
  });

  it("safe retry: a failed quote does not affect a later valid quote, and results are deterministic", async () => {
    await expect(getZapQuote({ ...base, amountInStroops: "0" })).rejects.toThrow();
    const a = await getZapQuote({ ...base, amountInStroops: "1000000", slippageTolerance: 0.01 });
    const b = await getZapQuote({ ...base, amountInStroops: "1000000", slippageTolerance: 0.01 });
    expect(a.minAmountOutStroops).toBe(b.minAmountOutStroops);
    expect(a.expectedAmountOutStroops).toBe("1000000");
    // 1_000_000 * (1 - s) == 1_000_000 - s * 1e6 exactly, with s rounded to 1e-6.
    expect(a.minAmountOutStroops).toBe(String(1_000_000 - Math.round(a.slippageApplied * 1_000_000)));
  });
});

describe("validateZapQuote middleware", () => {
  const run = (body: Record<string, unknown>) => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    const next = jest.fn();
    validateZapQuote({ body } as never, res as never, next);
    return { res, next };
  };
  const ok = { inputTokenContract: "A", vaultTokenContract: "B" };

  it("passes a valid amount", () => {
    const { next } = run({ ...ok, amountInStroops: "1" });
    expect(next).toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", (I128_MAX + BigInt(1)).toString()])("rejects amount %p with 400", (amt) => {
    const { res, next } = run({ ...ok, amountInStroops: amt });
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects non-finite slippage tolerance with 400", () => {
    for (const s of [NaN, Infinity, "abc", "", null, {}]) {
      const { res, next } = run({ ...ok, amountInStroops: "5", slippageTolerance: s });
      expect(res.statusCode).toBe(400);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("accepts numeric slippage (number or numeric string)", () => {
    expect(run({ ...ok, amountInStroops: "5", slippageTolerance: 0.01 }).next).toHaveBeenCalled();
    expect(run({ ...ok, amountInStroops: "5", slippageTolerance: "0.01" }).next).toHaveBeenCalled();
  });
});
