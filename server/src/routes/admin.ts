import { Router, Request, Response } from "express";
import {
  setAuditContext,
  getAuditLogs,
  getAuditStatistics,
  exportAuditLogsToCSV,
  verifyAuditTrailIntegrity,
  recordAdminConfirmation,
  recordCancelledAction,
} from "../middleware/audit";
import { uploadVaultMetadata } from "../services/ipfs/vaultMetadataService";
import { freezeService } from "../services/freezeService";
import {
  parsePaginationLimit,
  type PaginatedResponse,
} from "../types/pagination";
import { PROTOCOLS } from "../config/protocols";
import { strategyStateTransitionAuditService } from "../services/strategyStateTransitionAuditService";
import { rebalanceSagaService, SAGA_STATE } from "../services/rebalanceSagaService";
import { recoverStuckSagas } from "../services/rebalanceSagaExecutor";

const adminRouter = Router();

/**
 * Admin authentication middleware (implement based on your auth system)
 */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const user = (req as unknown as Record<string, unknown>).user as
    { role?: string } | undefined;

  if (!user || user.role !== "ADMIN") {
    res.status(403).json({ error: "Unauthorized: Admin access required" });
    return;
  }

  next();
}

/**
 * Update vault parameters
 * POST /api/admin/vaults/:vaultId/parameters
 */
adminRouter.post(
  "/vaults/:vaultId/parameters",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;
      const changes = req.body;

      // Set audit context before processing
      setAuditContext(req, {
        action: "UPDATE_VAULT_PARAMETERS",
        resource: "VAULT",
        resourceId: vaultId,
        changes,
      });

      // TODO: Implement actual vault parameter update logic
      // Example: await updateVaultParameters(vaultId, changes);

      res.json({
        success: true,
        message: `Vault ${vaultId} parameters updated`,
        vaultId,
        changes,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to update vault parameters",
      });
    }
  },
);

/**
 * Upload vault metadata to IPFS and return metadata URI for contract updates
 * POST /api/admin/vaults/:vaultId/metadata
 */
adminRouter.post(
  "/vaults/:vaultId/metadata",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;
      const { vaultName, description, iconSvg } = req.body as {
        vaultName?: string;
        description?: string;
        iconSvg?: string;
      };

      if (!vaultName || !description || !iconSvg) {
        res.status(400).json({
          error: "vaultName, description, and iconSvg are required",
        });
        return;
      }

      const uploadResult = await uploadVaultMetadata({
        vaultName,
        description,
        iconSvg,
      });

      setAuditContext(req, {
        action: "UPDATE_VAULT_METADATA_URI",
        resource: "VAULT",
        resourceId: vaultId,
        changes: {
          metadataUri: uploadResult.metadataUri,
          cid: uploadResult.cid,
          uploadMode: uploadResult.uploadMode,
        },
      });

      res.json({
        success: true,
        vaultId,
        cid: uploadResult.cid,
        metadataUri: uploadResult.metadataUri,
        iconUri: uploadResult.iconUri,
        uploadMode: uploadResult.uploadMode,
        metadata: uploadResult.metadata,
        transactionPayload: {
          method: "set_metadata_uri",
          args: {
            vaultId,
            metadataUri: uploadResult.metadataUri,
          },
        },
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to upload vault metadata",
      });
    }
  },
);

/**
 * Pause vault
 * POST /api/admin/vaults/:vaultId/pause
 */
adminRouter.post(
  "/vaults/:vaultId/pause",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;
      const { reason } = req.body;

      setAuditContext(req, {
        action: "PAUSE_VAULT",
        resource: "VAULT",
        resourceId: vaultId,
        changes: { reason },
      });

      // TODO: Implement actual vault pause logic
      // Example: await pauseVault(vaultId, reason);

      res.json({
        success: true,
        message: `Vault ${vaultId} paused`,
        vaultId,
        reason,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to pause vault",
      });
    }
  },
);

/**
 * Resume vault
 * POST /api/admin/vaults/:vaultId/resume
 */
adminRouter.post(
  "/vaults/:vaultId/resume",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;

      setAuditContext(req, {
        action: "RESUME_VAULT",
        resource: "VAULT",
        resourceId: vaultId,
      });

      // TODO: Implement actual vault resume logic
      // Example: await resumeVault(vaultId);

      res.json({
        success: true,
        message: `Vault ${vaultId} resumed`,
        vaultId,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to resume vault",
      });
    }
  },
);

/**
 * Update fee configuration
 * POST /api/admin/fees/config
 */
