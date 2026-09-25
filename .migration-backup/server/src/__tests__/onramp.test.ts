import request from "supertest";
import express from "express";
import onrampRouter from "../routes/onramp";

const mockTransaction = {
  id: "test-id",
  providerTxId: "tx_12345",
  provider: "STRIPE",
  status: "PENDING",
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amountFiat: 100,
  currency: "USD",
  amountUsdc: 98,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockTransactionsDb = new Map<string, any>();
mockTransactionsDb.set("tx_12345", mockTransaction);

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      onRampTransaction: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(mockTransactionsDb.get(where.providerTxId) || null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const newTx = {
            id: `tx_${Math.random()}`,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockTransactionsDb.set(data.providerTxId, newTx);
          return Promise.resolve(newTx);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const existing = mockTransactionsDb.get(where.providerTxId);
          if (!existing) return Promise.reject(new Error("Record not found"));
          const updated = { ...existing, ...data, updatedAt: new Date() };
          mockTransactionsDb.set(where.providerTxId, updated);
          return Promise.resolve(updated);
        }),
        upsert: jest.fn().mockImplementation(({ where, update, create }) => {
          const existing = mockTransactionsDb.get(where.providerTxId);
          if (existing) {
            const updated = { ...existing, ...update, updatedAt: new Date() };
            mockTransactionsDb.set(where.providerTxId, updated);
            return Promise.resolve(updated);
          } else {
            const created = {
              id: `tx_${Math.random()}`,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            mockTransactionsDb.set(where.providerTxId, created);
            return Promise.resolve(created);
          }
        }),
      },
      notification: {
        create: jest.fn().mockResolvedValue({ id: "notif-id" }),
      },
      $disconnect: jest.fn(),
    })),
  };
});

const app = express();
app.use(express.json());
app.use("/api/onramp", onrampRouter);

describe("On-ramp API Routes", () => {
  beforeEach(() => {
    mockTransactionsDb.clear();
    mockTransactionsDb.set("tx_12345", { ...mockTransaction });
  });

  describe("POST /api/onramp/quote", () => {
    it("creates a valid quote", async () => {
      const res = await request(app)
        .post("/api/onramp/quote")
        .send({ amountFiat: 100, currency: "USD", provider: "STRIPE" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("quoteId");
      expect(res.body.amountFiat).toBe(100);
      expect(res.body.currency).toBe("USD");
      expect(res.body.amountUsdc).toBe(98);
      expect(res.body).toHaveProperty("expiresAt");
    });

    it("returns 400 for negative amounts", async () => {
      const res = await request(app)
        .post("/api/onramp/quote")
        .send({ amountFiat: -50, currency: "USD" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("amountFiat");
    });

    it("returns 400 for invalid currency codes", async () => {
      const res = await request(app)
        .post("/api/onramp/quote")
        .send({ amountFiat: 100, currency: "US" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("currency");
    });
  });

  describe("POST /api/onramp/intent", () => {
    it("confirms intent and creates pending transaction", async () => {
      // First generate a quote
      const quoteRes = await request(app)
        .post("/api/onramp/quote")
        .send({ amountFiat: 200, currency: "EUR" });
      
      const { quoteId } = quoteRes.body;

      const res = await request(app)
        .post("/api/onramp/intent")
        .send({
          quoteId,
          walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction.status).toBe("PENDING");
      expect(res.body.transaction.amountFiat).toBe(200);
      expect(res.body.transaction.currency).toBe("EUR");
    });

    it("returns 404 for nonexistent quote", async () => {
      const res = await request(app)
        .post("/api/onramp/intent")
        .send({
          quoteId: "quote_nonexistent",
          walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("GET /api/onramp/status/:txId", () => {
    it("returns status for existing transaction", async () => {
      const res = await request(app).get("/api/onramp/status/tx_12345");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("PENDING");
    });

    it("returns 404 for nonexistent transaction", async () => {
      const res = await request(app).get("/api/onramp/status/tx_unknown");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/onramp/cancel", () => {
    it("cancels pending transaction", async () => {
      const res = await request(app)
        .post("/api/onramp/cancel")
        .send({ txId: "tx_12345" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction.status).toBe("FAILED");
    });

    it("returns 404 for unknown transaction", async () => {
      const res = await request(app)
        .post("/api/onramp/cancel")
        .send({ txId: "tx_unknown" });

      expect(res.status).toBe(404);
    });
  });
});
