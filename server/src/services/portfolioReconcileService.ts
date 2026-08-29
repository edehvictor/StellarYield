import {
  resolveAssetIdentity,
  mergeHoldings,
  type RawHolding,
  type MergedHolding,
} from "./assetIdentityService";
  analyzeConcentration,
  buildExposureBuckets,
  type ConcentrationAnalysis,
  type ConcentrationThresholdsInput,
} from '../../../shared/types/exposureConcentration';
import { readConcentrationThresholdOverrides } from '../config/concentrationThresholds';
import { safeWalletId } from '../utils/redact';
import { recordFailure, resolveNetworkLabel } from '../monitoring/prometheus';

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

export class PortfolioReconcileService {
  constructor(
    private prisma: PrismaClient,
    private concentrationThresholds?: ConcentrationThresholdsInput,
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

      // Step 8: Audit and log reconciliation with anomalies
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
        },
      );

      return {
        status:
          mismatches.length === 0 && orphanedTransactions.length === 0
            ? "success"
            : "partial",
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
      };
        orphanedTransactions: orphanedTransactions.length > 0 ? orphanedTransactions : undefined,
        duplicatePositions: duplicatePositions.length > 0 ? duplicatePositions : undefined,
        concentration: this.analyzeConcentration(chainPositions),
      }
    } catch (error) {
      await this.logReconciliationEvent(walletAddress, [], [], "failed", error);
      await this.logReconciliationEvent(walletAddress, [], [], 'failed', error)
      recordFailure({
        route: 'portfolio/reconcile',
        network: resolveNetworkLabel(),
        failure_category: 'reconcile_failed',
      })
      return {
        status: "failed",
        changes: [],
        mismatches: [],
        timestamp: new Date(),
        sourceOfTruth: "chain",
        isStale: true,
      };
        concentration: this.analyzeConcentration([]),
      }
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
    _walletAddress: string,
  ): Promise<{
    positions: PortfolioPosition[];
    projectionVersion?: number;
    lastLedger?: { ledger: number; processedAt: Date };
  }> {
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
    persistReconciliationEvent(entry);
    console.log(`[Reconciliation] ${status} for ${walletAddress}`)
    console.log(`[Reconciliation] ${status} for ${safeWalletId(walletAddress)}`)
    persistReconciliationEvent(entry)
  }

  async getReconciliationHistory(
    walletAddress: string,
    limit: number = 10,
  ): Promise<ReconciliationHistoryEntry[]> {
    return queryReconciliationHistory(walletAddress, { limit });
  }
}

export function createPortfolioReconcileService(prisma: PrismaClient) {
  return new PortfolioReconcileService(prisma);
export function createPortfolioReconcileService(
  prisma: PrismaClient,
  concentrationThresholds?: ConcentrationThresholdsInput,
) {
  return new PortfolioReconcileService(prisma, concentrationThresholds)
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
