/**
 * Valuation freshness guardrails for daily-movement reads (#1362).
 *
 * Covers the pure evaluator/query parser plus the route contract:
 * default requests keep their 200 behavior, while `requireFresh=true`
 * enforces the staleness guard with stable typed error codes.
 */
import express from "express";
import request from "supertest";

jest.mock("@prisma/client", () => {
  const dailyPortfolioSnapshotFindUnique = jest.fn();
  const userTransactionFindMany = jest.fn();
  class PrismaClient {
    dailyPortfolioSnapshot = { findUnique: dailyPortfolioSnapshotFindUnique };
    userTransaction = { findMany: userTransactionFindMany };
  }
  return {
    PrismaClient,
    __mockState: { dailyPortfolioSnapshotFindUnique, userTransactionFindMany },
  };
});

import {
  DEFAULT_VALUATION_MAX_AGE_MS,
  FreshnessQueryError,
  MAX_ALLOWED_VALUATION_MAX_AGE_MS,
  StaleValuationError,
  assertFreshValuation,
  evaluateValuationFreshness,
  parseValuationFreshnessQuery,
} from "../services/valuationFreshnessGuard";
import portfolioMovementRouter from "../routes/portfolioMovement";

const { __mockState } = jest.requireMock("@prisma/client") as {
  __mockState: {
    dailyPortfolioSnapshotFindUnique: jest.Mock;
    userTransactionFindMany: jest.Mock;
  };
};

const WALLET = `G${"A".repeat(55)}`;
const HOUR_MS = 60 * 60 * 1000;

function buildApp(): express.Express {
  const app = express();
  app.use("/api/portfolio", portfolioMovementRouter);
  return app;
}

function snapshotRow(ageMs: number) {
  return {
    totalValueUsd: 1000,
    totalDepositedUsd: 1000,
    totalWithdrawnUsd: 0,
    assetBreakdown: { USDC: { valueUsd: 1000, quantity: 1000 } },
    protocolBreakdown: { blend: { valueUsd: 1000 } },
    updatedAt: new Date(Date.now() - ageMs),
  };
}

beforeEach(() => {
  __mockState.dailyPortfolioSnapshotFindUnique.mockReset();
  __mockState.userTransactionFindMany.mockReset();
  __mockState.userTransactionFindMany.mockResolvedValue([]);
});

describe("evaluateValuationFreshness", () => {
  const now = 1_700_000_000_000;

  it("marks a missing snapshot stale with null age", () => {
    const freshness = evaluateValuationFreshness({ valuedAt: null, now });
    expect(freshness.isStale).toBe(true);
    expect(freshness.ageMs).toBeNull();
    expect(freshness.snapshotValuedAt).toBeNull();
    expect(freshness.maxAgeMs).toBe(DEFAULT_VALUATION_MAX_AGE_MS);
    expect(freshness.evaluatedAt).toBe(new Date(now).toISOString());
  });

  it("treats an unparseable timestamp like a missing snapshot", () => {
    const freshness = evaluateValuationFreshness({ valuedAt: "not-a-date", now });
    expect(freshness.isStale).toBe(true);
    expect(freshness.ageMs).toBeNull();
  });

  it("computes age against the injected clock and flags staleness", () => {
    const fresh = evaluateValuationFreshness({
      valuedAt: new Date(now - HOUR_MS),
      now,
    });
    expect(fresh.ageMs).toBe(HOUR_MS);
    expect(fresh.isStale).toBe(false);

    const stale = evaluateValuationFreshness({
      valuedAt: new Date(now - 48 * HOUR_MS),
      now,
    });
    expect(stale.ageMs).toBe(48 * HOUR_MS);
    expect(stale.isStale).toBe(true);
  });

  it("honors a custom maxAgeMs threshold", () => {
    const valuedAt = new Date(now - 2 * HOUR_MS);
    expect(
      evaluateValuationFreshness({ valuedAt, now, maxAgeMs: HOUR_MS }).isStale,
    ).toBe(true);
    expect(
      evaluateValuationFreshness({ valuedAt, now, maxAgeMs: 3 * HOUR_MS })
        .isStale,
    ).toBe(false);
  });

  it("accepts ISO string timestamps", () => {
    const valuedAt = new Date(now - HOUR_MS).toISOString();
    const freshness = evaluateValuationFreshness({ valuedAt, now });
    expect(freshness.ageMs).toBe(HOUR_MS);
    expect(freshness.snapshotValuedAt).toBe(valuedAt);
  });

  it("never reports a negative age for clock skew", () => {
    const freshness = evaluateValuationFreshness({
      valuedAt: new Date(now + HOUR_MS),
      now,
    });
    expect(freshness.ageMs).toBe(0);
    expect(freshness.isStale).toBe(false);
  });
});

