import request from "supertest";
import {
  simulateTreasury,
  compareTreasuryScenarios,
  exportComparisonJSON,
  exportComparisonCSV,
  DEFAULT_STRESS_RUNS,
  saveScenario,
  getScenario,
  listScenarios,
  deleteScenario,
  assertValidScenarioInput,
  previewImport,
  SUPPORTED_ASSETS,
  CASHFLOW_CATEGORIES,
  type TreasuryScenario,
  type AllocationPosition,
} from "../services/treasurySimulationService";

const baseAllocations: AllocationPosition[] = [
  { vaultId: "blend", vaultName: "Blend", allocationPct: 60, apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
  { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
];

const makeScenario = (overrides: Partial<TreasuryScenario> = {}): TreasuryScenario => ({
  id: `test-${Date.now()}`,
  name: "Test Scenario",
  totalCapitalUsd: 1_000_000,
  allocations: baseAllocations,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("simulateTreasury", () => {
  it("returns a projectedYieldPct > 0 for valid allocations", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.projectedYieldPct).toBeGreaterThan(0);
  });

  it("projectedYieldUsd matches capital × weighted APY", () => {
    const scenario = makeScenario({ totalCapitalUsd: 1_000_000 });
    const result = simulateTreasury(scenario);
    const expected =
      1_000_000 * 0.6 * (6.5 / 100) + 1_000_000 * 0.4 * (11.2 / 100);
    expect(result.projectedYieldUsd).toBeCloseTo(expected, 0);
  });

  it("includes rotation cost for all positions", () => {
    const result = simulateTreasury(makeScenario({ totalCapitalUsd: 1_000_000 }));
    const expected =
      1_000_000 * 0.6 * (0.1 / 100) + 1_000_000 * 0.4 * (0.2 / 100);
    expect(result.totalRotationCostUsd).toBeCloseTo(expected, 0);
  });

  it("warns on high concentration (>50%)", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.concentrationWarnings.length).toBeGreaterThan(0);
    expect(result.concentrationWarnings[0]).toContain("Blend");
  });

  it("no warnings when all allocations are ≤50%", () => {
    const scenario = makeScenario({
      allocations: [
        { ...baseAllocations[0], allocationPct: 50 },
        { ...baseAllocations[1], allocationPct: 50 },
      ],
    });
    const result = simulateTreasury(scenario);
    expect(result.concentrationWarnings).toHaveLength(0);
  });

  it("breakdown has an entry per allocation", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.allocationBreakdown).toHaveLength(2);
  });

  it("liquidityRiskScore is between 0 and 10", () => {
    const result = simulateTreasury(makeScenario());
    expect(result.liquidityRiskScore).toBeGreaterThanOrEqual(0);
    expect(result.liquidityRiskScore).toBeLessThanOrEqual(10);
  });

  it("returns 0 yield for zero capital", () => {
    const result = simulateTreasury(makeScenario({ totalCapitalUsd: 0 }));
    expect(result.projectedYieldPct).toBe(0);
    expect(result.projectedYieldUsd).toBe(0);
  });
});

describe("scenario persistence", () => {
  it("saves and retrieves a scenario", () => {
    const scenario = makeScenario({ id: "persist-1" });
    saveScenario(scenario);
    expect(getScenario("persist-1")).toMatchObject({ id: "persist-1" });
  });

  it("lists saved scenarios", () => {
    const scenario = makeScenario({ id: "list-1" });
    saveScenario(scenario);
    expect(listScenarios().some((s) => s.id === "list-1")).toBe(true);
  });

  it("deletes a scenario", () => {
    const scenario = makeScenario({ id: "delete-1" });
    saveScenario(scenario);
    expect(deleteScenario("delete-1")).toBe(true);
    expect(getScenario("delete-1")).toBeUndefined();
  });

  it("returns false when deleting non-existent scenario", () => {
    expect(deleteScenario("does-not-exist")).toBe(false);
  });
});

