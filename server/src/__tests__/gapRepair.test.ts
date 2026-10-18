import request from "supertest";
import express from "express";
import { authMiddleware } from "../middleware/auth";
import indexerRecoveryRouter from "../routes/indexerRecovery";
import {
  runGapRepair,
  listGapRepairRuns,
  GapRepairError,
  type GapRepairRunSummary,
} from "../indexer/gapRepair";
import { loadPrismaClient, type IndexerPrismaClient } from "../indexer/indexer";

jest.mock("../indexer/indexer", () => {
  const actual = jest.requireActual("../indexer/indexer");
  return {
    ...actual,
    loadPrismaClient: jest.fn(),
  };
});

const mockedLoadPrismaClient = loadPrismaClient as jest.MockedFunction<
  typeof loadPrismaClient
>;

interface FakeDeadLetter {
  id: string;
  ledger: number;
  txHash: string;
  contractId: string;
  topic: string;
  data: string;
  decoderVersion: string;
  errorClass: string;
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: Date;
  resolved: boolean;
  resolvedAt: Date | null;
}

function makeDeadLetter(
  overrides: Partial<FakeDeadLetter> & { id: string },
): FakeDeadLetter {
  return {
    ledger: 100,
    txHash: `tx-${overrides.id}`,
    contractId: "C-CONTRACT",
    topic: "AAAA-deposit-topic",
    data: "AAAAdata",
    decoderVersion: "1.0.0",
    errorClass: "DecodeError",
    errorMessage: "previous failure",
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: new Date(Date.now() - 60_000),
    resolved: false,
    resolvedAt: null,
    ...overrides,
  };
}

interface FakePrisma {
  deadLetterEvent: {
    count: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
  event: { upsert: jest.Mock };
  indexerRepairRun: {
    create: jest.Mock;
    findMany: jest.Mock;
  };
}

function createFakePrisma(deadLetters: FakeDeadLetter[]): {
  fake: FakePrisma;
  prisma: IndexerPrismaClient;
  repairRuns: Array<Record<string, unknown>>;
} {
  const repairRuns: Array<Record<string, unknown>> = [];

  const matches = (
    row: FakeDeadLetter,
    where: {
      resolved?: boolean;
      ledger?: { gte?: number; lte?: number };
    } = {},
  ): boolean => {
    if (where.resolved !== undefined && row.resolved !== where.resolved) {
      return false;
    }
    if (where.ledger?.gte !== undefined && row.ledger < where.ledger.gte) {
      return false;
    }
    if (where.ledger?.lte !== undefined && row.ledger > where.ledger.lte) {
      return false;
    }
    return true;
  };

  const fake: FakePrisma = {
    deadLetterEvent: {
      count: jest.fn(
        async ({ where }: { where?: Parameters<typeof matches>[1] } = {}) =>
          deadLetters.filter((row) => matches(row, where)).length,
      ),
      findMany: jest.fn(
        async ({
          where,
          take,
        }: {
          where?: Parameters<typeof matches>[1];
          take?: number;
        } = {}) => {
          const rows = deadLetters
            .filter((row) => matches(row, where))
            .sort((a, b) => a.nextRetryAt.getTime() - b.nextRetryAt.getTime());
          return take !== undefined ? rows.slice(0, take) : rows;
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeDeadLetter>;
        }) => {
          const row = deadLetters.find((entry) => entry.id === where.id);
          if (!row) throw new Error(`Dead letter ${where.id} not found`);
          Object.assign(row, data);
          return row;
        },
      ),
    },
    event: {
      upsert: jest.fn(
        async (args: {
          where: { txHash_topic_data: { txHash: string } };
        }) => {
          if (args.where.txHash_topic_data.txHash === "tx-fail") {
            throw new Error("simulated decode failure");
          }
          return {};
        },
      ),
    },
    indexerRepairRun: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `run-${repairRuns.length + 1}`;
        repairRuns.push({ id, ...data });
        return { id };
      }),
      findMany: jest.fn(
        async ({ take }: { take?: number } = {}) =>
          repairRuns
            .slice()
            .reverse()
            .slice(0, take ?? repairRuns.length),
      ),
    },
  };

  return {
    fake,
    prisma: fake as unknown as IndexerPrismaClient,
    repairRuns,
  };
}

