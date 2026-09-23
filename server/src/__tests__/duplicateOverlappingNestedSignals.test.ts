import {
  driftAnomalyGrouper,
  DriftSignal,
  GroupedAnomaly,
} from "../services/driftAnomalyGrouper";

describe("Duplicate, Overlapping, and Nested Drift Signals (Acceptance Criteria #1, #2, #3)", () => {
  const BASE_TIME = 1774360000000; // Fixed unix timestamp for deterministic tests

  describe("1. Duplicate Signal Handling (Deduplication)", () => {
    it("coalesces identical signals within the deduplication window into a single grouped output with duplicate counts", () => {
      // Simulate 5 repeated signals emitted by a polling loop every 30 seconds
      const signals: DriftSignal[] = [
        {
          id: "dup-sig-1",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.70,
          expectedValue: 0.60,
          deviation: 0.10,
          severity: "MEDIUM",
          timestamp: new Date(BASE_TIME).toISOString(),
        },
        {
          id: "dup-sig-2",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.71,
          expectedValue: 0.60,
          deviation: 0.11,
          severity: "MEDIUM",
          timestamp: new Date(BASE_TIME + 30_000).toISOString(),
        },
        {
          id: "dup-sig-3",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.72,
          expectedValue: 0.60,
          deviation: 0.12,
          severity: "MEDIUM",
          timestamp: new Date(BASE_TIME + 60_000).toISOString(),
        },
        {
          id: "dup-sig-4",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.72,
          expectedValue: 0.60,
          deviation: 0.12,
          severity: "MEDIUM",
          timestamp: new Date(BASE_TIME + 90_000).toISOString(),
        },
        {
          id: "dup-sig-5",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.73,
          expectedValue: 0.60,
          deviation: 0.13,
          severity: "MEDIUM",
          timestamp: new Date(BASE_TIME + 120_000).toISOString(),
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals, { dedupWindowMs: 10 * 60 * 1000 });

      // Exactly 1 group should be generated, not 5 separate warnings
      expect(groups).toHaveLength(1);

      const grp = groups[0];
      expect(grp.signalCount).toBe(5);
      expect(grp.uniqueSignalCount).toBe(1);
      expect(grp.duplicateCount).toBe(4);

      // The constituent signal should retain the highest deviation observed
      expect(grp.signals).toHaveLength(1);
      expect(grp.signals[0].deviation).toBe(0.13);
      expect(grp.signals[0].currentValue).toBe(0.73);

      // Severity and source data remain visible in breakdown (AC #2)
      expect(grp.sources).toEqual(["vault"]);
      expect(grp.sourceCount.vault).toBe(5);
      expect(grp.severityBreakdown.MEDIUM).toBe(5);
    });

    it("treats signals outside the deduplication window as separate occurrences while grouping related signals", () => {
      const signals: DriftSignal[] = [
        {
          id: "sig-time-1",
          source: "vault",
          asset: "VaultB",
          metric: "outflow_velocity",
          currentValue: 200,
          expectedValue: 50,
          deviation: 150,
          severity: "HIGH",
          timestamp: new Date(BASE_TIME).toISOString(),
        },
        {
          id: "sig-time-2",
          source: "vault",
          asset: "VaultB",
          metric: "outflow_velocity",
          currentValue: 210,
          expectedValue: 50,
          deviation: 160,
          severity: "HIGH",
          timestamp: new Date(BASE_TIME + 60 * 60 * 1000).toISOString(), // 1 hour later (outside 10 min window)
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals, {
        dedupWindowMs: 10 * 60 * 1000,
        correlationWindowMs: 2 * 60 * 60 * 1000, // Merged in temporal cluster
      });

      expect(groups).toHaveLength(1);
      expect(groups[0].uniqueSignalCount).toBe(2);
      expect(groups[0].duplicateCount).toBe(0);
      expect(groups[0].signalCount).toBe(2);
    });
  });

  describe("2. Overlapping Signal Handling (Multi-metric & Temporal Intersections)", () => {
    it("merges multiple distinct metrics occurring simultaneously on the same asset into a cohesive anomaly", () => {
      const now = new Date(BASE_TIME).toISOString();

      const signals: DriftSignal[] = [
        {
          id: "metric-1-allocation",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.85,
          expectedValue: 0.60,
          deviation: 0.25,
          severity: "CRITICAL",
          timestamp: now,
        },
        {
          id: "metric-2-outflow",
          source: "vault",
          subSource: "vault_pressure",
          asset: "VaultA",
          metric: "outflow_velocity",
          currentValue: 500,
          expectedValue: 100,
          deviation: 400,
          severity: "HIGH",
          timestamp: now,
        },
        {
          id: "metric-3-inflow",
          source: "vault",
          subSource: "vault_pressure",
          asset: "VaultA",
          metric: "inflow_velocity",
          currentValue: 10,
          expectedValue: 100,
          deviation: -90,
          severity: "MEDIUM",
          timestamp: now,
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals, { strategy: "byAssetAndProximity" });

      expect(groups).toHaveLength(1);
      const grp = groups[0];

      // Highest severity wins for the group
      expect(grp.aggregateSeverity).toBe("CRITICAL");
      expect(grp.uniqueSignalCount).toBe(3);
      expect(grp.signals.map((s) => s.metric)).toEqual(
        expect.arrayContaining(["allocation_drift", "outflow_velocity", "inflow_velocity"])
      );

      // Severity and source data remain visible in breakdown (AC #2)
      expect(grp.severityBreakdown.CRITICAL).toBe(1);
      expect(grp.severityBreakdown.HIGH).toBe(1);
      expect(grp.severityBreakdown.MEDIUM).toBe(1);
    });

    it("merges overlapping time window signals across portfolio, vault, and strategy services", () => {
      const t0 = BASE_TIME;
      const t1 = BASE_TIME + 2 * 60 * 1000;  // +2 min
      const t2 = BASE_TIME + 5 * 60 * 1000;  // +5 min
      const t3 = BASE_TIME + 8 * 60 * 1000;  // +8 min

      const signals: DriftSignal[] = [
        {
          id: "sig-strategy",
          source: "strategy",
          subSource: "strategy_health",
          asset: "Blend-XLM-Vault",
          metric: "provider_uptime_drop",
          currentValue: 0.65,
          expectedValue: 0.99,
          deviation: -0.34,
          severity: "HIGH",
          timestamp: new Date(t0).toISOString(),
        },
        {
          id: "sig-vault",
          source: "vault",
          subSource: "vault_pressure",
          asset: "Blend-XLM-Vault",
          metric: "outflow_velocity",
          currentValue: 400,
          expectedValue: 50,
          deviation: 350,
          severity: "HIGH",
          timestamp: new Date(t1).toISOString(),
        },
        {
          id: "sig-portfolio",
          source: "portfolio",
          subSource: "risk_preference",
          asset: "Blend-XLM-Vault",
          metric: "volatility_drift",
          currentValue: 32,
          expectedValue: 18,
          deviation: 14,
          severity: "MEDIUM",
          timestamp: new Date(t2).toISOString(),
        },
        {
          id: "sig-portfolio-2",
          source: "portfolio",
          subSource: "portfolio_attribution",
          asset: "Blend-XLM-Vault",
          metric: "data_completeness",
          currentValue: 0.5,
          expectedValue: 1.0,
          deviation: 0.5,
          severity: "MEDIUM",
          timestamp: new Date(t3).toISOString(),
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals, {
        strategy: "byAssetAndProximity",
        correlationWindowMs: 10 * 60 * 1000,
      });

      expect(groups).toHaveLength(1);
      const grp = groups[0];

      expect(grp.primaryAsset).toBe("Blend-XLM-Vault");
      expect(grp.durationMs).toBe(8 * 60 * 1000);
      expect(grp.sources).toEqual(expect.arrayContaining(["strategy", "vault", "portfolio"]));
      expect(grp.sourceCount.strategy).toBe(1);
      expect(grp.sourceCount.vault).toBe(1);
      expect(grp.sourceCount.portfolio).toBe(2);
      expect(grp.severityBreakdown.HIGH).toBe(2);
      expect(grp.severityBreakdown.MEDIUM).toBe(2);
    });
  });

  describe("3. Nested and Hierarchical Anomaly Handling (AC #3)", () => {
    it("correctly models parent-child causal relationships via parentSignalId into nested anomalies", () => {
      const now = new Date(BASE_TIME).toISOString();

      // Root Cause: Strategy execution failure
      const rootSignal: DriftSignal = {
        id: "root-strategy-failure",
        source: "strategy",
        subSource: "strategy_execution",
        asset: "DeFindex-USDC-Pool",
        metric: "execution_error_rate",
        currentValue: 0.85,
        expectedValue: 0.01,
        deviation: 0.84,
        severity: "CRITICAL",
        timestamp: now,
      };

      // Child 1 (caused by root): Vault allocation drift
      const childSignal1: DriftSignal = {
        id: "child-vault-drift",
        source: "vault",
        subSource: "vault_allocation",
        asset: "DeFindex-USDC-Pool",
        metric: "allocation_drift",
        currentValue: 0.30,
        expectedValue: 0.50,
        deviation: -0.20,
        severity: "HIGH",
        timestamp: now,
        parentSignalId: "root-strategy-failure",
      };

      // Child 2 (caused by root): Vault outflow surge
      const childSignal2: DriftSignal = {
        id: "child-vault-outflow",
        source: "vault",
        subSource: "vault_pressure",
        asset: "DeFindex-USDC-Pool",
        metric: "outflow_velocity",
        currentValue: 350,
        expectedValue: 50,
        deviation: 300,
        severity: "HIGH",
        timestamp: now,
        parentSignalId: "root-strategy-failure",
      };

      // Grandchild (caused by Child 1): Portfolio concentration drift
      const grandchildSignal: DriftSignal = {
        id: "grandchild-portfolio-drift",
        source: "portfolio",
        subSource: "risk_preference",
        asset: "DeFindex-USDC-Pool",
        metric: "concentration_drift",
        currentValue: 60,
        expectedValue: 40,
        deviation: 20,
        severity: "MEDIUM",
        timestamp: now,
        parentSignalId: "child-vault-drift",
      };

      const signals = [rootSignal, childSignal1, childSignal2, grandchildSignal];
      const groups = driftAnomalyGrouper.groupSignals(signals);

      // Top-level groups should only contain the root cause anomaly
      expect(groups).toHaveLength(1);

      const rootGroup = groups[0];
      expect(rootGroup.primarySource).toBe("strategy");
      expect(rootGroup.aggregateSeverity).toBe("CRITICAL");
      expect(rootGroup.signals).toHaveLength(1);
      expect(rootGroup.signals[0].id).toBe("root-strategy-failure");

      // Verify nested anomalies exist under the root group (AC #3)
      expect(rootGroup.nestedAnomalies).toBeDefined();
      expect(rootGroup.nestedAnomalies!.length).toBeGreaterThanOrEqual(1);

      // Inspect child group
      const childGroup = rootGroup.nestedAnomalies![0];
      expect(childGroup.primarySource).toBe("vault");
      expect(childGroup.aggregateSeverity).toBe("HIGH");
      expect(childGroup.signals.map((s) => s.id)).toEqual(
        expect.arrayContaining(["child-vault-drift", "child-vault-outflow"])
      );

      // Inspect grandchild group nested under child
      expect(childGroup.nestedAnomalies).toBeDefined();
      expect(childGroup.nestedAnomalies!).toHaveLength(1);

      const grandchildGroup = childGroup.nestedAnomalies![0];
      expect(grandchildGroup.primarySource).toBe("portfolio");
      expect(grandchildGroup.aggregateSeverity).toBe("MEDIUM");
      expect(grandchildGroup.signals[0].id).toBe("grandchild-portfolio-drift");
    });

    it("maintains source and severity visibility at every level of the nested hierarchy", () => {
      const now = new Date(BASE_TIME).toISOString();

      const rootSignal: DriftSignal = {
        id: "parent-signal-1",
        source: "strategy",
        asset: "Soroswap-Vault",
        metric: "yield_divergence",
        currentValue: 2.1,
        expectedValue: 10.5,
        deviation: -8.4,
        severity: "HIGH",
        timestamp: now,
      };

      const childSignal: DriftSignal = {
        id: "child-signal-1",
        source: "portfolio",
        asset: "Soroswap-Vault",
        metric: "decision_confidence",
        currentValue: 0.3,
        expectedValue: 0.9,
        deviation: -0.6,
        severity: "MEDIUM",
        timestamp: now,
        parentSignalId: "parent-signal-1",
      };

      const groups = driftAnomalyGrouper.groupSignals([rootSignal, childSignal]);
      expect(groups).toHaveLength(1);

      const top = groups[0];
      expect(top.aggregateSeverity).toBe("HIGH");
      expect(top.sources).toEqual(["strategy"]);
      expect(top.sourceCount.strategy).toBe(1);

      expect(top.nestedAnomalies).toBeDefined();
      expect(top.nestedAnomalies).toHaveLength(1);

      const nested = top.nestedAnomalies![0];
      expect(nested.aggregateSeverity).toBe("MEDIUM");
      expect(nested.sources).toEqual(["portfolio"]);
      expect(nested.sourceCount.portfolio).toBe(1);
      expect(nested.severityBreakdown.MEDIUM).toBe(1);
      expect(nested.signals[0].id).toBe("child-signal-1");
    });
  });
});
