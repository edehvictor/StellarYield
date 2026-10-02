import { Router, Request, Response } from "express";
import {
  AllocationRollbackPreviewError,
  buildAllocationRollbackPreview,
  loadVaultQueueContext,
} from "../services/allocationRollbackPreviewService";
import { sendError } from "../utils/errorResponse";
import type { AllocationRollbackSource } from "../../../shared/types/allocationRollback";

/**
 * Vault allocation rollback preview routes (#1360).
 *
 * GET  /api/vaults/:vaultId/allocation-rollback-preview
 *   Derives a preview from the vault's latest pending rebalance queue entry:
 *   rolling back from the entry's target weights to its pre-rebalance
 *   current weights. 404 NO_PENDING_REBALANCE when there is nothing to roll.
 *
 * POST /api/vaults/:vaultId/allocation-rollback-preview
 *   Ad-hoc preview from explicit allocation maps in the body:
 *     { currentAllocations?, rollbackAllocations, rollbackReason? }
 *   When `currentAllocations` is omitted the pending queue entry supplies it.
 *
 * Both routes are read-only and deterministic: identical inputs always
 * produce a byte-identical preview (same ordering, rounding, and inputHash).
 * Failures are stable typed codes via `sendError`, never raw provider output.
 */

const allocationRollbackPreviewRouter = Router({ mergeParams: true });

function sendPreviewError(res: Response, err: unknown): void {
  if (err instanceof AllocationRollbackPreviewError) {
    sendError(
      res,
      err.statusCode,
      err.code,
      err.message,
      err.details,
      undefined,
      false,
    );
    return;
  }
  sendError(
    res,
    500,
    "ROLLBACK_PREVIEW_FAILED",
    "Failed to generate allocation rollback preview.",
  );
}

function readVaultId(req: Request, res: Response): string | null {
  const vaultId = typeof req.params.vaultId === "string" ? req.params.vaultId.trim() : "";
  if (vaultId.length === 0) {
    sendError(res, 400, "INVALID_VAULT_ID", "vaultId path parameter is required.");
    return null;
  }
  return vaultId;
}

function readReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

allocationRollbackPreviewRouter.get(
  "/:vaultId/allocation-rollback-preview",
  async (req: Request, res: Response): Promise<void> => {
    const vaultId = readVaultId(req, res);
    if (vaultId === null) return;

    try {
      const context = await loadVaultQueueContext(vaultId);
      if (!context) {
        sendError(
          res,
          404,
          "NO_PENDING_REBALANCE",
          `No pending rebalance found for vault "${vaultId}". POST explicit allocations to preview an ad-hoc rollback.`,
        );
        return;
      }

      const preview = buildAllocationRollbackPreview({
        vaultId,
        currentAllocations: context.pending.targetAllocations,
        rollbackAllocations: context.pending.currentAllocations,
        source: "pending-rebalance" as AllocationRollbackSource,
        rollbackReason: readReason(req.query.reason),
        otherActiveEntries: context.activeEntries
          .filter((entry) => entry.id !== context.pending.id)
          .map((entry) => ({ id: entry.id, targetAllocations: entry.targetAllocations })),
      });

      res.json(preview);
    } catch (err) {
      sendPreviewError(res, err);
    }
  },
);

allocationRollbackPreviewRouter.post(
  "/:vaultId/allocation-rollback-preview",
  async (req: Request, res: Response): Promise<void> => {
    const vaultId = readVaultId(req, res);
    if (vaultId === null) return;

    const body = (req.body ?? {}) as {
      currentAllocations?: unknown;
      rollbackAllocations?: unknown;
      rollbackReason?: unknown;
    };

    if (body.rollbackAllocations === undefined) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "rollbackAllocations is required in the request body.",
      );
      return;
    }

    try {
      // Best-effort queue lookup: supplies a missing `currentAllocations`
      // and enables conflict detection. Explicit bodies work without a DB.
      const context = await loadVaultQueueContext(vaultId);

      let currentAllocations = body.currentAllocations;
      let source: AllocationRollbackSource = "explicit";

      if (currentAllocations === undefined) {
        if (!context) {
          sendError(
            res,
            404,
            "NO_PENDING_REBALANCE",
            `No pending rebalance found for vault "${vaultId}"; currentAllocations is required in the request body.`,
          );
          return;
        }
        currentAllocations = context.pending.targetAllocations;
        source = "pending-rebalance";
      }

      const preview = buildAllocationRollbackPreview({
        vaultId,
        currentAllocations,
        rollbackAllocations: body.rollbackAllocations,
        source,
        rollbackReason: readReason(body.rollbackReason),
        otherActiveEntries: (context?.activeEntries ?? [])
          .filter((entry) => entry.id !== context?.pending.id)
          .map((entry) => ({ id: entry.id, targetAllocations: entry.targetAllocations })),
      });

      res.json(preview);
    } catch (err) {
      sendPreviewError(res, err);
    }
  },
);

export default allocationRollbackPreviewRouter;
