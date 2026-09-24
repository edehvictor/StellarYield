import {
  reconcileRewardsAccrual,
  type RewardsHistoryTransaction,
} from "../rewardsAccrualReconciliation";

const WALLET = "GTESTWALLET123456789";

function harvestTx(
  overrides: Partial<RewardsHistoryTransaction> = {},
): RewardsHistoryTransaction {
  return {
    txHash: "tx-" + Math.random().toString(36).slice(2, 10),
    walletAddress: WALLET,
    action: "HARVEST",
    amount: 100,
    timestamp: new Date("2026-06-15T00:00:00.000Z"),
    ...overrides,
  };
}

const PERIOD = {
  start: new Date("2026-06-01T00:00:00.000Z"),
  end: new Date("2026-06-30T23:59:59.999Z"),
};

describe("reconcileRewardsAccrual", () => {
  it("reports no discrepancy when accrued rewards match transaction history", () => {
    const transactions: RewardsHistoryTransaction[] = [
      harvestTx({ amount: 100 }),
      harvestTx({ amount: 250 }),
    ];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 350,
      transactions,
      period: PERIOD,
    });

    expect(result.discrepancyType).toBe("none");
    expect(result.hasDiscrepancy).toBe(false);
    expect(result.recordedRewards).toBe(350);
    expect(result.delta).toBe(0);
    expect(result.deltaPct).toBe(0);
    expect(result.matchedTransactionCount).toBe(2);
  });

  it("flags over-accrual when accrued rewards exceed transaction history", () => {
    const transactions: RewardsHistoryTransaction[] = [harvestTx({ amount: 100 })];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 500,
      transactions,
      period: PERIOD,
    });

    expect(result.discrepancyType).toBe("over_accrual");
    expect(result.hasDiscrepancy).toBe(true);
    expect(result.recordedRewards).toBe(100);
    expect(result.delta).toBe(400);
  });

  it("flags under-accrual when accrued rewards fall short of transaction history", () => {
    const transactions: RewardsHistoryTransaction[] = [
      harvestTx({ amount: 300 }),
      harvestTx({ amount: 300 }),
    ];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 200,
      transactions,
      period: PERIOD,
    });

    expect(result.discrepancyType).toBe("under_accrual");
    expect(result.hasDiscrepancy).toBe(true);
    expect(result.recordedRewards).toBe(600);
    expect(result.delta).toBe(-400);
  });

  it("uses the reward field over amount when present, matching PnLTransaction semantics", () => {
    const transactions: RewardsHistoryTransaction[] = [
      harvestTx({ amount: 1000, reward: 75 }),
    ];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 75,
      transactions,
      period: PERIOD,
    });

    expect(result.discrepancyType).toBe("none");
    expect(result.recordedRewards).toBe(75);
  });

  it("ignores non-HARVEST transactions", () => {
    const transactions: RewardsHistoryTransaction[] = [
      harvestTx({ amount: 100 }),
      harvestTx({ action: "DEPOSIT", amount: 5000 }),
      harvestTx({ action: "WITHDRAW", amount: 2000 }),
    ];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 100,
      transactions,
      period: PERIOD,
    });

    expect(result.recordedRewards).toBe(100);
    expect(result.matchedTransactionCount).toBe(1);
    expect(result.discrepancyType).toBe("none");
  });

  it("ignores transactions outside the period and for other wallets", () => {
    const transactions: RewardsHistoryTransaction[] = [
      harvestTx({ amount: 100 }),
      harvestTx({ amount: 999, timestamp: new Date("2026-05-31T23:59:59.000Z") }),
      harvestTx({ amount: 999, timestamp: new Date("2026-07-01T00:00:00.000Z") }),
      harvestTx({ amount: 999, walletAddress: "GOTHERWALLET" }),
    ];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 100,
      transactions,
      period: PERIOD,
    });

    expect(result.recordedRewards).toBe(100);
    expect(result.matchedTransactionCount).toBe(1);
    expect(result.discrepancyType).toBe("none");
  });

  it("treats a difference within tolerance as no discrepancy (rounding noise)", () => {
    const transactions: RewardsHistoryTransaction[] = [harvestTx({ amount: 1000 })];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 1000.00005, // well within the default 0.01% tolerance
      transactions,
      period: PERIOD,
    });

    expect(result.discrepancyType).toBe("none");
    expect(result.hasDiscrepancy).toBe(false);
  });

  it("respects a custom tolerance", () => {
    const transactions: RewardsHistoryTransaction[] = [harvestTx({ amount: 1000 })];

    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 1010, // 1% over
      transactions,
      period: PERIOD,
      tolerance: 0.02, // 2% tolerance swallows a 1% delta
    });

    expect(result.discrepancyType).toBe("none");
    expect(result.hasDiscrepancy).toBe(false);
  });

  it("handles the zero/zero case without dividing by zero", () => {
    const result = reconcileRewardsAccrual({
      walletAddress: WALLET,
      accruedRewards: 0,
      transactions: [],
      period: PERIOD,
    });

    expect(result.discrepancyType).toBe("none");
    expect(result.deltaPct).toBe(0);
    expect(result.recordedRewards).toBe(0);
  });
});
