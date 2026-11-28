/**
 * GET /api/yields — privacy-safe failure diagnostics (#1877).
 *
 * The router is mounted on a bare express app (rather than `createApp()`) so
 * each processing stage can be failed deterministically through module mocks.
 */
import express from "express";
import request from "supertest";

jest.mock("../services/yieldService", () => ({
  CURRENT_YIELDS_TTL_SECONDS: 300,
  getYieldDataWithCacheStatus: jest.fn(),
  getYieldParityReport: jest.fn(),
}));
jest.mock("../services/yieldReliabilityService", () => ({
  yieldReliabilityEngine: { calculateReliabilityScore: jest.fn() },
}));
jest.mock("../services/netYieldEngine", () => ({
  calculateNetYield: jest.fn(),
}));
jest.mock("../services/protocolFeeHistoryService", () => ({
  getFeeHistory: jest.fn(),
}));

import yieldsRouter from "../routes/yields";
import { getYieldDataWithCacheStatus } from "../services/yieldService";
import { yieldReliabilityEngine } from "../services/yieldReliabilityService";
import { calculateNetYield } from "../services/netYieldEngine";
import { getFeeHistory } from "../services/protocolFeeHistoryService";
import {
  YIELD_DIAGNOSTIC_CATALOG,
  type YieldDiagnostic,
} from "../../../shared/types/yieldDiagnostics";
import { buildYieldFailureLogEntry, redactForLog } from "../utils/yieldDiagnosticsLog";

const getYields = getYieldDataWithCacheStatus as jest.Mock;
const score = yieldReliabilityEngine.calculateReliabilityScore as jest.Mock;
const netYield = calculateNetYield as jest.Mock;
const feeHistory = getFeeHistory as jest.Mock;

const REQUEST_ID = "req-1877-abc";
const SECRET_URL = "https://provider.example/rates?apiKey=sk_live_SUPERSECRET123";
const SECRET_SEED = "SB3KJ6WVQ7XG2RZ4TF5YHN6ML7OK2PJ3IH4GF5ED6CB7AZ2YX3WV4UT";

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { requestId: string }).requestId = REQUEST_ID;
    next();
  });
  app.use("/api/yields", yieldsRouter);
  return app;
}

const YIELDS = [
  { protocolName: "Blend", totalApy: 6.5, tvlUsd: 1_000_000 },
  { protocolName: "Soroswap", totalApy: 9.1, tvlUsd: 500_000 },
];

function healthyScore() {
  return {
    status: "high",
    signals: { lastSuccessfulFetch: new Date().toISOString() },
    metrics: { freshness: 1 },
  };
}

function mockHealthyPipeline() {
  getYields.mockResolvedValue({ data: YIELDS, cacheStatus: "HIT" });
  score.mockImplementation(async () => healthyScore());
  netYield.mockImplementation((apy: number) => ({
    netApy: apy - 1,
    feeDragApy: 1,
    assumptions: {},
    sensitivity: {},
    feeAttribution: {},
  }));
  feeHistory.mockReturnValue([]);
}

/** Every string a failure response or its log line could expose. */
function expectNoSecrets(text: string) {
  expect(text).not.toContain("SUPERSECRET");
  expect(text).not.toContain("sk_live");
  expect(text).not.toContain(SECRET_SEED);
  expect(text).not.toContain("apiKey=");
  expect(text).not.toMatch(/\bat .*\.ts:\d+/); // stack frames
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockHealthyPipeline();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

function loggedText(): string {
  return JSON.stringify(errorSpy.mock.calls);
}

describe("GET /api/yields — success path", () => {
  it("returns the enriched list unchanged by the diagnostics work", async () => {
    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(200);
    expect(res.headers["x-cache-status"]).toBe("HIT");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        protocolName: "Blend",
        netApy: 5.5,
        isStale: false,
        reliabilityStatus: "high",
        warnings: [],
        feeHistory: [],
      }),
    );
    expect(res.body[0].diagnostic).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("passes valid fee assumptions through to the net-yield engine", async () => {
    await request(buildApp()).get("/api/yields?protocolFeeBps=50&slippageBps=0");
    expect(netYield).toHaveBeenCalledWith(6.5, { protocolFeeBps: 50, slippageBps: 0 });
  });

  it("does not invent an age when freshness metadata is missing", async () => {
    score.mockImplementation(async () => ({ status: "high", signals: {}, metrics: {} }));

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(200);
    expect(res.body[0].isStale).toBe(true);
    expect(res.body[0].warnings).toEqual([
      "Freshness of yield data from Blend could not be determined.",
    ]);
    expect(JSON.stringify(res.body)).not.toContain("Infinity");
  });

  it("tolerates a reliability score with null signals and status", async () => {
    score.mockImplementation(async () => ({ status: null, signals: null, metrics: null }));

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(200);
    expect(res.body[0].reliabilityStatus).toBe("unknown");
    expect(res.body[0].isStale).toBe(true);
  });
});

