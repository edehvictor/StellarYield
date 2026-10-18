const mockCreate = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    rebalanceSimulationSnapshot: {
      create: mockCreate,
      findMany: mockFindMany,
      findUnique: mockFindUnique,
    },
  })),
}));

import {
  saveSimulationSnapshot,
  listSimulationSnapshots,
  getSimulationSnapshot,
  SimulationSnapshotError,
} from "../rebalanceSimulationSnapshotService";
import type { TreasuryScenario, SimulationResult } from "../treasurySimulationService";

const scenario: TreasuryScenario = {
  id: "scn-1",
  name: "Base case",
  totalCapitalUsd: 1_000_000,
  allocations: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const result: SimulationResult = {
  scenarioId: "scn-1",
  scenarioName: "Base case",
  projectedYieldPct: 5,
  projectedYieldUsd: 50_000,
  totalRotationCostUsd: 100,
  liquidityRiskScore: 3,
  concentrationWarnings: [],
  warnings: [],
  allocationBreakdown: [],
};

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "snap-1",
    scenarioId: "scn-1",
    scenarioLabel: "Base case",
    inputs: scenario,
    result,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("rebalanceSimulationSnapshotService", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("saveSimulationSnapshot", () => {
    it("main path: persists and returns a serialized snapshot", async () => {
      mockCreate.mockResolvedValue(row());

      const snapshot = await saveSimulationSnapshot(scenario, result, { saved: true });

      expect(snapshot.id).toBe("snap-1");
      expect(snapshot.scenarioId).toBe("scn-1");
      expect(snapshot.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scenarioId: "scn-1", scenarioLabel: "Base case" }),
        }),
      );
    });

    it("edge case: an unsaved scenario snapshot has a null scenarioId, not the scenario's own draft id", async () => {
      mockCreate.mockResolvedValue(row({ scenarioId: null }));

      await saveSimulationSnapshot(scenario, result, { saved: false });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ scenarioId: null }) }),
      );
    });

    it("failure state: a DB error becomes a typed SimulationSnapshotError, not a raw driver error", async () => {
      mockCreate.mockRejectedValue(new Error("P2002 unique constraint"));

      await expect(saveSimulationSnapshot(scenario, result)).rejects.toMatchObject({
        code: "SNAPSHOT_PERSIST_FAILED",
        statusCode: 503,
      });
    });
  });

  describe("listSimulationSnapshots", () => {
    it("main path: returns snapshots newest-first with no next cursor when under the page size", async () => {
      mockFindMany.mockResolvedValue([row()]);

      const page = await listSimulationSnapshots();

      expect(page.snapshots).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });

    it("edge case: an extra row beyond the limit produces a nextCursor and is trimmed from the page", async () => {
      mockFindMany.mockResolvedValue([row({ id: "a" }), row({ id: "b" })]);

      const page = await listSimulationSnapshots({ limit: 1 });

      expect(page.snapshots.map((s) => s.id)).toEqual(["a"]);
      expect(page.nextCursor).toBe("a");
    });

    it("edge case: empty result set returns an empty array, not an error", async () => {
      mockFindMany.mockResolvedValue([]);
      const page = await listSimulationSnapshots({ scenarioId: "does-not-exist" });
      expect(page).toEqual({ snapshots: [], nextCursor: null });
    });
  });

  describe("getSimulationSnapshot", () => {
    it("main path: returns the matching snapshot", async () => {
      mockFindUnique.mockResolvedValue(row());
      const snapshot = await getSimulationSnapshot("snap-1");
      expect(snapshot.id).toBe("snap-1");
    });

    it("failure state: a missing id throws a typed 404, not undefined/null", async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(getSimulationSnapshot("missing")).rejects.toBeInstanceOf(SimulationSnapshotError);
      await expect(getSimulationSnapshot("missing")).rejects.toMatchObject({
        code: "SNAPSHOT_NOT_FOUND",
        statusCode: 404,
      });
    });
  });
});
