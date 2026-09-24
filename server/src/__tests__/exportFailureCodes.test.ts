/**
 * Structured export failure codes (#1122).
 *
 * Verifies that portfolio and treasury export failures carry stable,
 * machine-readable codes with a coarse category (validation / timeout /
 * service failure) so the frontend can branch without parsing messages.
 */

import request from "supertest";
import type { Response } from "express";
import {
  EXPORT_FAILURES,
  ExportFailureError,
  isExportFailureCode,
  lookupExportFailure,
  toExportFailure,
} from "../types/exportFailure";
import { sendExportError } from "../utils/errorResponse";
import {
  ExportSizeLimitExceededError,
  exportService,
  resolveExportTimeoutMs,
  withExportTimeout,
  DEFAULT_EXPORT_TIMEOUT_MS,
} from "../services/exportService";
import { PortfolioService, type VaultPosition } from "../services/portfolioService";
import { yieldReliabilityEngine } from "../services/yieldReliabilityService";

jest.mock("../services/yieldSourceRegistryService", () => ({
  getSourceHealthRegistry: jest.fn().mockResolvedValue([]),
}));

let app: import("express").Express;

beforeAll(async () => {
  const { createApp } = await import("../app");
  app = createApp();
});

const ADMIN = { Authorization: "Bearer mock-admin-token" };

async function captureFailure(promise: Promise<unknown>): Promise<ExportFailureError> {
  try {
    await promise;
  } catch (err) {
    return err as ExportFailureError;
  }
  throw new Error("Expected the operation to reject with an export failure.");
}

interface MockResponse extends Response {
  status: jest.Mock;
  json: jest.Mock;
}

function mockResponse(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as MockResponse;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
}

// ── Catalog ───────────────────────────────────────────────────────────────

describe("export failure code catalog", () => {
  it("defines stable codes for every primary failure category", () => {
    expect(EXPORT_FAILURES.EXPORT_VALIDATION_FAILED.category).toBe("validation");
    expect(EXPORT_FAILURES.EXPORT_NO_DATA.category).toBe("validation");
    expect(EXPORT_FAILURES.EXPORT_SIZE_LIMIT_EXCEEDED.category).toBe("validation");
    expect(EXPORT_FAILURES.EXPORT_TIMEOUT.category).toBe("timeout");
    expect(EXPORT_FAILURES.EXPORT_SERVICE_UNAVAILABLE.category).toBe("service_failure");
    expect(EXPORT_FAILURES.EXPORT_SERVICE_FAILURE.category).toBe("service_failure");
  });

  it("gives every code a deterministic descriptor", () => {
    const descriptors = Object.values(EXPORT_FAILURES);
    expect(descriptors.length).toBeGreaterThanOrEqual(6);
    for (const descriptor of descriptors) {
      expect(isExportFailureCode(descriptor.code)).toBe(true);
      expect(descriptor.httpStatus).toBeGreaterThanOrEqual(400);
      expect(["validation", "timeout", "service_failure"]).toContain(descriptor.category);
      expect(typeof descriptor.retryable).toBe("boolean");
      expect(descriptor.defaultMessage.length).toBeGreaterThan(0);
      expect(lookupExportFailure(descriptor.code)).toBe(descriptor);
    }
  });

  it("marks only timeout and service failures as retryable by default", () => {
    expect(EXPORT_FAILURES.EXPORT_VALIDATION_FAILED.retryable).toBe(false);
    expect(EXPORT_FAILURES.EXPORT_NO_DATA.retryable).toBe(false);
    expect(EXPORT_FAILURES.EXPORT_TIMEOUT.retryable).toBe(true);
    expect(EXPORT_FAILURES.EXPORT_SERVICE_UNAVAILABLE.retryable).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(isExportFailureCode("MADE_UP_CODE")).toBe(false);
    expect(lookupExportFailure("MADE_UP_CODE")).toBeUndefined();
  });
});

// ── Portfolio export: validation category ─────────────────────────────────

