/**
 * Tests for the deterministic vault allocation rollback preview (#1360).
 *
 * Covers the pure builder (main path + edge cases), determinism guarantees,
 * and the HTTP route contract (success, empty, and typed failure states).
 */

import express from "express";
import request from "supertest";
import {
  AllocationRollbackPreviewError,
  buildAllocationRollbackPreview,
} from "../services/allocationRollbackPreviewService";
import allocationRollbackPreviewRouter from "../routes/allocationRollbackPreview";

// ── Pure builder ────────────────────────────────────────────────────────────

describe("buildAllocationRollbackPreview (#1360)", () => {
  const current = { Blend: 60, Soroswap: 40 };
  const rollback = { Blend: 40, Soroswap: 60 };

  it("builds a preview for the main path with sorted, stable rows", () => {
    const preview = buildAllocationRollbackPreview({
      vaultId: "vault-1",
      currentAllocations: current,
      rollbackAllocations: { Soroswap: 60, Blend: 40 },
      source: "explicit",
      rollbackReason: "undo pending rebalance",
    });

    expect(preview.vaultId).toBe("vault-1");
    expect(preview.source).toBe("explicit");
    expect(preview.changes.map((c) => c.vaultId)).toEqual(["Blend", "Soroswap"]);
    expect(preview.changes[0]).toEqual({
      vaultId: "Blend",
      currentWeight: 60,
      rollbackWeight: 40,
      deltaWeight: -20,
    });
    expect(preview.changes[1].deltaWeight).toBe(20);
    expect(preview.totalDeltaWeight).toBe(0);
    expect(preview.noOp).toBe(false);
    expect(preview.safe).toBe(true);
    expect(preview.conflictingQueueEntryIds).toEqual([]);
    expect(preview.rollbackReason).toBe("undo pending rebalance");
    expect(preview.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: identical inputs (different key order) produce identical output", () => {
    const a = buildAllocationRollbackPreview({
      vaultId: "vault-1",
      currentAllocations: { Blend: 60, Soroswap: 40 },
      rollbackAllocations: { Soroswap: 60, Blend: 40 },
      source: "explicit",
    });
    const b = buildAllocationRollbackPreview({
      vaultId: "vault-1",
      currentAllocations: { Soroswap: 40, Blend: 60 },
      rollbackAllocations: { Blend: 40, Soroswap: 60 },
      source: "explicit",
    });

    expect(a).toEqual(b);
    expect(a.inputHash).toBe(b.inputHash);
  });

  it("marks an identical rollback as a safe no-op", () => {
    const preview = buildAllocationRollbackPreview({
      vaultId: "vault-1",
      currentAllocations: { Blend: 60, Soroswap: 40 },
      rollbackAllocations: { Blend: 60, Soroswap: 40 },
      source: "explicit",
    });

    expect(preview.noOp).toBe(true);
    expect(preview.totalDeltaWeight).toBe(0);
    expect(preview.safe).toBe(true);
    expect(preview.changes.every((c) => c.deltaWeight === 0)).toBe(true);
  });

  it("supports fraction-scale weights (sums to 1) when both maps agree", () => {
    const preview = buildAllocationRollbackPreview({
      vaultId: "vault-1",
      currentAllocations: { Blend: 0.6, Soroswap: 0.4 },
      rollbackAllocations: { Blend: 0.5, Soroswap: 0.5 },
      source: "explicit",
    });

    expect(preview.changes.find((c) => c.vaultId === "Blend")?.deltaWeight).toBe(-0.1);
    expect(preview.noOp).toBe(false);
  });

  it("rejects weights that do not sum to 100 or 1 with a typed error", () => {
    let caught: unknown;
    try {
      buildAllocationRollbackPreview({
        vaultId: "vault-1",
        currentAllocations: { Blend: 60, Soroswap: 30 },
        rollbackAllocations: { Blend: 50, Soroswap: 50 },
        source: "explicit",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AllocationRollbackPreviewError);
    const typed = caught as AllocationRollbackPreviewError;
    expect(typed.code).toBe("ALLOCATIONS_MUST_SUM_100");
    expect(typed.statusCode).toBe(400);
    expect(typed.details?.actualSum).toBe(90);
  });

  it("rejects mixed percent/fraction scales", () => {
    expect(() =>
      buildAllocationRollbackPreview({
        vaultId: "vault-1",
        currentAllocations: { Blend: 60, Soroswap: 40 },
        rollbackAllocations: { Blend: 0.5, Soroswap: 0.5 },
        source: "explicit",
      }),
    ).toThrow(/same scale/);
  });

  it("rejects non-finite or negative weights and non-object inputs", () => {
    expect(() =>
      buildAllocationRollbackPreview({
        vaultId: "vault-1",
        currentAllocations: { Blend: Number.NaN, Soroswap: 40 },
        rollbackAllocations: { Blend: 40, Soroswap: 60 },
        source: "explicit",
      }),
    ).toThrow(AllocationRollbackPreviewError);

    expect(() =>
      buildAllocationRollbackPreview({
        vaultId: "vault-1",
        currentAllocations: "not-an-object",
        rollbackAllocations: { Blend: 40, Soroswap: 60 },
        source: "explicit",
      }),
    ).toThrow(AllocationRollbackPreviewError);

    expect(() =>
      buildAllocationRollbackPreview({
        vaultId: "   ",
        currentAllocations: current,
        rollbackAllocations: rollback,
        source: "explicit",
      }),
    ).toThrow(/vaultId/);
  });

  it("flags conflicting active queue entries whose targets differ from the rollback", () => {
    const preview = buildAllocationRollbackPreview({
      vaultId: "vault-1",
      currentAllocations: { Blend: 60, Soroswap: 40 },
      rollbackAllocations: { Blend: 40, Soroswap: 60 },
      source: "pending-rebalance",
      otherActiveEntries: [
        { id: "entry-match", targetAllocations: { Soroswap: 60, Blend: 40 } },
        { id: "entry-other", targetAllocations: { Blend: 70, Soroswap: 30 } },
        { id: "entry-invalid", targetAllocations: { Blend: 999 } },
      ],
    });

    expect(preview.conflictingQueueEntryIds).toEqual(["entry-invalid", "entry-other"]);
    expect(preview.safe).toBe(false);
  });
});

// ── HTTP route contract ─────────────────────────────────────────────────────

describe("allocation rollback preview routes (#1360)", () => {
  function buildApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use("/api/vaults", allocationRollbackPreviewRouter);
    return app;
  }

  it("POST returns a deterministic preview for explicit allocations", async () => {
    const app = buildApp();
    const body = {
      currentAllocations: { Blend: 60, Soroswap: 40 },
      rollbackAllocations: { Blend: 40, Soroswap: 60 },
      rollbackReason: "manual rollback",
    };

    const first = await request(app)
      .post("/api/vaults/vault-1/allocation-rollback-preview")
      .send(body)
      .expect(200);

    expect(first.body).toMatchObject({
      vaultId: "vault-1",
      source: "explicit",
      noOp: false,
      safe: true,
      rollbackReason: "manual rollback",
    });
    expect(first.body.changes).toHaveLength(2);

    const second = await request(app)
      .post("/api/vaults/vault-1/allocation-rollback-preview")
      .send(body)
      .expect(200);

    expect(second.body.inputHash).toBe(first.body.inputHash);
  });

  it("POST without rollbackAllocations returns a typed 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/vaults/vault-1/allocation-rollback-preview")
      .send({ currentAllocations: { Blend: 60, Soroswap: 40 } })
      .expect(400);

    expect(res.body).toMatchObject({
      error: "INVALID_REQUEST",
      message: expect.stringContaining("rollbackAllocations"),
    });
  });

  it("POST with unbalanced allocations returns typed ALLOCATIONS_MUST_SUM_100", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/vaults/vault-1/allocation-rollback-preview")
      .send({
        currentAllocations: { Blend: 60, Soroswap: 30 },
        rollbackAllocations: { Blend: 40, Soroswap: 60 },
      })
      .expect(400);

    expect(res.body.error).toBe("ALLOCATIONS_MUST_SUM_100");
    expect(res.body.details).toMatchObject({ field: "currentAllocations", actualSum: 90 });
  });

  it("POST without currentAllocations and without a pending entry returns typed 404", async () => {
    const app = buildApp();
    // No database context is available in this isolated app (Prisma load
    // fails best-effort), so the route must report NO_PENDING_REBALANCE
    // instead of crashing or falling back to raw errors.
    const res = await request(app)
      .post("/api/vaults/vault-1/allocation-rollback-preview")
      .send({ rollbackAllocations: { Blend: 40, Soroswap: 60 } })
      .expect(404);

    expect(res.body.error).toBe("NO_PENDING_REBALANCE");
    expect(typeof res.body.message).toBe("string");
  });

  it("GET without a pending entry returns typed 404 (empty state)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/vaults/vault-1/allocation-rollback-preview")
      .expect(404);

    expect(res.body.error).toBe("NO_PENDING_REBALANCE");
  });
});