describe("GET /api/yields — input validation", () => {
  it.each([
    ["protocolFeeBps=abc"],
    ["vaultFeeBps=-1"],
    ["slippageBps=10001"],
    ["rebalanceCostBps="],
    ["protocolFeeBps=1&protocolFeeBps=2"],
  ])("rejects %s with an input_validation diagnostic and no side effects", async (query) => {
    const res = await request(buildApp()).get(`/api/yields?${query}`);

    expect(res.status).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.error).toBe("VALIDATION_FAILED");
    expect(res.body.recoverable).toBe(false);
    expect(res.body.details.invalidParameters).toHaveLength(1);
    const diagnostic: YieldDiagnostic = res.body.diagnostic;
    expect(diagnostic).toEqual({
      code: "YIELD_INPUT_INVALID",
      stage: "input_validation",
      stageKnown: true,
      summary: YIELD_DIAGNOSTIC_CATALOG.YIELD_INPUT_INVALID.summary,
      remediation: YIELD_DIAGNOSTIC_CATALOG.YIELD_INPUT_INVALID.remediation,
      retryable: false,
      requestId: REQUEST_ID,
    });
    // Rejected before any data source is touched: no refresh, no scoring,
    // no fee-history read, so nothing can change.
    expect(getYields).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
    expect(feeHistory).not.toHaveBeenCalled();
  });

  it("reports parameter names but never echoes submitted values", async () => {
    const res = await request(buildApp()).get(
      `/api/yields?protocolFeeBps=${encodeURIComponent(SECRET_SEED)}`,
    );
    expect(res.body.details.invalidParameters).toEqual(["protocolFeeBps"]);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_SEED);
  });
});

