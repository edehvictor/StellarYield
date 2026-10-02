/**
 * Vault share-price reconciliation between contract events and the backend cache.
 *
 * The YieldVault contract does not emit an explicit "share price" event — the
 * share price is a *derived* quantity, `total_assets / total_shares`, where both
 * totals mutate only through a fixed set of contract events (deposit, withdraw,
 * deposit_for, harvest, rebalance, transfer_shares, flash_loan,
 * emergency_withdraw, rescue; see `contracts/yield_vault/src/`).
 *
 * This service reconstructs the contract-authoritative totals from an event log
 * and compares them against the backend `SharePriceSnapshot` cache, surfacing
 * named, actionable causes when the two disagree rather than letting a silent
 * stale quote reach users.
 */

import {
  RECONCILE_CAUSES,
  RECONCILE_CAUSE_ORDER,
  describeReconcileCause,
  type ReconcileCauseCode,
} from "../../../shared/types/reconcileCause";
import {
  SHARE_PRICE_THRESHOLD,
  SHARE_PRICE_STALE_PROJECTION_MS,
  type CachedSharePrice,
  type SharePriceMismatch,
  type SharePriceReconCause,
  type SharePriceReconStatus,
  type SharePriceSeverity,
  type VaultProjectedState,
  type VaultSharePriceEvent,
  type VaultSharePriceEventType,
  type VaultSharePriceErrorCode,
  type SharePriceReconciliationResult,
} from "../../../shared/types/vaultSharePrice";

// ── Typed errors ──────────────────────────────────────────────────────────────

/**
 * Deterministic, code-tagged error for invalid or unsupported inputs. Route
 * handlers map this to an HTTP status via `errorCodeToStatus` so callers never
 * have to parse a raw provider message to know what went wrong.
 */
export class VaultSharePriceError extends Error {
  readonly code: VaultSharePriceErrorCode;
  constructor(code: VaultSharePriceErrorCode, message: string) {
    super(message);
    this.name = "VaultSharePriceError";
    this.code = code;
  }
}

/** HTTP status that each error code should produce at the route boundary. */
export const errorCodeToStatus: Record<VaultSharePriceErrorCode, number> = {
  INVALID_EVENT: 400,
  MALFORMED_INPUT: 400,
  UNKNOWN_EVENT_TYPE: 400,
  NEGATIVE_TOTAL_ASSETS: 400,
  NEGATIVE_TOTAL_SHARES: 400,
  DIVISION_BY_ZERO: 400,
  CACHE_UNAVAILABLE: 503,
};

// ── Precision ─────────────────────────────────────────────────────────────────

/**
 * The contract stores `share_price` as `total_assets * 1e18 / total_shares`
 * (18-decimal fixed point). We compare in base units (1.0 = 1 base asset per
 * share), so the 1e18 precision cancels — but we keep it exported for callers
 * that want the raw fixed-point value.
 */
export const VAULT_SHARE_PRICE_PRECISION = 1_000_000_000_000_000_000n;

// ── Input validation helpers (pure) ───────────────────────────────────────────

const UNSIGNED_INTEGER_STRING = /^\d+$/;

/**
 * Parse a non-negative integer string. The contract rejects zero/negative
 * amounts and never emits a signed value, so a leading "-" means the event was
 * mis-decoded and is rejected rather than silently flipping the delta's sign.
 */
