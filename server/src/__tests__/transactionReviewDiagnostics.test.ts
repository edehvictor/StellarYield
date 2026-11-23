import request from "supertest";
import { createApp } from "../app";
import { getZapQuote } from "../services/zapQuote";
import { areTransactionReviewDiagnosticsPrivacySafe } from "../../../shared/types/transactionReviewDiagnostic";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([{ protocolName: "default", tvl: 10_000_000 }]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [{ protocolName: "default", tvl: 10_000_000 }],
    cacheStatus: "MISS",
  }),
}));

jest.mock("../services/freezeService", () => ({
  freezeService: { isFrozen: jest.fn().mockReturnValue(false) },
}));

jest.mock("../services/zapQuote", () => ({
  ...jest.requireActual("../services/zapQuote"),
  getZapQuote: jest.fn(),
}));

const mockGetZapQuote = getZapQuote as jest.MockedFunction<typeof getZapQuote>;

// Raw text that must never be echoed back to callers.
const SENSITIVE_ERROR =
  "RPC https://rpc.internal.example/v1 failed for GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF at /srv/app/zap.ts";

describe("transaction review diagnostics (#1893)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("names the validation stage for incomplete requests", async () => {
    const res = await request(createApp()).post("/api/zap/quote").send({ inputTokenContract: "A" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MISSING_FIELDS");
    expect(res.body.diagnostics[0]).toMatchObject({
      stage: "request-validation",
      code: "VALIDATION_FAILED",
      retryable: false,
      privacySafe: true,
    });
    expect(res.body.diagnostics[1].code).toBe("STATE_PRESERVED");
    expect(mockGetZapQuote).not.toHaveBeenCalled();
  });

  it("names the validation stage for a malformed amount", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({ inputTokenContract: "A", vaultTokenContract: "B", amountInStroops: "1.5" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_AMOUNT");
    expect(res.body.diagnostics[0].stage).toBe("request-validation");
  });

  it("reports a quote-stage diagnostic without echoing the raw exception", async () => {
    mockGetZapQuote.mockRejectedValueOnce(new Error(SENSITIVE_ERROR));

    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({ inputTokenContract: "A", vaultTokenContract: "B", amountInStroops: "1000" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("QUOTE_FAILED");
    expect(res.body.recoverable).toBe(true);
    expect(res.body.diagnostics[0]).toMatchObject({ stage: "quote", code: "STAGE_UNAVAILABLE", retryable: true });
    expect(areTransactionReviewDiagnosticsPrivacySafe(res.body.diagnostics)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/rpc\.internal|GAAAA|\/srv\/app/);
    expect(res.body.details).toBeUndefined();
  });

  it("allows a safe retry after a failed quote (failure leaves no state behind)", async () => {
    mockGetZapQuote.mockRejectedValueOnce(new Error("transient"));
    const app = createApp();
    const body = { inputTokenContract: "A", vaultTokenContract: "B", amountInStroops: "1000" };

    const failed = await request(app).post("/api/zap/quote").send(body);
    expect(failed.status).toBe(500);

    mockGetZapQuote.mockRejectedValueOnce(new Error("still failing"));
    const again = await request(app).post("/api/zap/quote").send(body);
    expect(again.status).toBe(500);
    expect(again.body.diagnostics).toEqual(failed.body.diagnostics);
    expect(mockGetZapQuote).toHaveBeenCalledTimes(2);
  });

  it("asks for a fresh quote when verify rejects a stale quote", async () => {
    const res = await request(createApp()).post("/api/zap/verify").send({ not: "a quote" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STALE_QUOTE");
    expect(res.body.recoverable).toBe(true);
    expect(res.body.diagnostics[0]).toMatchObject({
      stage: "quote-verification",
      code: "QUOTE_REFRESH_REQUIRED",
      retryable: true,
    });
    expect(res.body.diagnostics[1].code).toBe("STATE_PRESERVED");
    expect(areTransactionReviewDiagnosticsPrivacySafe(res.body.diagnostics)).toBe(true);
  });
});
