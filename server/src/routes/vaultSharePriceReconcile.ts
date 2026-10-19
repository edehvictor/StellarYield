/**
 * Vault share-price reconciliation route.
 *
 * POST /api/vaults/:vaultId/share-price/reconcile
 *   Reconciles the share price reconstructed from a contract event log against
 *   the backend cache snapshot. Accepts a supplied `cachedSnapshot` for
 *   deterministic one-off checks; when omitted the backend cache is loaded
 *   through the service's cache loader.
 *
 * GET /api/vaults/:vaultId/share-price/reconcile/history
 *   Returns previously persisted reconciliation runs for the vault.
 *
 * Error states are deterministic and code-tagged (see VaultSharePriceError);
 * the handler never parses a raw provider message to decide the response.
 */

import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import {
  errorCodeToStatus,
  VaultSharePriceError,
  VaultSharePriceReconciliationService,
} from "../services/vaultSharePriceReconciliationService";
import {
  VAULT_SHARE_PRICE_EVENT_TYPES,
  type CachedSharePrice,
  type SharePriceReconStatus,
  type VaultSharePriceEvent,
  type VaultSharePriceEventType,
} from "../../../shared/types/vaultSharePrice";

const RECON_STATUSES: readonly SharePriceReconStatus[] = ["success", "partial", "failed"];

/** True when the parsed body field passes its basic shape check. */
function isValidIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Serialize a reconciliation result to a JSON-safe value: bigint totals and
 * deltas (which cannot round-trip `JSON.stringify` on their own) are collapsed
 * to decimal strings so the API never responds with a 500 from a BigInt.
 */
function toJSONSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, val): unknown =>
      typeof val === "bigint" ? val.toString() : val,
    ),
  );
}

/** Validate a single event shape; returns null when valid, an error message otherwise. */
function validateEvent(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return "Each event must be an object.";
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.vaultId !== "string" || e.vaultId.trim() === "") {
    return "Each event requires a non-empty string `vaultId`.";
  }
  if (
    typeof e.eventType !== "string" ||
    !VAULT_SHARE_PRICE_EVENT_TYPES.includes(e.eventType as VaultSharePriceEventType)
  ) {
    return `Each event requires a valid \`eventType\` (one of ${[...VAULT_SHARE_PRICE_EVENT_TYPES].join(", ")}).`;
  }
  if (!isValidIntegerString(e.amount)) {
    return "Each event requires a non-negative integer-string `amount`.";
  }
  if (!Number.isInteger(e.ledger) || (e.ledger as number) < 0) {
    return "Each event requires a non-negative integer `ledger`.";
  }
  if (typeof e.txHash !== "string" || e.txHash.trim() === "") {
    return "Each event requires a non-empty string `txHash`.";
  }
  if (!Number.isInteger(e.eventIndex) || (e.eventIndex as number) < 0) {
    return "Each event requires a non-negative integer `eventIndex`.";
  }
  if (e.shares !== undefined && !isValidIntegerString(e.shares)) {
    return "If present, `shares` must be a non-negative integer-string.";
  }
  if (e.keeperFee !== undefined && !isValidIntegerString(e.keeperFee)) {
    return "If present, `keeperFee` must be a non-negative integer-string.";
  }
  return null;
}

function validateCachedSnapshot(raw: unknown): CachedSharePrice | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;

  const isFiniteNum = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);

  // All three totals are required: defaulting a missing total to 0 would be
  // reported as a critical drift that never existed.
  if (
    !isFiniteNum(c.sharePrice) ||
    !isFiniteNum(c.totalShares) ||
    !isFiniteNum(c.totalAssets)
  ) {
    return null;
  }

  return {
    vaultId:
      typeof c.vaultId === "string" && c.vaultId.trim() !== ""
        ? c.vaultId.trim()
        : "",
    sharePrice: c.sharePrice,
    totalShares: c.totalShares,
    totalAssets: c.totalAssets,
    snapshotAt:
      typeof c.snapshotAt === "string" &&
      !Number.isNaN(Date.parse(c.snapshotAt))
        ? c.snapshotAt
        : new Date().toISOString(),
    ...(typeof c.projectionVersion === "number"
      ? { projectionVersion: c.projectionVersion }
      : {}),
    ...(typeof c.lastLedger === "number"
      ? { lastLedger: c.lastLedger }
      : {}),
    ...(typeof c.projectionAgeMs === "number"
      ? { projectionAgeMs: c.projectionAgeMs }
      : {}),
  };
}

