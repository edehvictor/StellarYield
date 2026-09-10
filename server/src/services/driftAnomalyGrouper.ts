/**
 * Drift Anomaly Grouping Engine
 *
 * Groups related drift detection signals across portfolio, vault, and strategy services
 * so the same root cause does not appear as multiple uncoordinated warnings.
 *
 * Features:
 * - Multi-dimensional grouping by source, asset, and severity band
 * - Deduplication of repeated and duplicate signals within configurable time windows
 * - Intelligent merging of overlapping temporal and multi-metric anomaly windows
 * - Nested hierarchical anomaly support for causal parent-child relationships (any depth)
 * - Complete preservation of granular source and severity metadata
 */

export type DriftSourceType = "portfolio" | "vault" | "strategy";
export type AnomalySeverityBand = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface DriftSignal {
  id: string;
  source: DriftSourceType;
  subSource?: string;            // e.g. "vault_allocation", "vault_pressure", "portfolio_attribution", "risk_preference", "strategy_health"
  asset: string;                // Asset, vaultId, strategyId, or wallet address
  metric: string;               // e.g. "allocation_drift", "outflow_velocity", "concentration_drift", "volatility_drift"
  currentValue: number;
  expectedValue: number;
  deviation: number;
  severity: AnomalySeverityBand;
  timestamp: string | number;   // ISO string or unix epoch ms
  rootCauseId?: string;         // Explicit correlation key if identified
  parentSignalId?: string;      // ID of causal parent signal for nested anomalies
  metadata?: Record<string, unknown>;
}

export interface GroupedAnomaly {
  groupId: string;
  groupKey: string;                          // e.g. "vault:VaultA:HIGH" or correlated root cause key
  primarySource: DriftSourceType;
  primaryAsset: string;
  aggregateSeverity: AnomalySeverityBand;

  // Granular visibility (AC #2: Severity and source data remain visible)
  sources: DriftSourceType[];
  sourceCount: Record<DriftSourceType, number>;
  severityBreakdown: Record<AnomalySeverityBand, number>;

  // Timing and Counts (AC #1: Related drift alerts appear grouped rather than duplicated)
  firstDetectedAt: string;
  lastDetectedAt: string;
  durationMs: number;
  signalCount: number;                       // Total signals observed (including duplicates)
  uniqueSignalCount: number;                 // Deduplicated signal count
  duplicateCount: number;                    // Count of suppressed duplicates

  // Signals and hierarchy (AC #3: Cover overlapping and nested anomaly sets)
  signals: DriftSignal[];
  nestedAnomalies?: GroupedAnomaly[];

  rootCauseSummary: string;
  recommendedAction?: string;
  metadata?: Record<string, unknown>;
}

export type GroupingStrategy = "bySourceAssetSeverity" | "byAssetAndProximity" | "byRootCause" | "hierarchical";

export interface GroupingOptions {
  /** Strategy for grouping signals. Defaults to "bySourceAssetSeverity". */
  strategy?: GroupingStrategy;
  /** Deduplication window in milliseconds. Identical signals within this window are coalesced. Defaults to 600,000 (10 mins). */
  dedupWindowMs?: number;
  /** Correlation window in milliseconds for temporal proximity grouping. Defaults to 900,000 (15 mins). */
  correlationWindowMs?: number;
  /** Custom root cause resolver if available. */
  customRootCauseResolver?: (signals: DriftSignal[]) => string | undefined;
}

const SEVERITY_WEIGHTS: Record<AnomalySeverityBand, number> = {
  INFO: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  CRITICAL: 5,
};

const WEIGHT_TO_SEVERITY: Record<number, AnomalySeverityBand> = {
  1: "INFO",
  2: "LOW",
  3: "MEDIUM",
  4: "HIGH",
  5: "CRITICAL",
};

export class DriftAnomalyGrouper {
  private readonly defaultOptions: Required<Omit<GroupingOptions, "customRootCauseResolver">> = {
    strategy: "bySourceAssetSeverity",
    dedupWindowMs: 10 * 60 * 1000,
    correlationWindowMs: 15 * 60 * 1000,
  };

  /**
   * Main entrypoint to group drift signals into structured anomaly groups.
   */
  public groupSignals(signals: DriftSignal[], options: GroupingOptions = {}): GroupedAnomaly[] {
    if (!signals || signals.length === 0) {
      return [];
    }

    const opts = { ...this.defaultOptions, ...options };

    // 1. Partition top-level signals vs child signals mapped by parentSignalId
    const signalIds = new Set(signals.map((s) => s.id));
    const topLevelSignals: DriftSignal[] = [];
    const childSignalsByParent = new Map<string, DriftSignal[]>();

    for (const signal of signals) {
      if (signal.parentSignalId && signalIds.has(signal.parentSignalId)) {
        const existing = childSignalsByParent.get(signal.parentSignalId) ?? [];
        existing.push(signal);
        childSignalsByParent.set(signal.parentSignalId, existing);
      } else {
        topLevelSignals.push(signal);
      }
    }

    return this.groupSignalsInternal(topLevelSignals, childSignalsByParent, opts);
  }