describe("parseValuationFreshnessQuery", () => {
  it("defaults to no guard with the default threshold", () => {
    expect(parseValuationFreshnessQuery({})).toEqual({
      requireFresh: false,
      maxAgeMs: DEFAULT_VALUATION_MAX_AGE_MS,
    });
  });

  it("parses requireFresh=true / false case-insensitively", () => {
    expect(parseValuationFreshnessQuery({ requireFresh: "true" }).requireFresh).toBe(true);
    expect(parseValuationFreshnessQuery({ requireFresh: "TRUE" }).requireFresh).toBe(true);
    expect(parseValuationFreshnessQuery({ requireFresh: "false" }).requireFresh).toBe(false);
  });

  it("parses a positive integer maxAgeMs", () => {
    expect(parseValuationFreshnessQuery({ maxAgeMs: "3600000" }).maxAgeMs).toBe(
      3_600_000,
    );
  });

  it("rejects malformed requireFresh with a typed INVALID_QUERY error", () => {
    let caught: unknown;
    try {
      parseValuationFreshnessQuery({ requireFresh: "yes" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreshnessQueryError);
    const typed = caught as FreshnessQueryError;
    expect(typed.code).toBe("INVALID_QUERY");
    expect(typed.statusCode).toBe(400);
  });

  it("rejects malformed or out-of-range maxAgeMs", () => {
    expect(() => parseValuationFreshnessQuery({ maxAgeMs: "abc" })).toThrow(
      FreshnessQueryError,
    );
    expect(() => parseValuationFreshnessQuery({ maxAgeMs: "0" })).toThrow(
      FreshnessQueryError,
    );
    expect(() =>
      parseValuationFreshnessQuery({
        maxAgeMs: String(MAX_ALLOWED_VALUATION_MAX_AGE_MS + 1),
      }),
    ).toThrow(FreshnessQueryError);
  });
});

describe("assertFreshValuation", () => {
  const now = Date.now();

  it("passes for a fresh snapshot", () => {
    const freshness = evaluateValuationFreshness({
      valuedAt: new Date(now - HOUR_MS),
      now,
    });
    expect(() => assertFreshValuation(freshness)).not.toThrow();
  });

  it("throws a typed 409 StaleValuationError carrying the freshness details", () => {
    const freshness = evaluateValuationFreshness({
      valuedAt: null,
      now,
    });
    let caught: unknown;
    try {
      assertFreshValuation(freshness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaleValuationError);
    const typed = caught as StaleValuationError;
    expect(typed.code).toBe("STALE_VALUATION_SNAPSHOT");
    expect(typed.statusCode).toBe(409);
    expect(typed.freshness).toEqual(freshness);
  });
});

describe("GET /api/portfolio/:wallet/daily-movement guardrails", () => {
  it("returns 200 with a freshness annotation when no guard is requested", async () => {
    __mockState.dailyPortfolioSnapshotFindUnique
      .mockResolvedValueOnce(snapshotRow(48 * HOUR_MS))
      .mockResolvedValueOnce(snapshotRow(72 * HOUR_MS));

    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement`,
    );

    expect(res.status).toBe(200);
    expect(res.body.walletAddress).toBe(WALLET);
    expect(res.body.freshness).toBeDefined();
    expect(res.body.freshness.isStale).toBe(true);
    expect(typeof res.body.freshness.ageMs).toBe("number");
  });

  it("returns 409 STALE_VALUATION_SNAPSHOT for requireFresh=true on a stale snapshot", async () => {
    __mockState.dailyPortfolioSnapshotFindUnique
      .mockResolvedValueOnce(snapshotRow(48 * HOUR_MS))
      .mockResolvedValueOnce(snapshotRow(72 * HOUR_MS));

    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement?requireFresh=true`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("STALE_VALUATION_SNAPSHOT");
    expect(res.body.recoverable).toBe(true);
    expect(res.body.details).toBeDefined();
    expect(res.body.details.isStale).toBe(true);
  });

  it("returns 200 for requireFresh=true when the snapshot is within the threshold", async () => {
    __mockState.dailyPortfolioSnapshotFindUnique
      .mockResolvedValueOnce(snapshotRow(HOUR_MS))
      .mockResolvedValueOnce(snapshotRow(2 * HOUR_MS));

    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement?requireFresh=true`,
    );

    expect(res.status).toBe(200);
    expect(res.body.freshness.isStale).toBe(false);
  });

  it("honors maxAgeMs so a stale-by-default snapshot can still pass the guard", async () => {
    __mockState.dailyPortfolioSnapshotFindUnique
      .mockResolvedValueOnce(snapshotRow(48 * HOUR_MS))
      .mockResolvedValueOnce(snapshotRow(72 * HOUR_MS));

    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement?requireFresh=true&maxAgeMs=${
        72 * HOUR_MS
      }`,
    );

    expect(res.status).toBe(200);
    expect(res.body.freshness.maxAgeMs).toBe(72 * HOUR_MS);
  });

  it("returns 404 SNAPSHOT_NOT_FOUND for requireFresh=true with no current snapshot", async () => {
    __mockState.dailyPortfolioSnapshotFindUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement?requireFresh=true`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("SNAPSHOT_NOT_FOUND");
  });

  it("keeps the neutral 200 body for missing snapshots without requireFresh", async () => {
    __mockState.dailyPortfolioSnapshotFindUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement`,
    );

    expect(res.status).toBe(200);
    expect(res.body.hasPreviousSnapshot).toBe(false);
    expect(res.body.freshness.isStale).toBe(true);
  });

  it("returns 400 INVALID_QUERY for malformed guardrail params", async () => {
    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement?requireFresh=maybe`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_QUERY");
    expect(__mockState.dailyPortfolioSnapshotFindUnique).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_QUERY for a non-numeric maxAgeMs", async () => {
    const res = await request(buildApp()).get(
      `/api/portfolio/${WALLET}/daily-movement?maxAgeMs=soon`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_QUERY");
  });

  it("still rejects invalid wallet addresses before evaluating the guard", async () => {
    const res = await request(buildApp()).get(
      `/api/portfolio/not-a-wallet/daily-movement?requireFresh=true`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_ADDRESS");
  });
});
