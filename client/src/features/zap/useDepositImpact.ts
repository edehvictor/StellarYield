import { useMemo } from "react";

export type ImpactSeverity = "none" | "warning" | "critical";

export interface DepositImpactResult {
  severity: ImpactSeverity;
  reasons: string[];
  /** Estimated execution-quality degradation 0-100 */
  impactScore: number;
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
}

const WARNING_SLIPPAGE_PCT = 3;
const CRITICAL_SLIPPAGE_PCT = 8;
const WARNING_AMOUNT_USD = 50_000;
const CRITICAL_AMOUNT_USD = 500_000;
const LOW_EXECUTION_QUALITY = 70;
const CRITICAL_EXECUTION_QUALITY = 50;

/**
 * Pure hook — computes deposit route impact without side effects.
 * Returns the severity, human-readable reasons, and a composite impact score.
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

    return { severity, reasons, impactScore: clampedScore };
  }, [input]);
}
