/**
 * Deterministic vault allocation rollback preview (#1360).
 *
 * Produces a read-only, byte-stable diff between a vault's current allocation
 * weights and the weights a rollback would restore. Identical inputs always
 * produce an identical preview: keys are sorted byte-wise, weights use fixed
 * 4-decimal rounding, and no wall-clock time or random values are embedded.
 * The only ordering-sensitive value is `inputHash`, a SHA-256 over the
 * canonical inputs.
 *
 * Inputs may use either percent scale (sums to 100) or fraction scale
 * (sums to 1) — but both maps must agree on the scale, otherwise a typed
 * error is raised instead of producing a misleading diff.
 */

import crypto from "crypto";
import type {
  AllocationRollbackChange,
  AllocationRollbackPreview,
  AllocationRollbackSource,
} from "../../../shared/types/allocationRollback";

/** Allowed absolute deviation when validating an allocation sum. */
export const ALLOCATION_SUM_TOLERANCE = 0.01;
/** Fixed decimal places used for every emitted weight. */
export const WEIGHT_DECIMAL_PLACES = 4;

/**
 * Typed failure for rollback preview construction. Carries a stable machine
 * code and HTTP status so routes can map it without string parsing.
 */
export class AllocationRollbackPreviewError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AllocationRollbackPreviewError";
  }
}

export interface BuildAllocationRollbackPreviewParams {
  vaultId: string;
  /** Current weights (percent or fraction scale). */
  currentAllocations: unknown;
  /** Weights the rollback would restore (same scale as current). */
  rollbackAllocations: unknown;
  source: AllocationRollbackSource;
  rollbackReason?: string;
  /**
   * Other active queue entries for the vault (excluding the source entry).
   * Used to flag conflicts — an entry whose targets differ from the rollback
   * state would race this rollback.
   */
  otherActiveEntries?: Array<{ id: string; targetAllocations: unknown }>;
}

/** Deterministic byte-wise string ordering (locale-independent). */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function roundWeight(value: number): number {
  return Math.round(value * 10 ** WEIGHT_DECIMAL_PLACES) / 10 ** WEIGHT_DECIMAL_PLACES;
}

type AllocationScale = "percent" | "fraction";

function sumOf(record: Record<string, number>): number {
  let sum = 0;
  for (const key of Object.keys(record)) {
    sum += record[key];
  }
  return sum;
}

function detectScale(sum: number): AllocationScale | null {
  if (Math.abs(sum - 100) <= ALLOCATION_SUM_TOLERANCE) return "percent";
  if (Math.abs(sum - 1) <= ALLOCATION_SUM_TOLERANCE) return "fraction";
  return null;
}

/**
 * Validate + normalize an allocation map: rejects non-objects, non-finite or
 * negative weights, empty keys, and sums that match neither 100 (percent)
 * nor 1 (fraction).
 */
interface NormalizedAllocations {
  record: Record<string, number>;
  scale: AllocationScale;
}

function normalizeWithScale(value: unknown, field: string): NormalizedAllocations {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AllocationRollbackPreviewError(
      "INVALID_ALLOCATIONS",
      `${field} must be an object mapping allocation keys to weights.`,
      400,
      { field },
    );
  }

  const record: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (key.length === 0) {
      throw new AllocationRollbackPreviewError(
        "INVALID_ALLOCATIONS",
        `${field} contains an empty allocation key.`,
        400,
        { field },
      );
    }
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) {
      throw new AllocationRollbackPreviewError(
        "INVALID_ALLOCATIONS",
        `${field}["${key}"] must be a non-negative finite number.`,
        400,
        { field, key, value: rawValue },
      );
    }
    record[key] = rawValue;
  }

  if (Object.keys(record).length === 0) {
    throw new AllocationRollbackPreviewError(
      "INVALID_ALLOCATIONS",
      `${field} must contain at least one allocation.`,
      400,
      { field },
    );
  }

  const sum = sumOf(record);
  const scale = detectScale(sum);
  if (scale === null) {
    throw new AllocationRollbackPreviewError(
      "ALLOCATIONS_MUST_SUM_100",
      `${field} weights must sum to 100 (percent) or 1 (fraction); got ${roundWeight(sum)}.`,
      400,
      { field, actualSum: roundWeight(sum) },
    );
  }

  return { record, scale };
}

/** Canonicalize a record: rounded values, keys sorted byte-wise. */
function canonicalize(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort(compareKeys)) {
    out[key] = roundWeight(record[key]);
  }
  return out;
}

/**
 * Build a deterministic rollback preview. Pure — no clock, no randomness,
 * no I/O. Throws `AllocationRollbackPreviewError` for invalid inputs.
 */
