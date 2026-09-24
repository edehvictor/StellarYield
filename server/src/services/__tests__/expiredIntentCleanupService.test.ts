import { cleanupExpiredTransactionIntents } from "../expiredIntentCleanupService";

function makePrisma(overrides: {
  withdrawalUpdateMany?: jest.Mock;
  rebalanceUpdateMany?: jest.Mock;
}) {
  return {
    withdrawalQueueEntry: {
      updateMany: overrides.withdrawalUpdateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
    rebalanceQueueEntry: {
      updateMany: overrides.rebalanceUpdateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as Parameters<typeof cleanupExpiredTransactionIntents>[0];
}

describe("cleanupExpiredTransactionIntents", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("main path: expires both queue types and returns their counts", async () => {
    const withdrawalUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
    const rebalanceUpdateMany = jest.fn().mockResolvedValue({ count: 2 });

    const summary = await cleanupExpiredTransactionIntents(
      makePrisma({ withdrawalUpdateMany, rebalanceUpdateMany }),
      now,
    );

    expect(summary).toEqual({
      ranAt: now.toISOString(),
      expiredWithdrawals: 3,
      expiredRebalanceIntents: 2,
      errors: [],
    });

    expect(withdrawalUpdateMany).toHaveBeenCalledWith({
      where: { status: { in: ["QUEUED", "EXECUTABLE"] }, expiresAt: { lt: now } },
      data: { status: "EXPIRED", cancelledAt: now, cancellationReason: "Expired before execution" },
    });
    expect(rebalanceUpdateMany).toHaveBeenCalledWith({
      where: { status: "PENDING", intentValidUntil: { lt: now } },
      data: { status: "CANCELLED", lastError: "Intent expired before execution (past intentValidUntil)" },
    });
  });

  it("edge case: nothing expired returns zero counts without error", async () => {
    const summary = await cleanupExpiredTransactionIntents(makePrisma({}), now);
    expect(summary.expiredWithdrawals).toBe(0);
    expect(summary.expiredRebalanceIntents).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("edge case: a failure sweeping the withdrawal queue does not block the rebalance sweep", async () => {
    const withdrawalUpdateMany = jest.fn().mockRejectedValue(new Error("connection reset by peer"));
    const rebalanceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

    const summary = await cleanupExpiredTransactionIntents(
      makePrisma({ withdrawalUpdateMany, rebalanceUpdateMany }),
      now,
    );

    expect(summary.expiredWithdrawals).toBe(0);
    expect(summary.expiredRebalanceIntents).toBe(1);
    // Stable typed message, not the raw driver error leaking through.
    expect(summary.errors).toEqual(["Failed to sweep expired withdrawal queue intents"]);
    expect(summary.errors[0]).not.toContain("connection reset");
  });

  it("failure state: both sweeps failing surfaces two stable error messages, not raw errors", async () => {
    const withdrawalUpdateMany = jest.fn().mockRejectedValue(new Error("P2010 raw db error"));
    const rebalanceUpdateMany = jest.fn().mockRejectedValue(new Error("P2010 raw db error"));

    const summary = await cleanupExpiredTransactionIntents(
      makePrisma({ withdrawalUpdateMany, rebalanceUpdateMany }),
      now,
    );

    expect(summary.errors).toEqual([
      "Failed to sweep expired withdrawal queue intents",
      "Failed to sweep expired rebalance queue intents",
    ]);
  });
});
