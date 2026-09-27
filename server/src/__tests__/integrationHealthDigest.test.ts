/**
 * Scheduled health digest for backend integrations (#1341).
 */
import cron from "node-cron";
import type { HealthSnapshot } from "../routes/health";
import { sendAlert } from "../monitoring/healthMonitor";
import {
  buildIntegrationHealthDigest,
  collectIntegrationHealth,
  formatIntegrationHealthDigest,
  getLatestIntegrationHealthDigest,
  IntegrationHealthDigestError,
  PROBE_FAILED,
  PROBE_TIMEOUT,
  resetIntegrationHealthDigest,
  runIntegrationHealthDigest,
  type IntegrationProbe,
} from "../services/integrationHealthDigestService";
import {
  DEFAULT_INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS,
  DEFAULT_INTEGRATION_HEALTH_DIGEST_SCHEDULE,
  resolveIntegrationHealthDigestConfig,
} from "../config/integrationHealthDigest";
import {
  runIntegrationHealthDigestOnce,
  startIntegrationHealthDigestJob,
  stopIntegrationHealthDigestJob,
} from "../jobs/integrationHealthDigestJob";

jest.mock("../routes/health", () => {
  const up = (checkedAt: string) => ({ status: "up", checkedAt, errorCode: null, retryable: false, latencyMs: 5 });
  return {
    checkDatabaseWithLatency: jest.fn(async () => up("2026-09-24T09:00:00.000Z")),
    checkHorizonWithLatency: jest.fn(async () => ({
      status: "down",
      checkedAt: "2026-09-24T09:00:00.000Z",
      errorCode: "HORIZON_UNREACHABLE",
      retryable: true,
    })),
    checkSorobanRpcWithLatency: jest.fn(async () => up("2026-09-24T09:00:00.000Z")),
    checkIndexerWithLatency: jest.fn(async () => up("2026-09-24T09:00:00.000Z")),
    checkCacheWithLatency: jest.fn(async () => up("2026-09-24T09:00:00.000Z")),
  };
});

jest.mock("../monitoring/healthMonitor", () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("node-cron", () => ({
  __esModule: true,
  default: {
    schedule: jest.fn(() => ({ stop: jest.fn() })),
    validate: jest.fn((expression: string) => expression.trim().split(/\s+/).length === 5),
  },
}));

const NOW = new Date("2026-09-24T09:00:00.000Z");
const now = () => NOW;

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    status: "up",
    latencyMs: 12,
    checkedAt: NOW.toISOString(),
    errorCode: null,
    retryable: false,
    ...overrides,
  };
}

function probe(name: string, result: HealthSnapshot | (() => Promise<HealthSnapshot>)): IntegrationProbe {
  return { name, check: typeof result === "function" ? result : async () => result };
}

afterEach(() => {
  resetIntegrationHealthDigest();
  stopIntegrationHealthDigestJob();
  jest.clearAllMocks();
});

describe("buildIntegrationHealthDigest", () => {
  it("reports healthy with every integration up", async () => {
    const entries = await collectIntegrationHealth(
      [probe("horizon", snapshot()), probe("database", snapshot())],
      { timeoutMs: 1_000, now },
    );

    const digest = buildIntegrationHealthDigest(entries, NOW);

    expect(digest).toMatchObject({
      generatedAt: "2026-09-24T09:00:00.000Z",
      overallStatus: "healthy",
      summary: { total: 2, up: 2, warning: 0, down: 0 },
    });
    expect(digest.integrations.map((e) => e.name)).toEqual(["database", "horizon"]);
  });

  it("orders by severity and reports an outage when any integration is down", async () => {
    const entries = await collectIntegrationHealth(
      [
        probe("cache", snapshot()),
        probe("indexer", snapshot({ status: "warning", errorCode: "INDEXER_LAG", retryable: true })),
        probe("horizon", snapshot({ status: "down", errorCode: "HORIZON_UNREACHABLE", retryable: true })),
      ],
      { timeoutMs: 1_000, now },
    );

    const digest = buildIntegrationHealthDigest(entries, NOW);

    expect(digest.overallStatus).toBe("outage");
    expect(digest.summary).toEqual({ total: 3, up: 1, warning: 1, down: 1 });
    expect(digest.integrations.map((e) => [e.name, e.errorCode])).toEqual([
      ["horizon", "HORIZON_UNREACHABLE"],
      ["indexer", "INDEXER_LAG"],
      ["cache", null],
    ]);
  });

  it("reports degraded when the worst status is a warning", () => {
    const digest = buildIntegrationHealthDigest(
      [
        { name: "indexer", status: "warning", errorCode: "INDEXER_LAG", retryable: true, latencyMs: 3, checkedAt: NOW.toISOString() },
      ],
      NOW,
    );
    expect(digest.overallStatus).toBe("degraded");
  });

  it("is deterministic regardless of probe order", async () => {
    const probes = [
      probe("sorobanRpc", snapshot()),
      probe("database", snapshot({ status: "down", errorCode: "DB_UNREACHABLE", retryable: true })),
    ];
    const forward = buildIntegrationHealthDigest(await collectIntegrationHealth(probes, { timeoutMs: 1_000, now }), NOW);
    const reversed = buildIntegrationHealthDigest(
      await collectIntegrationHealth([...probes].reverse(), { timeoutMs: 1_000, now }),
      NOW,
    );
    expect(reversed).toEqual(forward);
  });
});

