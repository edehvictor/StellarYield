import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import {
  PortfolioReconcileService,
  staticPositionSource,
  type PortfolioPosition,
  type ReconciliationResult,
} from "../services/portfolioReconcileService";
import {
  RECONCILE_CAUSES,
  RECONCILE_CAUSE_ORDER,
} from "../../../shared/types/reconcileCause";

const router = Router();

/**
 * The reconciler persists through Prisma. When the client is not generated the
 * cache read returns nothing and the upsert is a no-op, which is the right
 * behaviour for a read-only reconciliation over supplied snapshots — it must
 * not fail just because there is no database to write the cache back to.
 */
interface VaultBalanceDelegate {
  findUnique(opts: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  upsert(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
}

let cachedDelegate: VaultBalanceDelegate | null = null;

async function loadVaultBalanceDelegate(): Promise<VaultBalanceDelegate> {
  if (cachedDelegate) return cachedDelegate;

  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => { vaultBalance?: VaultBalanceDelegate };
    };
    const client = prismaModule.PrismaClient ? new prismaModule.PrismaClient() : null;
    if (client?.vaultBalance) {
      cachedDelegate = client.vaultBalance;
      return cachedDelegate;
    }
  } catch {
    // Fall through to the no-op delegate below.
  }

  cachedDelegate = {
    async findUnique() {
      return null;
    },
    async upsert() {
      return {};
    },
  };
  return cachedDelegate;
}

/** Parses one position, returning null when a required field is missing or invalid. */
function parsePosition(raw: unknown): PortfolioPosition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { assetId, amount, vaultId, protocol } = raw as Record<string, unknown>;

  if (typeof assetId !== "string" || assetId.trim() === "") return null;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;

  return {
    assetId: assetId.trim(),
    amount,
    vaultId: typeof vaultId === "string" && vaultId.trim() !== "" ? vaultId.trim() : "unknown",
    protocol:
      typeof protocol === "string" && protocol.trim() !== "" ? protocol.trim() : "unknown",
  };
}

function parsePositions(raw: unknown): { positions: PortfolioPosition[]; invalid: number } {
  if (!Array.isArray(raw)) return { positions: [], invalid: 0 };

  const positions: PortfolioPosition[] = [];
  let invalid = 0;
  for (const entry of raw) {
    const parsed = parsePosition(entry);
    if (parsed) positions.push(parsed);
    else invalid += 1;
  }
  return { positions, invalid };
}

/** Shapes a reconciliation for the wire: causes first, then the raw diff. */
function toResponse(result: ReconciliationResult) {
  return {
    status: result.status,
    primaryCause: result.primaryCause,
    causeCounts: result.causeCounts,
    causes: result.causes,
    symbolDrifts: result.symbolDrifts,
    isStale: result.isStale,
    staleDurationMs: result.staleDurationMs,
    projectionVersion: result.projectionVersion,
    projectionCheckpoint: result.projectionCheckpoint,
    changes: result.changes,
    mismatches: result.mismatches,
    orphanedTransactions: result.orphanedTransactions,
    duplicatePositions: result.duplicatePositions,
    concentration: result.concentration,
    sourceOfTruth: result.sourceOfTruth,
    timestamp: result.timestamp.toISOString(),
  };
}

/**
 * GET /api/portfolio/reconcile/causes
 *
 * The cause taxonomy, in triage order. Lets an operator (or a support script)
 * read what a code means without the UI bundle.
 */
router.get("/causes", (_req: Request, res: Response) => {
  res.json({
    order: RECONCILE_CAUSE_ORDER,
    causes: RECONCILE_CAUSE_ORDER.map((code) => RECONCILE_CAUSES[code]),
  });
});

/**
 * POST /api/portfolio/reconcile
 *
 * Body: {
 *   walletAddress: string,
 *   chainPositions?: PortfolioPosition[],
 *   cachedPositions?: PortfolioPosition[],
 *   lastLedger?: { ledger: number, processedAt: string },
 *   projectionVersion?: number
 * }
 *
 * Reconciles a wallet and returns the named causes of anything that did not
 * come out clean. When both position lists are supplied the reconciliation runs
 * over that snapshot; otherwise it reads the service's live sources.
 */
router.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const walletAddress = body.walletAddress;

  if (typeof walletAddress !== "string" || walletAddress.trim() === "") {
    return sendError(
      res,
      400,
      "INVALID_REQUEST",
      "Request body must include a non-empty `walletAddress`.",
    );
  }

  const hasSnapshot =
    Array.isArray(body.chainPositions) && Array.isArray(body.cachedPositions);

  const chain = parsePositions(body.chainPositions);
  const cached = parsePositions(body.cachedPositions);

  if (hasSnapshot && chain.invalid + cached.invalid > 0) {
    return sendError(
      res,
      400,
      "INVALID_POSITION",
      `${chain.invalid + cached.invalid} position(s) are missing a string \`assetId\` or a finite numeric \`amount\`.`,
    );
  }

  let lastLedger: { ledger: number; processedAt: Date } | undefined;
  if (typeof body.lastLedger === "object" && body.lastLedger !== null) {
    const { ledger, processedAt } = body.lastLedger as Record<string, unknown>;
    const processedAtMs = Date.parse(String(processedAt));

    if (!Number.isFinite(processedAtMs)) {
      return sendError(
        res,
        400,
        "INVALID_LEDGER",
        "`lastLedger.processedAt` must be a parseable date.",
      );
    }
    lastLedger = {
      ledger: typeof ledger === "number" && Number.isFinite(ledger) ? ledger : 0,
      processedAt: new Date(processedAtMs),
    };
  }

  try {
    const vaultBalance = await loadVaultBalanceDelegate();
    const service = new PortfolioReconcileService(
      { vaultBalance },
      undefined,
      hasSnapshot
        ? staticPositionSource({
            chainPositions: chain.positions,
            cachedPositions: cached.positions,
            ...(typeof body.projectionVersion === "number"
              ? { projectionVersion: body.projectionVersion }
              : {}),
            ...(lastLedger ? { lastLedger } : {}),
          })
        : undefined,
    );

    const result = await service.reconcilePortfolio(walletAddress.trim(), true);
    res.status(200).json(toResponse(result));
  } catch (error) {
    console.error("Failed to reconcile portfolio.", error);
    sendError(
      res,
      500,
      "RECONCILE_FAILED",
      "Unable to reconcile this portfolio right now.",
      error instanceof Error ? error.message : undefined,
    );
  }
});

export default router;
