/**
 * Treasury withdrawal cooldown enforcement (#1343).
 *
 * Covers the in-memory service (typed errors, cooldown math, cancel-frees
 * cooldown, per-vault overrides) plus the HTTP contract on a mini express
 * app (envelopes, auth, stable error codes). Uses a mini app rather than
 * createApp() to avoid pulling in Prisma and every route for a pure
 * in-memory feature.
 */
import express from "express";
import request from "supertest";

import {
  DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS,
  TreasuryWithdrawalCooldownService,
  TreasuryWithdrawalError,
  treasuryWithdrawalCooldownService,
  resetTreasuryWithdrawalCooldownService,
} from "../services/treasuryWithdrawalCooldownService";
import treasuryRouter from "../routes/treasury";
import { authMiddleware } from "../middleware/auth";

const HOUR_MS = 60 * 60 * 1000;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api/treasury", treasuryRouter);
  return app;
}

function expectSuccessEnvelope(body: Record<string, unknown>, route: string) {
  expect(body.ok).toBe(true);
  expect(body).toHaveProperty("data");
  expect(body.meta).toMatchObject({ generatedAt: expect.any(String), route });
}

function expectErrorEnvelope(body: Record<string, unknown>, code: string) {
  expect(body.ok).toBe(false);
  expect((body.error as Record<string, unknown>).code).toBe(code);
  expect(typeof (body.error as Record<string, unknown>).message).toBe("string");
  expect(body.meta).toMatchObject({
    generatedAt: expect.any(String),
    route: expect.any(String),
  });
}

beforeEach(() => {
  resetTreasuryWithdrawalCooldownService();
});

