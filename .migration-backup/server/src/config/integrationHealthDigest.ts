/**
 * Scheduled integration health digest configuration (#1341).
 *
 * Controls whether the digest job runs, how often it fires, and how long a
 * single integration probe may take before it is reported as timed out. Every
 * value is deploy-time configurable via environment variables and degrades to
 * a safe default when missing or malformed.
 *
 * | Variable                                     | Default                 |
 * | -------------------------------------------- | ----------------------- |
 * | `INTEGRATION_HEALTH_DIGEST_ENABLED`          | `true`                  |
 * | `INTEGRATION_HEALTH_DIGEST_SCHEDULE`         | `0 9 * * *` (daily 09:00) |
 * | `INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS` | `10000`                 |
 */

export interface IntegrationHealthDigestConfig {
  /** Master switch for the scheduled digest (set to "false" to disable). */
  enabled: boolean;
  /** cron expression for the scheduled digest. */
  schedule: string;
  /** Per-integration probe deadline; slower probes are reported as timed out. */
  probeTimeoutMs: number;
}

export const DEFAULT_INTEGRATION_HEALTH_DIGEST_SCHEDULE = "0 9 * * *";
export const DEFAULT_INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS = 10_000;

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  return raw.trim().toLowerCase() === "true";
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the deployed digest configuration, applying defaults for anything
 * missing or malformed.
 */
export function resolveIntegrationHealthDigestConfig(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationHealthDigestConfig {
  return {
    enabled: readBool(env.INTEGRATION_HEALTH_DIGEST_ENABLED, true),
    schedule:
      env.INTEGRATION_HEALTH_DIGEST_SCHEDULE?.trim() ||
      DEFAULT_INTEGRATION_HEALTH_DIGEST_SCHEDULE,
    probeTimeoutMs: readPositiveInt(
      env.INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS,
      DEFAULT_INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS,
    ),
  };
}
