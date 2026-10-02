import express from "express";
import request from "supertest";
import driftRouter from "../routes/drift";
import { DriftService } from "../services/driftService";
import { driftAnomalyGrouper, DriftSignal, GroupedAnomaly } from "../services/driftAnomalyGrouper";
import { extractPressureDriftSignals, VaultPressureMetrics } from "../services/vaultPressureService";
import { extractAttributionDriftSignals, AttributionReport } from "../services/portfolioAttributionService";
import { extractStrategyHealthDriftSignals, StrategyHealthScore } from "../services/strategyHealthService";

jest.mock("../config/targetAllocations", () => ({
  TARGET_ALLOCATIONS: [
    { vaultId: "VaultA", targetWeight: 0.60, driftThreshold: 0.05 },
    { vaultId: "VaultB", targetWeight: 0.40, driftThreshold: 0.05 },
  ],
}));

jest.mock("../services/alertsService", () => ({
  dispatchDriftAlert: jest.fn(),
}));

jest.mock("@prisma/client", () => {
  const instance = {
    driftEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "mock-drift-event" }),
      update: jest.fn().mockResolvedValue({ id: "mock-drift-event", isRecovered: true }),
    },
  };
  const MockPrismaClient = jest.fn(() => instance);
  (MockPrismaClient as any).__mockInstance = instance;
  return { PrismaClient: MockPrismaClient };
});

