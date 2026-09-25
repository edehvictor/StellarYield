import {
  resolveAssetIdentity,
  resolveCanonicalSymbol,
  mergeHoldings,
  type RawHolding,
  type MergedHolding,
} from "./assetIdentityService";
import {
  analyzeConcentration,
  buildExposureBuckets,
  type ConcentrationAnalysis,
  type ConcentrationThresholdsInput,
} from '../../../shared/types/exposureConcentration';
import { readConcentrationThresholdOverrides } from '../config/concentrationThresholds';
import { safeWalletId } from '../utils/redact';
import { recordFailure, resolveNetworkLabel } from '../monitoring/prometheus';
import {
  RECONCILE_CAUSE_ORDER,
  describeReconcileCause,
  type ReconcileCauseCode,
  type ReconcileCauseDescriptor,
} from '../../../shared/types/reconcileCause';

export type Position = { asset: string; expected: number };
export type ProviderBalance = {
  provider: string;
  asset: string;
  balance?: number;
};

// ── Alias-aware holding merge (public) ───────────────────────────────────

/**
 * Normalise and merge an array of raw holdings using canonical asset identity.
 *
 * Duplicates that share the same canonical key (identical symbol + issuer
 * after alias resolution) are collapsed into a single row.  Unknown assets
 * are left as-is to avoid unsafe merging.
 */
export function normalizeAndMergeHoldings(
  holdings: RawHolding[],
): MergedHolding[] {
  return mergeHoldings(holdings);
}

export type { RawHolding, MergedHolding };

export type ReconcileRow = {
  asset: string;
  expected: number;
  observed: number | null;
  delta: number | null;
  deltaPct: number | null;
  severity: "matched" | "small" | "material" | "critical" | "unavailable";
};

export function reconcilePortfolio(
  positions: Position[],
  balances: ProviderBalance[],
) {
  const rows: ReconcileRow[] = [];
  positions.forEach((pos) => {
    // Normalise the expected asset symbol so alias variants match the same row.
    const { identityKey: posKey } = resolveAssetIdentity({ symbol: pos.asset });

    const matching = balances.filter((b) => {
      if (typeof b.balance !== "number") return false;
      const { identityKey: balKey } = resolveAssetIdentity({ symbol: b.asset });
      return balKey === posKey;
    });

    if (matching.length === 0) {
      rows.push({
        asset: pos.asset,
        expected: pos.expected,
        observed: null,
        delta: null,
        deltaPct: null,
        severity: "unavailable",
      });
      return;
    }

    const observed = matching.reduce((s, b) => s + (b.balance ?? 0), 0);
    const delta = observed - pos.expected;
    const deltaPct =
      pos.expected === 0
        ? observed === 0
          ? 0
          : Infinity
        : delta / Math.abs(pos.expected);

    const absPct = Math.abs(
      deltaPct === Infinity ? Number.POSITIVE_INFINITY : deltaPct,
    );
    let severity: ReconcileRow["severity"] = "matched";
    if (absPct < 0.01) severity = "matched";
    else if (absPct < 0.05) severity = "small";
    else if (absPct < 0.15) severity = "material";
    else severity = "critical";

    rows.push({
      asset: pos.asset,
      expected: pos.expected,
      observed,
      delta,
      deltaPct: Number.isFinite(deltaPct) ? deltaPct : null,
      severity,
    });
  });
  return rows;
}

export default reconcilePortfolio;

// ── Durable Reconciliation History ──────────────────────────────────────

export interface ReconciliationHistoryEntry {
  id: string;
  walletAddress: string;
  timestamp: string;
  status: "success" | "partial" | "failed";
  changeCount: number;
  mismatchCount: number;
  changes: PositionChange[];
  mismatches: ReconciliationMismatch[];
  error?: string;
  metadata?: {
    orphanedTransactions?: string[];
    duplicatePositions?: string[];
    projectionVersion?: number;
    isStale?: boolean;
    primaryCause?: ReconcileCauseCode | null;
    causeCounts?: Partial<Record<ReconcileCauseCode, number>>;
  };
}

const reconciliationStore: ReconciliationHistoryEntry[] = [];

export function resetReconciliationStore(): void {
  reconciliationStore.length = 0;
}

export function getReconciliationStore(): readonly ReconciliationHistoryEntry[] {
  return reconciliationStore;
}