describe("GET /api/yields — stage attribution", () => {
  const cases: Array<[string, () => void, YieldDiagnostic["stage"], YieldDiagnostic["code"]]> = [
    [
      "source retrieval",
      () => getYields.mockRejectedValue(new Error(`fetch ${SECRET_URL} failed`)),
      "source_retrieval",
      "YIELD_SOURCE_UNAVAILABLE",
    ],
    [
      "a non-list source result",
      () => getYields.mockResolvedValue({ data: null, cacheStatus: "MISS" }),
      "source_retrieval",
      "YIELD_SOURCE_UNAVAILABLE",
    ],
    [
      "reliability scoring",
      () => score.mockRejectedValue(new Error(`signer ${SECRET_SEED} rejected`)),
      "reliability_scoring",
      "YIELD_RELIABILITY_UNAVAILABLE",
    ],
    [
      "net-yield enrichment",
      () =>
        netYield.mockImplementation(() => {
          throw new Error("token=abcdef123456 overflow");
        }),
      "yield_enrichment",
      "YIELD_ENRICHMENT_FAILED",
    ],
    [
      "fee history enrichment",
      () =>
        feeHistory.mockImplementation(() => {
          throw new Error("fee store down");
        }),
      "yield_enrichment",
      "YIELD_ENRICHMENT_FAILED",
    ],
    [
      "response serialization",
      () => feeHistory.mockReturnValue([{ feeBps: BigInt(5) }]),
      "response_serialization",
      "YIELD_SERIALIZATION_FAILED",
    ],
  ];

  it.each(cases)("attributes a failure in %s to its stage", async (_label, arrange, stage, code) => {
    arrange();

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(500);
    expect(res.headers["cache-control"]).toBe("no-store");
    // Legacy fields kept for existing clients.
    expect(res.body.error).toBe("YIELD_FETCH_FAILED");
    expect(res.body.message).toBe("Unable to fetch yield data right now.");
    expect(res.body.requestId).toBe(REQUEST_ID);
    expect(res.body.recoverable).toBe(true);
    expect(res.body.diagnostic).toEqual(
      expect.objectContaining({
        code,
        stage,
        stageKnown: true,
        retryable: true,
        requestId: REQUEST_ID,
        summary: YIELD_DIAGNOSTIC_CATALOG[code].summary,
        remediation: YIELD_DIAGNOSTIC_CATALOG[code].remediation,
      }),
    );
    expect(res.body.diagnostic.remediation).toEqual(expect.any(String));
    expectNoSecrets(JSON.stringify(res.body));
    expectNoSecrets(loggedText());
    // The failure is logged once, as a structured entry naming the stage.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ event: "yield_request_failed", stage, code, requestId: REQUEST_ID }),
    );
  });

  it("falls back to the unknown stage without remediation when no stage can be attributed", async () => {
    // A throwing getter on the entry fails outside every tagged stage.
    const poisoned = {
      get protocolName(): string {
        throw new Error("corrupted entry");
      },
    };
    getYields.mockResolvedValue({ data: [poisoned], cacheStatus: "MISS" });

    const res = await request(buildApp()).get("/api/yields");

    expect(res.status).toBe(500);
    expect(res.body.diagnostic).toEqual({
      code: "YIELD_STAGE_UNKNOWN",
      stage: "unknown",
      stageKnown: false,
      summary: YIELD_DIAGNOSTIC_CATALOG.YIELD_STAGE_UNKNOWN.summary,
      remediation: null,
      retryable: true,
      requestId: REQUEST_ID,
    });
  });

  it("omits the request id rather than emitting an unsafe one", async () => {
    getYields.mockRejectedValue(new Error("down"));
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { requestId: string }).requestId = "<script>alert(1)</script>";
      next();
    });
    app.use("/api/yields", yieldsRouter);

    const res = await request(app).get("/api/yields");

    expect(res.status).toBe(500);
    expect(res.body.requestId).toBeUndefined();
    expect(res.body.diagnostic.requestId).toBeUndefined();
  });

  it("responds exactly once (no double send) on failure", async () => {
    getYields.mockRejectedValue(new Error("down"));
    const res = await request(buildApp()).get("/api/yields");
    expect(res.status).toBe(500);
    // The previous handler wrote a second response, which threw
    // ERR_HTTP_HEADERS_SENT inside the catch block.
    expect(loggedText()).not.toContain("ERR_HTTP_HEADERS_SENT");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/yields — state preservation and retry", () => {
  it("a failed request does not change source data, and a retry succeeds unchanged", async () => {
    const snapshot = JSON.parse(JSON.stringify(YIELDS));
    score.mockRejectedValueOnce(new Error("transient"));

    const failed = await request(buildApp()).get("/api/yields");
    expect(failed.status).toBe(500);
    expect(YIELDS).toEqual(snapshot); // handler never mutates source entries

    const retried = await request(buildApp()).get("/api/yields");
    const again = await request(buildApp()).get("/api/yields");
    expect(retried.status).toBe(200);
    expect(again.body).toEqual(retried.body); // repeated retries are idempotent
    expect(retried.body.map((e: { protocolName: string }) => e.protocolName)).toEqual([
      "Blend",
      "Soroswap",
    ]);
    expect(YIELDS).toEqual(snapshot);
  });

  it("a validation failure followed by a corrected request performs exactly one retrieval", async () => {
    await request(buildApp()).get("/api/yields?protocolFeeBps=oops");
    await request(buildApp()).get("/api/yields?protocolFeeBps=25");
    expect(getYields).toHaveBeenCalledTimes(1);
  });
});

describe("yield failure logging", () => {
  it("redacts credentials, seeds, e-mails and long tokens", () => {
    const text = redactForLog(
      new Error(
        `GET ${SECRET_URL} as https://admin:hunter2@db.internal/x for ops@example.com ` +
          `Bearer abc.def.ghi api_key=XYZ seed ${SECRET_SEED} id ${"a".repeat(40)}`,
      ),
    );
    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ops@example.com");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("XYZ");
    expect(text).not.toContain(SECRET_SEED);
    expect(text).not.toContain("a".repeat(40));
    expect(text).toContain("https://provider.example/rates?[redacted]");
  });

  it("truncates long messages and handles non-Error causes", () => {
    expect(redactForLog("x ".repeat(400)).length).toBeLessThanOrEqual(301);
    expect(redactForLog(undefined)).toBe("");
    expect(redactForLog({ message: "not an error" })).toBe("");
    const entry = buildYieldFailureLogEntry(
      {
        code: "YIELD_STAGE_UNKNOWN",
        stage: "unknown",
        stageKnown: false,
        summary: "s",
        remediation: null,
        retryable: true,
      },
      "plain string",
    );
    expect(entry).toEqual({
      event: "yield_request_failed",
      code: "YIELD_STAGE_UNKNOWN",
      stage: "unknown",
      errorName: "string",
      errorMessage: "plain string",
    });
  });
});
