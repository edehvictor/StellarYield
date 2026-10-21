import express from "express";
import request from "supertest";
import walletRecoveryRouter from "../routes/walletRecovery";
import {
  _resetSignatureRejectionStore,
  getSignatureRejectionSummary,
} from "../services/walletSignatureRecoveryService";

// Mount the router directly: createApp() loads the zap route, which verifies a
// registry checksum unrelated to this feature.
const app = express();
app.use(express.json());
app.use("/api/wallet", walletRecoveryRouter);

beforeEach(() => {
  _resetSignatureRejectionStore();
});

describe("POST /api/wallet/signature-rejections", () => {
  it("records a declined signature and returns stable recovery guidance", async () => {
    const res = await request(app).post("/api/wallet/signature-rejections").send({
      walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      provider: "freighter",
      action: "portfolio_deposit",
      code: "USER_REJECTED_SIGNATURE",
      attempt: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: "USER_REJECTED_SIGNATURE",
      title: "Signature request declined",
      retryable: true,
      attempt: 1,
      maxAttempts: 3,
      remainingAttempts: 2,
      provider: "freighter",
    });
    expect(res.body.actions).toContain("retry");
    expect(typeof res.body.recordedAt).toBe("string");
  });

  it("classifies a raw reason without echoing it back", async () => {
    const rawReason = "FREIGHTER_INTERNAL_9f3c: user closed the popup";
    const res = await request(app).post("/api/wallet/signature-rejections").send({
      action: "zap_deposit",
      reason: rawReason,
    });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe("USER_REJECTED_SIGNATURE");
    expect(JSON.stringify(res.body)).not.toContain("FREIGHTER_INTERNAL_9f3c");
  });

  it("removes the retry action once the attempt limit is reached", async () => {
    const res = await request(app).post("/api/wallet/signature-rejections").send({
      action: "portfolio_deposit",
      code: "USER_REJECTED_SIGNATURE",
      attempt: 3,
      maxAttempts: 3,
    });

    expect(res.status).toBe(201);
    expect(res.body.retryable).toBe(false);
    expect(res.body.remainingAttempts).toBe(0);
    expect(res.body.actions).not.toContain("retry");
    expect(res.body.guidance).toContain("switch wallets");
  });

  it("rejects a missing action with a typed 400", async () => {
    const res = await request(app).post("/api/wallet/signature-rejections").send({
      code: "USER_REJECTED_SIGNATURE",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_ACTION");
    expect(res.body.details.fieldErrors[0].field).toBe("action");
  });

  it("rejects an unknown rejection code", async () => {
    const res = await request(app).post("/api/wallet/signature-rejections").send({
      action: "portfolio_deposit",
      code: "PROVIDER_EXPLODED",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REJECTION_CODE");
  });

  it("rejects invalid partial progress", async () => {
    const res = await request(app).post("/api/wallet/signature-rejections").send({
      action: "portfolio_deposit",
      completedSteps: 3,
      totalSteps: 2,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PROGRESS");
  });
});

describe("GET /api/wallet/signature-rejections/summary", () => {
  it("returns an empty summary before anything is recorded", async () => {
    const res = await request(app).get(
      "/api/wallet/signature-rejections/summary?wallet=GEMPTY",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      wallet: "GEMPTY",
      total: 0,
      byCode: {},
      topAction: null,
      lastOccurredAt: null,
    });
  });

  it("aggregates recorded rejections per wallet", async () => {
    const wallet = "GSUMMARYWALLET";
    await request(app).post("/api/wallet/signature-rejections").send({
      action: "portfolio_deposit",
      walletAddress: wallet,
      code: "USER_REJECTED_SIGNATURE",
    });
    await request(app).post("/api/wallet/signature-rejections").send({
      action: "portfolio_deposit",
      walletAddress: wallet,
      code: "SIGNING_TIMEOUT",
    });
    await request(app).post("/api/wallet/signature-rejections").send({
      action: "zap_deposit",
      walletAddress: "GOTHERWALLET",
      code: "USER_REJECTED_SIGNATURE",
    });

    const res = await request(app).get(
      `/api/wallet/signature-rejections/summary?wallet=${wallet}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.byCode).toEqual({
      USER_REJECTED_SIGNATURE: 1,
      SIGNING_TIMEOUT: 1,
    });
    expect(res.body.topAction).toBe("portfolio_deposit");
    expect(getSignatureRejectionSummary(wallet).total).toBe(2);
  });
});