adminRouter.post(
  "/fees/config",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const changes = req.body;

      setAuditContext(req, {
        action: "UPDATE_FEE_CONFIG",
        resource: "FEE_CONFIG",
        changes,
      });

      // TODO: Implement actual fee config update logic
      // Example: await updateFeeConfig(changes);

      res.json({
        success: true,
        message: "Fee configuration updated",
        changes,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to update fee configuration",
      });
    }
  },
);

/**
 * Update risk parameters
 * POST /api/admin/risk/parameters
 */
adminRouter.post(
  "/risk/parameters",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const changes = req.body;

      setAuditContext(req, {
        action: "UPDATE_RISK_PARAMETERS",
        resource: "RISK_CONFIG",
        changes,
      });

      // TODO: Implement actual risk parameter update logic
      // Example: await updateRiskParameters(changes);

      res.json({
        success: true,
        message: "Risk parameters updated",
        changes,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to update risk parameters",
      });
    }
  },
);

/**
 * Get audit logs
 * GET /api/admin/audit-logs
 */
adminRouter.get(
  "/audit-logs",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, action, resource, startDate, endDate, limit, cursor } =
        req.query;

      const effectiveLimit = parsePaginationLimit(limit);

      const logs = await getAuditLogs({
        userId: userId as string,
        action: action as string,
        resource: resource as string,
        startDate: startDate as string,
        endDate: endDate as string,
        limit: effectiveLimit + 1,
        cursor: cursor as string | undefined,
      });

      const hasMore = logs.length > effectiveLimit;
      const page = hasMore ? logs.slice(0, effectiveLimit) : logs;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      const response: PaginatedResponse<(typeof page)[0]> = {
        data: page,
        pagination: { nextCursor, hasMore, limit: effectiveLimit },
      };

      res.json(response);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve audit logs",
      });
    }
  },
);

/**
 * Get audit statistics
 * GET /api/admin/audit-stats
 */
adminRouter.get(
  "/audit-stats",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getAuditStatistics();

      res.json({
        success: true,
        stats,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve audit statistics",
      });
    }
  },
);

/**
 * Export audit logs as CSV
 * GET /api/admin/audit-logs/export
 */
adminRouter.get(
  "/audit-logs/export",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, action, resource, startDate, endDate } = req.query;

      const csv = await exportAuditLogsToCSV({
        userId: userId as string,
        action: action as string,
        resource: resource as string,
        startDate: startDate as string,
        endDate: endDate as string,
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="audit-logs.csv"',
      );
      res.send(csv);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to export audit logs",
      });
    }
  },
);

/**
 * Verify audit trail integrity
 * GET /api/admin/audit-verify
 */
adminRouter.get(
  "/audit-verify",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const logs = await getAuditLogs({ limit: 10000 });
      const verification = verifyAuditTrailIntegrity(logs);

      res.json({
        success: true,
        isValid: verification.isValid,
        totalEntries: logs.length,
        invalidEntries: verification.invalidEntries,
        message: verification.isValid
          ? "Audit trail integrity verified"
          : `Found ${verification.invalidEntries.length} invalid entries`,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to verify audit trail",
      });
    }
  },
);

/**
 * Revoke user access
 * POST /api/admin/users/:userId/revoke-access
 */
adminRouter.post(
  "/users/:userId/revoke-access",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const { reason } = req.body;

      setAuditContext(req, {
        action: "REVOKE_USER_ACCESS",
        resource: "USER",
        resourceId: userId,
        changes: { reason },
      });

      // TODO: Implement actual user access revocation logic
      // Example: await revokeUserAccess(userId, reason);

      res.json({
        success: true,
        message: `Access revoked for user ${userId}`,
        userId,
        reason,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to revoke user access",
      });
    }
  },
);

/**
 * Grant user access
 * POST /api/admin/users/:userId/grant-access
 */
adminRouter.post(
  "/users/:userId/grant-access",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const { role, permissions } = req.body;

      setAuditContext(req, {
        action: "GRANT_USER_ACCESS",
        resource: "USER",
        resourceId: userId,
        changes: { role, permissions },
      });

      // TODO: Implement actual user access grant logic
      // Example: await grantUserAccess(userId, role, permissions);

      res.json({
        success: true,
        message: `Access granted for user ${userId}`,
        userId,
        role,
        permissions,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to grant user access",
      });
    }
  },
);

/**
 * Global or protocol-specific recommendation freeze
 * POST /api/admin/recommendations/freeze
 */
