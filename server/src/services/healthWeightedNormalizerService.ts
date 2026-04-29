/**
 * Health-Weighted Allocation Normalizer (#384)
 *
 * Blends protocol health scores into allocation weights before explicit
 * exclusion kicks in. Hard safety blocks and freeze conditions are never
 * overridden by health weighting.
 */

export interface ProtocolHealth {
  protocolId: string;
  /** 0–1: 1 = fully healthy, 0 = completely degraded */
  healthScore: number;
  /** Hard block — allocation must be 0 regardless of health score */
  hardBlocked: boolean;
  /** Freeze condition — treated same as hardBlocked */
  frozen: boolean;
}

export interface AllocationInput {
  protocolId: string;
  /** Raw allocation weight before health adjustment */
  rawWeight: number;
}

export interface NormalizedAllocation {
  protocolId: string;
  adjustedWeight: number;
  /** Final allocation as a fraction of total (0–1) */
  normalizedPct: number;
}

export interface NormalizerConfig {
  /**
   * How strongly health score influences weight reduction.
   * 0 = no effect, 1 = full effect (degraded protocol gets 0 weight).
   * Default: 0.5
   */
  weightingStrength: number;
  /** Minimum allocation fraction for non-blocked protocols (0–1). Default: 0.01 */
  floor: number;
  /** Maximum allocation fraction for any single protocol (0–1). Default: 1 */
  ceiling: number;
}

const DEFAULT_CONFIG: NormalizerConfig = {
  weightingStrength: 0.5,
  floor: 0.01,
  ceiling: 1,
};

export class HealthWeightedNormalizerService {
  normalize(
    allocations: AllocationInput[],
    healthMap: Record<string, ProtocolHealth>,
    config: Partial<NormalizerConfig> = {}
  ): NormalizedAllocation[] {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // Step 1: apply health weighting; hard blocks / freezes → 0
    const adjusted = allocations.map((a) => {
      const health = healthMap[a.protocolId];
      if (!health || health.hardBlocked || health.frozen) {
        return { protocolId: a.protocolId, adjustedWeight: 0 };
      }
      // weight = rawWeight * (1 - weightingStrength * (1 - healthScore))
      const multiplier = 1 - cfg.weightingStrength * (1 - health.healthScore);
      return { protocolId: a.protocolId, adjustedWeight: a.rawWeight * multiplier };
    });

    const total = adjusted.reduce((s, a) => s + a.adjustedWeight, 0);

    if (total === 0) {
      return adjusted.map((a) => ({ ...a, normalizedPct: 0 }));
    }

    // Step 2: normalize to fractions, apply floor/ceiling
    const raw = adjusted.map((a) => ({
      ...a,
      normalizedPct: a.adjustedWeight > 0
        ? Math.min(cfg.ceiling, Math.max(cfg.floor, a.adjustedWeight / total))
        : 0,
    }));

    // Step 3: re-normalize so fractions sum to 1
    const sum = raw.reduce((s, a) => s + a.normalizedPct, 0);
    return raw.map((a) => ({
      ...a,
      normalizedPct: sum > 0 ? Math.round((a.normalizedPct / sum) * 10000) / 10000 : 0,
    }));
  }
}

export const healthWeightedNormalizerService = new HealthWeightedNormalizerService();
