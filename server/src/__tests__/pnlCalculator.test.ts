import {
  calculatePnL,
  calculateTWR,
  type UserTransaction,
  type SharePriceSnapshot,
} from "../services/pnl_engine";

// ── calculateTWR ────────────────────────────────────────────────────────

describe("calculateTWR", () => {
  it("returns 0 for empty transactions", () => {
    expect(calculateTWR([], [], 1.0)).toBe(0);
  });

  it("returns 0 for zero current price", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    expect(calculateTWR(txs, [], 0)).toBe(0);
  });

  it("calculates correct return for single deposit with appreciation", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    // Share price went from 1.0 to 1.5 (50% return)
    const twr = calculateTWR(txs, [], 1.5);
    expect(twr).toBeCloseTo(0.5, 4);
  });

  it("calculates correct return for single deposit with depreciation", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    // Share price went from 1.0 to 0.8 (-20% return)
    const twr = calculateTWR(txs, [], 0.8);
    expect(twr).toBeCloseTo(-0.2, 4);
  });

  it("eliminates cash flow effects with multiple deposits", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
      {
        action: "DEPOSIT",
        amount: 1100,
        shares: 1000,
        sharePriceAtTx: 1.1,
        timestamp: new Date("2025-02-01"),
      },
    ];
    // Period 1: 1.0 -> 1.1 = 10% return
    // Period 2: 1.1 -> 1.2 = ~9.09% return
    // TWR = (1.1)(1.2/1.1) - 1 = 0.2 = 20%
    const twr = calculateTWR(txs, [], 1.2);
    expect(twr).toBeCloseTo(0.2, 4);
  });

  it("handles deposit then withdrawal", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
      {
        action: "WITHDRAW",
        amount: 550,
        shares: 500,
        sharePriceAtTx: 1.1,
        timestamp: new Date("2025-02-01"),
      },
    ];
    // Period 1: price 1.0 -> 1.1 (10%)
    // After withdrawal: 500 shares at 1.1 = 550
    // Period 2: price 1.1 -> 1.2
    // TWR: (1.1/1.0) * (1.2/1.1) - 1 = 1.2 - 1 = 0.2
    const twr = calculateTWR(txs, [], 1.2);
    expect(twr).toBeCloseTo(0.2, 4);
  });
});

// ── calculatePnL ────────────────────────────────────────────────────────

describe("calculatePnL", () => {
  it("returns zeroes for empty transactions", () => {
    const result = calculatePnL([], [], 1.0);
    expect(result.totalDeposited).toBe(0);
    expect(result.totalWithdrawn).toBe(0);
    expect(result.currentValue).toBe(0);
    expect(result.costBasis).toBe(0);
    expect(result.absolutePnL).toBe(0);
    expect(result.twrPercent).toBe(0);
    expect(result.dailySnapshots).toHaveLength(0);
  });

  it("calculates correct PnL for a single deposit with gain", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    const prices: SharePriceSnapshot[] = [
      { sharePrice: 1.0, snapshotAt: new Date("2025-01-01") },
      { sharePrice: 1.1, snapshotAt: new Date("2025-01-15") },
    ];
    const result = calculatePnL(txs, prices, 1.2);

    expect(result.totalDeposited).toBe(1000);
    expect(result.totalWithdrawn).toBe(0);
    expect(result.currentValue).toBe(1200);
    expect(result.costBasis).toBe(1000);
    expect(result.absolutePnL).toBe(200);
    expect(result.twrPercent).toBeCloseTo(20, 0);
  });

  it("calculates correct PnL for deposit + partial withdrawal", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
      {
        action: "WITHDRAW",
        amount: 550,
        shares: 500,
        sharePriceAtTx: 1.1,
        timestamp: new Date("2025-02-01"),
      },
    ];

    const prices: SharePriceSnapshot[] = [
      { sharePrice: 1.0, snapshotAt: new Date("2025-01-01") },
      { sharePrice: 1.1, snapshotAt: new Date("2025-02-01") },
    ];

    const result = calculatePnL(txs, prices, 1.2);

    expect(result.totalDeposited).toBe(1000);
    expect(result.totalWithdrawn).toBe(550);
    // 500 shares * 1.2 = 600
    expect(result.currentValue).toBe(600);
    // cost basis = 1000 - 550 = 450
    expect(result.costBasis).toBe(450);
    // absolute PnL = 600 - 450 = 150
    expect(result.absolutePnL).toBe(150);
  });

  it("handles negative PnL (loss)", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    const prices: SharePriceSnapshot[] = [
      { sharePrice: 1.0, snapshotAt: new Date("2025-01-01") },
    ];
    const result = calculatePnL(txs, prices, 0.8);

    expect(result.currentValue).toBe(800);
    expect(result.absolutePnL).toBe(-200);
    expect(result.twrPercent).toBeCloseTo(-20, 0);
  });

  it("generates daily snapshots for charting", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    const prices: SharePriceSnapshot[] = [
      { sharePrice: 1.0, snapshotAt: new Date("2025-01-01") },
      { sharePrice: 1.05, snapshotAt: new Date("2025-01-02") },
      { sharePrice: 1.1, snapshotAt: new Date("2025-01-03") },
    ];
    const result = calculatePnL(txs, prices, 1.15);

    // Should have snapshots for each price point + today
    expect(result.dailySnapshots.length).toBeGreaterThanOrEqual(3);

    // First snapshot should have 0 PnL (just deposited at that price)
    expect(result.dailySnapshots[0].cumulativePnL).toBe(0);

    // Second snapshot should show gain
    expect(result.dailySnapshots[1].cumulativePnL).toBeGreaterThan(0);
  });

  it("rounds USD values to 2 decimal places", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 3,
        sharePriceAtTx: 333.3333,
        timestamp: new Date("2025-01-01"),
      },
    ];
    const result = calculatePnL(txs, [], 333.3334);

    // Values should be rounded to 2 decimal places
    expect(result.currentValue.toString()).toMatch(/^\d+(\.\d{1,2})?$/);
    expect(result.absolutePnL.toString()).toMatch(/^-?\d+(\.\d{1,2})?$/);
  });

  it("handles full withdrawal (zero remaining shares)", () => {
    const txs: UserTransaction[] = [
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
      {
        action: "WITHDRAW",
        amount: 1100,
        shares: 1000,
        sharePriceAtTx: 1.1,
        timestamp: new Date("2025-02-01"),
      },
    ];
    const result = calculatePnL(txs, [], 1.2);

    expect(result.currentValue).toBe(0);
    // Cost basis = 1000 - 1100 = -100 (user withdrew more than deposited)
    expect(result.costBasis).toBe(-100);
  });

  it("sorts transactions by timestamp regardless of input order", () => {
    const txs: UserTransaction[] = [
      {
        action: "WITHDRAW",
        amount: 550,
        shares: 500,
        sharePriceAtTx: 1.1,
        timestamp: new Date("2025-02-01"),
      },
      {
        action: "DEPOSIT",
        amount: 1000,
        shares: 1000,
        sharePriceAtTx: 1.0,
        timestamp: new Date("2025-01-01"),
      },
    ];
    const result = calculatePnL(txs, [], 1.2);

    // Should process deposit first, then withdrawal
    expect(result.totalDeposited).toBe(1000);
    expect(result.totalWithdrawn).toBe(550);
    expect(result.currentValue).toBe(600); // 500 shares * 1.2
  });
});
