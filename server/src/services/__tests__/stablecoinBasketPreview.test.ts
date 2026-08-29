import {
  getBasketRebalancePreview,
  validateBasketTargetWeights,
} from "../stablecoinBasketPreview";
import { simulateReadOnlyCall } from "../sorobanReader";

jest.mock("../sorobanReader");

const mockSimulate = simulateReadOnlyCall as jest.MockedFunction<typeof simulateReadOnlyCall>;

const CONTRACT_ID = "CBASKET000000000000000000000000000000000000000000000000";
const TOKEN_A = "CTOKENA00000000000000000000000000000000000000000000000";
const TOKEN_B = "CTOKENB00000000000000000000000000000000000000000000000";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getBasketRebalancePreview", () => {
  it("returns before/after weight rows, backfilling non-drifted assets to target=current", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_state") {
        return {
          ok: true,
          value: {
            total_deposited: 1_000_000,
            asset_configs: [
              { token: TOKEN_A, weight_bps: 6000, max_concentration_bps: 8000 },
              { token: TOKEN_B, weight_bps: 4000, max_concentration_bps: 8000 },
            ],
            rebalance_threshold_bps: 500,
          },
        };
      }
      if (method === "compute_rebalance_deltas") {
        // Only TOKEN_A drifted past threshold; TOKEN_B is not returned.
        return { ok: true, value: [[TOKEN_A, 7000, 6000, -100_000]] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const preview = await getBasketRebalancePreview(CONTRACT_ID);

    expect(preview.source).toBe("onchain");
    expect(preview.rebalanceNeeded).toBe(true);
    expect(preview.legs).toHaveLength(2);

    const legA = preview.legs.find((l) => l.tokenContractId === TOKEN_A)!;
    expect(legA.currentWeightBps).toBe(7000);
    expect(legA.targetWeightBps).toBe(6000);
    expect(legA.isEstimated).toBe(false);

    const legB = preview.legs.find((l) => l.tokenContractId === TOKEN_B)!;
    expect(legB.currentWeightBps).toBe(4000);
    expect(legB.targetWeightBps).toBe(4000);
    expect(legB.driftBps).toBe(0);
    expect(legB.isEstimated).toBe(true);
  });

  it("uses a safe fallback (current=target for every asset) for an empty basket", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_state") {
        return {
          ok: true,
          value: {
            total_deposited: 0,
            asset_configs: [
              { token: TOKEN_A, weight_bps: 5000, max_concentration_bps: 8000 },
              { token: TOKEN_B, weight_bps: 5000, max_concentration_bps: 8000 },
            ],
            rebalance_threshold_bps: 500,
          },
        };
      }
      if (method === "compute_rebalance_deltas") {
        return { ok: true, value: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const preview = await getBasketRebalancePreview(CONTRACT_ID);

    expect(preview.source).toBe("onchain");
    expect(preview.rebalanceNeeded).toBe(false);
    expect(preview.legs.every((l) => l.isEstimated && l.currentWeightBps === l.targetWeightBps)).toBe(
      true,
    );
  });

  it("uses the same safe fallback when compute_rebalance_deltas returns RebalanceNotNeeded", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_state") {
        return {
          ok: true,
          value: {
            total_deposited: 1_000_000,
            asset_configs: [{ token: TOKEN_A, weight_bps: 10000, max_concentration_bps: 10000 }],
            rebalance_threshold_bps: 500,
          },
        };
      }
      if (method === "compute_rebalance_deltas") {
        return { ok: false, reason: "contract_error", message: "Error(Contract, #9)" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const preview = await getBasketRebalancePreview(CONTRACT_ID);
    expect(preview.rebalanceNeeded).toBe(false);
    expect(preview.legs[0].currentWeightBps).toBe(preview.legs[0].targetWeightBps);
  });

  it("never throws — returns an unavailable fallback when get_state cannot be read", async () => {
    mockSimulate.mockResolvedValue({ ok: false, reason: "unreachable" });

    const preview = await getBasketRebalancePreview(CONTRACT_ID);

    expect(preview.source).toBe("unavailable");
    expect(preview.legs).toEqual([]);
    expect(preview.warnings.length).toBeGreaterThan(0);
  });
});

describe("validateBasketTargetWeights", () => {
  it("passes when weights sum to exactly 10000 bps", () => {
    const errors = validateBasketTargetWeights([
      { token: TOKEN_A, weightBps: 6000 },
      { token: TOKEN_B, weightBps: 4000 },
    ]);
    expect(errors).toEqual([]);
  });

  it("fails when weights sum below 10000 bps", () => {
    const errors = validateBasketTargetWeights([
      { token: TOKEN_A, weightBps: 5000 },
      { token: TOKEN_B, weightBps: 4000 },
    ]);
    expect(errors.some((e) => /sum to 10000 bps/.test(e))).toBe(true);
  });

  it("fails when weights sum above 10000 bps", () => {
    const errors = validateBasketTargetWeights([
      { token: TOKEN_A, weightBps: 6000 },
      { token: TOKEN_B, weightBps: 5000 },
    ]);
    expect(errors.some((e) => /sum to 10000 bps/.test(e))).toBe(true);
  });

  it("fails on non-positive weights", () => {
    const errors = validateBasketTargetWeights([{ token: TOKEN_A, weightBps: 0 }]);
    expect(errors.some((e) => /positive/.test(e))).toBe(true);
  });

  it("fails on an empty weight list", () => {
    const errors = validateBasketTargetWeights([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
