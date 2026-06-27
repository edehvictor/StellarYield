/**
 * Pure scoring helpers for execution quality classification.
 *
 * Extracted from ExecutionQualityCard so thresholds and labels can be
 * unit-tested independently of React rendering.
 *
 * Thresholds (from spec §4.2):
 *   score >= 70  →  "Good"      (green)
 *   score >= 50  →  "Fair"      (yellow)
 *   score <  50  →  "Poor"      (red)
 *
 * Material impact (§4.3):
 *   executionQualityScore < 70  →  materialImpact = true
 */

export type ExecutionQualityLabel = "Good" | "Fair" | "Poor";

export type ExecutionQualityTier = "good" | "fair" | "poor";

export interface ExecutionQualityClassification {
  label:  ExecutionQualityLabel;
  tier:   ExecutionQualityTier;
  /** Whether this score triggers the material-impact warning. */
  materialImpact: boolean;
}

/** Boundaries that define tier transitions. */
export const QUALITY_THRESHOLDS = {
  GOOD: 70,
  FAIR: 50,
} as const;

/** Score range for the 0-100 execution quality scale. */
export const QUALITY_SCALE = { MIN: 0, MAX: 100 } as const;

/**
 * Classify a raw execution quality score (0–100) into a label, tier, and
 * material-impact flag.
 *
 * Scores outside [0, 100] are clamped before classification so callers
 * don't need to guard against out-of-range values from the API.
 */
export function classifyExecutionQuality(
  rawScore: number,
): ExecutionQualityClassification {
  const score = Math.max(QUALITY_SCALE.MIN, Math.min(QUALITY_SCALE.MAX, rawScore));

  if (score >= QUALITY_THRESHOLDS.GOOD) {
    return { label: "Good", tier: "good", materialImpact: false };
  }
  if (score >= QUALITY_THRESHOLDS.FAIR) {
    return { label: "Fair", tier: "fair", materialImpact: true };
  }
  return { label: "Poor", tier: "poor", materialImpact: true };
}

/**
 * Round a raw score to one decimal place, matching the display precision
 * used by ExecutionQualityCard.
 */
export function formatQualityScore(score: number): string {
  return score.toFixed(1);
}

/**
 * Given a fragmentation score (0–100 HHI-derived scale), derive the
 * FragmentationCategory label used in FragmentationMetrics.
 *
 * Thresholds (from README §3):
 *   score <= 33  →  "Low"
 *   score <= 66  →  "Medium"
 *   score >  66  →  "High"
 */
export type FragmentationCategoryLabel = "Low" | "Medium" | "High";

export const FRAGMENTATION_THRESHOLDS = {
  LOW_MAX:    33,
  MEDIUM_MAX: 66,
} as const;

export function classifyFragmentationScore(
  score: number,
): FragmentationCategoryLabel {
  if (score <= FRAGMENTATION_THRESHOLDS.LOW_MAX)    return "Low";
  if (score <= FRAGMENTATION_THRESHOLDS.MEDIUM_MAX) return "Medium";
  return "High";
}