/**
 * Build the reconciliation router. Injecting the service lets tests stub the
 * cache loader (and history store) without a running database.
 */
export function createVaultSharePriceReconcileRouter(
  service: VaultSharePriceReconciliationService = new VaultSharePriceReconciliationService(),
): ReturnType<typeof Router> {
  const router = Router({ mergeParams: true });

  router.post(
    "/:vaultId/share-price/reconcile",
    async (req: Request, res: Response) => {
      const vaultId = String(req.params.vaultId ?? "").trim();
      if (vaultId === "") {
        return sendError(
          res,
          400,
          "MALFORMED_INPUT",
          "Path parameter `vaultId` is required.",
        );
      }

      const body = (req.body ?? {}) as Record<string, unknown>;

      if (!Array.isArray(body.events)) {
        return sendError(
          res,
          400,
          "MALFORMED_INPUT",
          "Request body must include an array of contract `events`.",
        );
      }

      for (let i = 0; i < body.events.length; i += 1) {
        const problem = validateEvent(body.events[i]);
        if (problem !== null) {
          return sendError(
            res,
            400,
            "INVALID_EVENT",
            `Event #${i} is invalid: ${problem}`,
          );
        }
        const eventVaultId = (body.events[i] as { vaultId: string }).vaultId;
        if (eventVaultId !== vaultId) {
          return sendError(
            res,
            400,
            "INVALID_EVENT",
            `Event #${i} belongs to vault "${eventVaultId}", not "${vaultId}".`,
          );
        }
      }

      const cachedRaw = body.cachedSnapshot;
      let cached: CachedSharePrice | undefined;
      if (cachedRaw !== undefined) {
        const parsed = validateCachedSnapshot(cachedRaw);
        if (parsed === null) {
          return sendError(
            res,
            400,
            "MALFORMED_INPUT",
            "If provided, `cachedSnapshot` must include a finite numeric `sharePrice`, `totalShares`, and `totalAssets`.",
          );
        }
        cached = parsed;
      }

      try {
        const result = await service.reconcileVault(
          vaultId,
          body.events as VaultSharePriceEvent[],
          cached,
        );
        return res.status(200).json(toJSONSafe(result));
      } catch (error) {
        if (error instanceof VaultSharePriceError) {
          return sendError(
            res,
            errorCodeToStatus[error.code],
            error.code,
            error.message,
          );
        }
        return sendError(
          res,
          500,
          "RECONCILE_FAILED",
          "Unable to reconcile vault share price at this time.",
          error instanceof Error ? error.message : undefined,
        );
      }
    },
  );

  router.get(
    "/:vaultId/share-price/reconcile/history",
    (req: Request, res: Response) => {
      const vaultId = String(req.params.vaultId ?? "").trim();

      const rawLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
        : 50;

      const status = req.query.status
        ? String(req.query.status)
        : undefined;
      if (status !== undefined && !RECON_STATUSES.includes(status as SharePriceReconStatus)) {
        return sendError(
          res,
          400,
          "MALFORMED_INPUT",
          `Query parameter \`status\` must be one of ${RECON_STATUSES.join(", ")}.`,
        );
      }

      // Newest first, so the latest run is always data[0].
      const filtered = service.queryHistory({
        vaultId: vaultId || undefined,
        status: status as SharePriceReconStatus | undefined,
        limit,
      });

      res.json(toJSONSafe({ vaultId, count: filtered.length, limit, data: filtered }));
    },
  );

  return router;
}

export default createVaultSharePriceReconcileRouter();
