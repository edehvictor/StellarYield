/**
 * Governance Vote Receipt Route Tests (#1896)
 *
 * Mounts the vote-receipt router on a bare Express app (like the execution
 * attempt route tests) so unrelated app wiring is not exercised.
 */
import request from "supertest";
import express, { Express } from "express";
import governanceVoteReceiptsRouter from "../governanceVoteReceipts";
import {
  clearReceiptStore,
  listVoteReceipts,
} from "../../services/governanceVoteReceiptService";
import {
  InMemoryIdempotencyStore,
  setDefaultIdempotencyStore,
} from "../../middleware/idempotency";

beforeEach(() => {
  clearReceiptStore();
  setDefaultIdempotencyStore(new InMemoryIdempotencyStore());
});

afterAll(() => {
  setDefaultIdempotencyStore(null);
});

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/governance", governanceVoteReceiptsRouter);
  return app;
}

const vote = (app: Express, body: unknown) =>
  request(app).post("/api/governance/vote-receipts").send(body);

describe("POST /api/governance/vote-receipts (#1896)", () => {
  it("creates a pending receipt for a first submission", async () => {
    const res = await vote(buildApp(), { proposalId: "p-1", voter: "GABC", choice: "yes" });

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.body.status).toBe("pending");
    expect(res.body.choice).toBe("yes");
  });

  it("replays the same receipt on a retry without an Idempotency-Key", async () => {
    const app = buildApp();
    const first = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" });
    const retry = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" });

    expect(retry.status).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.receiptId).toBe(first.body.receiptId);
    expect(listVoteReceipts("p-1")).toHaveLength(1);
  });

  it("still records one receipt when a retry carries a different Idempotency-Key", async () => {
    const app = buildApp();
    const first = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" }).set(
      "Idempotency-Key",
      "key-one",
    );
    const retry = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" }).set(
      "Idempotency-Key",
      "key-two",
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.receiptId).toBe(first.body.receiptId);
    expect(listVoteReceipts("p-1")).toHaveLength(1);
  });

  it("answers 409 for a different choice and leaves the stored receipt untouched", async () => {
    const app = buildApp();
    const first = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" });
    const conflict = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "no" });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("VOTE_ALREADY_SUBMITTED");
    expect(conflict.body.details.receiptId).toBe(first.body.receiptId);
    expect(conflict.body.details.choice).toBe("yes");

    const stored = listVoteReceipts("p-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].choice).toBe("yes");
  });

  it("stores nothing when validation fails", async () => {
    const app = buildApp();
    const res = await vote(app, { proposalId: "p-1", voter: "GABC" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MISSING_CHOICE");
    expect(listVoteReceipts("p-1")).toHaveLength(0);
  });

  it("lets a second voter vote on the same proposal", async () => {
    const app = buildApp();
    await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" });
    const other = await vote(app, { proposalId: "p-1", voter: "GDEF", choice: "no" });

    expect(other.status).toBe(201);
    expect(listVoteReceipts("p-1")).toHaveLength(2);
  });

  it("rejects whitespace-only fields and malformed reconcile events without mutating state", async () => {
    const app = buildApp();
    const valid = await vote(app, { proposalId: "p-1", voter: "GABC", choice: "yes" });
    expect(valid.status).toBe(201);

    const badVote = await vote(app, { proposalId: "   ", voter: "GDEF", choice: "no" });
    expect(badVote.status).toBe(400);
    expect(badVote.body.error).toBe("MISSING_PROPOSAL_ID");

    const badReconcile = await request(app)
      .post("/api/governance/vote-receipts/reconcile")
      .send({ events: [null, { proposalId: "p-1", voter: "GABC", choice: "yes", txHash: "TX", indexedAt: "not-a-date" }] });
    expect(badReconcile.status).toBe(400);
    expect(badReconcile.body.error).toBe("INVALID_EVENT_SHAPE");

    const stored = listVoteReceipts("p-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("pending");

    const retryReconcile = await request(app)
      .post("/api/governance/vote-receipts/reconcile")
      .send({
        events: [
          {
            proposalId: "p-1",
            voter: "GABC",
            choice: "yes",
            txHash: "TX1",
            indexedAt: new Date().toISOString(),
          },
        ],
      });
    expect(retryReconcile.status).toBe(200);
    expect(retryReconcile.body.reconciled).toBe(1);
  });
});