  /**
   * Internal grouping logic that preserves the child hierarchy map across recursive levels.
   */
  private groupSignalsInternal(
    signals: DriftSignal[],
    childSignalsByParent: Map<string, DriftSignal[]>,
    options: Required<Omit<GroupingOptions, "customRootCauseResolver">> & GroupingOptions
  ): GroupedAnomaly[] {
    if (!signals || signals.length === 0) {
      return [];
    }

    // 2. Perform deduplication on signals at current hierarchy level
    const { uniqueSignals, duplicateCounts } = this.deduplicateSignals(signals, options.dedupWindowMs);

    // 3. Cluster signals into groups based on chosen strategy
    const clusters = this.clusterSignals(uniqueSignals, options);

    // 4. Build GroupedAnomaly objects for each cluster and attach nested hierarchies recursively
    const groupedAnomalies = clusters.map((cluster) =>
      this.buildGroupedAnomaly(cluster, duplicateCounts, childSignalsByParent, options)
    );

    // 5. Sort by aggregate severity (highest first), then by recency
    return groupedAnomalies.sort((a, b) => {
      const severityDiff = SEVERITY_WEIGHTS[b.aggregateSeverity] - SEVERITY_WEIGHTS[a.aggregateSeverity];
      if (severityDiff !== 0) return severityDiff;
      return new Date(b.lastDetectedAt).getTime() - new Date(a.lastDetectedAt).getTime();
    });
  }

  /**
   * Deduplicates signals that have identical source, asset, metric, and severity within a dedupWindowMs window.
   */
  private deduplicateSignals(
    signals: DriftSignal[],
    dedupWindowMs: number
  ): {
    uniqueSignals: DriftSignal[];
    duplicateCounts: Map<string, number>;
  } {
    const sorted = [...signals].sort((a, b) => this.toTimestampMs(a.timestamp) - this.toTimestampMs(b.timestamp));
    const uniqueSignals: DriftSignal[] = [];
    const duplicateCounts = new Map<string, number>();

    for (const signal of sorted) {
      const sigTime = this.toTimestampMs(signal.timestamp);

      // Look for an existing signal in uniqueSignals that matches identity and is within dedupWindowMs
      const existingMatch = uniqueSignals.find((u) => {
        const uTime = this.toTimestampMs(u.timestamp);
        const isSameIdentity =
          u.source === signal.source &&
          u.asset === signal.asset &&
          u.metric === signal.metric &&
          u.severity === signal.severity &&
          (u.subSource ?? "") === (signal.subSource ?? "");
        const isWithinWindow = Math.abs(sigTime - uTime) <= dedupWindowMs;
        return isSameIdentity && isWithinWindow;
      });

      if (existingMatch) {
        // Increment duplicate count for the master signal
        const currentCount = duplicateCounts.get(existingMatch.id) ?? 0;
        duplicateCounts.set(existingMatch.id, currentCount + 1);

        // Update existing match with highest deviation and newest timestamp if applicable
        if (Math.abs(signal.deviation) > Math.abs(existingMatch.deviation)) {
          existingMatch.deviation = signal.deviation;
          existingMatch.currentValue = signal.currentValue;
        }
        if (sigTime > this.toTimestampMs(existingMatch.timestamp)) {
          existingMatch.timestamp = signal.timestamp;
        }
      } else {
        uniqueSignals.push({ ...signal });
        duplicateCounts.set(signal.id, 0);
      }
    }

    return { uniqueSignals, duplicateCounts };
  }

  /**
   * Clusters signals into logical buckets according to strategy and correlation rules.
   */
  private clusterSignals(
    signals: DriftSignal[],
    options: Required<Omit<GroupingOptions, "customRootCauseResolver">> & GroupingOptions
  ): DriftSignal[][] {
    if (signals.length === 0) return [];

    const clusters: Map<string, DriftSignal[]> = new Map();

    for (const signal of signals) {
      const key = this.computeClusterKey(signal, options);
      const existing = clusters.get(key) ?? [];
      existing.push(signal);
      clusters.set(key, existing);
    }

    // Merge overlapping temporal clusters for the same asset & root cause if applicable
    return this.mergeOverlappingClusters(Array.from(clusters.values()), options.correlationWindowMs);
  }

