import {
  runScheduledReconciliation,
  resetScheduledReconciliationStore,
  getScheduledReconciliationRuns,
  getConsecutiveUnhealthyCount,
  getScheduledReconciliationRunById,
  type ReconcileWalletOutcome,
  type ReconciliationAlert,
} from "../scheduledReconciliationService";

const baseConfig = {
  driftThresholdPct: 0.05,
  consecutiveFailAlert: 3,
  alertsEnabled: true,
};

describe("Scheduled Reconciliation Service", () => {
  let alerts: ReconciliationAlert[];

  beforeEach(() => {
    resetScheduledReconciliationStore();
    alerts = [];
  });

  const sink = async (alert: ReconciliationAlert) => {
    alerts.push(alert);
  };

  const outcome = (
    status: ReconcileWalletOutcome["status"],
    driftPct = 0,
    overrides: Partial<ReconcileWalletOutcome> = {},
  ): ReconcileWalletOutcome => ({
    status,
    changeCount: 0,
    mismatchCount: 0,
    driftPct,
    ...overrides,
  });

  describe("clean run", () => {
    it("persists a success run with no alert when no drift is observed", async () => {
      const reconcile = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockResolvedValue(outcome("success", 0));

      const run = await runScheduledReconciliation(
        { ...baseConfig, wallets: [{ walletAddress: "wallet-A" }, { walletAddress: "wallet-B" }] },
        reconcile,
        sink,
      );

      expect(run.status).toBe("success");
      expect(run.alerted).toBe(false);
      expect(run.walletsReconciled).toBe(2);
      expect(run.maxDriftPct).toBe(0);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(alerts).toHaveLength(0);
      expect(getConsecutiveUnhealthyCount()).toBe(0);

      expect(getScheduledReconciliationRuns()).toHaveLength(1);
      expect(
        getScheduledReconciliationRunById(run.id)?.status,
      ).toBe("success");
    });
  });

  describe("drift over threshold", () => {
    it("raises a drift alert and marks the run partial", async () => {
      const reconcile = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockResolvedValue(outcome("partial", 0.2, { mismatchCount: 2 }));

      const run = await runScheduledReconciliation(
        { ...baseConfig, wallets: [{ walletAddress: "wallet-A" }] },
        reconcile,
        sink,
      );

      expect(run.status).toBe("partial");
      expect(run.maxDriftPct).toBe(0.2);
      expect(run.alerted).toBe(true);
      expect(run.alertReason).toBe("drift");

      expect(alerts).toHaveLength(1);
      expect(alerts[0].level).toBe("drift");
      expect(alerts[0].message).toContain("20.00%");
    });

    it("does not alert when drift stays within threshold", async () => {
      const reconcile = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockResolvedValue(outcome("success", 0.02));

      const run = await runScheduledReconciliation(
        { ...baseConfig, wallets: [{ walletAddress: "wallet-A" }] },
        reconcile,
        sink,
      );

      expect(run.status).toBe("success");
      expect(run.maxDriftPct).toBe(0.02);
      expect(run.alerted).toBe(false);
      expect(alerts).toHaveLength(0);
    });
  });

  describe("run failure", () => {
    it("treats a thrown runner error as a failed run", async () => {
      const reconcile = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockRejectedValue(new Error("provider down"));

      const run = await runScheduledReconciliation(
        { ...baseConfig, wallets: [{ walletAddress: "wallet-A" }], consecutiveFailAlert: 2 },
        reconcile,
        sink,
      );

      expect(run.status).toBe("failed");
      expect(run.runs[0].status).toBe("failed");
      expect(run.runs[0].error).toContain("provider down");
      expect(getConsecutiveUnhealthyCount()).toBe(1);
      // Not yet at the consecutive threshold of 2
      expect(alerts).toHaveLength(0);
    });

    it("raises an unhealthy alert after consecutive failed runs reach the threshold", async () => {
      const reconcile = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockRejectedValue(new Error("provider down"));

      const config = { ...baseConfig, wallets: [{ walletAddress: "wallet-A" }], consecutiveFailAlert: 2 };

      const first = await runScheduledReconciliation(config, reconcile, sink);
      expect(first.alerted).toBe(false);

      const second = await runScheduledReconciliation(config, reconcile, sink);
      expect(second.alerted).toBe(true);
      expect(second.alertReason).toBe("unhealthy");

      expect(getConsecutiveUnhealthyCount()).toBe(2);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].level).toBe("unhealthy");
      expect(alerts[0].message).toContain("2 consecutive");
    });

    it("resets the consecutive counter after a successful run", async () => {
      const failing = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockRejectedValue(new Error("provider down"));
      const config = { ...baseConfig, wallets: [{ walletAddress: "wallet-A" }], consecutiveFailAlert: 2 };

      await runScheduledReconciliation(config, failing, sink);
      await runScheduledReconciliation(config, failing, sink);
      expect(getConsecutiveUnhealthyCount()).toBe(2);

      const healthy = jest
        .fn<Promise<ReconcileWalletOutcome>, [string]>()
        .mockResolvedValue(outcome("success", 0));
      await runScheduledReconciliation(config, healthy, sink);

      expect(getConsecutiveUnhealthyCount()).toBe(0);
    });
  });

  describe("skipped runs", () => {
    it("records a skipped run when no wallets are configured", async () => {
      const run = await runScheduledReconciliation(
        { ...baseConfig, wallets: [] },
        jest.fn(),
        sink,
      );

      expect(run.status).toBe("skipped");
      expect(run.walletsReconciled).toBe(0);
      expect(getConsecutiveUnhealthyCount()).toBe(1);
    });
  });
});
