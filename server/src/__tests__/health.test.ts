import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $queryRaw: jest.fn().mockResolvedValue([{}]),
      indexerState: {
        findFirst: jest.fn().mockResolvedValue({ lastLedger: 100 }),
      },
    })),
  };
});

const mockCall = jest.fn();
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({
            order: () => ({
              call: mockCall
            })
          })
        })
      }))
    }
  };
});

describe("GET /api/health", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_HORIZON_TIMEOUT_MS = "100";
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_TIMEOUT_MS;
  });

  it("returns 200 when healthy", async () => {
    mockCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.horizon).toBe("up");
  });

  it("returns 503 and degraded horizon on timeout", async () => {
    mockCall.mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 200));
    });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(503);
    expect(response.body.horizon).toBe("down");
  });
});