describe("collectIntegrationHealth failures", () => {
  it("reports a throwing probe as PROBE_FAILED without its raw message", async () => {
    const entries = await collectIntegrationHealth(
      [
        probe("horizon", async () => {
          throw new Error("connect ECONNREFUSED secret-host.internal:443");
        }),
      ],
      { timeoutMs: 1_000, now },
    );

    expect(entries).toEqual([
      {
        name: "horizon",
        status: "down",
        errorCode: PROBE_FAILED,
        retryable: true,
        latencyMs: null,
        checkedAt: NOW.toISOString(),
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-host");
  });

  it("reports a hanging probe as PROBE_TIMEOUT", async () => {
    const entries = await collectIntegrationHealth(
      [probe("database", () => new Promise<HealthSnapshot>(() => undefined))],
      { timeoutMs: 10, now },
    );

    expect(entries[0]).toMatchObject({ name: "database", status: "down", errorCode: PROBE_TIMEOUT });
  });

  it("rejects an empty or duplicated integration list with typed errors", async () => {
    await expect(collectIntegrationHealth([], { timeoutMs: 1_000 })).rejects.toMatchObject({
      name: "IntegrationHealthDigestError",
      code: "HEALTH_DIGEST_NO_INTEGRATIONS",
    });
    await expect(
      collectIntegrationHealth([probe("cache", snapshot()), probe("cache", snapshot())], { timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(IntegrationHealthDigestError);
  });
});

describe("runIntegrationHealthDigest", () => {
  it("records the latest digest and delivers it", async () => {
    const deliver = jest.fn().mockResolvedValue(undefined);
    expect(getLatestIntegrationHealthDigest()).toBeNull();

    const run = await runIntegrationHealthDigest({
      probes: [probe("database", snapshot())],
      deliver,
      timeoutMs: 1_000,
      now,
    });

    expect(run).toMatchObject({ delivered: true, deliveryError: null });
    expect(deliver).toHaveBeenCalledWith(run.digest);
    expect(getLatestIntegrationHealthDigest()).toEqual(run.digest);
  });

  it("keeps the digest and returns a typed code when delivery fails", async () => {
    const run = await runIntegrationHealthDigest({
      probes: [probe("database", snapshot())],
      deliver: jest.fn().mockRejectedValue(new Error("webhook 500")),
      timeoutMs: 1_000,
      now,
    });

    expect(run).toMatchObject({ delivered: false, deliveryError: "HEALTH_DIGEST_DELIVERY_FAILED" });
    expect(getLatestIntegrationHealthDigest()).toEqual(run.digest);
  });
});

describe("formatIntegrationHealthDigest", () => {
  it("lists only the integrations that need attention", () => {
    const digest = buildIntegrationHealthDigest(
      [
        { name: "horizon", status: "down", errorCode: "HORIZON_UNREACHABLE", retryable: true, latencyMs: null, checkedAt: NOW.toISOString() },
        { name: "database", status: "up", errorCode: null, retryable: false, latencyMs: 4, checkedAt: NOW.toISOString() },
      ],
      NOW,
    );

    expect(formatIntegrationHealthDigest(digest)).toBe(
      "Integration health digest — OUTAGE (2 integrations: 1 up, 0 warning, 1 down)\n" +
        "• horizon: down (HORIZON_UNREACHABLE, retryable)",
    );
  });

  it("says so when everything is healthy", () => {
    const digest = buildIntegrationHealthDigest(
      [{ name: "database", status: "up", errorCode: null, retryable: false, latencyMs: 4, checkedAt: NOW.toISOString() }],
      NOW,
    );
    expect(formatIntegrationHealthDigest(digest)).toContain("All integrations healthy.");
  });
});

describe("resolveIntegrationHealthDigestConfig", () => {
  it("applies defaults", () => {
    expect(resolveIntegrationHealthDigestConfig({})).toEqual({
      enabled: true,
      schedule: DEFAULT_INTEGRATION_HEALTH_DIGEST_SCHEDULE,
      probeTimeoutMs: DEFAULT_INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS,
    });
  });

  it("reads overrides and ignores malformed values", () => {
    expect(
      resolveIntegrationHealthDigestConfig({
        INTEGRATION_HEALTH_DIGEST_ENABLED: "false",
        INTEGRATION_HEALTH_DIGEST_SCHEDULE: "*/30 * * * *",
        INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS: "-5",
      }),
    ).toEqual({
      enabled: false,
      schedule: "*/30 * * * *",
      probeTimeoutMs: DEFAULT_INTEGRATION_HEALTH_DIGEST_PROBE_TIMEOUT_MS,
    });
  });
});

describe("integration health digest job", () => {
  const config = { enabled: true, schedule: "0 9 * * *", probeTimeoutMs: 1_000 };

  it("probes the default integrations and alerts with the digest severity", async () => {
    const run = await runIntegrationHealthDigestOnce(config);

    expect(run.digest.overallStatus).toBe("outage");
    expect(run.digest.integrations.map((e) => e.name)).toEqual([
      "horizon",
      "cache",
      "database",
      "indexer",
      "sorobanRpc",
    ]);
    expect(sendAlert).toHaveBeenCalledWith(formatIntegrationHealthDigest(run.digest), "HIGH");
  });

  it("schedules the digest when enabled", () => {
    startIntegrationHealthDigestJob(config);
    expect(cron.schedule).toHaveBeenCalledWith("0 9 * * *", expect.any(Function));
  });

  it("does not schedule when disabled or when the schedule is invalid", () => {
    startIntegrationHealthDigestJob({ ...config, enabled: false });
    startIntegrationHealthDigestJob({ ...config, schedule: "not a cron" });
    expect(cron.schedule).not.toHaveBeenCalled();
  });
});