describe("Drift Anomaly Grouping", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/drift", driftRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    DriftService.clearActiveGroupedAnomalies();
  });

  describe("driftAnomalyGrouper core engine", () => {
    it("returns empty array when no signals provided", () => {
      const groups = driftAnomalyGrouper.groupSignals([]);
      expect(groups).toEqual([]);
    });

    it("groups related signals by source, asset, and severity band (AC #1 & #2)", () => {
      const now = new Date().toISOString();
      const signals: DriftSignal[] = [
        {
          id: "sig-1",
          source: "vault",
          subSource: "vault_allocation",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.72,
          expectedValue: 0.60,
          deviation: 0.12,
          severity: "HIGH",
          timestamp: now,
        },
        {
          id: "sig-2",
          source: "vault",
          subSource: "vault_pressure",
          asset: "VaultA",
          metric: "outflow_velocity",
          currentValue: 250,
          expectedValue: 50,
          deviation: 200,
          severity: "HIGH",
          timestamp: now,
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals);
      expect(groups).toHaveLength(1);

      const grp = groups[0];
      expect(grp.primaryAsset).toBe("VaultA");
      expect(grp.primarySource).toBe("vault");
      expect(grp.aggregateSeverity).toBe("HIGH");

      // Verify severity and source data remain visible (AC #2)
      expect(grp.sources).toContain("vault");
      expect(grp.sourceCount.vault).toBe(2);
      expect(grp.severityBreakdown.HIGH).toBe(2);
      expect(grp.signals).toHaveLength(2);
      expect(grp.signals.map((s) => s.id)).toEqual(["sig-1", "sig-2"]);
    });

    it("aggregates signals across multiple sources (portfolio, vault, strategy) for same asset", () => {
      const now = new Date().toISOString();
      const signals: DriftSignal[] = [
        {
          id: "vault-sig",
          source: "vault",
          asset: "USDC-Vault",
          metric: "allocation_drift",
          currentValue: 0.80,
          expectedValue: 0.50,
          deviation: 0.30,
          severity: "CRITICAL",
          timestamp: now,
        },
        {
          id: "strategy-sig",
          source: "strategy",
          asset: "USDC-Vault",
          metric: "strategy_health_score",
          currentValue: 35,
          expectedValue: 80,
          deviation: -45,
          severity: "HIGH",
          timestamp: now,
        },
        {
          id: "portfolio-sig",
          source: "portfolio",
          asset: "USDC-Vault",
          metric: "concentration_drift",
          currentValue: 65,
          expectedValue: 40,
          deviation: 25,
          severity: "MEDIUM",
          timestamp: now,
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals, { strategy: "byAssetAndProximity" });
      expect(groups).toHaveLength(1);

      const grp = groups[0];
      expect(grp.primaryAsset).toBe("USDC-Vault");
      expect(grp.aggregateSeverity).toBe("CRITICAL"); // Max severity wins
      expect(grp.sources).toEqual(expect.arrayContaining(["vault", "strategy", "portfolio"]));
      expect(grp.sourceCount.vault).toBe(1);
      expect(grp.sourceCount.strategy).toBe(1);
      expect(grp.sourceCount.portfolio).toBe(1);
      expect(grp.severityBreakdown.CRITICAL).toBe(1);
      expect(grp.severityBreakdown.HIGH).toBe(1);
      expect(grp.severityBreakdown.MEDIUM).toBe(1);
    });

    it("groups signals sharing explicit rootCauseId", () => {
      const now = new Date().toISOString();
      const rootCauseId = "oracle_outage_soroswap";

      const signals: DriftSignal[] = [
        {
          id: "sig-vault-1",
          source: "vault",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.75,
          expectedValue: 0.60,
          deviation: 0.15,
          severity: "HIGH",
          timestamp: now,
          rootCauseId,
        },
        {
          id: "sig-strategy-1",
          source: "strategy",
          asset: "soroswap_yield_strategy",
          metric: "apy_crash",
          currentValue: 0.5,
          expectedValue: 12.0,
          deviation: -11.5,
          severity: "HIGH",
          timestamp: now,
          rootCauseId,
        },
      ];

      const groups = driftAnomalyGrouper.groupSignals(signals, { strategy: "byRootCause" });
      expect(groups).toHaveLength(1);
      expect(groups[0].rootCauseSummary).toContain("oracle_outage_soroswap");
      expect(groups[0].signals).toHaveLength(2);
    });
  });

  describe("Service signal extractors", () => {
    it("extracts DriftSignals from VaultPressureMetrics", () => {
      const metrics: VaultPressureMetrics = {
        vaultId: "VaultA",
        windowMs: 300000,
        inflowVelocity: 150,
        outflowVelocity: 450,
        netVelocity: -300,
        inflowPressure: "NORMAL",
        outflowPressure: "CRITICAL",
        totalInflowInWindow: BigInt(45000),
        totalOutflowInWindow: BigInt(135000),
        eventCount: 30,
        computedAt: Date.now(),
      };

      const signals = extractPressureDriftSignals(metrics);
      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe("vault");
      expect(signals[0].subSource).toBe("vault_pressure");
      expect(signals[0].metric).toBe("outflow_velocity");
      expect(signals[0].severity).toBe("CRITICAL");
      expect(signals[0].asset).toBe("VaultA");
    });

    it("extracts DriftSignals from AttributionReport", () => {
      const report: AttributionReport = {
        walletAddress: "GBX7...TEST",
        totalReturn: 120,
        totalDeposited: 5000,
        attributionBreakdown: [
          {
            decisionType: "rotation",
            contribution: 40,
            percentage: 33.3,
            apyImpact: 1.5,
            decisions: [],
            confidence: 0.35, // Low confidence trigger
          },
        ],
        rewardSourceMix: [],
        timeWindow: { start: "2026-03-01T00:00:00Z", end: "2026-03-30T00:00:00Z" },
        generatedAt: new Date().toISOString(),
        dataCompleteness: 0.55, // Incomplete data trigger (< 0.7)
      };

      const signals = extractAttributionDriftSignals(report);
      expect(signals.length).toBeGreaterThanOrEqual(2);

      const completenessSignal = signals.find((s) => s.metric === "data_completeness");
      expect(completenessSignal).toBeDefined();
      expect(completenessSignal?.severity).toBe("MEDIUM");

      const confidenceSignal = signals.find((s) => s.metric.includes("decision_confidence_rotation"));
      expect(confidenceSignal).toBeDefined();
      expect(confidenceSignal?.severity).toBe("HIGH");
    });

    it("extracts DriftSignals from StrategyHealthScore", () => {
      const score: StrategyHealthScore = {
        strategyId: "Blend-XLM-Strategy",
        strategyName: "Blend XLM Yield Strategy",
        overallScore: 42,
        metrics: {
          contractSafety: 0.95,
          dataFreshness: 0.90,
          providerUptime: 0.82, // Low uptime trigger (< 0.85 -> HIGH)
          liquidityConditions: 0.70,
          executionOutcomes: 0.60,
          volatilityIndex: 0.50,
          errorRate: 0.12, // High error rate trigger (>= 0.05 -> HIGH)
          latency: 450,
        },
        status: "critical",
        signals: [],
        lastUpdated: new Date().toISOString(),
        trend: "declining",
        recommendations: ["Review error rates"],
      };

      const signals = extractStrategyHealthDriftSignals(score);
      expect(signals.length).toBeGreaterThanOrEqual(3);

      const healthScoreSig = signals.find((s) => s.metric === "strategy_health_score");
      expect(healthScoreSig).toBeDefined();
      expect(healthScoreSig?.source).toBe("strategy");
      expect(healthScoreSig?.severity).toBe("HIGH");

      const errorRateSig = signals.find((s) => s.metric === "error_rate");
      expect(errorRateSig).toBeDefined();
      expect(errorRateSig?.severity).toBe("HIGH");

      const uptimeSig = signals.find((s) => s.metric === "provider_uptime_drop");
      expect(uptimeSig).toBeDefined();
      expect(uptimeSig?.severity).toBe("HIGH");
    });
  });

  describe("DriftService API and REST Endpoints", () => {
    it("converts vault values into drift signals and groups them", async () => {
      const grouped = await DriftService.evaluateGroupedDriftEvents({
        VaultA: 800, // 80% vs 60% target -> 20% drift (HIGH)
        VaultB: 200, // 20% vs 40% target -> -20% drift (HIGH)
      });

      expect(grouped.length).toBeGreaterThanOrEqual(1);
      const active = DriftService.getActiveGroupedAnomalies();
      expect(active).toHaveLength(grouped.length);
    });

    it("POST /api/drift/group groups submitted signals", async () => {
      const now = new Date().toISOString();
      const signals: DriftSignal[] = [
        {
          id: "sig-test-1",
          source: "vault",
          asset: "VaultA",
          metric: "allocation_drift",
          currentValue: 0.70,
          expectedValue: 0.60,
          deviation: 0.10,
          severity: "MEDIUM",
          timestamp: now,
        },
      ];

      const res = await request(app)
        .post("/api/drift/group")
        .send({ signals })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].primaryAsset).toBe("VaultA");
    });

    it("POST /api/drift/evaluate evaluates vault USD values with external signals", async () => {
      const res = await request(app)
        .post("/api/drift/evaluate")
        .send({
          vaultValuesUsd: { VaultA: 750, VaultB: 250 },
          externalSignals: [
            {
              id: "ext-1",
              source: "strategy",
              asset: "VaultA",
              metric: "strategy_health",
              currentValue: 40,
              expectedValue: 90,
              deviation: -50,
              severity: "HIGH",
              timestamp: new Date().toISOString(),
            },
          ],
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("GET /api/drift/anomalies returns filtered active anomalies", async () => {
      // First populate some active anomalies
      await DriftService.evaluateGroupedDriftEvents({
        VaultA: 850,
        VaultB: 150,
      });

      const res = await request(app)
        .get("/api/drift/anomalies?source=vault")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(typeof res.body.count).toBe("number");
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