describe("TreasuryWithdrawalCooldownService", () => {
  it("accepts a first withdrawal and stamps cooldownUntil = submittedAt + 4h", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const now = 1_700_000_000_000;
    const record = service.submitWithdrawal({
      vaultId: "blend",
      amountUsd: 25_000,
      requestedBy: "admin-123",
      memo: "liquidity rebalance",
      now,
    });

    expect(record.status).toBe("PENDING");
    expect(record.vaultId).toBe("blend");
    expect(record.amountUsd).toBe(25_000);
    expect(record.requestedBy).toBe("admin-123");
    expect(record.cancelledAt).toBeNull();
    expect(new Date(record.submittedAt).getTime()).toBe(now);
    expect(new Date(record.cooldownUntil).getTime()).toBe(
      now + DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS,
    );
  });

  it("blocks a second submission during the cooldown with typed COOLDOWN_ACTIVE", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const now = 1_700_000_000_000;
    const first = service.submitWithdrawal({
      vaultId: "blend",
      amountUsd: 1000,
      now,
    });

    let caught: unknown;
    try {
      service.submitWithdrawal({
        vaultId: "blend",
        amountUsd: 2000,
        now: now + HOUR_MS,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TreasuryWithdrawalError);
    const typed = caught as TreasuryWithdrawalError;
    expect(typed.code).toBe("COOLDOWN_ACTIVE");
    expect(typed.statusCode).toBe(409);
    expect(typed.details?.blockingWithdrawalId).toBe(first.id);
    expect(typed.details?.remainingMs).toBe(3 * HOUR_MS);
    expect(typed.details?.availableAt).toBe(first.cooldownUntil);
  });

  it("allows a new submission once the cooldown lapses (even if still pending)", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const now = 1_700_000_000_000;
    service.submitWithdrawal({ vaultId: "blend", amountUsd: 1000, now });

    expect(() =>
      service.submitWithdrawal({
        vaultId: "blend",
        amountUsd: 2000,
        now: now + DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS,
      }),
    ).not.toThrow();
  });

  it("scopes the cooldown per vault", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const now = 1_700_000_000_000;
    service.submitWithdrawal({ vaultId: "blend", amountUsd: 1000, now });

    expect(() =>
      service.submitWithdrawal({ vaultId: "soroswap", amountUsd: 1000, now }),
    ).not.toThrow();
  });

  it("cancel frees the cooldown immediately", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const now = 1_700_000_000_000;
    const first = service.submitWithdrawal({
      vaultId: "blend",
      amountUsd: 1000,
      now,
    });

    expect(() =>
      service.submitWithdrawal({ vaultId: "blend", amountUsd: 1, now: now + 1 }),
    ).toThrow(TreasuryWithdrawalError);

    const cancelled = service.cancelWithdrawal(first.id, now + 5);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).toBe(new Date(now + 5).toISOString());

    expect(
      service.evaluateCooldown("blend", now + 5).cooldownActive,
    ).toBe(false);
    expect(() =>
      service.submitWithdrawal({ vaultId: "blend", amountUsd: 500, now: now + 5 }),
    ).not.toThrow();
  });

  it("rejects cancelling an unknown id with NOT_FOUND", () => {
    const service = new TreasuryWithdrawalCooldownService();
    let caught: unknown;
    try {
      service.cancelWithdrawal("nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TreasuryWithdrawalError);
    expect((caught as TreasuryWithdrawalError).code).toBe("NOT_FOUND");
    expect((caught as TreasuryWithdrawalError).statusCode).toBe(404);
  });

  it("rejects double-cancel with INVALID_STATE", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const record = service.submitWithdrawal({ vaultId: "blend", amountUsd: 1 });
    service.cancelWithdrawal(record.id);

    let caught: unknown;
    try {
      service.cancelWithdrawal(record.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TreasuryWithdrawalError);
    expect((caught as TreasuryWithdrawalError).code).toBe("INVALID_STATE");
    expect((caught as TreasuryWithdrawalError).statusCode).toBe(409);
  });

  it("honors per-vault cooldown overrides", () => {
    const service = new TreasuryWithdrawalCooldownService({
      defaultCooldownMs: 4 * HOUR_MS,
      vaultCooldownMs: { fast: 1000 },
    });
    const now = 1_700_000_000_000;
    const record = service.submitWithdrawal({ vaultId: "fast", amountUsd: 1, now });
    expect(new Date(record.cooldownUntil).getTime() - now).toBe(1000);

    expect(() =>
      service.submitWithdrawal({ vaultId: "fast", amountUsd: 1, now: now + 999 }),
    ).toThrow(TreasuryWithdrawalError);
    expect(() =>
      service.submitWithdrawal({ vaultId: "fast", amountUsd: 1, now: now + 1000 }),
    ).not.toThrow();
  });

  it("validates inputs with typed INVALID_REQUEST errors", () => {
    const service = new TreasuryWithdrawalCooldownService();
    expect(() => service.submitWithdrawal({ vaultId: "", amountUsd: 1 })).toThrow(
      TreasuryWithdrawalError,
    );
    expect(() =>
      service.submitWithdrawal({ vaultId: "blend", amountUsd: -5 }),
    ).toThrow(TreasuryWithdrawalError);
    expect(() =>
      service.submitWithdrawal({ vaultId: "blend", amountUsd: Number.NaN }),
    ).toThrow(TreasuryWithdrawalError);
    expect(() =>
      service.submitWithdrawal({ vaultId: "blend", amountUsd: 1, memo: 42 }),
    ).toThrow(TreasuryWithdrawalError);
  });

  it("lists withdrawals newest-first with optional vault filter", () => {
    const service = new TreasuryWithdrawalCooldownService();
    service.submitWithdrawal({ vaultId: "blend", amountUsd: 1, now: 1_000 });
    service.submitWithdrawal({ vaultId: "soroswap", amountUsd: 2, now: 2_000 });
    service.submitWithdrawal({ vaultId: "blend", amountUsd: 3, now: 3_000 });

    const all = service.listWithdrawals();
    expect(all).toHaveLength(3);
    expect(all[0].amountUsd).toBe(3);

    const blendOnly = service.listWithdrawals({ vaultId: "blend" });
    expect(blendOnly).toHaveLength(2);
    expect(blendOnly.every((r) => r.vaultId === "blend")).toBe(true);
  });

  it("reports cooldown status for a vault", () => {
    const service = new TreasuryWithdrawalCooldownService();
    const now = 1_700_000_000_000;

    const free = service.getCooldownStatus("blend", now);
    expect(free.cooldownActive).toBe(false);
    expect(free.remainingMs).toBe(0);
    expect(free.availableAt).toBeNull();

    const record = service.submitWithdrawal({ vaultId: "blend", amountUsd: 1, now });
    const active = service.getCooldownStatus("blend", now + HOUR_MS);
    expect(active.cooldownActive).toBe(true);
    expect(active.blockingWithdrawalId).toBe(record.id);
    expect(active.remainingMs).toBe(3 * HOUR_MS);
    expect(active.cooldownMs).toBe(DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS);
  });
});

