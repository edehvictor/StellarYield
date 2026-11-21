/**
 * Governance Boundary Validation Tests (#1897)
 *
 * Verifies that malformed external payloads are rejected with typed 400
 * responses, existing server state is preserved on failure, and safe retries
 * with valid data succeed.
 */
import request from "supertest";
import express, { Express } from "express";
import governanceRouter from "../governance";
import governanceVoteReceiptsRouter from "../governanceVoteReceipts";
import governanceExecutionAttemptsRouter from "../governanceExecutionAttempts";
import {
  clearReceiptStore,
  getVoteReceipt,
  listVoteReceipts,
} from "../../services/governanceVoteReceiptService";
import {
  clearExecutionAttemptStore,
  countExecutionAttempts,
  getExecutionAttempt,
} from "../../services/governanceExecutionAttemptService";
import {
  InMemoryIdempotencyStore,
  setDefaultIdempotencyStore,
} from "../../middleware/idempotency";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/governance", governanceRouter);
  app.use("/api/governance", governanceVoteReceiptsRouter);
  app.use("/api/governance/execution-attempts", governanceExecutionAttemptsRouter);
  return app;
}

beforeEach(() => {
  clearReceiptStore();
  clearExecutionAttemptStore();
  setDefaultIdempotencyStore(new InMemoryIdempotencyStore());
});

afterAll(() => {
  setDefaultIdempotencyStore(null);
});

