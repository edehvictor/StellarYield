/**
 * Scheduled health digest for backend integrations (#1341).
 *
 * Probes each backend integration (database, Horizon, Soroban RPC, indexer,
 * cache, …) on a schedule and condenses the results into a single digest: an
 * overall status, each integration's status with its stable error code, and
 * counts. The digest is built only from the probes' typed snapshots — status,
 * `errorCode`, `retryable` — so it is deterministic and never echoes raw
 * provider messages. A probe that throws or hangs is reported with its own
 * stable code instead of failing the whole digest.
 */
import type { HealthSnapshot } from "../routes/health";

// ── Types ─────────────────────────────────────────────────────────────────

export interface IntegrationProbe {
  /** Stable integration id, e.g. "database" or "horizon". */
  name: string;
  /** Returns the integration's typed health snapshot. */
  check: () => Promise<HealthSnapshot>;
}

export type IntegrationDigestStatus = "healthy" | "degraded" | "outage";

export interface IntegrationDigestEntry {
  name: string;
  status: HealthSnapshot["status"];
  /** Stable code from the probe (e.g. `HORIZON_UNREACHABLE`), or null when up. */
  errorCode: string | null;
  retryable: boolean;
  latencyMs: number | null;
  checkedAt: string;
}

export interface IntegrationHealthDigest {
  generatedAt: string;
  overallStatus: IntegrationDigestStatus;
  summary: { total: number; up: number; warning: number; down: number };
  /** Sorted by severity (down, warning, up), then by name. */
  integrations: IntegrationDigestEntry[];
}

/** Codes reported for a probe that failed to produce a snapshot at all. */
export const PROBE_FAILED = "PROBE_FAILED";
export const PROBE_TIMEOUT = "PROBE_TIMEOUT";

// ── Typed errors ──────────────────────────────────────────────────────────

export type IntegrationHealthDigestErrorCode =
  | "HEALTH_DIGEST_NO_INTEGRATIONS"
  | "HEALTH_DIGEST_DUPLICATE_INTEGRATION"
  | "HEALTH_DIGEST_NOT_READY"
  | "HEALTH_DIGEST_DELIVERY_FAILED";

export interface IntegrationHealthDigestErrorDescriptor {
  code: IntegrationHealthDigestErrorCode;
  httpStatus: number;
  retryable: boolean;
  defaultMessage: string;
}

export const INTEGRATION_HEALTH_DIGEST_ERRORS: Record<
  IntegrationHealthDigestErrorCode,
  IntegrationHealthDigestErrorDescriptor
> = {
  HEALTH_DIGEST_NO_INTEGRATIONS: {
    code: "HEALTH_DIGEST_NO_INTEGRATIONS",
    httpStatus: 500,
    retryable: false,
    defaultMessage: "No integrations are configured for the health digest.",
  },
  HEALTH_DIGEST_DUPLICATE_INTEGRATION: {
    code: "HEALTH_DIGEST_DUPLICATE_INTEGRATION",
    httpStatus: 500,
    retryable: false,
    defaultMessage: "Each integration may appear only once in the health digest.",
  },
  HEALTH_DIGEST_NOT_READY: {
    code: "HEALTH_DIGEST_NOT_READY",
    httpStatus: 404,
    retryable: true,
    defaultMessage: "No integration health digest has been generated yet.",
  },
  HEALTH_DIGEST_DELIVERY_FAILED: {
    code: "HEALTH_DIGEST_DELIVERY_FAILED",
    httpStatus: 502,
    retryable: true,
    defaultMessage: "The integration health digest could not be delivered.",
  },
};

export class IntegrationHealthDigestError extends Error {
  readonly code: IntegrationHealthDigestErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: IntegrationHealthDigestErrorCode, message?: string) {
    const descriptor = INTEGRATION_HEALTH_DIGEST_ERRORS[code];
    super(message ?? descriptor.defaultMessage);
    this.name = "IntegrationHealthDigestError";
    this.code = code;
    this.statusCode = descriptor.httpStatus;
    this.retryable = descriptor.retryable;
  }
}

// ── Collection ────────────────────────────────────────────────────────────

export interface CollectIntegrationHealthOptions {
  /** Deadline per probe; slower probes are reported as `PROBE_TIMEOUT`. */
  timeoutMs: number;
  now?: () => Date;
}

const TIMED_OUT = Symbol("timed out");