describe("Treasury withdrawal cooldown routes", () => {
  const app = buildApp();
  const admin = { Authorization: "Bearer mock-admin-token" };
  const user = { Authorization: "Bearer mock-user-token" };

  it("POST /withdrawals creates a pending withdrawal envelope", async () => {
    const res = await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 50_000, memo: "ops payout" });

    expect(res.status).toBe(201);
    expectSuccessEnvelope(res.body, "treasury/withdrawals");
    expect(res.body.data).toMatchObject({
      vaultId: "blend",
      amountUsd: 50_000,
      status: "PENDING",
      memo: "ops payout",
      requestedBy: "admin-123",
    });
    expect(typeof res.body.data.id).toBe("string");
    expect(typeof res.body.data.cooldownUntil).toBe("string");
  });

  it("POST /withdrawals returns 409 COOLDOWN_ACTIVE during cooldown", async () => {
    await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 1000 })
      .expect(201);

    const res = await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 2000 });

    expect(res.status).toBe(409);
    expectErrorEnvelope(res.body, "COOLDOWN_ACTIVE");
    const err = res.body.error as Record<string, unknown>;
    expect(err.retryable).toBe(true);
    const details = err.details as Record<string, unknown>;
    expect(details.vaultId).toBe("blend");
    expect(typeof details.remainingMs).toBe("number");
    expect(typeof details.availableAt).toBe("string");
  });

  it("POST /withdrawals validates the body with 400 INVALID_REQUEST", async () => {
    const res = await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: -1 });

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "INVALID_REQUEST");
  });

  it("GET /withdrawals lists submitted withdrawals", async () => {
    await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 1000 })
      .expect(201);

    const res = await request(app)
      .get("/api/treasury/withdrawals")
      .set(admin);

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body, "treasury/withdrawals");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it("GET /withdrawals/cooldown reports active status for a vault", async () => {
    await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 1000 })
      .expect(201);

    const res = await request(app)
      .get("/api/treasury/withdrawals/cooldown?vaultId=blend")
      .set(admin);

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body, "treasury/withdrawals/cooldown");
    expect(res.body.data).toMatchObject({
      vaultId: "blend",
      cooldownActive: true,
      cooldownMs: DEFAULT_TREASURY_WITHDRAWAL_COOLDOWN_MS,
    });
    expect(
      (res.body.data as Record<string, unknown>).blockingWithdrawalId,
    ).toEqual(expect.any(String));
  });

  it("GET /withdrawals/cooldown requires vaultId", async () => {
    const res = await request(app)
      .get("/api/treasury/withdrawals/cooldown")
      .set(admin);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "INVALID_REQUEST");
  });

  it("POST /withdrawals/:id/cancel frees the cooldown", async () => {
    const created = await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 1000 });
    const id = (created.body.data as { id: string }).id;

    const cancelRes = await request(app)
      .post(`/api/treasury/withdrawals/${id}/cancel`)
      .set(admin);
    expect(cancelRes.status).toBe(200);
    expectSuccessEnvelope(cancelRes.body, "treasury/withdrawals");
    expect(cancelRes.body.data).toMatchObject({ id, status: "CANCELLED" });

    const statusRes = await request(app)
      .get("/api/treasury/withdrawals/cooldown?vaultId=blend")
      .set(admin);
    expect(
      (statusRes.body.data as { cooldownActive: boolean }).cooldownActive,
    ).toBe(false);

    await request(app)
      .post("/api/treasury/withdrawals")
      .set(admin)
      .send({ vaultId: "blend", amountUsd: 500 })
      .expect(201);
  });

  it("POST /withdrawals/:id/cancel returns 404 for unknown ids", async () => {
    const res = await request(app)
      .post("/api/treasury/withdrawals/does-not-exist/cancel")
      .set(admin);

    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, "NOT_FOUND");
  });

  it("returns 401 UNAUTHORIZED for anonymous calls", async () => {
    const res = await request(app)
      .post("/api/treasury/withdrawals")
      .send({ vaultId: "blend", amountUsd: 1000 });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "UNAUTHORIZED");
  });

  it("returns 403 FORBIDDEN for non-admin users", async () => {
    const res = await request(app)
      .post("/api/treasury/withdrawals")
      .set(user)
      .send({ vaultId: "blend", amountUsd: 1000 });

    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "FORBIDDEN");

    const listRes = await request(app).get("/api/treasury/withdrawals").set(user);
    expect(listRes.status).toBe(403);
  });

  it("allows public reads of the cooldown status only for admins", async () => {
    const anon = await request(app).get(
      "/api/treasury/withdrawals/cooldown?vaultId=blend",
    );
    expect(anon.status).toBe(401);
  });
});

describe("process-wide withdrawal service", () => {
  it("reset clears records between tests", () => {
    treasuryWithdrawalCooldownService.submitWithdrawal({
      vaultId: "blend",
      amountUsd: 1,
    });
    expect(
      treasuryWithdrawalCooldownService.listWithdrawals().length,
    ).toBeGreaterThan(0);
    resetTreasuryWithdrawalCooldownService();
    expect(treasuryWithdrawalCooldownService.listWithdrawals()).toHaveLength(0);
  });
});
