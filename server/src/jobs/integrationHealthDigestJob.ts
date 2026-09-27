/**
 * Scheduled integration health digest job (#1341).
 *
 * Wires a node-cron scheduler to the integration health digest: each run
 * probes the backend integrations with the same typed checkers that power
 * `GET /api/health/dependencies`, records the digest for
 * `GET /api/health/digest`, and sends it to the monitoring alert channel with a
 * severity that follows the digest's overall status.
 */
import cron from "node-cron";
import {
  checkCacheWithLatency,
  checkDatabaseWithLatency,
  checkHorizonWithLatency,
  checkIndexerWithLatency,
  checkSorobanRpcWithLatency,
} from "../routes/health";
import { sendAlert } from "../monitoring/healthMonitor";
import { AlertSeverity } from "../utils/alertSeverity";
import {
  formatIntegrationHealthDigest,
  runIntegrationHealthDigest,
  type IntegrationDigestStatus,
  type IntegrationHealthDigest,
  type IntegrationProbe,
} from "../services/integrationHealthDigestService";
import {
  resolveIntegrationHealthDigestConfig,
  type IntegrationHealthDigestConfig,
} from "../config/integrationHealthDigest";

let jobHandle: ReturnType<typeof cron.schedule> | null = null;

/** Integrations covered by the scheduled digest. */
export const DEFAULT_INTEGRATION_PROBES: IntegrationProbe[] = [
  { name: "database", check: checkDatabaseWithLatency },
  { name: "horizon", check: checkHorizonWithLatency },
  { name: "sorobanRpc", check: checkSorobanRpcWithLatency },
  // Indexer state availability; ledger lag is reported by /api/health/dependencies.
  { name: "indexer", check: () => checkIndexerWithLatency() },
  { name: "cache", check: checkCacheWithLatency },
];

const DIGEST_SEVERITY: Record<IntegrationDigestStatus, AlertSeverity> = {
  healthy: AlertSeverity.LOW,
  degraded: AlertSeverity.MEDIUM,
  outage: AlertSeverity.HIGH,
};

async function deliverToAlertChannel(digest: IntegrationHealthDigest): Promise<void> {
  await sendAlert(formatIntegrationHealthDigest(digest), DIGEST_SEVERITY[digest.overallStatus]);
}

/**
 * Run a single digest pass and return its result. Exposed so operators or
 * tests can trigger a pass on demand.
 */
export async function runIntegrationHealthDigestOnce(
  config: IntegrationHealthDigestConfig = resolveIntegrationHealthDigestConfig(),
  probes: readonly IntegrationProbe[] = DEFAULT_INTEGRATION_PROBES,
) {
  return runIntegrationHealthDigest({
    probes,
    deliver: deliverToAlertChannel,
    timeoutMs: config.probeTimeoutMs,
  });
}

export function startIntegrationHealthDigestJob(
  config: IntegrationHealthDigestConfig = resolveIntegrationHealthDigestConfig(),
) {
  if (jobHandle) return;
  if (!config.enabled) {
    console.log("Integration Health Digest Job disabled via INTEGRATION_HEALTH_DIGEST_ENABLED");
    return;
  }
  if (!cron.validate(config.schedule)) {
    console.error(
      `Integration Health Digest Job not started: invalid schedule "${config.schedule}"`,
    );
    return;
  }

  console.log(`Starting Integration Health Digest Job with schedule: ${config.schedule}`);

  jobHandle = cron.schedule(config.schedule, async () => {
    try {
      const run = await runIntegrationHealthDigestOnce(config);
      console.log(
        `[IntegrationHealthDigest] ${run.digest.overallStatus}: ` +
          `${run.digest.summary.down} down, ${run.digest.summary.warning} warning` +
          (run.deliveryError ? ` (${run.deliveryError})` : ""),
      );
    } catch (error) {
      console.error("Integration Health Digest Job failed:", error);
    }
  });
}

export function stopIntegrationHealthDigestJob() {
  if (jobHandle) {
    jobHandle.stop();
    jobHandle = null;
    console.log("Integration Health Digest Job stopped");
  }
}