describe("portfolio export failure codes", () => {
  const positions: VaultPosition[] = [
    { protocol: "Blend", asset: "USDC", depositedUsd: 1000, currentValueUsd: 1100 },
    { protocol: "Soroswap", asset: "XLM", depositedUsd: 2000, currentValueUsd: 2200 },
  ];

  it("classifies empty filters as EXPORT_VALIDATION_FAILED", async () => {
    const err = await captureFailure(exportService.exportPortfolio(positions, {}));

    expect(err).toBeInstanceOf(ExportFailureError);
    expect(err.code).toBe("EXPORT_VALIDATION_FAILED");
    expect(err.category).toBe("validation");
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(
      "Export filters cannot be empty. Please select at least one asset class.",
    );
    expect(err.details).toMatchObject({ field: "assetClass" });
  });

  it("classifies unsupported asset classes as EXPORT_VALIDATION_FAILED", async () => {
    const err = await captureFailure(
      exportService.exportPortfolio(positions, { assetClass: "meme" }),
    );

    expect(err.code).toBe("EXPORT_VALIDATION_FAILED");
    expect(err.category).toBe("validation");
    expect(err.message).toContain('Unsupported asset class: "meme"');
    expect(err.details).toMatchObject({ assetClass: "meme" });
  });

  it("classifies an invalid size limit as EXPORT_VALIDATION_FAILED", async () => {
    const err = await captureFailure(
      exportService.exportPortfolio(positions, {
        assetClass: "stablecoin",
        maxResponseBytes: "lots",
      }),
    );

    expect(err.code).toBe("EXPORT_VALIDATION_FAILED");
    expect(err.category).toBe("validation");
    expect(err.message).toBe(
      "Export response-size limit must be a positive number of bytes.",
    );
  });

  it("classifies an empty result set as EXPORT_NO_DATA", async () => {
    const err = await captureFailure(
      exportService.exportPortfolio(
        [{ protocol: "Blend", asset: "USDC", depositedUsd: 1, currentValueUsd: 1 }],
        { assetClass: "crypto" },
      ),
    );

    expect(err.code).toBe("EXPORT_NO_DATA");
    expect(err.category).toBe("validation");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("No portfolio data matches the selected filters.");
  });

  it("keeps the dedicated size-limit error class while carrying the stable code", async () => {
    const err = await captureFailure(
      exportService.exportPortfolio(positions, {
        assetClass: "stablecoin,crypto",
        maxResponseBytes: 10,
      }),
    );

    expect(err).toBeInstanceOf(ExportSizeLimitExceededError);
    expect(err).toBeInstanceOf(ExportFailureError);
    expect(err.code).toBe("EXPORT_SIZE_LIMIT_EXCEEDED");
    expect(err.category).toBe("validation");
    expect(err.statusCode).toBe(413);
    const sizeErr = err as ExportSizeLimitExceededError;
    expect(sizeErr.limitBytes).toBe(10);
    expect(err.details).toMatchObject({ actualBytes: sizeErr.actualBytes, limitBytes: 10 });
  });

  it("throws the same coded errors from PortfolioService directly", () => {
    expect(() =>
      PortfolioService.filterPositionsByAssetClass([], { assetClass: "stablecoin" }),
    ).toThrow(ExportFailureError);
    try {
      PortfolioService.filterPositionsByAssetClass([], { assetClass: "stablecoin" });
      throw new Error("expected rejection");
    } catch (err) {
      const failure = err as ExportFailureError;
      expect(failure.code).toBe("EXPORT_NO_DATA");
      expect(failure.category).toBe("validation");
    }
  });
});

// ── Timeout category ──────────────────────────────────────────────────────

describe("export timeout failures", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("resolves operations that finish within the deadline", async () => {
    await expect(withExportTimeout(Promise.resolve("csv"), 1000)).resolves.toBe("csv");
  });

  it("rejects with EXPORT_TIMEOUT when the deadline passes", async () => {
    jest.useFakeTimers();
    const pending = withExportTimeout(new Promise(() => {}), 50, "Portfolio export");
    jest.advanceTimersByTime(60);

    const err = await captureFailure(pending);
    expect(err).toBeInstanceOf(ExportFailureError);
    expect(err.code).toBe("EXPORT_TIMEOUT");
    expect(err.category).toBe("timeout");
    expect(err.statusCode).toBe(504);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Portfolio export timed out after 50ms");
    expect(err.details).toMatchObject({ timeoutMs: 50 });
  });

  it("turns synchronous throws into rejections", async () => {
    await expect(
      withExportTimeout(() => {
        throw new Error("sync failure");
      }, 1000),
    ).rejects.toThrow("sync failure");
  });

  it("validates timeout configuration as a validation failure", () => {
    expect(resolveExportTimeoutMs()).toBe(DEFAULT_EXPORT_TIMEOUT_MS);
    expect(resolveExportTimeoutMs({})).toBe(DEFAULT_EXPORT_TIMEOUT_MS);
    expect(resolveExportTimeoutMs({ timeoutMs: "250" })).toBe(250);

    try {
      resolveExportTimeoutMs({ timeoutMs: "never" });
      throw new Error("expected rejection");
    } catch (err) {
      const failure = err as ExportFailureError;
      expect(failure).toBeInstanceOf(ExportFailureError);
      expect(failure.code).toBe("EXPORT_VALIDATION_FAILED");
      expect(failure.category).toBe("validation");
    }
  });

  it("surfaces a hanging reliability backend as EXPORT_TIMEOUT from generateSnapshotBundle", async () => {
    jest
      .spyOn(yieldReliabilityEngine, "getReliabilityScores")
      .mockImplementation(() => new Promise(() => {}));

    const err = await captureFailure(exportService.generateSnapshotBundle({ timeoutMs: 20 }));

    expect(err).toBeInstanceOf(ExportFailureError);
    expect(err.code).toBe("EXPORT_TIMEOUT");
    expect(err.category).toBe("timeout");
    expect(err.statusCode).toBe(504);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("timed out");
  });

  it("rejects invalid timeout configuration from generateSnapshotBundle", async () => {
    const err = await captureFailure(
      exportService.generateSnapshotBundle({ timeoutMs: "never" }),
    );

    expect(err.code).toBe("EXPORT_VALIDATION_FAILED");
    expect(err.category).toBe("validation");
    expect(err.statusCode).toBe(400);
  });
});

