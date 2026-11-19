export interface StrategyCompatibilityCandidate {
  id: string;
  compatibilityTags: string[];
  isActive: boolean;
}

export interface StrategyCompatibilityMetadata {
  strategies: StrategyCompatibilityCandidate[];
}

export interface RebalanceExecutionStrategy extends Record<string, unknown> {
  vaultContractId?: string;
  intentValidUntil?: string;
  strategyCompatibility?: StrategyCompatibilityMetadata;
}

export interface StrategyCompatibilityResult {
  compatible: boolean;
  issues: string[];
}

const INCOMPATIBLE_TAG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["stablecoin-only", "volatile-assets"],
  ["manual-execution", "automated-rebalancing"],
  ["high-frequency", "low-frequency"],
];

const INVALID_METADATA_ISSUE = "Strategy compatibility metadata is invalid";

/**
 * Validate a strategy compatibility payload without exposing provider or
 * runtime errors to callers.
 */
export function checkStrategyCompatibility(
  metadata: unknown,
): StrategyCompatibilityResult {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("strategies" in metadata) ||
    !Array.isArray(metadata.strategies) ||
    metadata.strategies.length === 0
  ) {
    return { compatible: false, issues: [INVALID_METADATA_ISSUE] };
  }

  const ids = new Set<string>();
  const activeTags = new Set<string>();
  let activeCount = 0;

  for (const strategy of metadata.strategies) {
    if (
      typeof strategy !== "object" ||
      strategy === null ||
      !("id" in strategy) ||
      typeof strategy.id !== "string" ||
      strategy.id.trim().length === 0 ||
      !("compatibilityTags" in strategy) ||
      !Array.isArray(strategy.compatibilityTags) ||
      !strategy.compatibilityTags.every(
        (tag: unknown) => typeof tag === "string" && tag.trim().length > 0,
      ) ||
      !("isActive" in strategy) ||
      typeof strategy.isActive !== "boolean" ||
      ids.has(strategy.id)
    ) {
      return { compatible: false, issues: [INVALID_METADATA_ISSUE] };
    }

    ids.add(strategy.id);
    if (!strategy.isActive) continue;

    activeCount++;
    for (const tag of strategy.compatibilityTags) {
      activeTags.add(tag.trim().toLowerCase());
    }
  }

  if (activeCount === 0) {
    return {
      compatible: false,
      issues: ["At least one active strategy is required for compatibility validation"],
    };
  }

  const issues = INCOMPATIBLE_TAG_PAIRS
    .filter(([first, second]) => activeTags.has(first) && activeTags.has(second))
    .map(
      ([first, second]) =>
        `Incompatible strategy tags: "${first}" cannot be combined with "${second}"`,
    );

  return { compatible: issues.length === 0, issues };
}
