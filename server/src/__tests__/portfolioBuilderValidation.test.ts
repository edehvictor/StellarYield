import express from "express";
import request from "supertest";
import portfolioBuilderRouter from "../routes/portfolioBuilder";
import { DUST_VALIDATION_MESSAGES } from "../../../shared/types/portfolioDust";

// Mount the router directly so the test does not depend on the full app's
// contract-registry bootstrap.
const app = express();
app.use(express.json());
app.use("/api/portfolio/builder", portfolioBuilderRouter);

const vault = (vaultContractId: string, weight: number, vaultName?: string) => ({
  vaultContractId,
  ...(vaultName ? { vaultName } : {}),
  weight,
});

describe("POST /api/portfolio/builder/validate", () => {
  it("accepts a clean allocation and serializes amounts as strings", async () => {
    const res = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({
        totalAmount: "1000",
        allocations: [
          vault("blend", 50, "Blend"),
          vault("soroswap", 50, "Soroswap"),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true,
      totalAmount: "1000",
      minimumAllocationAmount: "1",
      minNonZeroWeightPct: 0.01,
      weightsTotalPct: 100,
      issues: [],
      suggestedAllocations: null,
    });
    expect(res.body.message).toBe(DUST_VALIDATION_MESSAGES.valid);
  });

  it("returns dust issues with a cleanup suggestion instead of throwing", async () => {
    const res = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({
        totalAmount: "1",
        allocations: [
          vault("blend", 50, "Blend"),
          vault("soroswap", 50, "Soroswap"),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0]).toMatchObject({
      code: "AMOUNT_ROUNDS_TO_ZERO",
      vaultContractId: "soroswap",
      amount: "0",
      minimumAmount: "1",
    });
    expect(res.body.suggestedAllocations).toEqual([
      { vaultContractId: "blend", weight: 100 },
    ]);
  });

  it("flags weight dust and below-minimum custom amounts", async () => {
    const weightDust = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({
        totalAmount: "1000000",
        allocations: [vault("blend", 0.005, "Blend"), vault("soroswap", 99.995)],
      });

    expect(weightDust.status).toBe(200);
    expect(weightDust.body.valid).toBe(false);
    expect(weightDust.body.issues[0].code).toBe("WEIGHT_BELOW_MINIMUM");

    const amountDust = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({
        totalAmount: "100",
        minimumAllocationAmount: "10",
        allocations: [vault("blend", 2), vault("soroswap", 98)],
      });

    expect(amountDust.status).toBe(200);
    expect(amountDust.body.issues[0]).toMatchObject({
      code: "AMOUNT_BELOW_MINIMUM",
      amount: "2",
      minimumAmount: "10",
    });
  });

  it("handles an empty allocation list without failing", async () => {
    const res = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({ totalAmount: "100", allocations: [] });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.message).toBe(DUST_VALIDATION_MESSAGES.emptyAllocations);
  });

  it("returns a typed 400 for a malformed total amount", async () => {
    const res = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({ totalAmount: "1.5", allocations: [vault("blend", 100)] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_TOTAL_AMOUNT");
    expect(res.body.details.fieldErrors[0].field).toBe("totalAmount");
  });

  it("returns a typed 400 when weights do not sum to 100", async () => {
    const res = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({
        totalAmount: "100",
        allocations: [vault("blend", 40), vault("soroswap", 40)],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ALLOCATION_SUM_MISMATCH");
    expect(res.body.details.fieldErrors[0].code).toBe("ALLOCATION_SUM_MISMATCH");
  });

  it("returns typed 400s for malformed allocations", async () => {
    const nonArray = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({ totalAmount: "100", allocations: "blend" });
    expect(nonArray.status).toBe(400);
    expect(nonArray.body.error).toBe("INVALID_ALLOCATIONS");

    const missingVault = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({ totalAmount: "100", allocations: [{ weight: 100 }] });
    expect(missingVault.status).toBe(400);
    expect(missingVault.body.error).toBe("INVALID_ALLOCATION");

    const invalidWeight = await request(app)
      .post("/api/portfolio/builder/validate")
      .send({ totalAmount: "100", allocations: [vault("blend", 120)] });
    expect(invalidWeight.status).toBe(400);
    expect(invalidWeight.body.error).toBe("INVALID_ALLOCATION_WEIGHT");
  });

  it("rejects a non-object body", async () => {
    const res = await request(app)
      .post("/api/portfolio/builder/validate")
      .send([]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_BODY");
  });
});
