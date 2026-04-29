import { calculateNetYield, sanitizeAssumptions } from "../services/netYieldEngine";

describe("netYieldEngine", () => {
  it("stacks protocol/vault/rebalance/slippage fees into net APY", () => {
    const result = calculateNetYield(12, {
      protocolFeeBps: 100,
      vaultFeeBps: 50,
      rebalanceCostBps: 25,
      slippageBps: 25,
    });

    expect(result.feeDragApy).toBe(0.24);
    expect(result.netApy).toBe(11.76);
  });

  it("clamps invalid assumptions and handles non-finite values", () => {
    const sanitized = sanitizeAssumptions({
      protocolFeeBps: Number.POSITIVE_INFINITY,
      vaultFeeBps: -10,
      rebalanceCostBps: 9_999,
      slippageBps: NaN,
    });

    expect(sanitized).toEqual({
      protocolFeeBps: 0,
      vaultFeeBps: 0,
      rebalanceCostBps: 3000,
      slippageBps: 0,
    });
  });

  it("returns low/medium/high sensitivity outputs", () => {
    const result = calculateNetYield(10);

    expect(result.sensitivity).toHaveLength(3);
    expect(result.sensitivity.map((item) => item.environment)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(result.sensitivity[0].netApy).toBeGreaterThan(result.sensitivity[2].netApy);
  });
});
