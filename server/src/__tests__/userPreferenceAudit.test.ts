import request from "supertest";
import express from "express";
import preferencesRouter from "../routes/preferences";
import {
  recordUserPreferenceChange,
  getUserPreferenceAuditHistory,
  resetUserPreferenceAuditStore,
} from "../services/userPreferenceAuditService";

const app = express();
app.use(express.json());
app.use("/api/preferences", preferencesRouter);

const WALLET = "G" + "A".repeat(55);
const INVALID_WALLET = "not-a-wallet";

describe("User preference audit service (#1311)", () => {
  beforeEach(() => {
    resetUserPreferenceAuditStore();
  });

  it("records changes newest-first", () => {
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_preference",
      actor: WALLET,
      source: "api",
      before: { enabled: false },
      after: { enabled: true },
    });
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_schedule",
      actor: "admin",
      source: "admin",
      before: { hour: 9 },
      after: { hour: 10 },
      reason: "timezone change",
    });

    const history = getUserPreferenceAuditHistory(WALLET);
    expect(history).toHaveLength(2);
    expect(history[0].category).toBe("digest_schedule");
    expect(history[1].category).toBe("digest_preference");
    expect(history[0].reason).toBe("timezone change");
    expect(history[0].source).toBe("admin");
  });

  it("filters by category when provided", () => {
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_preference",
      actor: WALLET,
      source: "api",
      before: null,
      after: { enabled: true },
    });
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_schedule",
      actor: WALLET,
      source: "api",
      before: null,
      after: { hour: 8 },
    });

    expect(getUserPreferenceAuditHistory(WALLET, "digest_preference")).toHaveLength(1);
    expect(getUserPreferenceAuditHistory(WALLET, "digest_schedule")).toHaveLength(1);
  });

  it("caps retained history at 100 entries per wallet", () => {
    for (let i = 0; i < 110; i++) {
      recordUserPreferenceChange({
        walletAddress: WALLET,
        category: "other",
        actor: "system",
        source: "system",
        before: { i },
        after: { i: i + 1 },
      });
    }
    expect(getUserPreferenceAuditHistory(WALLET)).toHaveLength(100);
  });

  it("is wallet-scoped (case-insensitive)", () => {
    recordUserPreferenceChange({
      walletAddress: WALLET.toUpperCase(),
      category: "other",
      actor: "system",
      source: "system",
      before: null,
      after: { x: 1 },
    });
    expect(getUserPreferenceAuditHistory(WALLET.toLowerCase())).toHaveLength(1);
    expect(getUserPreferenceAuditHistory("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")).toHaveLength(0);
  });
});

describe("GET /api/preferences/audit/:walletAddress (#1311)", () => {
  beforeEach(() => {
    resetUserPreferenceAuditStore();
  });

  it("rejects invalid wallet addresses", async () => {
    const res = await request(app)
      .get(`/api/preferences/audit/${INVALID_WALLET}`)
      .expect(400);
    expect(res.body.error).toBe("INVALID_ADDRESS");
  });

  it("returns empty history for a wallet with no changes", async () => {
    const res = await request(app)
      .get(`/api/preferences/audit/${WALLET}`)
      .expect(200);
    expect(res.body.walletAddress).toBe(WALLET);
    expect(res.body.history).toEqual([]);
  });

  it("returns recorded history after a preference change", async () => {
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_preference",
      actor: WALLET,
      source: "api",
      before: { enabled: false },
      after: { enabled: true },
    });

    const res = await request(app)
      .get(`/api/preferences/audit/${WALLET}`)
      .expect(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].category).toBe("digest_preference");
    expect(res.body.history[0].after).toEqual({ enabled: true });
  });

  it("filters history by valid category query", async () => {
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_preference",
      actor: WALLET,
      source: "api",
      before: null,
      after: { enabled: true },
    });
    recordUserPreferenceChange({
      walletAddress: WALLET,
      category: "digest_schedule",
      actor: WALLET,
      source: "api",
      before: null,
      after: { hour: 6 },
    });

    const res = await request(app)
      .get(`/api/preferences/audit/${WALLET}?category=digest_schedule`)
      .expect(200);
    expect(res.body.category).toBe("digest_schedule");
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].category).toBe("digest_schedule");
  });

  it("rejects unknown category values", async () => {
    const res = await request(app)
      .get(`/api/preferences/audit/${WALLET}?category=bogus`)
      .expect(400);
    expect(res.body.error).toBe("INVALID_CATEGORY");
  });
});