describe("assertValidScenarioInput - invalid input", () => {
  const baseAlloc: AllocationPosition = {
    vaultId: "v1",
    vaultName: "V1",
    allocationPct: 100,
    apy: 5,
    tvlUsd: 1_000_000,
    riskScore: 5,
    rotationCostPct: 0.1,
  };

  it("rejects non-object body", () => {
    expect(() => assertValidScenarioInput(null)).toThrow();
    expect(() => assertValidScenarioInput("string")).toThrow();
    expect(() => assertValidScenarioInput(123)).toThrow();
  });

  it("rejects missing id", () => {
    expect(() =>
      assertValidScenarioInput({
        name: "n",
        totalCapitalUsd: 1000,
        allocations: [baseAlloc],
      }),
    ).toThrow();
  });

  it("rejects missing name", () => {
    expect(() =>
      assertValidScenarioInput({
        id: "1",
        totalCapitalUsd: 1000,
        allocations: [baseAlloc],
      }),
    ).toThrow();
  });

  it("rejects invalid totalCapitalUsd", () => {
    expect(() =>
      assertValidScenarioInput({
        id: "1",
        name: "n",
        totalCapitalUsd: -1,
        allocations: [baseAlloc],
      }),
    ).toThrow();
  });

  it("rejects missing allocations array", () => {
    expect(() =>
      assertValidScenarioInput({
        id: "1",
        name: "n",
        totalCapitalUsd: 1000,
        allocations: [],
      }),
    ).toThrow();
  });

  it("rejects allocation item missing required fields", () => {
    expect(() =>
      assertValidScenarioInput({
        id: "1",
        name: "n",
        totalCapitalUsd: 1000,
        allocations: [{ ...baseAlloc, apy: "bad" as any }],
      }),
    ).toThrow();
  });

  it("rejects allocations not summing to 100", () => {
    expect(() =>
      assertValidScenarioInput({
        id: "1",
        name: "n",
        totalCapitalUsd: 1000,
        allocations: [baseAlloc, { ...baseAlloc, allocationPct: 50 }],
      }),
    ).toThrow();
  });

  it("returns typed scenario on valid input", () => {
    const scenario = assertValidScenarioInput({
      id: "1",
      name: "ok",
      totalCapitalUsd: 1000,
      allocations: [baseAlloc],
    });
    expect(scenario.id).toBe("1");
    expect(scenario.allocations).toHaveLength(1);
  });
});

const validRow = {
  id: "cf-1",
  date: "2025-06-01",
  asset: "USDC",
  amount: 50000,
  direction: "inflow",
  category: "interest",
  memo: "Q2 yield",
};

describe("previewImport - cashflow row validation", () => {
  it("validates a single valid row", () => {
    const result = previewImport([validRow]);
    expect(result.validRows).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.summary.totalInflow).toBe(50000);
    expect(result.summary.totalOutflow).toBe(0);
  });

  it("rejects null/undefined row", () => {
    const result = previewImport([null]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].code).toBe("not_an_object");
  });

  it("rejects missing id", () => {
    const { id: _id, ...rest } = validRow;
    const result = previewImport([rest]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "missing_id")).toBe(true);
  });

  it("rejects duplicate id", () => {
    const result = previewImport([validRow, { ...validRow, id: "cf-1" }]);
    expect(result.validRows).toHaveLength(1);
    expect(result.errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });

  it("rejects invalid date", () => {
    const result = previewImport([{ ...validRow, date: "not-a-date" }]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "invalid_date")).toBe(true);
  });

  it("warns on future date", () => {
    const result = previewImport([{ ...validRow, date: "2099-01-01" }]);
    expect(result.validRows).toHaveLength(1);
    expect(result.warnings.some((w) => w.code === "future_date")).toBe(true);
  });

  it("rejects unsupported asset", () => {
    const result = previewImport([{ ...validRow, asset: "DOGE" }]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "unsupported_asset")).toBe(true);
  });

  it("accepts every supported asset", () => {
    for (const asset of SUPPORTED_ASSETS) {
      const result = previewImport([{ ...validRow, id: `cf-${asset}`, asset }]);
      expect(result.errors.some((e) => e.code === "unsupported_asset")).toBe(false);
    }
  });

  it("rejects negative amount", () => {
    const result = previewImport([{ ...validRow, amount: -100 }]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "negative_amount")).toBe(true);
  });

  it("rejects zero amount", () => {
    const result = previewImport([{ ...validRow, amount: 0 }]);
    expect(result.errors.some((e) => e.code === "negative_amount")).toBe(true);
  });

  it("rejects non-finite amount", () => {
    const result = previewImport([{ ...validRow, amount: NaN }]);
    expect(result.errors.some((e) => e.code === "invalid_amount")).toBe(true);
  });

  it("rejects invalid direction", () => {
    const result = previewImport([{ ...validRow, direction: "sideways" }]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "invalid_direction")).toBe(true);
  });

  it("rejects missing direction", () => {
    const { direction: _direction, ...rest } = validRow;
    const result = previewImport([rest]);
    expect(result.errors.some((e) => e.code === "missing_direction")).toBe(true);
  });

  it("rejects invalid category", () => {
    const result = previewImport([{ ...validRow, category: "gambling" }]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "invalid_category")).toBe(true);
  });

  it("accepts every valid category", () => {
    for (const cat of CASHFLOW_CATEGORIES) {
      const result = previewImport([{ ...validRow, id: `cf-${cat}`, category: cat }]);
      expect(result.errors.some((e) => e.code === "invalid_category")).toBe(false);
    }
  });

  it("computes outflow correctly", () => {
    const result = previewImport([
      { ...validRow, id: "out-1", direction: "outflow", amount: 10000 },
    ]);
    expect(result.summary.totalOutflow).toBe(10000);
    expect(result.summary.netFlow).toBe(-10000);
  });

  it("reports summary counts accurately", () => {
    const result = previewImport([
      validRow,
      { ...validRow, id: "cf-2", amount: 25000, direction: "outflow" },
      { ...validRow, id: "cf-3", asset: "DOGE" }, // error
    ]);
    expect(result.summary.totalRows).toBe(3);
    expect(result.summary.validCount).toBe(2);
    expect(result.summary.errorCount).toBe(1);
  });

  it("handles empty array", () => {
    const result = previewImport([]);
    expect(result.validRows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.summary.totalRows).toBe(0);
  });
});

