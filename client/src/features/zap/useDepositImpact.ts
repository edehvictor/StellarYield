import { useMemo } from "react";

export type ImpactSeverity = "none" | "warning" | "critical";

export interface DepositImpactResult {
  severity: ImpactSeverity;
  reasons: string[];
  /** Estimated execution-quality degradation 0-100 */
  impactScore: number;
  /** Whether the deposit should be blocked due to stale/high-impact quote */
  shouldBlock: boolean;
  /** Human-readable block reason if shouldBlock is true */
  blockReason?: string;
}

export interface QuoteSnapshot {
  /** When the quote was generated */
  quotedAt: string;
  /** Route hops */
  route: string[];
  /** Expected output in stroops */
  expectedOut: bigint;
  /** Minimum output after slippage in stroops */
  minOut: bigint;
  /** Previous expectedOut for delta calculation */
  prevExpectedOut?: bigint;
  /** Previous route hops, used to detect a path change between fetches */
  prevRoute?: string[];
  /** Whether the quote came from fallback */
  isFallback: boolean;
  /** Whether the quote is stale */
  isStale: boolean;
  /** Quote source identifier */
  source?: string;
}

interface UseDepositImpactInput {
  /** Amount the user is depositing, in the token's base units */
  amountUsd: number;
  /** Slippage tolerance the user has configured (%) */
  slippageTolerance: number;
  /** True when the quote came from the fallback rate estimator */
  isFallback: boolean;
  /** True when the quote is stale (over STALE_QUOTE_AGE_MS old) */
  isStale: boolean;
  /** If the fragmentation API is available, pass executionQualityScore (0-100) */
  executionQualityScore?: number;
  /** materialImpact flag from the fragmentation API */
  materialImpact?: boolean;
  /** Current quote snapshot for route/amount tracking */
  quote?: QuoteSnapshot;
  /** Route impact threshold for blocking (0-100, default 75) */
  routeImpactThreshold?: number;
  /** Whether to enforce stale quote blocking */
  blockStaleQuotes?: boolean;
}

const WARNING_SLIPPAGE_PCT = 3;
const CRITICAL_SLIPPAGE_PCT = 8;
const WARNING_AMOUNT_USD = 50_000;
const CRITICAL_AMOUNT_USD = 500_000;
const LOW_EXECUTION_QUALITY = 70;
const CRITICAL_EXECUTION_QUALITY = 50;
const DEFAULT_ROUTE_IMPACT_THRESHOLD = 75;
const MAX_QUOTE_AGE_MS = 60_000;
/** route.length - 1 = hop count. >=3 hops means more than one intermediate pool. */
const WARNING_HOP_COUNT = 3;
const CRITICAL_HOP_COUNT = 5;
/** Output delta below this is treated as "nominally unchanged" for path-change detection. */
const NOMINAL_OUTPUT_DELTA_PCT = 5;

/**
 * Computes output impact delta as a percentage.
 * Returns the magnitude of change between previous and current expected output.
 */
function computeOutputDelta(prev: bigint | undefined, current: bigint): number {
  if (!prev || prev <= 0n || current <= 0n) return 0;
  const delta = Number(current - prev) / Number(prev);
  return Math.abs(delta) * 100;
}

/** Number of conversion hops implied by a route's contract list (edges, not nodes). */
function computeHopCount(route: string[]): number {
  return route.length > 1 ? route.length - 1 : 0;
}

/** Whether two route hop lists are identical, in order. */
function routesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((hop, i) => hop === b[i]);
}

/**
 * Pure hook — computes deposit route impact without side effects.
 * Returns the severity, human-readable reasons, a composite impact score,
 * and whether the deposit should be blocked.
 */