// ── Service-failure category ──────────────────────────────────────────────

describe("export service-failure classification", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("maps connection-level failures to EXPORT_SERVICE_UNAVAILABLE", async () => {
    jest
      .spyOn(yieldReliabilityEngine, "getReliabilityScores")
      .mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
          code: "ECONNREFUSED",
        }),
      );

    const err = await captureFailure(exportService.generateSnapshotBundle());

    expect(err.code).toBe("EXPORT_SERVICE_UNAVAILABLE");
    expect(err.category).toBe("service_failure");
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(
      EXPORT_FAILURES.EXPORT_SERVICE_UNAVAILABLE.defaultMessage,
    );
    expect(err.message).not.toContain("10.0.0.5");
  });

  it("maps unexpected failures to EXPORT_SERVICE_FAILURE without leaking internals", async () => {
    jest
      .spyOn(yieldReliabilityEngine, "getReliabilityScores")
      .mockRejectedValue(new Error("secret internal detail"));

    const err = await captureFailure(exportService.generateSnapshotBundle());

    expect(err.code).toBe("EXPORT_SERVICE_FAILURE");
    expect(err.category).toBe("service_failure");
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe("Failed to generate export.");
    expect(err.message).not.toContain("secret internal detail");
  });

  it("classifies timeout-shaped errors as EXPORT_TIMEOUT", () => {
    const timeoutLike = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
    const resolved = toExportFailure(timeoutLike);
    expect(resolved.code).toBe("EXPORT_TIMEOUT");
    expect(resolved.category).toBe("timeout");
    expect(resolved.httpStatus).toBe(504);
    expect(resolved.retryable).toBe(true);
  });

  it("classifies undici header timeouts by error code", () => {
    const resolved = toExportFailure(
      Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    );
    expect(resolved.code).toBe("EXPORT_TIMEOUT");
    expect(resolved.category).toBe("timeout");
  });

  it("passes ExportFailureError instances through unchanged", () => {
    const original = new ExportFailureError("EXPORT_NO_DATA", "nothing here", { a: 1 });
    const resolved = toExportFailure(original);
    expect(resolved.code).toBe("EXPORT_NO_DATA");
    expect(resolved.category).toBe("validation");
    expect(resolved.message).toBe("nothing here");
    expect(resolved.details).toEqual({ a: 1 });
    expect(resolved.httpStatus).toBe(404);
  });

  it("keeps foreign coded errors and classifies them by status", () => {
    class ForeignValidationError extends Error {
      code = "MISMATCHED_VAULT_SETS";
      statusCode = 400;
      details = { expected: ["blend"] };
    }
    const resolved = toExportFailure(new ForeignValidationError());
    expect(resolved.code).toBe("MISMATCHED_VAULT_SETS");
    expect(resolved.category).toBe("validation");
    expect(resolved.httpStatus).toBe(400);
    expect(resolved.retryable).toBe(false);
    expect(resolved.details).toEqual({ expected: ["blend"] });
  });

  it("maps unknown errors to EXPORT_SERVICE_FAILURE", () => {
    const resolved = toExportFailure(new Error("boom"));
    expect(resolved.code).toBe("EXPORT_SERVICE_FAILURE");
    expect(resolved.category).toBe("service_failure");
    expect(resolved.httpStatus).toBe(500);
    expect(resolved.retryable).toBe(true);
  });
});

// ── Response serialisation ────────────────────────────────────────────────