describe("compareTreasuryScenarios", () => {
  it("computes baseline and stress runs comparison with deltas", () => {
    const scenario = makeScenario({ totalCapitalUsd: 1_000_000 });
    const comparison = compareTreasuryScenarios(scenario);

    expect(comparison.baseline.scenarioName).toBe("Test Scenario");
    expect(comparison.baseline.totals.projectedYieldUsd).toBeGreaterThan(0);
    expect(comparison.stressRuns.length).toBe(Object.keys(DEFAULT_STRESS_RUNS).length);

    const yieldCollapse = comparison.stressRuns.find((sr) => sr.stressId === "yield-collapse");
    expect(yieldCollapse).toBeDefined();
    expect(yieldCollapse!.totals.projectedYieldUsd).toBeLessThan(comparison.baseline.totals.projectedYieldUsd);
    expect(yieldCollapse!.totals.yieldDeltaUsd).toBeLessThan(0);
    expect(yieldCollapse!.totals.yieldDeltaPct).toBeCloseTo(-50, 0);

    expect(comparison.summary.worstCaseYieldUsd).toBeLessThanOrEqual(comparison.baseline.totals.projectedYieldUsd);
    expect(comparison.summary.maxYieldLossUsd).toBeGreaterThan(0);
  });

  it("evaluates custom/selected stress run IDs", () => {
    const scenario = makeScenario();
    const comparison = compareTreasuryScenarios(scenario, ["severe-crash"]);

    expect(comparison.stressRuns).toHaveLength(1);
    expect(comparison.stressRuns[0].stressId).toBe("severe-crash");
  });
});

describe("exportComparisonJSON and exportComparisonCSV", () => {
  it("exportComparisonJSON formats valid JSON with all metadata", () => {
    const scenario = makeScenario();
    const comparison = compareTreasuryScenarios(scenario);
    const jsonStr = exportComparisonJSON(comparison);

    const parsed = JSON.parse(jsonStr);
    expect(parsed.exportedAt).toBeDefined();
    expect(parsed.baseline.scenarioName).toBe("Test Scenario");
    expect(parsed.baseline.assumptions.allocations).toHaveLength(2);
    expect(parsed.stressRuns).toHaveLength(3);
    expect(parsed.summary.maxYieldLossUsd).toBeDefined();
  });

  it("exportComparisonCSV includes metadata headers, summary, run matrix, and allocations", () => {
    const scenario = makeScenario();
    const comparison = compareTreasuryScenarios(scenario);
    const csv = exportComparisonCSV(comparison);

    expect(csv).toContain("# Treasury Scenario Comparison Report");
    expect(csv).toContain("# Scenario Name: Test Scenario");
    expect(csv).toContain("# SUMMARY");
    expect(csv).toContain("Baseline Projected Yield ($)");
    expect(csv).toContain("Worst-Case Projected Yield ($)");
    expect(csv).toContain("# RUN COMPARISON");
    expect(csv).toContain('"baseline"');
    expect(csv).toContain('"yield-collapse"');
    expect(csv).toContain("# ALLOCATION ASSUMPTIONS");
    expect(csv).toContain('"blend"');
  });
});