export function useDepositImpact(input: UseDepositImpactInput): DepositImpactResult {
  return useMemo(() => {
    const reasons: string[] = [];
    let impactScore = 0;

    // Slippage signal
    if (input.slippageTolerance >= CRITICAL_SLIPPAGE_PCT) {
      reasons.push(`High slippage tolerance (${input.slippageTolerance}%) increases execution risk`);
      impactScore += 40;
    } else if (input.slippageTolerance >= WARNING_SLIPPAGE_PCT) {
      reasons.push(`Elevated slippage tolerance (${input.slippageTolerance}%) may widen price impact`);
      impactScore += 20;
    }

    // Deposit size signal
    if (input.amountUsd >= CRITICAL_AMOUNT_USD) {
      reasons.push(`Large deposit ($${(input.amountUsd / 1000).toFixed(0)}k) may fragment liquidity pools`);
      impactScore += 40;
    } else if (input.amountUsd >= WARNING_AMOUNT_USD) {
      reasons.push(`Moderate deposit size ($${(input.amountUsd / 1000).toFixed(0)}k) could affect routing quality`);
      impactScore += 20;
    }

    // Quote quality signals
    if (input.isFallback) {
      reasons.push("Fallback quote active — actual output may differ from estimate");
      impactScore += 15;
    }
    if (input.isStale) {
      reasons.push("Quote is stale — market conditions may have shifted");
      impactScore += 10;
    }

    // Route output delta
    if (input.quote) {
      const outputDelta = computeOutputDelta(input.quote.prevExpectedOut, input.quote.expectedOut);
      if (outputDelta >= 10) {
        reasons.push(`Quote output changed by ${outputDelta.toFixed(1)}% since last fetch — possible route shift`);
        impactScore += 25;
      } else if (outputDelta > 5) {
        reasons.push(`Quote output changed by ${outputDelta.toFixed(1)}% — minor route variation`);
        impactScore += 10;
      }

      // Quote age signal
      const quoteAgeMs = Date.now() - new Date(input.quote.quotedAt).getTime();
      if (quoteAgeMs > MAX_QUOTE_AGE_MS) {
        const ageSec = Math.floor(quoteAgeMs / 1000);
        reasons.push(`Quote is ${ageSec}s old — freshness degraded`);
        impactScore += 15;
      }

      // Route depth signal — multi-hop routes (more than one intermediate pool)
      // compound slippage and execution risk beyond what the output delta alone reflects.
      const hopCount = computeHopCount(input.quote.route);
      if (hopCount >= CRITICAL_HOP_COUNT) {
        reasons.push(
          `Route spans ${hopCount} hops through multiple intermediate pools — deep multi-hop paths compound execution risk`,
        );
        impactScore += 30;
      } else if (hopCount >= WARNING_HOP_COUNT) {
        reasons.push(
          `Route spans ${hopCount} hops through intermediate pools — execution risk increases with route depth`,
        );
        impactScore += 15;
      }

      // Path-change signal — a different hop sequence was selected since the
      // last fetch. This can hide behind a stable headline output number, so
      // it's evaluated independently of the output-delta signal above.
      if (input.quote.prevRoute && !routesEqual(input.quote.route, input.quote.prevRoute)) {
        if (outputDelta < NOMINAL_OUTPUT_DELTA_PCT) {
          reasons.push(
            `Route path changed to a different ${hopCount}-hop sequence while expected output stayed nominal — confirm the new route before proceeding`,
          );
          impactScore += 20;
        } else {
          reasons.push("Route path changed alongside the output amount — verify the new route");
          impactScore += 10;
        }
      }
    }

    // Fragmentation signals
    if (input.executionQualityScore !== undefined) {
      if (input.executionQualityScore < CRITICAL_EXECUTION_QUALITY) {
        reasons.push(`Critical execution quality (${input.executionQualityScore}/100) — high fragmentation detected`);
        impactScore += 35;
      } else if (input.executionQualityScore < LOW_EXECUTION_QUALITY) {
        reasons.push(`Degraded execution quality (${input.executionQualityScore}/100) due to fragmented liquidity`);
        impactScore += 20;
      }
    }

    if (input.materialImpact) {
      reasons.push("This deposit route has a material impact on pool allocation");
      impactScore += 15;
    }

    const clampedScore = Math.min(100, impactScore);

    let severity: ImpactSeverity = "none";
    if (clampedScore >= 60) {
      severity = "critical";
    } else if (clampedScore >= 25) {
      severity = "warning";
    }

    // Block conditions
    let shouldBlock = false;
    let blockReason: string | undefined;

    const blockStale = input.blockStaleQuotes !== false;
    if (blockStale && input.isStale) {
      shouldBlock = true;
      blockReason = "Quote is stale. Refresh to get current rates before submitting.";
    } else if (severity === "critical" && clampedScore >= (input.routeImpactThreshold ?? DEFAULT_ROUTE_IMPACT_THRESHOLD)) {
      shouldBlock = true;
      blockReason = "Route impact exceeds safety threshold. Reduce amount or adjust slippage.";
    }

    return { severity, reasons, impactScore: clampedScore, shouldBlock, blockReason };
  }, [input]);
}