adminRouter.post(
  "/recommendations/freeze",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { protocol, reason } = req.body;
      const actor =
        (req as unknown as { user?: { id: string } }).user?.id || "admin";

      let state;
      if (protocol) {
        state = await freezeService.freezeProtocol(protocol, reason, actor);

        // #371 operator intervention: record lifecycle transition to frozen.
        try {
          strategyStateTransitionAuditService.recordOperatorIntervention(
            String(protocol).toLowerCase(),
            "frozen",
            `freeze_reason=${reason}`,
            actor,
          );
        } catch (err) {
          console.warn("Failed to record frozen transition:", err);
        }
      } else {
        state = await freezeService.freezeGlobal(reason, actor);

        // #371 operator intervention: record frozen transition for all known strategies.
        for (const p of PROTOCOLS) {
          try {
            strategyStateTransitionAuditService.recordOperatorIntervention(
              p.protocolName.toLowerCase(),
              "frozen",
              `freeze_reason=${reason}`,
              actor,
            );
          } catch {
            // Best-effort only; never break the admin endpoint.
          }
        }
      }

      setAuditContext(req, {
        action: "FREEZE_RECOMMENDATIONS",
        resource: protocol ? "PROTOCOL" : "GLOBAL",
        resourceId: protocol || "GLOBAL",
        changes: { reason },
      });

      res.json({ success: true, state });
    } catch {
      res.status(500).json({ error: "Failed to freeze recommendations" });
    }
  },
);

/**
 * Global or protocol-specific recommendation resume
 * POST /api/admin/recommendations/resume
 */
adminRouter.post(
  "/recommendations/resume",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { protocol } = req.body;
      const actor =
        (req as unknown as { user?: { id: string } }).user?.id || "admin";

      let state;
      if (protocol) {
        state = await freezeService.resumeProtocol(protocol, actor);

        // #371 operator intervention: record lifecycle transition to recovered.
        try {
          strategyStateTransitionAuditService.recordOperatorIntervention(
            String(protocol).toLowerCase(),
            "recovered",
            "resume_reason=operator",
            actor,
          );
        } catch (err) {
          console.warn("Failed to record recovered transition:", err);
        }
      } else {
        state = await freezeService.resumeGlobal(actor);

        for (const p of PROTOCOLS) {
          try {
            strategyStateTransitionAuditService.recordOperatorIntervention(
              p.protocolName.toLowerCase(),
              "recovered",
              "resume_reason=operator",
              actor,
            );
          } catch {
            // Best-effort only; never break the admin endpoint.
          }
        }
      }

      setAuditContext(req, {
        action: "RESUME_RECOMMENDATIONS",
        resource: protocol ? "PROTOCOL" : "GLOBAL",
        resourceId: protocol || "GLOBAL",
      });

      res.json({ success: true, state });
    } catch {
      res.status(500).json({ error: "Failed to resume recommendations" });
    }
  },
);

/**
 * Record a successful admin confirmation after an action is applied.
 * POST /api/admin/confirm
 *
 * Body:
 *   actionType      — e.g. "UPDATE_TREASURY_FEE"
 *   resource        — e.g. "TREASURY", "GOVERNANCE"
 *   resourceId?     — specific id
 *   confirmationText — the text the actor reviewed in the UI
 *   changes?        — the payload that was applied
 */
adminRouter.post(
  "/confirm",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { actionType, resource, resourceId, confirmationText, changes } =
        req.body as {
          actionType?: string;
          resource?: string;
          resourceId?: string;
          confirmationText?: string;
          changes?: Record<string, unknown>;
        };

      if (!actionType || !resource || !confirmationText) {
        res.status(400).json({
          error: "actionType, resource, and confirmationText are required.",
        });
        return;
      }

      const user = (req as unknown as Record<string, unknown>).user as
        { id?: string; email?: string } | undefined;

      const entry = await recordAdminConfirmation({
        actorId: user?.id ?? "ANONYMOUS",
        actorEmail: user?.email,
        actionType,
        resource,
        resourceId,
        confirmationText,
        changes,
        ipAddress:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ??
          req.socket.remoteAddress ??
          "UNKNOWN",
        userAgent: req.headers["user-agent"] ?? "UNKNOWN",
 * GET /api/admin/rebalance-sagas
 * List rebalance sagas with optional filters.
 */
adminRouter.get(
  "/rebalance-sagas",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId, state, limit, offset } = req.query;

      const result = await rebalanceSagaService.listSagas({
        vaultId: vaultId as string | undefined,
        state: state as (typeof SAGA_STATE)[keyof typeof SAGA_STATE] | undefined,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });

      res.json({
        success: true,
        auditId: entry.id,
        timestamp: entry.timestamp,
      });
        data: result.sagas,
        total: result.total,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to list rebalance sagas",
      });
    }
  },
);

