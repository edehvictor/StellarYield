import request from "supertest";
import { createApp } from "../app";
import {
  evaluateSharePriceFreshness,
  SHARE_PRICE_FRESHNESS_THRESHOLDS,
} from "../services/sharePriceFreshness";

const mockPrismaState = {
  latestSnapshotAt: null as Date | null,
  latestEventAt: null as Date | null,
  rejectQueries: false,
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({
    sharePriceSnapshot: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => {
        if (mockPrismaState.rejectQueries) {
          throw new Error("db down");
        }
        return mockPrismaState.latestSnapshotAt
          ? { snapshotAt: mockPrismaState.latestSnapshotAt }
          : null;
      }),
    },
    event: {
      findFirst: jest.fn(async () => {
        if (mockPrismaState.rejectQueries) {
          throw new Error("db down");
        }
        return mockPrismaState.latestEventAt
          ? { createdAt: mockPrismaState.latestEventAt }
          : null;
      }),
    },
    $disconnect: jest.fn(async () => undefined),
  })),
}));

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

describe("evaluateSharePriceFreshness", () => {
  it("returns current when the snapshot trails the checkpoint by less than the threshold", () => {
    const result = evaluateSharePriceFreshness({
      sharePriceUpdatedAt: new Date(NOW - 6 * HOUR),
      eventCheckpointAt: new Date(NOW - 5 * HOUR),
      now: NOW,
    });

    expect(result.status).toBe("current");
    expect(result.isDelayed).toBe(false);
    expect(result.message).toBeNull();
    expect(result.sharePriceUpdatedAt).toBe(
      new Date(NOW - 6 * HOUR).toISOString(),
    );
    expect(result.eventCheckpointAt).toBe(
      new Date(NOW - 5 * HOUR).toISOString(),
    );
    expect(result.delayMs).toBe(1 * HOUR);
    expect(result.maxDelayMs).toBe(
      SHARE_PRICE_FRESHNESS_THRESHOLDS.maxDelayMs,
    );
  });

  it("returns delayed when the share price trails the checkpoint beyond the threshold, including the last known update", () => {
    const snapshotAt = new Date(NOW - 48 * HOUR);
    const result = evaluateSharePriceFreshness({
      sharePriceUpdatedAt: snapshotAt,
      eventCheckpointAt: new Date(NOW - 1000),
      now: NOW,
    });

    expect(result.status).toBe("delayed");
    expect(result.isDelayed).toBe(true);
    expect(result.message).toContain("last known update");
    expect(result.message).toContain(snapshotAt.toISOString());
    expect(result.delayMs).toBe(48 * HOUR - 1000);
  });

  it("returns current when the snapshot is exactly at the threshold", () => {
    const result = evaluateSharePriceFreshness({
      sharePriceUpdatedAt: new Date(NOW - 36 * HOUR),
      eventCheckpointAt: new Date(NOW),
      now: NOW,
    });

    expect(result.status).toBe("current");
    expect(result.delayMs).toBe(36 * HOUR);
  });

  it("returns missing when the indexer checkpoint is absent", () => {
    const snapshotAt = new Date(NOW - HOUR);
    const result = evaluateSharePriceFreshness({
      sharePriceUpdatedAt: snapshotAt,
      eventCheckpointAt: null,
      now: NOW,
    });

    expect(result.status).toBe("missing");
    expect(result.isDelayed).toBe(true);
    expect(result.eventCheckpointAt).toBeNull();
    expect(result.message).toContain("checkpoint");
    expect(result.message).toContain(snapshotAt.toISOString());
  });

  it("returns missing when no share price snapshot exists yet", () => {
    const checkpoint = new Date(NOW - HOUR);
    const result = evaluateSharePriceFreshness({
      sharePriceUpdatedAt: null,
      eventCheckpointAt: checkpoint,
      now: NOW,
    });

    expect(result.status).toBe("missing");
    expect(result.isDelayed).toBe(true);
    expect(result.sharePriceUpdatedAt).toBeNull();
    expect(result.message).toContain("No share price snapshot");
    expect(result.message).toContain(checkpoint.toISOString());
  });

  it("honours a custom threshold and falls back to the default for invalid values", () => {
    const base = {
      sharePriceUpdatedAt: new Date(NOW - 2 * HOUR),
      eventCheckpointAt: new Date(NOW),
      now: NOW,
    };

    expect(evaluateSharePriceFreshness(base).status).toBe("current");
    expect(evaluateSharePriceFreshness({ ...base, maxDelayMs: 1000 }).status).toBe(
      "delayed",
    );
    expect(
      evaluateSharePriceFreshness({ ...base, maxDelayMs: -5 }).maxDelayMs,
    ).toBe(SHARE_PRICE_FRESHNESS_THRESHOLDS.maxDelayMs);
    expect(
      evaluateSharePriceFreshness({ ...base, maxDelayMs: Number.NaN })
        .maxDelayMs,
    ).toBe(SHARE_PRICE_FRESHNESS_THRESHOLDS.maxDelayMs);
  });

  it("treats malformed timestamps as missing instead of throwing", () => {
    const result = evaluateSharePriceFreshness({
      sharePriceUpdatedAt: "not-a-date",
      eventCheckpointAt: new Date(NOW),
      now: NOW,
    });

    expect(result.status).toBe("missing");
    expect(result.sharePriceUpdatedAt).toBeNull();
  });
});