function parseAmount(value: string, field: string): bigint {
  if (typeof value !== "string" || !UNSIGNED_INTEGER_STRING.test(value)) {
    throw new VaultSharePriceError(
      "MALFORMED_INPUT",
      `${field} must be a non-negative integer string, got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

function requireShares(event: VaultSharePriceEvent): bigint {
  if (event.shares === undefined || event.shares === null) {
    throw new VaultSharePriceError(
      "INVALID_EVENT",
      `Event type "${event.eventType}" requires a "shares" field (tx ${event.txHash}:${event.eventIndex}).`,
    );
  }
  return parseAmount(event.shares, "shares");
}

function requireKeeperFee(event: VaultSharePriceEvent): bigint {
  if (event.keeperFee === undefined || event.keeperFee === null) {
    throw new VaultSharePriceError(
      "INVALID_EVENT",
      `Harvest event requires a "keeperFee" field (tx ${event.txHash}:${event.eventIndex}).`,
    );
  }
  return parseAmount(event.keeperFee, "keeperFee");
}

/**
 * The per-event delta to (totalAssets, totalShares) as understood by the
 * contract. A positive `assetsDelta` grows vault assets; a positive
 * `sharesDelta` grows outstanding shares. `transfer_shares` is a no-op on the
 * totals (it only moves shares between users).
 */
interface EventDelta {
  assetsDelta: bigint;
  sharesDelta: bigint;
  /** Clamp totalAssets at 0 instead of treating an underflow as corrupt data. */
  floorAssetsAtZero?: boolean;
}

/**
 * Maps a single contract event to its (assets, shares) delta.
 *
 * Throws a typed VaultSharePriceError for unknown event types or malformed
 * fields — never a raw provider message.
 */
export function eventDelta(event: VaultSharePriceEvent): EventDelta {
  const amount = parseAmount(event.amount, "amount");

  switch (event.eventType) {
    case "deposit":
    case "deposit_for": {
      const shares = requireShares(event);
      return { assetsDelta: amount, sharesDelta: shares };
    }
    case "withdraw":
    case "emergency_withdraw": {
      // emergency_withdraw carries the post-penalty net amount actually paid
      // out, which is exactly what the contract subtracts from totalAssets.
      const shares = requireShares(event);
      return { assetsDelta: -amount, sharesDelta: -shares };
    }
    case "harvest": {
      const keeperFee = requireKeeperFee(event);
      return { assetsDelta: amount - keeperFee, sharesDelta: 0n };
    }
    case "rebalance": {
      // Funds deployed to a strategy leave the vault's token balance.
      return { assetsDelta: -amount, sharesDelta: 0n };
    }
    case "transfer_shares": {
      // Share transfer between users — no effect on vault totals.
      return { assetsDelta: 0n, sharesDelta: 0n };
    }
    case "flash_loan": {
      // `amount` is the premium; the principal is repaid within the call.
      return { assetsDelta: amount, sharesDelta: 0n };
    }
    case "rescue": {
      // The contract floors totalAssets at zero; replay applies the same clamp.
      return { assetsDelta: -amount, sharesDelta: 0n, floorAssetsAtZero: true };
    }
    default:
      throw new VaultSharePriceError(
        "UNKNOWN_EVENT_TYPE",
        `Unsupported vault event type: ${String(event.eventType ?? "undefined")}`,
      );
  }
}

// ── Event log handling ────────────────────────────────────────────────────────

/**
 * Sort key for deterministic event ordering: ledger → txHash → eventIndex.
 */
function eventSortKey(e: VaultSharePriceEvent): string {
  return `${String(e.ledger).padStart(20, "0")}:${e.txHash}:${String(
    e.eventIndex,
  ).padStart(12, "0")}`;
}

/**
 * Detect events that appear more than once. Identity is (vaultId, txHash,
 * eventIndex); a duplicate inflates the replay and corrupts the totals.
 */
export function detectDuplicateEvents(
  events: VaultSharePriceEvent[],
): { duplicateCount: number; duplicatedKeys: string[] } {
  const seen = new Set<string>();
  const duplicatedKeys = new Set<string>();
  let duplicateCount = 0;

  for (const event of events) {
    const key = `${event.vaultId}:${event.txHash}:${event.eventIndex}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      duplicatedKeys.add(key);
    } else {
      seen.add(key);
    }
  }

  return { duplicateCount, duplicatedKeys: [...duplicatedKeys] };
}

/** The result of replaying an event log into vault totals. */
export interface VaultReconstruction {
  state: VaultProjectedState;
  duplicateCount: number;
  warnings: string[];
}

export interface ReplayInitialState {
  totalAssets?: bigint;
  totalShares?: bigint;
}

/**
 * Reconstruct the contract-authoritative (totalAssets, totalShares) by replaying
 * the supplied event log from deployment (or a provided baseline).
 *
 * Events are sorted deterministically before replay so the result is stable
 * regardless of input ordering. Throws VaultSharePriceError on malformed input
 * or when a replay step would drive totals negative (which is impossible in the
 * contract and therefore signals corrupt event data).
 *
 * @throws {VaultSharePriceError} MALFORMED_INPUT / INVALID_EVENT /
 *   UNKNOWN_EVENT_TYPE / NEGATIVE_TOTAL_ASSETS / NEGATIVE_TOTAL_SHARES
 */