describe("sendExportError", () => {
  it("emits the legacy fields plus code, category, and retryable", () => {
    const res = mockResponse();
    sendExportError(
      res,
      new ExportFailureError("EXPORT_TIMEOUT", "Export bundle generation timed out after 20ms.", {
        timeoutMs: 20,
      }),
    );

    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({
      error: "EXPORT_TIMEOUT",
      message: "Export bundle generation timed out after 20ms.",
      code: "EXPORT_TIMEOUT",
      category: "timeout",
      retryable: true,
      details: { timeoutMs: 20 },
    });
  });

  it("lets callers keep legacy codes while still classifying them", () => {
    const res = mockResponse();
    sendExportError(res, null, {
      statusCode: 404,
      code: "NO_TRANSACTIONS",
      message: "No transactions found for this address.",
    });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: "NO_TRANSACTIONS",
      message: "No transactions found for this address.",
      code: "NO_TRANSACTIONS",
      category: "validation",
      retryable: false,
    });
  });

  it("attaches requestId and details when provided", () => {
    const res = mockResponse();
    sendExportError(res, new ExportFailureError("EXPORT_VALIDATION_FAILED", "bad input", { field: "assetClass" }), {
      requestId: "req-123",
    });

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.requestId).toBe("req-123");
    expect(body.details).toEqual({ field: "assetClass" });
    expect(body.category).toBe("validation");
  });
});

// ── Route-level contracts ─────────────────────────────────────────────────

describe("treasury export routes carry failure categories", () => {
  it("classifies rebalancing preview validation failures", async () => {
    const res = await request(app)
      .post("/api/treasury/rebalancing/preview/export")
      .set(ADMIN)
      .send({
        name: "Target Mix",
        totalCapitalUsd: 1_000_000,
        allocations: [
          { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
          { vaultId: "blend", vaultName: "Blend", allocationPct: 60, apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
        ],
        currentAllocations: [{ vaultId: "other", allocationPct: 100 }],
      })
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatchObject({
      code: "MISMATCHED_VAULT_SETS",
      category: "validation",
      retryable: false,
    });
    expect(typeof res.body.error.message).toBe("string");
  });

  it("classifies export-comparison validation failures", async () => {
    const res = await request(app)
      .post("/api/treasury/export-comparison")
      .set(ADMIN)
      .send({
        name: "Bad Export",
        totalCapitalUsd: 1_000_000,
        allocations: [
          { vaultId: "blend", vaultName: "Blend", allocationPct: 10, apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
        ],
        format: "csv",
      })
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error.category).toBe("validation");
    expect(res.body.error.retryable).toBe(false);
    expect(typeof res.body.error.code).toBe("string");
  });

  it("keeps returning successful attachments unchanged", async () => {
    const res = await request(app)
      .post("/api/treasury/rebalancing/preview/export")
      .set(ADMIN)
      .send({
        name: "Target Mix",
        totalCapitalUsd: 1_000_000,
        allocations: [
          { vaultId: "soroswap", vaultName: "Soroswap", allocationPct: 40, apy: 11.2, tvlUsd: 4_500_000, riskScore: 6, rotationCostPct: 0.2 },
          { vaultId: "blend", vaultName: "Blend", allocationPct: 60, apy: 6.5, tvlUsd: 12_000_000, riskScore: 8, rotationCostPct: 0.1 },
        ],
        currentAllocations: [
          { vaultId: "blend", allocationPct: 50 },
          { vaultId: "soroswap", allocationPct: 50 },
        ],
        format: "csv",
      })
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/csv");
  });
});

describe("strategies export routes return structured failures", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns a timeout-classified body when generation times out", async () => {
    jest
      .spyOn(exportService, "generateSnapshotBundle")
      .mockRejectedValue(
        new ExportFailureError(
          "EXPORT_TIMEOUT",
          "Export bundle generation timed out after 15000ms.",
          { timeoutMs: 15000 },
        ),
      );

    const res = await request(app).get("/api/strategies/export").expect(504);

    expect(res.body).toMatchObject({
      error: "EXPORT_TIMEOUT",
      code: "EXPORT_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(res.body.message).toContain("timed out");
  });

  it("returns a service-failure-classified body for unexpected errors", async () => {
    jest
      .spyOn(exportService, "generateSnapshotBundle")
      .mockRejectedValue(new Error("internal detail"));

    const res = await request(app).get("/api/strategies/export/preview").expect(500);

    expect(res.body).toMatchObject({
      error: "EXPORT_SERVICE_FAILURE",
      code: "EXPORT_SERVICE_FAILURE",
      category: "service_failure",
      retryable: true,
    });
    expect(res.body.message).not.toContain("internal detail");
  });

  it("returns a validation-classified body for invalid filters", async () => {
    jest
      .spyOn(exportService, "generateSnapshotBundle")
      .mockRejectedValue(
        new ExportFailureError(
          "EXPORT_VALIDATION_FAILED",
          "Export timeout must be a positive number of milliseconds.",
          { field: "timeoutMs" },
        ),
      );

    const res = await request(app)
      .get("/api/strategies/export")
      .query({ timeoutMs: "never" })
      .expect(400);

    expect(res.body).toMatchObject({
      code: "EXPORT_VALIDATION_FAILED",
      category: "validation",
      retryable: false,
    });
  });
});