  /**
   * Generates a clustering key for a signal.
   */
  private computeClusterKey(signal: DriftSignal, options: GroupingOptions): string {
    if (signal.rootCauseId) {
      return `root_cause:${signal.rootCauseId}`;
    }

    switch (options.strategy) {
      case "byAssetAndProximity":
        return `asset:${signal.asset}`;
      case "byRootCause":
        return signal.rootCauseId ? `root_cause:${signal.rootCauseId}` : `asset_source:${signal.asset}:${signal.source}`;
      case "hierarchical":
        return `hierarchical:${signal.asset}:${signal.source}`;
      case "bySourceAssetSeverity":
      default:
        return `group:${signal.source}:${signal.asset}:${signal.severity}`;
    }
  }

  /**
   * Merges clusters that represent overlapping temporal or multi-metric events on the same asset/source.
   */
  private mergeOverlappingClusters(clusters: DriftSignal[][], correlationWindowMs: number): DriftSignal[][] {
    const result: DriftSignal[][] = [];

    for (const cluster of clusters) {
      let merged = false;
      for (const existing of result) {
        if (this.shouldMergeClusters(existing, cluster, correlationWindowMs)) {
          existing.push(...cluster);
          merged = true;
          break;
        }
      }
      if (!merged) {
        result.push([...cluster]);
      }
    }

    return result;
  }

  /**
   * Evaluates whether two signal clusters overlap in scope and time.
   */
  private shouldMergeClusters(clusterA: DriftSignal[], clusterB: DriftSignal[], correlationWindowMs: number): boolean {
    if (clusterA.length === 0 || clusterB.length === 0) return false;

    // Must share at least one asset or explicit root cause ID
    const assetsA = new Set(clusterA.map((s) => s.asset));
    const assetsB = new Set(clusterB.map((s) => s.asset));
    const shareAsset = Array.from(assetsA).some((a) => assetsB.has(a));

    const rootCausesA = new Set(clusterA.map((s) => s.rootCauseId).filter(Boolean));
    const rootCausesB = new Set(clusterB.map((s) => s.rootCauseId).filter(Boolean));
    const shareRootCause = Array.from(rootCausesA).some((rc) => rootCausesB.has(rc));

    if (!shareAsset && !shareRootCause) {
      return false;
    }

    // Check temporal overlap within correlationWindowMs
    const timesA = clusterA.map((s) => this.toTimestampMs(s.timestamp));
    const timesB = clusterB.map((s) => this.toTimestampMs(s.timestamp));

    const minA = Math.min(...timesA);
    const maxA = Math.max(...timesA);
    const minB = Math.min(...timesB);
    const maxB = Math.max(...timesB);

    const hasTemporalOverlap = minA <= maxB + correlationWindowMs && minB <= maxA + correlationWindowMs;
    return hasTemporalOverlap;
  }