export function replayVaultEvents(
  events: VaultSharePriceEvent[],
  initial: ReplayInitialState = {},
): VaultReconstruction {
  if (events.length === 0) {
    throw new VaultSharePriceError(
      "INVALID_EVENT",
      "No contract events supplied; cannot reconstruct vault state from an empty event log.",
    );
  }

  const sorted = [...events].sort((a, b) =>
    eventSortKey(a) < eventSortKey(b) ? -1 : eventSortKey(a) > eventSortKey(b) ? 1 : 0,
  );

  const vaultId = sorted[0].vaultId;
  for (const event of sorted) {
    if (event.vaultId !== vaultId) {
      throw new VaultSharePriceError(
        "INVALID_EVENT",
        `Mixed vault ids in a single reconciliation batch (found "${event.vaultId}" and "${vaultId}").`,
      );
    }
  }

  // De-duplicate by (vaultId, txHash, eventIndex), keeping the first occurrence.
  // Duplicate events (e.g. from an idempotent re-index pass) would otherwise
  // inflate the reconstructed totals, so they are excluded from the projection.
  const { duplicateCount, duplicatedKeys } = detectDuplicateEvents(sorted);
  const seen = new Set<string>();
  const deduped: VaultSharePriceEvent[] = [];
  for (const event of sorted) {
    const key = `${event.vaultId}:${event.txHash}:${event.eventIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  const warnings: string[] = [];
  if (duplicateCount > 0) {
    warnings.push(
      `${duplicateCount} duplicate event(s) detected and skipped: ${duplicatedKeys.join(", ")}`,
    );
  }

  let totalAssets = initial.totalAssets ?? 0n;
  let totalShares = initial.totalShares ?? 0n;

  let lastLedger = deduped[0].ledger;
  let lastTxHash = deduped[0].txHash;

  for (const event of deduped) {
    const { assetsDelta, sharesDelta, floorAssetsAtZero } = eventDelta(event);
    totalAssets += assetsDelta;
    totalShares += sharesDelta;
    if (floorAssetsAtZero && totalAssets < 0n) totalAssets = 0n;

    if (totalAssets < 0n) {
      throw new VaultSharePriceError(
        "NEGATIVE_TOTAL_ASSETS",
        `Replay drove totalAssets negative at ledger ${event.ledger} (${event.txHash}).`,
      );
    }
    if (totalShares < 0n) {
      throw new VaultSharePriceError(
        "NEGATIVE_TOTAL_SHARES",
        `Replay drove totalShares negative at ledger ${event.ledger} (${event.txHash}).`,
      );
    }

    lastLedger = event.ledger;
    lastTxHash = event.txHash;
  }

  return {
    state: {
      vaultId,
      totalAssets,
      totalShares,
      eventCount: deduped.length,
      lastLedger,
      lastTxHash,
    },
    duplicateCount,
    warnings,
  };
}

// ── Share price derivation (pure) ─────────────────────────────────────────────

/**
 * Contract-authoritative share price in base units (1.0 = 1 base asset / share),
 * mirroring the contract's `share_price` view. Returns null when the vault has
 * no outstanding shares (degenerate pricing, matches the contract returning the
 * 1e18 constant).
 */
export function computeContractSharePrice(state: VaultProjectedState): number | null {
  if (state.totalShares === 0n) return null;
  return Number(state.totalAssets) / Number(state.totalShares);
}

/** Null-safe share-price derivation used in early-return branches. */
function deriveSharePrice(state: VaultProjectedState | null): number | null {
  return state !== null ? computeContractSharePrice(state) : null;
}

/** The raw 18-decimal fixed-point share price the contract exposes. */
export function computeContractSharePriceRaw(state: VaultProjectedState): bigint | null {
  if (state.totalShares === 0n) return null;
  return (state.totalAssets * VAULT_SHARE_PRICE_PRECISION) / state.totalShares;
}

// ── Drift severity (pure) ─────────────────────────────────────────────────────

/** Amounts closer than this are treated as equal (float-noise guard at the JSON boundary). */
export const FIELD_EPSILON = 1e-9;

/**
 * Classify a relative drift against the same bands the portfolio reconciler
 * uses, so operators see a consistent language across surfaces.
 */
export function severityForDeltaPct(pct: number): SharePriceSeverity {
  const abs = Math.abs(pct);
  if (abs >= SHARE_PRICE_THRESHOLD.CRITICAL) return "critical";
  if (abs >= SHARE_PRICE_THRESHOLD.MATERIAL) return "material";
  if (abs >= SHARE_PRICE_THRESHOLD.SMALL) return "small";
  return "matched";
}

// ── Cause helpers (pure) ──────────────────────────────────────────────────────

function cause(
  code: ReconcileCauseCode,
  detail: string,
  evidence: SharePriceReconCause["evidence"] = {},
  vaultId?: string,
): SharePriceReconCause {
  const descriptor = describeReconcileCause(code);
  return {
    ...descriptor,
    vaultId,
    detail,
    evidence,
  };
}

// ── Core reconciliation (pure) ────────────────────────────────────────────────

export interface ReconcileSharePriceOptions {
  vaultId: string;
  /** Count of duplicate events detected during replay (for DUPLICATE_POSITION). */
  duplicateEvents?: number;
  /** Set when replaying the event log itself threw before comparison. */
  sourceError?: unknown;
}

/**
 * Compare the contract-derived vault state against the backend cache snapshot.
 *
 * This is a pure function: it owns no state and throws nothing for ordinary
 * data disagreements — only the (already-typed) inputs determine the result, so
 * every "failed" / "partial" outcome is deterministic and reproducible.
 */
export function reconcileSharePrice(
  contractState: VaultProjectedState | null,
  cachedState: CachedSharePrice | null,
  options: ReconcileSharePriceOptions,
): SharePriceReconciliationResult {
  const vaultId = options.vaultId;

  // SOURCE_UNAVAILABLE dominates — if a source threw, the remaining causes
  // would be chasing ghosts rather than real discrepancies.
  if (options.sourceError !== undefined) {
    return buildResult(
      "failed",
      vaultId,
      contractState,
      cachedState,
      [],
      [
        cause(
          "SOURCE_UNAVAILABLE",
          `Share-price reconstruction was aborted: ${String(options.sourceError)}`,
          {},
          vaultId,
        ),
      ],
    );
  }

   // No cache → nothing to compare against. We still report the contract state
   // so an operator can see what the chain says.
   if (cachedState === null) {
     return buildResult(
       "failed",
       vaultId,
       contractState,
       null,
       [],
       [
         cause(
           "SOURCE_UNAVAILABLE",
           "Backend cache snapshot was unavailable for this vault; cannot compare share price.",
           {},
           vaultId,
         ),
       ],
       { contractSharePrice: deriveSharePrice(contractState) },
     );
   }

  // No contract events → nothing to compare from the chain side.
  if (contractState === null) {
    return buildResult(
      "partial",
      vaultId,
      null,
      cachedState,
      [],
      [
        cause(
          "SOURCE_UNAVAILABLE",
          "No contract events were supplied to reconstruct the vault state; the cached share price is unverified.",
          { cachedValue: cachedState.sharePrice },
          vaultId,
        ),
      ],
    );
  }

  const mismatches: SharePriceMismatch[] = [];
  const causes: SharePriceReconCause[] = [];
  let isStale = false;
  let staleDurationMs: number | undefined;

  const projectionAgeMs = cachedState.projectionAgeMs ?? 0;
  if (projectionAgeMs > SHARE_PRICE_STALE_PROJECTION_MS) {
    isStale = true;
    staleDurationMs = projectionAgeMs;
    causes.push(
      cause(
        "STALE_SOURCE",
        `Cached share-price projection last advanced ${Math.round(projectionAgeMs / 1000)}s ago, past the ${SHARE_PRICE_STALE_PROJECTION_MS / 1000}s freshness budget.`,
        { staleDurationMs, projectionVersion: cachedState.projectionVersion, lastLedger: cachedState.lastLedger },
        vaultId,
      ),
    );
  }

  // totalShares comparison (bigint vs number).
  const contractShares = Number(contractState.totalShares);
  const cachedShares = cachedState.totalShares;
  const sharesDrift = compareField(contractShares, cachedShares);
  if (sharesDrift.delta !== null && Math.abs(sharesDrift.delta) > FIELD_EPSILON) {
    mismatches.push({
      field: "totalShares",
      contractValue: contractState.totalShares,
      cachedValue: cachedShares,
      delta: BigInt(Math.trunc(sharesDrift.delta)),
      deltaPct: sharesDrift.deltaPct,
      severity: sharesDrift.severity,
    });
    if (sharesDrift.severity !== "matched" && sharesDrift.severity !== "unavailable") {
      causes.push(
        cause(
          "AMOUNT_DRIFT",
          `totalShares drift: contract reconstructed ${contractShares} vs cache ${cachedShares} (delta ${sharesDrift.delta}, ${formatPct(sharesDrift.deltaPct)}).`,
          { contractValue: contractShares, cachedValue: cachedShares, deltaPct: sharesDrift.deltaPct ?? undefined, lastLedger: contractState.lastLedger, eventCount: contractState.eventCount },
          vaultId,
        ),
      );
    }
  }

  // totalAssets comparison (bigint vs number).
  const contractAssets = Number(contractState.totalAssets);
  const cachedAssets = cachedState.totalAssets;
  const assetsDrift = compareField(contractAssets, cachedAssets);
  if (assetsDrift.delta !== null && Math.abs(assetsDrift.delta) > FIELD_EPSILON) {
    mismatches.push({
      field: "totalAssets",
      contractValue: contractState.totalAssets,
      cachedValue: cachedAssets,
      delta: BigInt(Math.trunc(assetsDrift.delta)),
      deltaPct: assetsDrift.deltaPct,
      severity: assetsDrift.severity,
    });
    if (assetsDrift.severity !== "matched" && assetsDrift.severity !== "unavailable") {
      causes.push(
        cause(
          "AMOUNT_DRIFT",
          `totalAssets drift: contract reconstructed ${contractAssets} vs cache ${cachedAssets} (delta ${assetsDrift.delta}, ${formatPct(assetsDrift.deltaPct)}).`,
          { contractValue: contractAssets, cachedValue: cachedAssets, deltaPct: assetsDrift.deltaPct ?? undefined, lastLedger: contractState.lastLedger, eventCount: contractState.eventCount },
          vaultId,
        ),
      );
    }
  }

  // share price comparison (base units).
  const contractSharePrice = deriveSharePrice(contractState);
  if (contractSharePrice !== null) {
    const priceDrift = compareField(contractSharePrice, cachedState.sharePrice);
    if (priceDrift.delta !== null && Math.abs(priceDrift.delta) > FIELD_EPSILON) {
      mismatches.push({
        field: "sharePrice",
        contractValue: contractSharePrice,
        cachedValue: cachedState.sharePrice,
        delta: priceDrift.delta,
        deltaPct: priceDrift.deltaPct,
        severity: priceDrift.severity,
      });
      if (priceDrift.severity !== "matched" && priceDrift.severity !== "unavailable") {
        causes.push(
          cause(
            "AMOUNT_DRIFT",
            `share price drift: contract-derived ${round(contractSharePrice)} vs cache ${round(cachedState.sharePrice)} (delta ${round(priceDrift.delta)}, ${formatPct(priceDrift.deltaPct)}).`,
            { contractValue: contractSharePrice, cachedValue: cachedState.sharePrice, deltaPct: priceDrift.deltaPct ?? undefined, eventCount: contractState.eventCount },
            vaultId,
          ),
        );
      }
    }
  } else {
    // totalShares == 0 → contract share price is undefined.
    mismatches.push({
      field: "sharePrice",
      contractValue: null,
      cachedValue: cachedState.sharePrice,
      delta: null,
      deltaPct: null,
      severity: "unavailable",
    });
  }

  if (options.duplicateEvents && options.duplicateEvents > 0) {
    causes.push(
      cause(
        "DUPLICATE_POSITION",
        `${options.duplicateEvents} duplicate event(s) were present in the event log and were excluded from the projection; the cache total may be inflated if duplicates were also indexed.`,
        { eventCount: contractState.eventCount, cachedValue: options.duplicateEvents },
        vaultId,
      ),
    );
  }

  const sharesAgree =
    Math.abs(contractShares - cachedShares) <= FIELD_EPSILON;
  const assetsAgree =
    Math.abs(contractAssets - cachedAssets) <= FIELD_EPSILON;

  const maxDriftPct = computeMaxDrift(mismatches);
  const status: SharePriceReconStatus =
    causes.length === 0 ? "success" : "partial";

  return buildResult(
    status,
    vaultId,
    contractState,
    cachedState,
    mismatches,
    causes,
    { isStale, staleDurationMs, maxDriftPct, sharesAgree, assetsAgree, contractSharePrice },
  );
}

/**
 * Compare a contract (authoritative) numeric value against a cached numeric
 * value. Returns the signed delta, the relative deltaPct (or null), and the
 * severity band. deltaPct is null when the cached value is 0 and they differ.
 */
function compareField(
  contractValue: number,
  cachedValue: number,
): { delta: number | null; deltaPct: number | null; severity: SharePriceSeverity } {
  const delta = contractValue - cachedValue;
  if (delta === 0) {
    return { delta: 0, deltaPct: 0, severity: "matched" };
  }
  if (cachedValue === 0) {
    // Non-zero contract vs zero cache — infinitely off, treat as critical.
    return { delta, deltaPct: null, severity: "critical" };
  }
  const deltaPct = delta / Math.abs(cachedValue);
  return { delta, deltaPct, severity: severityForDeltaPct(deltaPct) };
}

function computeMaxDrift(mismatches: SharePriceMismatch[]): number | null {
  let maxAbs: number | null = null;
  for (const m of mismatches) {
    if (m.deltaPct !== null) {
      const abs = Math.abs(m.deltaPct);
      if (maxAbs === null || abs > maxAbs) maxAbs = abs;
    } else if (m.severity === "critical") {
      // Infinite drift (zero cache) counts as the worst band.
      return SHARE_PRICE_THRESHOLD.CRITICAL;
    }
  }
  return maxAbs;
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function formatPct(pct: number | null): string {
  return pct === null ? "infinite" : `${round(pct * 100)}%`;
}

interface BuildResultExtras {
  isStale: boolean;
  staleDurationMs?: number;
  maxDriftPct: number | null;
  sharesAgree: boolean;
  assetsAgree: boolean;
  contractSharePrice: number | null;
}

function buildResult(
  status: SharePriceReconStatus,
  vaultId: string,
  contractState: VaultProjectedState | null,
  cachedState: CachedSharePrice | null,
  mismatches: SharePriceMismatch[],
  causes: SharePriceReconCause[],
  extras?: Partial<BuildResultExtras>,
): SharePriceReconciliationResult {
  const causeCounts: Partial<Record<ReconcileCauseCode, number>> = {};
  for (const c of causes) {
    causeCounts[c.code] = (causeCounts[c.code] ?? 0) + 1;
  }

  const primaryCause =
    RECONCILE_CAUSE_ORDER.find((code) => causeCounts[code] !== undefined) ?? null;

  const sharesAgree = extras?.sharesAgree ?? false;
  const assetsAgree = extras?.assetsAgree ?? false;

  return {
    status,
    vaultId,
    contractState,
    contractSharePrice: extras?.contractSharePrice ?? null,
    cachedState,
    mismatches,
    sharesAgree,
    assetsAgree,
    maxDriftPct: extras?.maxDriftPct ?? null,
    isStale: extras?.isStale ?? false,
    staleDurationMs: extras?.staleDurationMs,
    projectionVersion: cachedState?.projectionVersion,
    causes,
    primaryCause,
    causeCounts,
    timestamp: new Date().toISOString(),
  };
}

// ── In-memory reconciliation history (mirrors reconciliationStore pattern) ─────

export interface SharePriceReconHistoryEntry
  extends SharePriceReconciliationResult {
  id: string;
}

/** Oldest entries are evicted past this size so the store cannot grow unbounded. */
export const SHARE_PRICE_RECON_HISTORY_LIMIT = 1000;

const historyStore: SharePriceReconHistoryEntry[] = [];

export function resetSharePriceReconHistory(): void {
  historyStore.length = 0;
}

export function getSharePriceReconHistory(
  vaultId?: string,
): readonly SharePriceReconHistoryEntry[] {
  if (vaultId === undefined) return historyStore;
  return historyStore.filter((e) => e.vaultId === vaultId);
}

export interface SharePriceReconHistoryQuery {
  vaultId?: string;
  status?: SharePriceReconStatus;
  limit?: number;
  startDate?: string;
  endDate?: string;
}

export function querySharePriceReconHistory(
  options: SharePriceReconHistoryQuery = {},
): SharePriceReconHistoryEntry[] {
  let results = options.vaultId
    ? historyStore.filter((e) => e.vaultId === options.vaultId)
    : [...historyStore];

  if (options.status) {
    results = results.filter((e) => e.status === options.status);
  }
  if (options.startDate) {
    const start = new Date(options.startDate).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() >= start);
  }
  if (options.endDate) {
    const end = new Date(options.endDate).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() <= end);
  }

  results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return results.slice(0, options.limit ?? 50);
}

// ── Service class ─────────────────────────────────────────────────────────────

export interface SharePriceCacheLoader {
  loadSharePrice(vaultId: string): Promise<CachedSharePrice | null>;
}

/**
 * Minimal Prisma delegate this loader relies on. Kept loose so the service
 * works without a generated client (mirrors `routes/sharePriceHistory.ts`).
 */
interface SharePriceSnapshotDelegate {
  findFirst: (args: unknown) => Promise<PrismaSnapshot | null>;
}

interface PrismaWithSnapshot {
  sharePriceSnapshot?: SharePriceSnapshotDelegate;
  $disconnect?: () => Promise<void>;
}

interface PrismaSnapshot {
  sharePrice: number;
  totalShares: number;
  totalAssets: number;
  snapshotAt: Date;
  projectionVersion?: number | null;
  lastLedger?: number | null;
  projectionAgeMs?: number | null;
}

/**
 * Lazily load the most recent share-price snapshot for a vault from the
 * backend cache. Returns null (not a throwable) when no snapshot exists or the
 * Prisma client is unavailable; rethrows only genuine DB errors as
 * VaultSharePriceError so the route can map them to 503.
 */
export async function loadLatestSharePriceSnapshot(
  vaultId: string,
): Promise<CachedSharePrice | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => PrismaWithSnapshot;
    };
    if (!prismaModule.PrismaClient) return null;
    const prisma = new prismaModule.PrismaClient();

    if (!prisma.sharePriceSnapshot) {
      await prisma.$disconnect?.().catch(() => undefined);
      return null;
    }

    const snapshot = await prisma.sharePriceSnapshot.findFirst({
      where: { vaultId },
      orderBy: { snapshotAt: "desc" },
    });
    await prisma.$disconnect?.().catch(() => undefined);

    if (snapshot === null || snapshot === undefined) return null;
    return {
      vaultId,
      sharePrice: snapshot.sharePrice,
      totalShares: snapshot.totalShares,
      totalAssets: snapshot.totalAssets,
      snapshotAt: snapshot.snapshotAt.toISOString(),
      projectionVersion: snapshot.projectionVersion ?? undefined,
      lastLedger: snapshot.lastLedger ?? undefined,
      projectionAgeMs: snapshot.projectionAgeMs ?? undefined,
    };
  } catch {
    // Any failure to talk to the database is surfaced as a typed 503 rather
    // than a raw provider message.
    throw new VaultSharePriceError(
      "CACHE_UNAVAILABLE",
      "Could not reach the share-price cache backend.",
    );
  }
}

/**
 * Default cache loader. Lazily instantiates the Prisma client so the service
 * degrades gracefully (returns null) when the database is unavailable, matching
 * the pattern in `routes/sharePriceHistory.ts`.
 */
export class PrismaSharePriceCacheLoader implements SharePriceCacheLoader {
  async loadSharePrice(vaultId: string): Promise<CachedSharePrice | null> {
    return loadLatestSharePriceSnapshot(vaultId);
  }
}

export interface VaultSharePriceReconciliationDeps {
  cacheLoader?: SharePriceCacheLoader;
}

/**
 * Orchestrates end-to-end share-price reconciliation: validate and replay the
 * contract event log, load the cache snapshot, classify the comparison, and
 * persist the result to the in-memory history store.
 *
 * Error policy (deterministic, no raw provider messages):
 *   - malformed/unsupported events     → throws VaultSharePriceError (400)
 *   - cache backend unreachable        → throws VaultSharePriceError (503)
 *   - empty event log / no cache data  → returns a "failed"/"partial" result
 *     (200) so operators can see what was and was not available.
 */
export class VaultSharePriceReconciliationService {
  private readonly cacheLoader: SharePriceCacheLoader | null;

  constructor(deps: VaultSharePriceReconciliationDeps = {}) {
    this.cacheLoader =
      deps.cacheLoader !== undefined
        ? deps.cacheLoader
        : new PrismaSharePriceCacheLoader();
  }

  /**
   * Reconcile a vault's contract events against its cached share price.
   *
   * @param vaultId     Vault contract id.
   * @param events      Contract event log (any order; will be sorted). May be
   *                     empty, in which case the contract side is unavailable.
   * @param cachedState When omitted, the cache is loaded via `cacheLoader`.
   * @returns           A deterministic reconciliation result.
   *
   * @throws {VaultSharePriceError} for malformed/unsupported events (400) or an
   *   unreachable cache backend (503).
   */
  async reconcileVault(
    vaultId: string,
    events: VaultSharePriceEvent[],
    cachedState?: CachedSharePrice,
  ): Promise<SharePriceReconciliationResult> {
    let reconstruction: VaultReconstruction | null = null;

    if (events.length > 0) {
      // Throws VaultSharePriceError for malformed/unsupported input — let it
      // propagate so the route maps it to 400.
      reconstruction = replayVaultEvents(events);
    }

    const contractState = reconstruction?.state ?? null;

    let resolvedCached: CachedSharePrice | null = null;
    if (cachedState !== undefined) {
      resolvedCached = cachedState;
    } else if (this.cacheLoader) {
      // The default loader wraps its own DB errors into VaultSharePriceError,
      // but an injected loader may surface a raw rejection. Normalize any
      // non-typed failure to CACHE_UNAVAILABLE so the route can map it to 503
      // and never surfaces a provider message.
      try {
        resolvedCached = await this.cacheLoader.loadSharePrice(vaultId);
      } catch (error) {
        if (error instanceof VaultSharePriceError) throw error;
        throw new VaultSharePriceError(
          "CACHE_UNAVAILABLE",
          "Could not reach the share-price cache backend.",
        );
      }
    }

    if (contractState !== null && contractState.vaultId !== vaultId) {
      throw new VaultSharePriceError(
        "INVALID_EVENT",
        `Events belong to vault "${contractState.vaultId}" but reconciliation was requested for "${vaultId}".`,
      );
    }

    const result = reconcileSharePrice(contractState, resolvedCached, {
      vaultId,
      duplicateEvents: reconstruction?.duplicateCount,
    });

    persistSharePriceRecon(result);
    return result;
  }

  getHistory(vaultId?: string): readonly SharePriceReconHistoryEntry[] {
    return getSharePriceReconHistory(vaultId);
  }

  /** Filtered history, newest first. */
  queryHistory(query: SharePriceReconHistoryQuery): SharePriceReconHistoryEntry[] {
    return querySharePriceReconHistory(query);
  }
}

function persistSharePriceRecon(
  result: SharePriceReconciliationResult,
): void {
  const entry: SharePriceReconHistoryEntry = {
    ...result,
    id: `sp_recon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  };
  historyStore.push(entry);
  if (historyStore.length > SHARE_PRICE_RECON_HISTORY_LIMIT) {
    historyStore.splice(0, historyStore.length - SHARE_PRICE_RECON_HISTORY_LIMIT);
  }
}

// Re-export the cause descriptor table so the route can serve it without
// re-importing through a second path.
export { RECONCILE_CAUSES, RECONCILE_CAUSE_ORDER };
export type {
  CachedSharePrice,
  SharePriceMismatch,
  VaultProjectedState,
  VaultSharePriceEvent,
  VaultSharePriceEventType,
};
