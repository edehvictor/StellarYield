import request from "supertest";
import { createApp } from "../app";

describe("POST /api/zap/quote", () => {
  it("returns a fallback quote for identical tokens", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vaultTokenContract: "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.status).toBe(200);
    expect(res.body.expectedAmountOutStroops).toBe("1000");
    expect(res.body.source).toBe("fallback_rate");
  });

  it("returns 400 when body is incomplete", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({ inputTokenContract: "A" });

    expect(res.status).toBe(400);
  });
});