describe("Governance boundary validation (#1897)", () => {
  describe("POST /api/governance/forecast", () => {
    const validForecast = {
      proposalType: "fee_change",
      parameters: { feeRatePct: 3 },
      baseline: {
        yieldPct: 8,
        exposurePct: 40,
        feeRatePct: 2,
        tvlUsd: 10_000_000,
      },
    };

    it("rejects non-numeric parameter values and array baselines, then succeeds on retry", async () => {
      const app = buildApp();

      const badParams = await request(app)
        .post("/api/governance/forecast")
        .send({ ...validForecast, parameters: { feeRatePct: "3" } });
      expect(badParams.status).toBe(400);
      expect(badParams.body.error).toBe("VALIDATION_FAILED");
      expect(badParams.body.fields).toContain("parameters");

      const badBaseline = await request(app)
        .post("/api/governance/forecast")
        .send({ ...validForecast, baseline: [8, 40, 2, 10_000_000] });
      expect(badBaseline.status).toBe(400);
      expect(badBaseline.body.error).toBe("VALIDATION_FAILED");
      expect(badBaseline.body.fields).toContain("baseline");

      const negTvl = await request(app)
        .post("/api/governance/forecast")
        .send({
          ...validForecast,
          baseline: { ...validForecast.baseline, tvlUsd: -1 },
        });
      expect(negTvl.status).toBe(400);
      expect(negTvl.body.fields).toContain("baseline");

      const retry = await request(app)
        .post("/api/governance/forecast")
        .send(validForecast);
      expect(retry.status).toBe(200);
      expect(retry.body.forecast).toBeDefined();
    });
  });

  describe("POST /api/governance/quorum-progress", () => {
    it("rejects non-string signers/signatures and non-integer thresholds, then succeeds on retry", async () => {
      const app = buildApp();

      const badSigners = await request(app)
        .post("/api/governance/quorum-progress")
        .send({ signers: ["GABC", 123], signatures: ["GABC"], threshold: 1 });
      expect(badSigners.status).toBe(400);
      expect(badSigners.body.error).toBe("VALIDATION_FAILED");
      expect(badSigners.body.fields).toContain("signers");

      const badThreshold = await request(app)
        .post("/api/governance/quorum-progress")
        .send({ signers: ["GABC"], signatures: ["GABC"], threshold: 0 });
      expect(badThreshold.status).toBe(400);
      expect(badThreshold.body.fields).toContain("threshold");

      const retry = await request(app)
        .post("/api/governance/quorum-progress")
        .send({ signers: ["GABC", "GDEF"], signatures: ["GABC"], threshold: 2 });
      expect(retry.status).toBe(200);
      expect(retry.body.signed).toBe(1);
      expect(retry.body.remaining).toBe(1);
      expect(retry.body.met).toBe(false);
    });
  });

  describe("Vote receipts & reconciliation", () => {
    it("rejects whitespace-only fields and malformed reconcile events without altering stored receipts", async () => {
      const app = buildApp();

      const blankVoter = await request(app)
        .post("/api/governance/vote-receipts")
        .send({ proposalId: "p-1", voter: "   ", choice: "yes" });
      expect(blankVoter.status).toBe(400);
      expect(blankVoter.body.error).toBe("MISSING_VOTER");
      expect(listVoteReceipts("p-1")).toHaveLength(0);

      const created = await request(app)
        .post("/api/governance/vote-receipts")
        .send({ proposalId: "p-1", voter: "GABC", choice: "yes" });
      expect(created.status).toBe(201);

      const nullEvent = await request(app)
        .post("/api/governance/vote-receipts/reconcile")
        .send({ events: [null] });
      expect(nullEvent.status).toBe(400);
      expect(nullEvent.body.error).toBe("INVALID_EVENT_SHAPE");
      expect(getVoteReceipt(created.body.receiptId)?.status).toBe("pending");

      const badDate = await request(app)
        .post("/api/governance/vote-receipts/reconcile")
        .send({
          events: [
            {
              proposalId: "p-1",
              voter: "GABC",
              choice: "yes",
              txHash: "hash-1",
              indexedAt: "not-a-date",
            },
          ],
        });
      expect(badDate.status).toBe(400);
      expect(badDate.body.error).toBe("INVALID_EVENT_SHAPE");
      expect(getVoteReceipt(created.body.receiptId)?.status).toBe("pending");

      const retry = await request(app)
        .post("/api/governance/vote-receipts/reconcile")
        .send({
          events: [
            {
              proposalId: "p-1",
              voter: "GABC",
              choice: "yes",
              txHash: "hash-1",
              indexedAt: "2026-11-21T00:00:00.000Z",
            },
          ],
        });
      expect(retry.status).toBe(200);
      expect(retry.body.reconciled).toBe(1);
      expect(getVoteReceipt(created.body.receiptId)?.status).toBe("confirmed");
    });
  });

  describe("Execution attempts", () => {
    it("rejects malformed attempt payloads and preserves existing attempt state", async () => {
      const app = buildApp();

      const blankProposal = await request(app)
        .post("/api/governance/execution-attempts")
        .send({ proposalId: "   " });
      expect(blankProposal.status).toBe(400);
      expect(blankProposal.body.error).toBe("MISSING_PROPOSAL_ID");
      expect(countExecutionAttempts()).toBe(0);

      const badAttemptNum = await request(app)
        .post("/api/governance/execution-attempts")
        .send({ proposalId: "p-1", attemptNumber: 0 });
      expect(badAttemptNum.status).toBe(400);
      expect(badAttemptNum.body.error).toBe("INVALID_ATTEMPT_NUMBER");
      expect(countExecutionAttempts()).toBe(0);

      const created = await request(app)
        .post("/api/governance/execution-attempts")
        .send({ proposalId: "p-1", phase: "submitting" });
      expect(created.status).toBe(201);
      const attemptId = created.body.attemptId;

      const badTxHash = await request(app)
        .post(`/api/governance/execution-attempts/${attemptId}/succeeded`)
        .send({ txHash: "   " });
      expect(badTxHash.status).toBe(400);
      expect(badTxHash.body.error).toBe("INVALID_TX_HASH");
      expect(getExecutionAttempt(attemptId)?.status).toBe("submitted");

      const retry = await request(app)
        .post(`/api/governance/execution-attempts/${attemptId}/succeeded`)
        .send({ txHash: "tx-abc" });
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe("succeeded");
      expect(retry.body.txHash).toBe("tx-abc");
    });
  });
});