describe("GET /api/vaults/:vaultId/share-price-freshness", () => {
  const app = createApp();
  const path = "/api/vaults/primary-yield-vault/share-price-freshness";

  beforeEach(() => {
    mockPrismaState.latestSnapshotAt = null;
    mockPrismaState.latestEventAt = null;
    mockPrismaState.rejectQueries = false;
  });

  it("reports current status and stays quiet when data is in sync", async () => {
    mockPrismaState.latestSnapshotAt = new Date(Date.now() - 1 * HOUR);
    mockPrismaState.latestEventAt = new Date(Date.now() - 0.5 * HOUR);

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body.vaultId).toBe("primary-yield-vault");
    expect(res.body.status).toBe("current");
    expect(res.body.isDelayed).toBe(false);
    expect(res.body.message).toBeNull();
  });

  it("reports delayed status with the last known update time", async () => {
    const snapshotAt = new Date(Date.now() - 48 * HOUR);
    mockPrismaState.latestSnapshotAt = snapshotAt;
    mockPrismaState.latestEventAt = new Date(Date.now() - 60 * 1000);

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delayed");
    expect(res.body.isDelayed).toBe(true);
    expect(res.body.sharePriceUpdatedAt).toBe(snapshotAt.toISOString());
    expect(res.body.message).toContain("last known update");
    expect(res.body.message).toContain(snapshotAt.toISOString());
  });

  it("reports missing when the indexer checkpoint is absent", async () => {
    mockPrismaState.latestSnapshotAt = new Date(Date.now() - 1 * HOUR);
    mockPrismaState.latestEventAt = null;

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("missing");
    expect(res.body.eventCheckpointAt).toBeNull();
    expect(res.body.message).toContain("checkpoint");
  });

  it("reports missing when the vault has no share price snapshot", async () => {
    mockPrismaState.latestSnapshotAt = null;
    mockPrismaState.latestEventAt = new Date(Date.now() - 1 * HOUR);

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("missing");
    expect(res.body.sharePriceUpdatedAt).toBeNull();
    expect(res.body.message).toContain("No share price snapshot");
  });

  it("applies a maxAgeMs query override", async () => {
    mockPrismaState.latestSnapshotAt = new Date(Date.now() - 2 * HOUR);
    mockPrismaState.latestEventAt = new Date(Date.now());

    const withinDefault = await request(app).get(path);
    expect(withinDefault.body.status).toBe("current");

    const withOverride = await request(app).get(`${path}?maxAgeMs=1000`);
    expect(withOverride.body.status).toBe("delayed");

    const invalidOverride = await request(app).get(`${path}?maxAgeMs=abc`);
    expect(invalidOverride.body.status).toBe("current");
  });

  it("answers 500 with SHARE_PRICE_FRESHNESS_ERROR when the database fails", async () => {
    mockPrismaState.rejectQueries = true;

    const res = await request(app).get(path);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("SHARE_PRICE_FRESHNESS_ERROR");
  });
});