/**
 * GET /api/admin/rebalance-sagas/:sagaId
 * Get detailed saga state with checkpoints and retry history.
 */
adminRouter.get(
  "/rebalance-sagas/:sagaId",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sagaId } = req.params;
      const result = await rebalanceSagaService.getSagaWithHistory(sagaId);

      if (!result) {
        res.status(404).json({ error: `Saga ${sagaId} not found` });
        return;
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to get saga details",
      });
    }
  },
);

/**
 * POST /api/admin/rebalance-sagas/:sagaId/cancel
 * Cancel a saga.
 */
adminRouter.post(
  "/rebalance-sagas/:sagaId/cancel",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sagaId } = req.params;
      const { reason } = req.body as { reason?: string };

      const saga = await rebalanceSagaService.cancelSaga(
        sagaId,
        reason ?? "Cancelled by admin",
      );

      setAuditContext(req, {
        action: "CANCEL_REBALANCE_SAGA",
        resource: "REBALANCE_SAGA",
        resourceId: sagaId,
        changes: { reason },
      });

      res.json({ success: true, data: saga });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to record admin confirmation.",
      });
    }
  },
);

/**
 * Record that an admin cancelled an action without applying changes.
 * POST /api/admin/cancel
 *
 * Body:
 *   actionType          — the action that was cancelled
 *   resource            — resource category
 *   resourceId?         — specific resource id
 *   cancellationReason? — optional note
 */
adminRouter.post(
  "/cancel",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { actionType, resource, resourceId, cancellationReason } =
        req.body as {
          actionType?: string;
          resource?: string;
          resourceId?: string;
          cancellationReason?: string;
        };

      if (!actionType || !resource) {
        res.status(400).json({
          error: "actionType and resource are required.",
        });
        return;
      }

      const user = (req as unknown as Record<string, unknown>).user as
        { id?: string; email?: string } | undefined;

      const entry = await recordCancelledAction({
        actorId: user?.id ?? "ANONYMOUS",
        actorEmail: user?.email,
        actionType,
        resource,
        resourceId,
        cancellationReason,
        ipAddress:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ??
          req.socket.remoteAddress ??
          "UNKNOWN",
        userAgent: req.headers["user-agent"] ?? "UNKNOWN",
            : "Failed to cancel saga",
      });
    }
  },
);

/**
 * POST /api/admin/rebalance-sagas/:sagaId/resolve-review
 * Resolve a manual review (retry or cancel).
 */
adminRouter.post(
  "/rebalance-sagas/:sagaId/resolve-review",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sagaId } = req.params;
      const { decision, reason } = req.body as {
        decision?: "retry" | "cancel";
        reason?: string;
      };

      if (!decision || !["retry", "cancel"].includes(decision)) {
        res.status(400).json({ error: "decision must be 'retry' or 'cancel'" });
        return;
      }

      const actor = (req as unknown as { user?: { id: string } }).user?.id || "admin";
      const saga = await rebalanceSagaService.resolveManualReview(
        sagaId,
        decision,
        actor,
        reason,
      );

      setAuditContext(req, {
        action: "RESOLVE_REBALANCE_SAGA_REVIEW",
        resource: "REBALANCE_SAGA",
        resourceId: sagaId,
        changes: { decision, reason },
      });

      res.json({ success: true, data: saga });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to resolve saga review",
      });
    }
  },
);

/**
 * POST /api/admin/rebalance-sagas/recover
 * Recover stuck sagas (expired locks, interrupted executions).
 */
adminRouter.post(
  "/rebalance-sagas/recover",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const workerId = `admin-${Date.now()}`;
      const result = await recoverStuckSagas(workerId);

      setAuditContext(req, {
        action: "RECOVER_REBALANCE_SAGAS",
        resource: "REBALANCE_SAGA",
        changes: { recovered: result.recovered },
      });

      res.json({
        success: true,
        auditId: entry.id,
        timestamp: entry.timestamp,
        recovered: result.recovered,
        sagas: result.sagas,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to record cancelled action.",
            : "Failed to recover stuck sagas",
      });
    }
  },
);

export default adminRouter;