async function probeIntegration(
  probe: IntegrationProbe,
  timeoutMs: number,
  now: () => Date,
): Promise<IntegrationDigestEntry> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      probe.check(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      return {
        name: probe.name,
        status: "down",
        errorCode: PROBE_TIMEOUT,
        retryable: true,
        latencyMs: null,
        checkedAt: now().toISOString(),
      };
    }
    return {
      name: probe.name,
      status: result.status,
      errorCode: result.errorCode,
      retryable: result.retryable,
      latencyMs: result.latencyMs ?? null,
      checkedAt: result.checkedAt,
    };
  } catch {
    // The probe's own error text may carry hosts or credentials; report only
    // the stable code.
    return {
      name: probe.name,
      status: "down",
      errorCode: PROBE_FAILED,
      retryable: true,
      latencyMs: null,
      checkedAt: now().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every probe concurrently. Throws `IntegrationHealthDigestError` when the
 * probe list is empty or names an integration twice.
 */
export async function collectIntegrationHealth(
  probes: readonly IntegrationProbe[],
  { timeoutMs, now = () => new Date() }: CollectIntegrationHealthOptions,
): Promise<IntegrationDigestEntry[]> {
  if (probes.length === 0) {
    throw new IntegrationHealthDigestError("HEALTH_DIGEST_NO_INTEGRATIONS");
  }
  const names = new Set<string>();
  for (const probe of probes) {
    if (names.has(probe.name)) {
      throw new IntegrationHealthDigestError(
        "HEALTH_DIGEST_DUPLICATE_INTEGRATION",
        `Integration "${probe.name}" appears more than once in the health digest.`,
      );
    }
    names.add(probe.name);
  }
  return Promise.all(probes.map((probe) => probeIntegration(probe, timeoutMs, now)));
}

// ── Digest ────────────────────────────────────────────────────────────────

const STATUS_RANK: Record<IntegrationDigestEntry["status"], number> = {
  down: 0,
  warning: 1,
  up: 2,
};

/** Condense probe results into a digest. Pure: the same input yields the same digest. */
export function buildIntegrationHealthDigest(
  entries: readonly IntegrationDigestEntry[],
  generatedAt: Date,
): IntegrationHealthDigest {
  const integrations = [...entries].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name),
  );
  const summary = {
    total: integrations.length,
    up: integrations.filter((e) => e.status === "up").length,
    warning: integrations.filter((e) => e.status === "warning").length,
    down: integrations.filter((e) => e.status === "down").length,
  };
  const overallStatus: IntegrationDigestStatus =
    summary.down > 0 ? "outage" : summary.warning > 0 ? "degraded" : "healthy";

  return {
    generatedAt: generatedAt.toISOString(),
    overallStatus,
    summary,
    integrations,
  };
}

/** Plain-text rendering for alert channels; lists every integration that is not up. */
export function formatIntegrationHealthDigest(digest: IntegrationHealthDigest): string {
  const { summary } = digest;
  const header =
    `Integration health digest — ${digest.overallStatus.toUpperCase()} ` +
    `(${summary.total} integrations: ${summary.up} up, ${summary.warning} warning, ${summary.down} down)`;
  const attention = digest.integrations
    .filter((entry) => entry.status !== "up")
    .map(
      (entry) =>
        `• ${entry.name}: ${entry.status} (${entry.errorCode ?? "NO_CODE"}` +
        `${entry.retryable ? ", retryable" : ""})`,
    );
  return [header, ...(attention.length > 0 ? attention : ["All integrations healthy."])].join("\n");
}

// ── Scheduled run ─────────────────────────────────────────────────────────

export type IntegrationHealthDigestDelivery = (digest: IntegrationHealthDigest) => Promise<void>;

export interface IntegrationHealthDigestRun {
  digest: IntegrationHealthDigest;
  delivered: boolean;
  /** Set when delivery failed; the digest is still recorded. */
  deliveryError: "HEALTH_DIGEST_DELIVERY_FAILED" | null;
}

export interface RunIntegrationHealthDigestOptions extends CollectIntegrationHealthOptions {
  probes: readonly IntegrationProbe[];
  deliver: IntegrationHealthDigestDelivery;
}

let latestDigest: IntegrationHealthDigest | null = null;

/** Probe every integration, record the digest as the latest one, and deliver it. */
export async function runIntegrationHealthDigest({
  probes,
  deliver,
  timeoutMs,
  now = () => new Date(),
}: RunIntegrationHealthDigestOptions): Promise<IntegrationHealthDigestRun> {
  const entries = await collectIntegrationHealth(probes, { timeoutMs, now });
  const digest = buildIntegrationHealthDigest(entries, now());
  latestDigest = digest;

  try {
    await deliver(digest);
    return { digest, delivered: true, deliveryError: null };
  } catch {
    console.error("[IntegrationHealthDigest] delivery failed: HEALTH_DIGEST_DELIVERY_FAILED");
    return { digest, delivered: false, deliveryError: "HEALTH_DIGEST_DELIVERY_FAILED" };
  }
}

/** The most recent digest, or null before the first scheduled run. */
export function getLatestIntegrationHealthDigest(): IntegrationHealthDigest | null {
  return latestDigest;
}

/** Test-only: forget the recorded digest. */
export function resetIntegrationHealthDigest(): void {
  latestDigest = null;
}