export function persistReconciliationEvent(
  entry: ReconciliationHistoryEntry,
): void {
  reconciliationStore.push(entry);
}

export function queryReconciliationHistory(
  walletAddress: string,
  options: {
    limit?: number;
    status?: "success" | "partial" | "failed";
    startDate?: string;
    endDate?: string;
  } = {},
): ReconciliationHistoryEntry[] {
  let results = reconciliationStore.filter(
    (e) => e.walletAddress === walletAddress,
  );

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

export interface PortfolioPosition {
  assetId: string;
  amount: number;
  vaultId: string;
  protocol: string;
}

export interface ReconciliationResult {
  status: "success" | "partial" | "failed";
  changes: PositionChange[];
  mismatches: ReconciliationMismatch[];
  timestamp: Date;
  sourceOfTruth: "chain" | "backend_snapshot";
  projectionVersion?: number;
  projectionCheckpoint?: number;
  isStale: boolean;
  staleDurationMs?: number;
  orphanedTransactions?: string[];
  duplicatePositions?: string[];
  status: 'success' | 'partial' | 'failed'
  changes: PositionChange[]
  mismatches: ReconciliationMismatch[]
  timestamp: Date
  sourceOfTruth: 'chain' | 'backend_snapshot'
  projectionVersion?: number
  projectionCheckpoint?: number
  isStale: boolean
  staleDurationMs?: number
  orphanedTransactions?: string[]
  duplicatePositions?: string[]
  /**
   * Named reasons this reconciliation did not come out clean. Empty on a clean
   * run. See shared/types/reconcileCause.ts for the taxonomy.
   */
  causes: ReconcileCause[]
  /** The cause to act on first, by triage order, or null on a clean run. */
  primaryCause: ReconcileCauseCode | null
  causeCounts: Partial<Record<ReconcileCauseCode, number>>
  /** Positions carried under a different asset code on each side. */
  symbolDrifts: SymbolDrift[]
  /**
   * Asset and protocol concentration of the reconciled (chain-authoritative)
   * positions, so callers see exposure risk against the same snapshot they just
   * reconciled rather than a separately-fetched one.
   */
  concentration: ConcentrationAnalysis
}

export interface PositionChange {
  type: "added" | "removed" | "updated";
  position: PortfolioPosition;
  previousAmount?: number;
  currentAmount: number;
}

export interface ReconciliationMismatch {
  assetId: string;
  chainValue: number;
  cachedValue: number;
  discrepancy: number;
  severity: "info" | "warning" | "critical";
}

interface PrismaVaultBalance {
  findUnique(
    opts: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  upsert(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface PrismaClient {
  vaultBalance: PrismaVaultBalance;
}

/**
 * Grades asset and protocol concentration for a set of positions.
 *
 * Position `amount` is used as the exposure weight; the reconciler works in
 * position units and does not carry USD prices, so shares are relative to the
 * reconciled total rather than to a priced portfolio value.
 */
export function analyzePositionConcentration(
  positions: PortfolioPosition[],
  thresholds?: ConcentrationThresholdsInput,
): ConcentrationAnalysis {
  const buckets = buildExposureBuckets(positions, (p) => ({
    asset: p.assetId,
    protocol: p.protocol,
    valueUsd: p.amount,
  }))

  return analyzeConcentration(buckets, thresholds ?? readConcentrationThresholdOverrides())
}

// ── Reconciliation Cause Mapping ────────────────────────────────────────
//
// A reconciliation that comes back "partial" tells an operator nothing they can
// act on. These helpers turn each discrepancy into a named cause so the API and
// the UI can say whether a holding is missing, whether it merely moved to a new
// asset code, or whether the source behind the comparison had stopped
// advancing before the comparison was even made.

/** A single named reason this reconciliation did not come out clean. */
export interface ReconcileCause extends ReconcileCauseDescriptor {
  /** Asset the cause attaches to, when it is position-specific. */
  assetId?: string
  vaultId?: string
  /** This occurrence, with the actual values — the descriptor is generic. */
  detail: string
  evidence?: {
    chainAssetId?: string
    cachedAssetId?: string
    chainAmount?: number
    cachedAmount?: number
    canonicalAsset?: string
    staleDurationMs?: number
    projectionVersion?: number
    lastLedger?: number
  }
}

/** A position carried under a different asset code on each side. */
export interface SymbolDrift {
  canonicalAsset: string
  chainAssetId: string
  cachedAssetId: string
  vaultId: string
  chainAmount: number
  cachedAmount: number
  /** True when the amounts match, i.e. only the code changed. */
  amountsAgree: boolean
}

/**
 * Bridged and wrapped forms that `assetIdentityService` deliberately does not
 * fold together.
 *
 * That service backs holding *merge*, where collapsing a bridge wrapper into
 * its underlying asset would silently combine two positions that can be
 * redeemed on different rails. Drift reporting has no such risk — it only
 * pairs a chain-side and a cache-side row so a rename is described once
 * instead of twice — so these live here rather than in the shared table.
 */
const DRIFT_ONLY_ALIASES: Record<string, string> = {
  'USDC.E': 'USDC',
  USDCET: 'USDC',
  USDCV2: 'USDC',
  XUSDC: 'USDC',
  USDCALLBRIDGE: 'USDC',
  NATIVE: 'XLM',
  WXLM: 'XLM',
  'EURC.E': 'EURC',
  EURCV2: 'EURC',
  BTCLN: 'BTC',
}

/**
 * Reduces an asset id to the key two sides must share to be the same asset.
 *
 * Strips the Stellar `CODE:ISSUER` qualifier — an issuer migration keeps the
 * code and is drift, not a new asset — then resolves the code through the
 * shared alias table in `assetIdentityService`, falling back to the
 * drift-only supplement above. Symbol aliases live in one place; this adds
 * only the issuer handling that drift detection specifically needs.
 */
export function canonicalAssetKey(assetId: string): string {
  const code = assetId.split(':')[0].trim()

  // The drift-only table is keyed on the separator-free form, so `USDC.e` and
  // `usdc-e` both land on USDC.
  const compact = code.toUpperCase().replace(/[^A-Z0-9.]/g, '')
  const driftAlias = DRIFT_ONLY_ALIASES[compact]
  if (driftAlias !== undefined) return driftAlias

  // The shared table is looked up on the *unmodified* code, because several of
  // its keys contain spaces or hyphens ("usd coin", "xlm-usdc"). Stripping
  // first would silently miss them.
  const { canonical, isKnown } = resolveCanonicalSymbol(code)
  if (isKnown) return canonical.toUpperCase()

  return compact.replace(/\./g, '')
}

/**
 * Pairs chain-only positions with cache-only positions that resolve to the same
 * canonical asset, in the same vault.
 *
 * Matching is per (canonical asset, vault) and consumes both sides, so one
 * rename produces one drift rather than a missing holding *and* an orphaned
 * one. Positions left unpaired are genuinely missing or genuinely orphaned.
 */
export function detectSymbolDrift(
  chainOnly: PortfolioPosition[],
  cachedOnly: PortfolioPosition[],
): {
  drifts: SymbolDrift[]
  unmatchedChain: PortfolioPosition[]
  unmatchedCached: PortfolioPosition[]
} {
  const drifts: SymbolDrift[] = []
  const remainingCached = [...cachedOnly]
  const unmatchedChain: PortfolioPosition[] = []

  for (const chainPos of chainOnly) {
    const chainKey = canonicalAssetKey(chainPos.assetId)
    const matchIndex = remainingCached.findIndex(
      (cachedPos) =>
        cachedPos.vaultId === chainPos.vaultId &&
        canonicalAssetKey(cachedPos.assetId) === chainKey &&
        cachedPos.assetId !== chainPos.assetId,
    )

    if (matchIndex === -1) {
      unmatchedChain.push(chainPos)
      continue
    }

    const [cachedPos] = remainingCached.splice(matchIndex, 1)
    drifts.push({
      canonicalAsset: chainKey,
      chainAssetId: chainPos.assetId,
      cachedAssetId: cachedPos.assetId,
      vaultId: chainPos.vaultId,
      chainAmount: chainPos.amount,
      cachedAmount: cachedPos.amount,
      amountsAgree: Math.abs(chainPos.amount - cachedPos.amount) <= AMOUNT_EPSILON,
    })
  }

  return { drifts, unmatchedChain, unmatchedCached: remainingCached }
}

/** Amounts closer than this are treated as equal. */
const AMOUNT_EPSILON = 0.0001

function cause(
  code: ReconcileCauseCode,
  detail: string,
  extra: Pick<ReconcileCause, 'assetId' | 'vaultId' | 'evidence'> = {},
): ReconcileCause {
  return { ...describeReconcileCause(code), detail, ...extra }
}

export interface ClassifyReconcileInput {
  chainPositions: PortfolioPosition[]
  cachedPositions: PortfolioPosition[]
  /** Milliseconds since the cached projection last advanced. */
  projectionAgeMs?: number
  projectionVersion?: number
  lastLedger?: number
  duplicatePositions?: string[]
  orphanedTransactions?: string[]
  /** Set when the reconciliation itself threw. */
  sourceError?: unknown
}

export interface ReconcileClassification {
  causes: ReconcileCause[]
  symbolDrifts: SymbolDrift[]
  /** The cause an operator should act on first, by triage order. */
  primaryCause: ReconcileCauseCode | null
  causeCounts: Partial<Record<ReconcileCauseCode, number>>
}

/** Projection age past which the cached side is reported as stale. */
export const STALE_PROJECTION_MS = 5 * 60 * 1000

/**
 * Maps a reconciliation into named causes.
 *
 * Symbol drift is resolved *before* anything is called missing, because the
 * same rename otherwise shows up twice — once as a holding the cache lacks and
 * once as a holding the chain lacks — and an operator chasing either half is
 * chasing a position that never moved.
 */
export function classifyReconciliation(
  input: ClassifyReconcileInput,
): ReconcileClassification {
  const causes: ReconcileCause[] = []

  if (input.sourceError !== undefined) {
    return {
      causes: [
        cause(
          'SOURCE_UNAVAILABLE',
          `Reconciliation aborted: ${String(input.sourceError)}`,
        ),
      ],
      symbolDrifts: [],
      primaryCause: 'SOURCE_UNAVAILABLE',
      causeCounts: { SOURCE_UNAVAILABLE: 1 },
    }
  }

  // Staleness is reported first because it changes how every other cause in the
  // same run should be read: against a projection that stopped advancing, a
  // "missing" holding may simply not have been indexed yet.
  const projectionAgeMs = input.projectionAgeMs ?? 0
  if (projectionAgeMs > STALE_PROJECTION_MS) {
    causes.push(
      cause(
        'STALE_SOURCE',
        `Cached projection last advanced ${Math.round(projectionAgeMs / 1000)}s ago, past the ${STALE_PROJECTION_MS / 1000}s freshness budget.`,
        {
          evidence: {
            staleDurationMs: projectionAgeMs,
            ...(input.projectionVersion !== undefined
              ? { projectionVersion: input.projectionVersion }
              : {}),
            ...(input.lastLedger !== undefined ? { lastLedger: input.lastLedger } : {}),
          },
        },
      ),
    )
  }

  const chainByAsset = new Map(input.chainPositions.map((p) => [p.assetId, p]))
  const cachedByAsset = new Map(input.cachedPositions.map((p) => [p.assetId, p]))

  const chainOnly = input.chainPositions.filter((p) => !cachedByAsset.has(p.assetId))
  const cachedOnly = input.cachedPositions.filter((p) => !chainByAsset.has(p.assetId))

  const { drifts, unmatchedChain, unmatchedCached } = detectSymbolDrift(chainOnly, cachedOnly)

  for (const drift of drifts) {
    causes.push(
      cause(
        'SYMBOL_DRIFT',
        drift.amountsAgree
          ? `${drift.cachedAssetId} is carried on-chain as ${drift.chainAssetId}; both sides hold ${drift.chainAmount}, so only the asset code changed.`
          : `${drift.cachedAssetId} is carried on-chain as ${drift.chainAssetId}, and the amounts also differ (chain ${drift.chainAmount} vs cached ${drift.cachedAmount}).`,
        {
          assetId: drift.chainAssetId,
          vaultId: drift.vaultId,
          evidence: {
            chainAssetId: drift.chainAssetId,
            cachedAssetId: drift.cachedAssetId,
            chainAmount: drift.chainAmount,
            cachedAmount: drift.cachedAmount,
            canonicalAsset: drift.canonicalAsset,
          },
        },
      ),
    )
  }

  for (const position of unmatchedChain) {
    causes.push(
      cause(
        'MISSING_HOLDING',
        `Chain reports ${position.amount} ${position.assetId} in ${position.vaultId}, which the cached projection has no record of.`,
        {
          assetId: position.assetId,
          vaultId: position.vaultId,
          evidence: { chainAssetId: position.assetId, chainAmount: position.amount },
        },
      ),
    )
  }

  for (const position of unmatchedCached) {
    causes.push(
      cause(
        'ORPHANED_HOLDING',
        `Cache holds ${position.amount} ${position.assetId} in ${position.vaultId}, which the chain no longer reports.`,
        {
          assetId: position.assetId,
          vaultId: position.vaultId,
          evidence: { cachedAssetId: position.assetId, cachedAmount: position.amount },
        },
      ),
    )
  }

  for (const [assetId, chainPos] of chainByAsset.entries()) {
    const cachedPos = cachedByAsset.get(assetId)
    if (!cachedPos) continue
    if (Math.abs(chainPos.amount - cachedPos.amount) <= AMOUNT_EPSILON) continue

    causes.push(
      cause(
        'AMOUNT_DRIFT',
        `${assetId} differs by ${Math.abs(chainPos.amount - cachedPos.amount)} (chain ${chainPos.amount} vs cached ${cachedPos.amount}).`,
        {
          assetId,
          vaultId: chainPos.vaultId,
          evidence: {
            chainAmount: chainPos.amount,
            cachedAmount: cachedPos.amount,
          },
        },
      ),
    )
  }

  for (const key of input.duplicatePositions ?? []) {
    const [assetId, vaultId] = key.split(':')
    causes.push(
      cause('DUPLICATE_POSITION', `${assetId} appears more than once in ${vaultId}.`, {
        assetId,
        vaultId,
      }),
    )
  }

  for (const txHash of input.orphanedTransactions ?? []) {
    causes.push(
      cause('ORPHANED_TRANSACTION', `Transaction ${txHash} has no matching on-chain event.`),
    )
  }

  const causeCounts: Partial<Record<ReconcileCauseCode, number>> = {}
  for (const item of causes) {
    causeCounts[item.code] = (causeCounts[item.code] ?? 0) + 1
  }

  const primaryCause =
    RECONCILE_CAUSE_ORDER.find((code) => causeCounts[code] !== undefined) ?? null

  return { causes, symbolDrifts: drifts, primaryCause, causeCounts }
}

/**
 * Where a reconciliation reads its two sides from.
 *
 * The chain side has no production implementation yet, so without a seam here
 * every reconciliation compares an empty list against the cache and the cause
 * mapping is unreachable. Callers that already hold a snapshot — the API
 * running a reconciliation over a supplied pair, the tests — provide one.
 */
export interface ReconcilePositionSource {
  fetchChainPositions(
    walletAddress: string,
  ): Promise<{
    positions: PortfolioPosition[]
    projectionVersion?: number
    lastLedger?: { ledger: number; processedAt: Date }
  }>
  fetchCachedPositions?(walletAddress: string): Promise<PortfolioPosition[]>
}

export class PortfolioReconcileService {
  constructor(
    private prisma: PrismaClient,
    private concentrationThresholds?: ConcentrationThresholdsInput,
    private positionSource?: ReconcilePositionSource,
  ) {}

  async reconcilePortfolio(
    walletAddress: string,
    forceChainRevalidation: boolean = false,
  ): Promise<ReconciliationResult> {
    const changes: PositionChange[] = [];
    const mismatches: ReconciliationMismatch[] = [];
    const orphanedTransactions: string[] = [];
    const duplicatePositions: string[] = [];

    try {
      // Step 1: Fetch chain-authoritative state with projection metadata
      const {
        positions: chainPositions,
        projectionVersion,
        lastLedger,
      } = await this.fetchChainPositionsWithMetadata(walletAddress);

      // Step 2: Fetch cached state from backend
      const cachedPositions = await this.fetchCachedPositions(walletAddress);

      // Step 3: Check for staleness (projection age > 5 minutes)
      const now = Date.now();
      const projectionAge = now - (lastLedger?.processedAt?.getTime() ?? now);
      const isStale = projectionAge > 5 * 60 * 1000; // 5 minutes

      // Step 4: Detect orphaned transactions (positions without matching on-chain events)
      const orphanedTxs = await this.detectOrphanedTransactions(
        walletAddress,
        chainPositions,
      );
      orphanedTransactions.push(...orphanedTxs);

      // Step 5: Detect duplicate positions (same asset across multiple vaults incorrectly)
      const duplicates = this.detectDuplicatePositions(chainPositions);
      duplicatePositions.push(...duplicates);

      // Step 6: Compare and identify discrepancies
      const comparisonResult = this.comparePositions(
        chainPositions,
        cachedPositions,
      );
      changes.push(...comparisonResult.changes);
      mismatches.push(...comparisonResult.mismatches);

      // Step 7: Update cache to match chain (with confirmation)
      if (!forceChainRevalidation) {
        // In production, this would require user confirmation
        await this.updateCachedPositions(walletAddress, chainPositions);
      }

      // Step 8: Name every reason this run was not clean, so the API and the
      // UI can say *which* problem this is rather than just "partial".
      const classification = classifyReconciliation({
        chainPositions,
        cachedPositions,
        projectionAgeMs: projectionAge,
        ...(projectionVersion !== undefined ? { projectionVersion } : {}),
        ...(lastLedger?.ledger !== undefined ? { lastLedger: lastLedger.ledger } : {}),
        duplicatePositions,
        orphanedTransactions,
      });

      // Step 9: Audit and log reconciliation with anomalies
      await this.logReconciliationEvent(
        walletAddress,
        changes,
        mismatches,
        "success",
        undefined,
        {
          orphanedTransactions,
          duplicatePositions,
          projectionVersion,
          isStale,
          primaryCause: classification.primaryCause,
          causeCounts: classification.causeCounts,
        },
      );

      return {
        status: classification.causes.length === 0 ? "success" : "partial",
        changes,
        mismatches,
        timestamp: new Date(),
        sourceOfTruth: "chain",
        projectionVersion,
        projectionCheckpoint: lastLedger?.ledger,
        isStale,
        staleDurationMs: isStale ? projectionAge : undefined,
        orphanedTransactions:
          orphanedTransactions.length > 0 ? orphanedTransactions : undefined,
        duplicatePositions:
          duplicatePositions.length > 0 ? duplicatePositions : undefined,
        causes: classification.causes,
        primaryCause: classification.primaryCause,
        causeCounts: classification.causeCounts,
        symbolDrifts: classification.symbolDrifts,
        concentration: this.analyzeConcentration(chainPositions),
      };

    } catch (error) {
      // A run that threw produced no information: an empty cause list here
      // would read as "clean", so the failure itself is reported as a cause.
      const classification = classifyReconciliation({
        chainPositions: [],
        cachedPositions: [],
        sourceError: error,
      });

      await this.logReconciliationEvent(walletAddress, [], [], "failed", error, {
        primaryCause: classification.primaryCause,
        causeCounts: classification.causeCounts,
      });

      recordFailure({
        route: "portfolio/reconcile",
        network: resolveNetworkLabel(),
        failure_category: "reconcile_failed",
      });
      return {
        status: "failed",
        changes: [],
        mismatches: [],
        timestamp: new Date(),
        sourceOfTruth: "chain",
        isStale: true,
        causes: classification.causes,
        primaryCause: classification.primaryCause,
        causeCounts: classification.causeCounts,
        symbolDrifts: [],
        concentration: this.analyzeConcentration([]),
      };
    }
  }

  /** Grades concentration using this service's configured thresholds. */
  analyzeConcentration(positions: PortfolioPosition[]): ConcentrationAnalysis {
    return analyzePositionConcentration(positions, this.concentrationThresholds)
  }

  private comparePositions(
    chainPositions: PortfolioPosition[],
    cachedPositions: PortfolioPosition[],
  ) {
    const changes: PositionChange[] = [];
    const mismatches: ReconciliationMismatch[] = [];

    const chainMap = new Map(chainPositions.map((p) => [p.assetId, p]));
    const cachedMap = new Map(cachedPositions.map((p) => [p.assetId, p]));

    // Find added and updated positions
    for (const [assetId, chainPos] of chainMap.entries()) {
      const cachedPos = cachedMap.get(assetId);

      if (!cachedPos) {
        changes.push({
          type: "added",
          position: chainPos,
          currentAmount: chainPos.amount,
        });
      } else if (Math.abs(chainPos.amount - cachedPos.amount) > 0.0001) {
        changes.push({
          type: "updated",
          position: chainPos,
          previousAmount: cachedPos.amount,
          currentAmount: chainPos.amount,
        });

        const discrepancy = Math.abs(chainPos.amount - cachedPos.amount);
        const severity =
          discrepancy > chainPos.amount * 0.1 ? "critical" : "warning";

        mismatches.push({
          assetId,
          chainValue: chainPos.amount,
          cachedValue: cachedPos.amount,
          discrepancy,
          severity,
        });
      }
    }

    // Find removed positions
    for (const [assetId, cachedPos] of cachedMap.entries()) {
      if (!chainMap.has(assetId)) {
        changes.push({
          type: "removed",
          position: cachedPos,
          previousAmount: cachedPos.amount,
          currentAmount: 0,
        });
      }
    }

    return { changes, mismatches };
  }

  private async fetchChainPositionsWithMetadata(
    walletAddress: string,
  ): Promise<{
    positions: PortfolioPosition[];
    projectionVersion?: number;
    lastLedger?: { ledger: number; processedAt: Date };
  }> {
    if (this.positionSource) {
      return this.positionSource.fetchChainPositions(walletAddress)
    }

    // In production, this would query the actual blockchain/Stellar network
    // with projection version tracking from IndexerState
    // For now, return empty array (would be populated by SDK calls)
    return {
      positions: [],
      projectionVersion: 1,
      lastLedger: { ledger: 0, processedAt: new Date() },
    };
  }

  private async detectOrphanedTransactions(
    _walletAddress: string,
    _chainPositions: PortfolioPosition[],
  ): Promise<string[]> {
    // Detect transactions in database without matching on-chain events
    // Would query UserTransaction table and cross-reference with Event table
    return [];
  }

  private detectDuplicatePositions(positions: PortfolioPosition[]): string[] {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];

    for (const pos of positions) {
      // Use canonical identity key so alias variants of the same asset are caught.
      // e.g. "usdc" and "USDC" in the same vault both map to "USDC:<issuer>".
      const { identityKey } = resolveAssetIdentity({ symbol: pos.assetId });
      const key = `${identityKey}:${pos.vaultId}`;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);

      if (count > 0) {
        duplicates.push(key);
      }
    }

    return duplicates;
  }

  private async fetchChainPositions(
    _walletAddress: string,
  ): Promise<PortfolioPosition[]> {
    // In production, this would query the actual blockchain/Stellar network
    // For now, return empty array (would be populated by SDK calls)
    return [];
  }

  private async fetchCachedPositions(
    walletAddress: string,
  ): Promise<PortfolioPosition[]> {
    if (this.positionSource?.fetchCachedPositions) {
      return this.positionSource.fetchCachedPositions(walletAddress);
    }

    const vaultBalance = await this.prisma.vaultBalance.findUnique({
      where: { walletAddress },
    });

    if (!vaultBalance) return [];

    // Map stored balance to positions (simplified - would need position tracking table)
    return [
      {
        assetId: "USDC",
        amount: vaultBalance.tvl as number,
        vaultId: "vault-1",
        protocol: "unknown",
      },
    ];
  }

  private async updateCachedPositions(
    walletAddress: string,
    positions: PortfolioPosition[],
  ): Promise<void> {
    const totalTvl = positions.reduce((sum, p) => sum + p.amount, 0);

    await this.prisma.vaultBalance.upsert({
      where: { walletAddress },
      update: { tvl: totalTvl, updatedAt: new Date() },
      create: {
        walletAddress,
        tvl: totalTvl,
        totalYield: 0,
      },
    });
  }

  private async logReconciliationEvent(
    walletAddress: string,
    changes: PositionChange[],
    mismatches: ReconciliationMismatch[],
    status: string = "success",
    error?: unknown,
    metadata?: {
      orphanedTransactions?: string[];
      duplicatePositions?: string[];
      projectionVersion?: number;
      isStale?: boolean;
      primaryCause?: ReconcileCauseCode | null;
      causeCounts?: Partial<Record<ReconcileCauseCode, number>>;
    },
  ): Promise<void> {
    const entry: ReconciliationHistoryEntry = {
      id: `recon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      walletAddress,
      timestamp: new Date().toISOString(),
      status: status as ReconciliationHistoryEntry["status"],
      changeCount: changes.length,
      mismatchCount: mismatches.length,
      changes,
      mismatches,
    };
    if (error) {
      entry.error = String(error);
    }
    if (metadata) {
      entry.metadata = metadata;
    }
    console.log(`[Reconciliation] ${status} for ${safeWalletId(walletAddress)}`);
    persistReconciliationEvent(entry);
  }

  async getReconciliationHistory(
    walletAddress: string,
    limit: number = 10,
  ): Promise<ReconciliationHistoryEntry[]> {
    return queryReconciliationHistory(walletAddress, { limit });
  }
}

export function createPortfolioReconcileService(
  prisma: PrismaClient,
  concentrationThresholds?: ConcentrationThresholdsInput,
  positionSource?: ReconcilePositionSource,
) {
  return new PortfolioReconcileService(prisma, concentrationThresholds, positionSource)
}

/**
 * A position source backed by an explicit pair of snapshots, for reconciling
 * data the caller already has rather than re-fetching it.
 */
export function staticPositionSource(input: {
  chainPositions: PortfolioPosition[]
  cachedPositions: PortfolioPosition[]
  projectionVersion?: number
  lastLedger?: { ledger: number; processedAt: Date }
}): ReconcilePositionSource {
  return {
    async fetchChainPositions() {
      return {
        positions: input.chainPositions,
        ...(input.projectionVersion !== undefined
          ? { projectionVersion: input.projectionVersion }
          : {}),
        ...(input.lastLedger !== undefined ? { lastLedger: input.lastLedger } : {}),
      }
    },
    async fetchCachedPositions() {
      return input.cachedPositions
    },
  }
}

// ── Deposit Receipt Reconciliation ─────────────────────────────────────

export type DepositReceiptStatus = 'pending' | 'confirmed' | 'mismatched';

export interface DepositReceipt {
  txHash: string;
  walletAddress: string;
  vaultId: string;
  assetId: string;
  amount: number;
  submittedAt: string;
  status: DepositReceiptStatus;
  indexedEventId?: string;
  confirmedAt?: string;
  sharesAssigned?: number;
  mismatchReason?: string;
}

export interface IndexedVaultDepositEvent {
  eventId: string;
  txHash: string;
  vaultId: string;
  assetId: string;
  amount: number;
  sharesAssigned: number;
  ledgerSequence: number;
  processedAt: string;
}

const receiptStore: DepositReceipt[] = [];

export function resetReceiptStore(): void {
  receiptStore.length = 0;
}

export function getReceiptStore(): readonly DepositReceipt[] {
  return receiptStore;
}

export function submitDepositReceipt(receipt: DepositReceipt): void {
  receiptStore.push(receipt);
}

export function reconcileReceipts(
  receipts: DepositReceipt[],
  events: IndexedVaultDepositEvent[],
): DepositReceipt[] {
  const eventsByTxHash = new Map<string, IndexedVaultDepositEvent[]>();
  for (const event of events) {
    const existing = eventsByTxHash.get(event.txHash) ?? [];
    existing.push(event);
    eventsByTxHash.set(event.txHash, existing);
  }

  return receipts.map((receipt) => {
    const matchingEvents = eventsByTxHash.get(receipt.txHash);

    if (!matchingEvents || matchingEvents.length === 0) {
      return { ...receipt, status: 'pending' as DepositReceiptStatus };
    }

    if (matchingEvents.length > 1) {
      return {
        ...receipt,
        status: 'mismatched' as DepositReceiptStatus,
        mismatchReason: 'duplicate_events',
        indexedEventId: matchingEvents[0].eventId,
      };
    }

    const event = matchingEvents[0];
    const amountMatches = Math.abs(event.amount - receipt.amount) < 0.0001;

    if (!amountMatches) {
      return {
        ...receipt,
        status: 'mismatched' as DepositReceiptStatus,
        indexedEventId: event.eventId,
        mismatchReason: 'amount_mismatch',
        confirmedAt: event.processedAt,
        sharesAssigned: event.sharesAssigned,
      };
    }

    return {
      ...receipt,
      status: 'confirmed' as DepositReceiptStatus,
      indexedEventId: event.eventId,
      confirmedAt: event.processedAt,
      sharesAssigned: event.sharesAssigned,
    };
  });
}

export function getReceiptsByStatus(
  receipts: DepositReceipt[],
  status: DepositReceiptStatus,
): DepositReceipt[] {
  return receipts.filter((r) => r.status === status);
}
