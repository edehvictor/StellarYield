import {
  KeeperHeartbeatRegistry,
  HEARTBEAT_THRESHOLDS,
  KEEPER_WORKER_NAMES,
} from "../monitors/KeeperHeartbeat";

describe("Keeper Heartbeat Registry (#1034)", () => {
  let registry: KeeperHeartbeatRegistry;

  beforeEach(() => {
    registry = new KeeperHeartbeatRegistry();
  });

  it("reports missing status for uninitialized workers", () => {
    const health = registry.getWorkerHealth("liquidation");
    expect(health.status).toBe("missing");
    expect(health.lastHeartbeat).toBeNull();
    expect(health.ageMs).toBeNull();
    expect(health.recoveryGuidance).toContain("restart liquidation keeper");
    expect(health.degradedBehavior).toContain("Undercollateralized positions");
  });

  it("reports healthy status when heartbeat is within threshold", () => {
    const now = 1_000_000;
    registry.recordHeartbeat("rebalance", now - 10_000);

    const health = registry.getWorkerHealth("rebalance", now);
    expect(health.status).toBe("healthy");
    expect(health.ageMs).toBe(10_000);
    expect(health.lastHeartbeat).toBe(new Date(now - 10_000).toISOString());
  });

  it("reports stale status when heartbeat exceeds freshness threshold", () => {
    const now = 1_000_000;
    const staleTime = now - (HEARTBEAT_THRESHOLDS.HEALTHY_MAX_AGE_MS + 5_000);
    registry.recordHeartbeat("reward", staleTime);

    const health = registry.getWorkerHealth("reward", now);
    expect(health.status).toBe("stale");
    expect(health.ageMs).toBeGreaterThan(HEARTBEAT_THRESHOLDS.HEALTHY_MAX_AGE_MS);
    expect(health.recoveryGuidance).toContain("restart compound worker");
  });

  it("produces aggregated summary covering all four keeper workers", () => {
    const now = 2_000_000;
    registry.recordHeartbeat("rebalance", now - 5_000);
    registry.recordHeartbeat("liquidation", now - 10_000);
    registry.recordHeartbeat("reward", now - 15_000);
    registry.recordHeartbeat("indexer", now - 20_000);

    const summary = registry.getSummary(now);
    expect(summary.status).toBe("healthy");
    expect(summary.staleCount).toBe(0);
    expect(summary.missingCount).toBe(0);

    for (const name of KEEPER_WORKER_NAMES) {
      expect(summary.keepers[name].status).toBe("healthy");
    }
  });

  it("marks summary as degraded when at least one keeper is stale or missing", () => {
    const now = 2_000_000;
    registry.recordHeartbeat("rebalance", now - 5_000);
    registry.recordHeartbeat("liquidation", now - 120_000); // stale

    const summary = registry.getSummary(now);
    expect(summary.status).toBe("degraded");
    expect(summary.staleCount).toBe(1);
    expect(summary.missingCount).toBe(2); // reward, indexer missing
  });
});
