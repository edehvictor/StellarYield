import {
  DEFAULT_CONCENTRATION_THRESHOLDS,
  resolveConcentrationThresholds,
  type ConcentrationThresholds,
  type ConcentrationThresholdsInput,
} from "../../../shared/types/exposureConcentration";

/**
 * Deployment-level overrides for exposure concentration warnings.
 *
 * Each variable is a share in (0, 1] — `0.6` means "warn once a single asset
 * exceeds 60% of the portfolio". Anything missing or out of range falls back to
 * the shared defaults, so a bad value degrades to safe behaviour instead of
 * disabling the warnings.
 *
 * | Variable                             | Default |
 * | ------------------------------------ | ------- |
 * | `CONCENTRATION_ASSET_WARN_SHARE`     | 0.5     |
 * | `CONCENTRATION_ASSET_CRITICAL_SHARE` | 0.85    |
 * | `CONCENTRATION_PROTOCOL_WARN_SHARE`  | 0.5     |
 * | `CONCENTRATION_PROTOCOL_CRITICAL_SHARE` | 0.85 |
 */
function readShare(raw: string | undefined): number | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readConcentrationThresholdOverrides(
  env: NodeJS.ProcessEnv = process.env,
): ConcentrationThresholdsInput {
  return {
    asset: {
      warn: readShare(env.CONCENTRATION_ASSET_WARN_SHARE),
      critical: readShare(env.CONCENTRATION_ASSET_CRITICAL_SHARE),
    },
    protocol: {
      warn: readShare(env.CONCENTRATION_PROTOCOL_WARN_SHARE),
      critical: readShare(env.CONCENTRATION_PROTOCOL_CRITICAL_SHARE),
    },
  };
}

/** Configured thresholds for this deployment, with defaults applied. */
export function getConcentrationThresholds(
  env: NodeJS.ProcessEnv = process.env,
): ConcentrationThresholds {
  return resolveConcentrationThresholds(readConcentrationThresholdOverrides(env));
}

export { DEFAULT_CONCENTRATION_THRESHOLDS };