  /**
   * Constructs a comprehensive GroupedAnomaly from a cluster of signals.
   */
  private buildGroupedAnomaly(
    cluster: DriftSignal[],
    duplicateCounts: Map<string, number>,
    childSignalsByParent: Map<string, DriftSignal[]>,
    options: Required<Omit<GroupingOptions, "customRootCauseResolver">> & GroupingOptions
  ): GroupedAnomaly {
    const sortedSignals = [...cluster].sort((a, b) => this.toTimestampMs(a.timestamp) - this.toTimestampMs(b.timestamp));

    const firstTimeMs = this.toTimestampMs(sortedSignals[0].timestamp);
    const lastSignal = sortedSignals.at(-1) ?? sortedSignals[0];
    const lastTimeMs = this.toTimestampMs(lastSignal.timestamp);

    // Calculate duplicate counts and total signal counts
    let totalDuplicates = 0;
    for (const sig of sortedSignals) {
      totalDuplicates += duplicateCounts.get(sig.id) ?? 0;
    }
    const uniqueSignalCount = sortedSignals.length;
    const signalCount = uniqueSignalCount + totalDuplicates;

    // Sources breakdown (AC #2)
    const sourceCount: Record<DriftSourceType, number> = {
      portfolio: 0,
      vault: 0,
      strategy: 0,
    };
    for (const sig of sortedSignals) {
      sourceCount[sig.source] = (sourceCount[sig.source] || 0) + 1 + (duplicateCounts.get(sig.id) ?? 0);
    }
    const sources = (Object.keys(sourceCount) as DriftSourceType[]).filter((src) => sourceCount[src] > 0);

    // Severity breakdown and aggregate severity (AC #2)
    const severityBreakdown: Record<AnomalySeverityBand, number> = {
      INFO: 0,
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0,
    };
    let maxSeverityWeight = 1;

    for (const sig of sortedSignals) {
      severityBreakdown[sig.severity] = (severityBreakdown[sig.severity] || 0) + 1 + (duplicateCounts.get(sig.id) ?? 0);
      const weight = SEVERITY_WEIGHTS[sig.severity] || 1;
      if (weight > maxSeverityWeight) {
        maxSeverityWeight = weight;
      }
    }
    const aggregateSeverity = WEIGHT_TO_SEVERITY[maxSeverityWeight] || "INFO";

    // Primary source and asset
    const primaryAsset = sortedSignals[0].asset;
    const primarySource = this.determinePrimarySource(sortedSignals, maxSeverityWeight);

    // Process nested child anomalies recursively for signals in this cluster (AC #3)
    const nestedAnomalies: GroupedAnomaly[] = [];
    for (const sig of sortedSignals) {
      const children = childSignalsByParent.get(sig.id);
      if (children && children.length > 0) {
        const nestedGroup = this.groupSignalsInternal(children, childSignalsByParent, {
          ...options,
          strategy: "bySourceAssetSeverity",
        });
        nestedAnomalies.push(...nestedGroup);
      }
    }

    const groupKey = `${primarySource}:${primaryAsset}:${aggregateSeverity}`;
    const rawKey = `${groupKey}_${firstTimeMs}_${sortedSignals[0].id}`;
    const groupId = `anomaly_grp_${this.hashKey(rawKey)}`;

    const rootCauseSummary = this.generateRootCauseSummary(sortedSignals, aggregateSeverity, options);
    const recommendedAction = this.generateRecommendedAction(primarySource, aggregateSeverity, sortedSignals);

    return {
      groupId,
      groupKey,
      primarySource,
      primaryAsset,
      aggregateSeverity,
      sources,
      sourceCount,
      severityBreakdown,
      firstDetectedAt: new Date(firstTimeMs).toISOString(),
      lastDetectedAt: new Date(lastTimeMs).toISOString(),
      durationMs: Math.max(0, lastTimeMs - firstTimeMs),
      signalCount,
      uniqueSignalCount,
      duplicateCount: totalDuplicates,
      signals: sortedSignals,
      ...(nestedAnomalies.length > 0 ? { nestedAnomalies } : {}),
      rootCauseSummary,
      recommendedAction,
    };
  }

  private determinePrimarySource(signals: DriftSignal[], maxWeight: number): DriftSourceType {
    // Pick the source of the signal with highest severity, or most frequent
    const highestSig = signals.find((s) => SEVERITY_WEIGHTS[s.severity] === maxWeight);
    if (highestSig) return highestSig.source;
    return signals[0].source;
  }

  private generateRootCauseSummary(
    signals: DriftSignal[],
    aggregateSeverity: AnomalySeverityBand,
    options: GroupingOptions
  ): string {
    if (options.customRootCauseResolver) {
      const custom = options.customRootCauseResolver(signals);
      if (custom) return custom;
    }

    const explicitRootCause = signals.find((s) => s.rootCauseId)?.rootCauseId;
    if (explicitRootCause) {
      return `Grouped drift anomaly linked to root cause '${explicitRootCause}' affecting ${signals.length} signal(s).`;
    }

    const uniqueMetrics = Array.from(new Set(signals.map((s) => s.metric)));
    const uniqueAssets = Array.from(new Set(signals.map((s) => s.asset)));
    const uniqueSources = Array.from(new Set(signals.map((s) => s.source)));

    return `Detected ${aggregateSeverity} severity drift across ${uniqueSources.join(", ")} for asset(s) [${uniqueAssets.join(", ")}] involving metric(s): ${uniqueMetrics.join(", ")}.`;
  }

  private generateRecommendedAction(
    source: DriftSourceType,
    severity: AnomalySeverityBand,
    signals: DriftSignal[]
  ): string {
    if (severity === "CRITICAL") {
      return "Immediate intervention required: check liquidity reserves, evaluate protocol pause/unwind, and execute emergency rebalance.";
    }
    if (severity === "HIGH") {
      return "High priority review: trigger automated rebalancing or adjust strategy allocation weights to restore equilibrium.";
    }
    if (severity === "MEDIUM") {
      return "Monitor trend and evaluate scheduled rebalance to mitigate further allocation or yield divergence.";
    }
    return "Log anomaly and maintain observation during normal operational cycles.";
  }

  private toTimestampMs(ts: string | number): number {
    if (typeof ts === "number") return ts;
    const parsed = new Date(ts).getTime();
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  private hashKey(key: string): string {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + (key.codePointAt(i) ?? 0);
      hash = Math.trunc(hash);
    }
    return Math.abs(hash).toString(36);
  }
}

export const driftAnomalyGrouper = new DriftAnomalyGrouper();