// ── Treasury Route Envelope Contract Tests ───────────────────────────────────
//
// These tests verify that the HTTP layer applies the shared response envelope
// (ok, data, meta) consistently for success, warning, and validation-error
// scenarios.

jest.mock("../services/yieldSourceRegistryService", () => ({
  getSourceHealthRegistry: jest.fn().mockResolvedValue([]),
}));

describe("Treasury Route Envelope Contract", () => {
  let app: import("express").Express;

  beforeAll(async () => {
    const { createApp } = await import("../app");
    app = createApp();
  });

  // ── Helper ────────────────────────────────────────────────────────────────

  function expectSuccessEnvelope(body: Record<string, unknown>, route: string) {
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("data");
    expect(body.meta).toMatchObject({ generatedAt: expect.any(String), route });
  }

  function expectErrorEnvelope(body: Record<string, unknown>, code: string) {
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, unknown>).code).toBe(code);
    expect(typeof (body.error as Record<string, unknown>).message).toBe("string");
    expect(body.meta).toMatchObject({ generatedAt: expect.any(String), route: expect.any(String) });
  }

  // ── Shared allocations ────────────────────────────────────────────────────

  const validAllocations = [
    { vaultId: "blend",    vaultName: "Blend",    allocationPct: 60, apy: 6.5,  tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
    { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd:  4_500_000, riskScore: 6, rotationCostPct: 0.2 },
  ];

  const evenAllocations = [
    { vaultId: "blend",    vaultName: "Blend",    allocationPct: 50, apy: 6.5,  tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
    { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 50, apy: 11.2, tvlUsd:  4_500_000, riskScore: 6, rotationCostPct: 0.2 },
  ];

  // ── POST /api/treasury/simulate ───────────────────────────────────────────

  describe("POST /api/treasury/simulate", () => {
    it("returns success envelope with simulation data", async () => {
      const res = await request(app)
        .post("/api/treasury/simulate")
        .send({ name: "Envelope Test", totalCapitalUsd: 1_000_000, allocations: validAllocations })
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/simulate");
      expect(res.body.data).toMatchObject({
        projectedYieldPct: expect.any(Number),
        projectedYieldUsd: expect.any(Number),
        totalRotationCostUsd: expect.any(Number),
        liquidityRiskScore: expect.any(Number),
        concentrationWarnings: expect.any(Array),
        allocationBreakdown: expect.any(Array),
      });
    });

    it("surfaces concentration warnings in meta.warnings when concentration > 50 %", async () => {
      const res = await request(app)
        .post("/api/treasury/simulate")
        .send({ name: "Concentrate Test", totalCapitalUsd: 1_000_000, allocations: validAllocations })
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/simulate");
      // Blend is at 60 % → should trigger a warning
      expect(Array.isArray(res.body.meta.warnings)).toBe(true);
      expect((res.body.meta.warnings as string[]).length).toBeGreaterThan(0);
    });

    it("has no meta.warnings when all allocations are ≤ 50 %", async () => {
      const res = await request(app)
        .post("/api/treasury/simulate")
        .send({ name: "Even Test", totalCapitalUsd: 1_000_000, allocations: evenAllocations })
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/simulate");
      expect(res.body.meta.warnings).toBeUndefined();
    });

    it("returns validation-error envelope for missing name", async () => {
      const res = await request(app)
        .post("/api/treasury/simulate")
        .send({ totalCapitalUsd: 1_000_000, allocations: validAllocations })
        .expect(400);

      expectErrorEnvelope(res.body, "invalid_name");
    });

    it("returns validation-error envelope for allocations not summing to 100", async () => {
      const badAllocations = [{ ...validAllocations[0], allocationPct: 30 }, validAllocations[1]];
      const res = await request(app)
        .post("/api/treasury/simulate")
        .send({ name: "Bad Alloc", totalCapitalUsd: 1_000_000, allocations: badAllocations })
        .expect(400);

      // The allocations sum to 70, which triggers invalid_allocations
      expect(res.body.ok).toBe(false);
      expect(typeof (res.body.error as Record<string, unknown>).code).toBe("string");
    });

    it("returns INVALID_REQUEST envelope for a completely invalid body", async () => {
      const res = await request(app)
        .post("/api/treasury/simulate")
        .send("not json")
        .set("Content-Type", "text/plain")
        .expect(400);

      expect(res.body.ok).toBe(false);
    });
  });

  // ── POST /api/treasury/scenarios ─────────────────────────────────────────

  describe("POST /api/treasury/scenarios", () => {
    it("returns 201 success envelope with id, name, createdAt", async () => {
      const res = await request(app)
        .post("/api/treasury/scenarios")
        .send({ name: "Saved Scenario", totalCapitalUsd: 500_000, allocations: evenAllocations })
        .expect(201);

      expectSuccessEnvelope(res.body, "treasury/scenarios");
      expect(res.body.data).toMatchObject({
        id: expect.any(String),
        name: "Saved Scenario",
        createdAt: expect.any(String),
      });
    });

    it("returns validation-error envelope for missing totalCapitalUsd", async () => {
      const res = await request(app)
        .post("/api/treasury/scenarios")
        .send({ name: "Bad Capital", allocations: evenAllocations })
        .expect(400);

      expectErrorEnvelope(res.body, "invalid_totalCapitalUsd");
    });
  });

  // ── GET /api/treasury/scenarios ──────────────────────────────────────────

  describe("GET /api/treasury/scenarios", () => {
    it("returns success envelope with an array", async () => {
      const res = await request(app)
        .get("/api/treasury/scenarios")
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/scenarios");
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ── GET /api/treasury/scenarios/:id ──────────────────────────────────────

  describe("GET /api/treasury/scenarios/:id", () => {
    it("returns 404 NOT_FOUND envelope for unknown id", async () => {
      const res = await request(app)
        .get("/api/treasury/scenarios/does-not-exist")
        .expect(404);

      expectErrorEnvelope(res.body, "NOT_FOUND");
    });

    it("returns success envelope with scenario and simulation for known id", async () => {
      // First save a scenario
      const save = await request(app)
        .post("/api/treasury/scenarios")
        .send({ id: "envelope-get-test", name: "Envelope GET", totalCapitalUsd: 200_000, allocations: evenAllocations })
        .expect(201);
      const { id } = save.body.data as { id: string };

      const res = await request(app)
        .get(`/api/treasury/scenarios/${id}`)
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/scenarios");
      expect(res.body.data).toMatchObject({
        scenario: expect.objectContaining({ id }),
        simulation: expect.objectContaining({
          projectedYieldPct: expect.any(Number),
        }),
      });
    });
  });

  // ── POST /api/treasury/cashflow/preview ──────────────────────────────────

  describe("POST /api/treasury/cashflow/preview", () => {
    const validRow = {
      id: "cf-1",
      date: "2025-06-01",
      asset: "USDC",
      amount: 50000,
      direction: "inflow",
      category: "interest",
    };

    it("returns success envelope with preview data for valid rows", async () => {
      const res = await request(app)
        .post("/api/treasury/cashflow/preview")
        .send({ rows: [validRow] })
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/cashflow/preview");
      expect(res.body.data).toMatchObject({
        validRows: expect.any(Array),
        errors: expect.any(Array),
        summary: expect.objectContaining({ totalRows: 1 }),
      });
    });

    it("returns 400 VALIDATION_ERROR envelope for non-array body", async () => {
      const res = await request(app)
        .post("/api/treasury/cashflow/preview")
        .send({ rows: "not an array" })
        .expect(400);

      expectErrorEnvelope(res.body, "VALIDATION_ERROR");
    });
  });

  // ── POST /api/treasury/cashflow/import ───────────────────────────────────

  describe("POST /api/treasury/cashflow/import", () => {
    const validRow = {
      id: "imp-1",
      date: "2025-06-01",
      asset: "USDC",
      amount: 50000,
      direction: "inflow",
      category: "interest",
    };

    it("returns 201 success envelope for valid import", async () => {
      const res = await request(app)
        .post("/api/treasury/cashflow/import")
        .send({ scenarioId: "s-1", rows: [validRow] })
        .expect(201);

      expectSuccessEnvelope(res.body, "treasury/cashflow/import");
      expect(res.body.data).toMatchObject({
        imported: 1,
        preview: expect.objectContaining({ validRows: expect.any(Array) }),
      });
    });

    it("returns 422 CASHFLOW_VALIDATION_ERROR envelope for rows with errors", async () => {
      const badRow = { ...validRow, id: "bad-1", asset: "DOGE" };
      const res = await request(app)
        .post("/api/treasury/cashflow/import")
        .send({ scenarioId: "s-1", rows: [badRow] })
        .expect(422);

      expectErrorEnvelope(res.body, "CASHFLOW_VALIDATION_ERROR");
      expect(res.body.error.details).toMatchObject({
        preview: expect.objectContaining({ errors: expect.any(Array) }),
      });
    });

    it("returns 400 VALIDATION_ERROR envelope for missing scenarioId", async () => {
      const res = await request(app)
        .post("/api/treasury/cashflow/import")
        .send({ rows: [validRow] })
        .expect(400);

      expectErrorEnvelope(res.body, "VALIDATION_ERROR");
    });
  });

  // ── POST /api/treasury/compare ───────────────────────────────────────────

  describe("POST /api/treasury/compare", () => {
    it("returns success envelope with baseline vs stress comparison payload", async () => {
      const res = await request(app)
        .post("/api/treasury/compare")
        .send({ name: "Compare Test", totalCapitalUsd: 1_000_000, allocations: validAllocations })
        .expect(200);

      expectSuccessEnvelope(res.body, "treasury/compare");
      expect(res.body.data).toMatchObject({
        exportedAt: expect.any(String),
        baseline: expect.objectContaining({ scenarioName: "Compare Test" }),
        stressRuns: expect.any(Array),
        summary: expect.objectContaining({ worstCaseYieldUsd: expect.any(Number) }),
      });
    });

    it("returns validation error envelope for invalid capital", async () => {
      const res = await request(app)
        .post("/api/treasury/compare")
        .send({ name: "Bad Capital", totalCapitalUsd: -500, allocations: validAllocations })
        .expect(400);

      expectErrorEnvelope(res.body, "invalid_totalCapitalUsd");
    });
  });

  // ── POST /api/treasury/export-comparison ──────────────────────────────────

  describe("POST /api/treasury/export-comparison", () => {
    it("returns downloadable JSON content by default", async () => {
      const res = await request(app)
        .post("/api/treasury/export-comparison")
        .send({ name: "JSON Export Test", totalCapitalUsd: 1_000_000, allocations: validAllocations, format: "json" })
        .expect(200);

      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.headers["content-disposition"]).toContain("treasury_scenario_comparison.json");
      const parsed = JSON.parse(res.text);
      expect(parsed.baseline.scenarioName).toBe("JSON Export Test");
      expect(parsed.stressRuns.length).toBeGreaterThan(0);
    });

    it("returns downloadable CSV content when format=csv", async () => {
      const res = await request(app)
        .post("/api/treasury/export-comparison")
        .send({ name: "CSV Export Test", totalCapitalUsd: 1_000_000, allocations: validAllocations, format: "csv" })
        .expect(200);

      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("treasury_scenario_comparison.csv");
      expect(res.text).toContain("# Treasury Scenario Comparison Report");
      expect(res.text).toContain("# Scenario Name: CSV Export Test");
      expect(res.text).toContain('"baseline"');
    });

    it("returns validation error for invalid allocation sum on export", async () => {
      const badAllocations = [{ ...validAllocations[0], allocationPct: 10 }];
      const res = await request(app)
        .post("/api/treasury/export-comparison")
        .send({ name: "Bad Export", totalCapitalUsd: 1_000_000, allocations: badAllocations, format: "csv" })
        .expect(400);

      expect(res.body.ok).toBe(false);
    });
  });
});