describe("runGapRepair", () => {
  it("scans a range and counts restored, skipped, and still-missing events", async () => {
    const { fake, prisma, repairRuns } = createFakePrisma([
      makeDeadLetter({ id: "dl-done", ledger: 100, resolved: true }),
      makeDeadLetter({ id: "dl-restore", ledger: 105, txHash: "tx-ok" }),
      makeDeadLetter({ id: "dl-fail", ledger: 110, txHash: "tx-fail" }),
      makeDeadLetter({ id: "dl-outside", ledger: 900 }),
    ]);

    const run = await runGapRepair(prisma, {
      startLedger: 100,
      endLedger: 120,
    });

    expect(run.status).toBe("completed");
    expect(run.startLedger).toBe(100);
    expect(run.endLedger).toBe(120);
    expect(run.scannedCount).toBe(3);
    expect(run.restoredCount).toBe(1);
    expect(run.skippedCount).toBe(1);
    expect(run.stillMissingCount).toBe(1);
    expect(run.restoredCount + run.skippedCount + run.stillMissingCount).toBe(
      run.scannedCount,
    );
    expect(run.failureReason).toBeNull();
    expect(run.runId).toBe("run-1");

    // Persisted summary matches the returned one.
    expect(repairRuns).toHaveLength(1);
    expect(repairRuns[0]).toMatchObject({
      id: "run-1",
      startLedger: 100,
      endLedger: 120,
      restoredCount: 1,
      skippedCount: 1,
      stillMissingCount: 1,
      status: "completed",
    });

    // The restored event is now resolved; the failed one kept its retry count.
    const restored = fake.deadLetterEvent.count.mock.calls;
    expect(restored.length).toBeGreaterThan(0);
    expect(
      (await fake.deadLetterEvent.count({
        where: { resolved: false, ledger: { gte: 100, lte: 120 } },
      })),
    ).toBe(1);
  });

  it("persists a failed run with a typed failure reason", async () => {
    const { fake, prisma, repairRuns } = createFakePrisma([]);
    fake.deadLetterEvent.count.mockRejectedValueOnce(
      new Error("connection lost"),
    );

    let caught: unknown;
    try {
      await runGapRepair(prisma, { startLedger: 1, endLedger: 50 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GapRepairError);
    const error = caught as GapRepairError;
    expect(error.code).toBe("REPLAY_ERROR");
    expect(error.statusCode).toBe(500);

    const details = error.details as { run: GapRepairRunSummary };
    expect(details.run.status).toBe("failed");
    expect(details.run.failureReason?.code).toBe("REPLAY_ERROR");
    expect(details.run.failureReason?.message).toContain("connection lost");

    expect(repairRuns).toHaveLength(1);
    expect(repairRuns[0]).toMatchObject({
      status: "failed",
      failureReasonCode: "REPLAY_ERROR",
    });
    expect(String(repairRuns[0].failureReasonMessage)).toContain(
      "connection lost",
    );
  });

  it("rejects an invalid range without touching storage", async () => {
    const { fake, prisma } = createFakePrisma([]);

    let caught: unknown;
    try {
      await runGapRepair(prisma, { startLedger: 100, endLedger: 50 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GapRepairError);
    const error = caught as GapRepairError;
    expect(error.code).toBe("INVALID_RANGE");
    expect(error.statusCode).toBe(400);
    expect(fake.deadLetterEvent.count).not.toHaveBeenCalled();
    expect(fake.indexerRepairRun.create).not.toHaveBeenCalled();
  });

  it("rejects non-integer and negative checkpoints", async () => {
    const { prisma } = createFakePrisma([]);

    for (const input of [
      { startLedger: 1.5, endLedger: 10 },
      { startLedger: -1, endLedger: 10 },
      { startLedger: "100", endLedger: 200 },
    ]) {
      let caught: unknown;
      try {
        await runGapRepair(prisma, input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GapRepairError);
      expect((caught as GapRepairError).code).toBe("INVALID_RANGE");
    }
  });

  it("reports PRISMA_UNAVAILABLE when storage is missing", async () => {
    let caught: unknown;
    try {
      await runGapRepair(null, { startLedger: 1, endLedger: 2 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GapRepairError);
    const error = caught as GapRepairError;
    expect(error.code).toBe("PRISMA_UNAVAILABLE");
    expect(error.statusCode).toBe(503);
  });
});

describe("listGapRepairRuns", () => {
  it("lists persisted runs newest first and clamps the limit", async () => {
    const { prisma, repairRuns } = createFakePrisma([]);
    repairRuns.push(
      {
        id: "run-1",
        startLedger: 10,
        endLedger: 20,
        restoredCount: 2,
        skippedCount: 1,
        stillMissingCount: 0,
        status: "completed",
        failureReasonCode: null,
        failureReasonMessage: null,
        startedAt: new Date("2026-09-01T00:00:00.000Z"),
        finishedAt: new Date("2026-09-01T00:00:01.000Z"),
      },
      {
        id: "run-2",
        startLedger: 30,
        endLedger: 40,
        restoredCount: 0,
        skippedCount: 0,
        stillMissingCount: 3,
        status: "failed",
        failureReasonCode: "REPLAY_ERROR",
        failureReasonMessage: "rpc timeout",
        startedAt: new Date("2026-09-02T00:00:00.000Z"),
        finishedAt: new Date("2026-09-02T00:00:01.000Z"),
      },
    );

    const runs = await listGapRepairRuns(prisma, 10);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.runId).toBe("run-2");
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.failureReason).toEqual({
      code: "REPLAY_ERROR",
      message: "rpc timeout",
    });
    expect(runs[1]?.runId).toBe("run-1");
    expect(runs[1]?.status).toBe("completed");
    expect(runs[1]?.failureReason).toBeNull();
    expect(typeof runs[1]?.startedAt).toBe("string");

    const limited = await listGapRepairRuns(prisma, 1);
    expect(limited).toHaveLength(1);

    const clamped = await listGapRepairRuns(prisma, 0);
    expect(clamped).toHaveLength(1);
  });

  it("reports PRISMA_UNAVAILABLE when storage is missing", async () => {
    let caught: unknown;
    try {
      await listGapRepairRuns(null);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GapRepairError);
    expect((caught as GapRepairError).code).toBe("PRISMA_UNAVAILABLE");
  });
});

describe("POST/GET /api/indexer/recovery-queue/gap-repair", () => {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api/indexer/recovery-queue", indexerRecoveryRouter);

  beforeEach(() => {
    mockedLoadPrismaClient.mockReset();
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/indexer/recovery-queue/gap-repair")
      .send({ startLedger: 1, endLedger: 10 });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("forbids non-admin users", async () => {
    const res = await request(app)
      .post("/api/indexer/recovery-queue/gap-repair")
      .set("Authorization", "Bearer mock-user-token")
      .send({ startLedger: 1, endLedger: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("runs a repair and returns the summary envelope for admins", async () => {
    const { fake, prisma, repairRuns } = createFakePrisma([
      makeDeadLetter({ id: "dl-restore", ledger: 105, txHash: "tx-ok" }),
      makeDeadLetter({ id: "dl-done", ledger: 110, resolved: true }),
    ]);
    mockedLoadPrismaClient.mockResolvedValue(prisma);

    const res = await request(app)
      .post("/api/indexer/recovery-queue/gap-repair")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ startLedger: 100, endLedger: 120 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const run = res.body.data.run as GapRepairRunSummary;
    expect(run.status).toBe("completed");
    expect(run.startLedger).toBe(100);
    expect(run.endLedger).toBe(120);
    expect(run.restoredCount).toBe(1);
    expect(run.skippedCount).toBe(1);
    expect(run.stillMissingCount).toBe(0);
    expect(fake.indexerRepairRun.create).toHaveBeenCalledTimes(1);
    expect(repairRuns).toHaveLength(1);
  });

  it("returns a typed 400 for an invalid range", async () => {
    mockedLoadPrismaClient.mockResolvedValue(createFakePrisma([]).prisma);

    const res = await request(app)
      .post("/api/indexer/recovery-queue/gap-repair")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ startLedger: 100, endLedger: 50 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("INVALID_RANGE");
    expect(res.body.error.category).toBe("validation");
  });

  it("returns a typed 503 when storage is unavailable", async () => {
    mockedLoadPrismaClient.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/indexer/recovery-queue/gap-repair")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ startLedger: 1, endLedger: 10 });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PRISMA_UNAVAILABLE");
    expect(res.body.error.retryable).toBe(true);
  });

  it("lists persisted repair summaries for admins", async () => {
    const { fake, prisma, repairRuns } = createFakePrisma([]);
    repairRuns.push({
      id: "run-9",
      startLedger: 5,
      endLedger: 15,
      restoredCount: 4,
      skippedCount: 2,
      stillMissingCount: 1,
      status: "completed",
      failureReasonCode: null,
      failureReasonMessage: null,
      startedAt: new Date("2026-09-10T00:00:00.000Z"),
      finishedAt: new Date("2026-09-10T00:00:02.000Z"),
    });
    mockedLoadPrismaClient.mockResolvedValue(prisma);

    const res = await request(app)
      .get("/api/indexer/recovery-queue/gap-repair?limit=5")
      .set("Authorization", "Bearer mock-admin-token");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.count).toBe(1);
    const run = res.body.data.runs[0] as GapRepairRunSummary;
    expect(run.runId).toBe("run-9");
    expect(run.restoredCount).toBe(4);
    expect(fake.indexerRepairRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });
});