export function buildAllocationRollbackPreview(
  params: BuildAllocationRollbackPreviewParams,
): AllocationRollbackPreview {
  const vaultId = typeof params.vaultId === "string" ? params.vaultId.trim() : "";
  if (vaultId.length === 0) {
    throw new AllocationRollbackPreviewError(
      "INVALID_VAULT_ID",
      "vaultId must be a non-empty string.",
      400,
    );
  }

  const current = normalizeWithScale(params.currentAllocations, "currentAllocations");
  const rollback = normalizeWithScale(params.rollbackAllocations, "rollbackAllocations");

  if (current.scale !== rollback.scale) {
    throw new AllocationRollbackPreviewError(
      "ALLOCATION_SCALE_MISMATCH",
      "currentAllocations and rollbackAllocations must use the same scale (both percent or both fraction).",
      400,
      { currentScale: current.scale, rollbackScale: rollback.scale },
    );
  }

  const currentCanonical = canonicalize(current.record);
  const rollbackCanonical = canonicalize(rollback.record);

  const allKeys = Array.from(
    new Set([...Object.keys(currentCanonical), ...Object.keys(rollbackCanonical)]),
  ).sort(compareKeys);

  const changes: AllocationRollbackChange[] = allKeys.map((key) => {
    const currentWeight = currentCanonical[key] ?? 0;
    const rollbackWeight = rollbackCanonical[key] ?? 0;
    return {
      vaultId: key,
      currentWeight,
      rollbackWeight,
      deltaWeight: roundWeight(rollbackWeight - currentWeight),
    };
  });

  const totalDeltaWeight = roundWeight(
    changes.reduce((sum, change) => sum + change.deltaWeight, 0),
  );
  const noOp = changes.every((change) => change.deltaWeight === 0);

  // Conflict detection: an active entry whose targets differ from the
  // rollback state would race this rollback. Entries on a different scale
  // or with invalid weights are conservatively treated as conflicts.
  const conflictingQueueEntryIds: string[] = [];
  const rollbackCanonicalJson = JSON.stringify(rollbackCanonical);
  for (const entry of params.otherActiveEntries ?? []) {
    try {
      const entryNormalized = normalizeWithScale(entry.targetAllocations, "targetAllocations");
      if (
        entryNormalized.scale !== rollback.scale ||
        JSON.stringify(canonicalize(entryNormalized.record)) !== rollbackCanonicalJson
      ) {
        conflictingQueueEntryIds.push(entry.id);
      }
    } catch {
      conflictingQueueEntryIds.push(entry.id);
    }
  }
  conflictingQueueEntryIds.sort(compareKeys);

  const rollbackReason =
    typeof params.rollbackReason === "string" && params.rollbackReason.trim().length > 0
      ? params.rollbackReason.trim()
      : undefined;

  const hashInput = JSON.stringify({
    vaultId,
    source: params.source,
    scale: current.scale,
    current: currentCanonical,
    rollback: rollbackCanonical,
    reason: rollbackReason ?? null,
    conflicts: conflictingQueueEntryIds,
  });
  const inputHash = crypto.createHash("sha256").update(hashInput).digest("hex");

  return {
    vaultId,
    source: params.source,
    currentAllocations: currentCanonical,
    rollbackAllocations: rollbackCanonical,
    changes,
    totalDeltaWeight,
    noOp,
    conflictingQueueEntryIds,
    safe: conflictingQueueEntryIds.length === 0,
    ...(rollbackReason !== undefined ? { rollbackReason } : {}),
    inputHash,
  };
}

// ── Queue context loading (best-effort) ─────────────────────────────────────

/** Minimal structural view of an active rebalance queue entry row. */
export interface VaultQueueEntrySummary {
  id: string;
  targetAllocations: Record<string, number>;
}

export interface VaultQueueContext {
  /** Latest active entry (PENDING/PROCESSING/PARTIAL), newest first, if any. */
  pending: VaultQueueEntrySummary & { currentAllocations: Record<string, number> };
  /** All active entries for the vault (newest first), including `pending`. */
  activeEntries: VaultQueueEntrySummary[];
}

type QueueEntryRow = {
  id: string;
  status: string;
  targetAllocations: unknown;
  currentAllocations: unknown;
};

type RollbackQueuePrismaClient = {
  rebalanceQueueEntry: {
    findMany(args: {
      where: { vaultId: string; status: { in: string[] } };
      orderBy: { createdAt: "desc" };
    }): Promise<QueueEntryRow[]>;
  };
  $disconnect?: () => Promise<void>;
};

const ACTIVE_QUEUE_STATUSES = ["PENDING", "PROCESSING", "PARTIAL"];

function asAllocationMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Load the active rebalance queue context for a vault. Best-effort: returns
 * `null` (instead of throwing) when the Prisma client is unavailable so the
 * route can still serve explicit-body previews without a database.
 */
export async function loadVaultQueueContext(
  vaultId: string,
): Promise<VaultQueueContext | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => RollbackQueuePrismaClient;
    };
    if (!prismaModule.PrismaClient) {
      return null;
    }

    const prisma = new prismaModule.PrismaClient() as RollbackQueuePrismaClient;
    const rows = await prisma.rebalanceQueueEntry.findMany({
      where: { vaultId, status: { in: ACTIVE_QUEUE_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    await prisma.$disconnect?.();

    if (rows.length === 0) {
      return null;
    }

    const activeEntries: VaultQueueEntrySummary[] = rows.map((row) => ({
      id: row.id,
      targetAllocations: asAllocationMap(row.targetAllocations),
    }));

    const latest = rows[0];
    return {
      pending: {
        id: latest.id,
        targetAllocations: asAllocationMap(latest.targetAllocations),
        currentAllocations: asAllocationMap(latest.currentAllocations),
      },
      activeEntries,
    };
  } catch {
    return null;
  }
}
