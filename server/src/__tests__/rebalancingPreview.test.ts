/**
 * Tests for the deterministic treasury rebalancing preview export (#1294).
 *
 * Verifies the pure build/serialize functions (determinism, ordering, typed
 * errors) and the HTTP route contract (attachment response + typed envelopes).
 */

import request from "supertest";
import { Router } from "express";
import {
  buildRebalancingPreview,
  exportRebalancingPreviewJSON,
  exportRebalancingPreviewCSV,
  assertValidCurrentAllocations,
  RebalancingPreviewError,
  type TreasuryScenario,
  type AllocationPosition,
} from "../services/treasurySimulationService";

import treasuryRouter from "../routes/treasury";

const targetAllocations: AllocationPosition[] = [
  { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
  { vaultId: "blend",    vaultName: "Blend",    allocationPct: 60, apy: 6.5,  tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
];

const currentAllocations: AllocationPosition[] = [
  { vaultId: "blend",    vaultName: "Blend",    allocationPct: 50, apy: 6.5,  tvlUsd: 10_000_000, riskScore: 8, rotationCostPct: 0.1 },
  { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 50, apy: 11.2, tvlUsd: 3_000_000,  riskScore: 6, rotationCostPct: 0.2 },
];

const makeScenario = (overrides: Partial<TreasuryScenario> = {}): TreasuryScenario => ({
  id: "scenario-1",
  name: "Target Mix",
  totalCapitalUsd: 1_000_000,
  allocations: targetAllocations,
  createdAt: "2026-05-28T12:00:00.000Z",
  ...overrides,
});

describe("buildRebalancingPreview", () => {
  it("produces a deterministic row order sorted by vault ID", () => {
    const preview = buildRebalancingPreview(makeScenario(), currentAllocations);
    expect(preview.rows.map((r) => r.vaultId)).toEqual(["blend", "soroswap"]);
  });

  it("prices deltas and rotation cost deterministically", () => {
    const preview = buildRebalancingPreview(makeScenario(), currentAllocations);
    const blend = preview.rows.find((r) => r.vaultId === "blend")!;
    const soroswap = preview.rows.find((r) => r.vaultId === "soroswap")!;

    expect(blend.currentCapitalUsd).toBe(500_000);
    expect(blend.targetCapitalUsd).toBe(600_000);
    expect(blend.deltaUsd).toBe(100_000);
    expect(blend.direction).toBe("INCREASE");
    expect(blend.rotationCostUsd).toBe(100); // 100_000 * 0.1%

    expect(soroswap.deltaUsd).toBe(-100_000);
    expect(soroswap.direction).toBe("DECREASE");
    expect(soroswap.rotationCostUsd).toBe(200);
  });

  it("treats an omitted current set as a fresh-deployment baseline", () => {
    const preview = buildRebalancingPreview(makeScenario());
    expect(preview.rows.every((r) => r.currentCapitalUsd === 0)).toBe(true);
    expect(preview.rows.every((r) => r.direction === "INCREASE")).toBe(true);
  });

  it("flags NO_CHANGE when current matches target", () => {
    const preview = buildRebalancingPreview(makeScenario(), targetAllocations);
    expect(preview.summary.unchangedCount).toBe(2);
    expect(preview.summary.increaseCount).toBe(0);
    expect(preview.summary.totalDeltaUsd).toBe(0);
  });

  it("returns the same JSON bytes for identical inputs", () => {
    const first = exportRebalancingPreviewJSON(buildRebalancingPreview(makeScenario(), currentAllocations));
    const second = exportRebalancingPreviewJSON(buildRebalancingPreview(makeScenario(), currentAllocations));
    expect(first).toBe(second);
  });

  it("exports a stable CSV with no timestamps", () => {
    const csv = exportRebalancingPreviewCSV(buildRebalancingPreview(makeScenario(), currentAllocations));
    expect(csv).toContain("# Treasury Rebalancing Preview");
    expect(csv).toContain("INCREASE");
    expect(csv).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("assertValidCurrentAllocations", () => {
  it("accepts omission as an empty array", () => {
    expect(assertValidCurrentAllocations(undefined)).toEqual([]);
  });

  it("rejects an empty array with a typed error", () => {
    expect(() => assertValidCurrentAllocations([])).toThrow(RebalancingPreviewError);
    try {
      assertValidCurrentAllocations([]);
    } catch (err) {
      expect((err as RebalancingPreviewError).code).toBe("INVALID_CURRENT_ALLOCATIONS");
    }
  });

  it("rejects allocations that do not sum to 100", () => {
    expect(() =>
      assertValidCurrentAllocations([
        { vaultId: "blend", allocationPct: 50 },
      ]),
    ).toThrow(RebalancingPreviewError);
  });
});

describe("POST /api/treasury/rebalancing/preview/export", () => {
  let app: import("express").Express;

  beforeAll(() => {
    const router = Router();
    router.use("/api/treasury", treasuryRouter);
    app = router as unknown as import("express").Express;
  });

  const body = {
    name: "Target Mix",
    totalCapitalUsd: 1_000_000,
    allocations: [
      { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
      { vaultId: "blend",    vaultName: "Blend",    allocationPct: 60, apy: 6.5,  tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
    ],
    currentAllocations: [
      { vaultId: "blend",    allocationPct: 50 },
      { vaultId: "soroswap", allocationPct: 50 },
    ],
  };

  it("returns a deterministic CSV attachment", async () => {
    const res = await request(app)
      .post("/api/treasury/rebalancing/preview/export")
      .send({ ...body, format: "csv" })
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("# Treasury Rebalancing Preview");
    expect(res.text).toContain("blend");
    expect(res.text).toContain("INCREASE");
    expect(res.text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns a JSON attachment when format is json", async () => {
    const res = await request(app)
      .post("/api/treasury/rebalancing/preview/export")
      .send({ ...body, format: "json" })
      .expect(200);

    expect(res.headers["content-type"]).toContain("application/json");
    const parsed = JSON.parse(res.text);
    expect(parsed.summary.positionCount).toBe(2);
  });

  it("returns a typed error envelope for mismatched vault sets", async () => {
    const res = await request(app)
      .post("/api/treasury/rebalancing/preview/export")
      .send({ ...body, currentAllocations: [{ vaultId: "other", allocationPct: 100 }] })
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("MISMATCHED_VAULT_SETS");
  });
});