/**
 * Governance Execution Attempt Route Tests (#1899)
 *
 * Mounts the execution-attempts router on a bare Express app (rather than
 * createApp) so the contract registry checksum verification — which fails in
 * this environment independent of these changes — is not triggered.
 */
import request from "supertest";
import express, { Express } from "express";
import governanceExecutionAttemptsRouter from "../governanceExecutionAttempts";
import {
  clearExecutionAttemptStore,
  countExecutionAttempts,
} from "../../services/governanceExecutionAttemptService";

beforeEach(() => {
  clearExecutionAttemptStore();
  expect(countExecutionAttempts()).toBe(0);
});

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/governance/execution-attempts", governanceExecutionAttemptsRouter);
  return app;
}

const postAttempt = (app: Express, body: unknown) =>
  request(app).post("/api/governance/execution-attempts").send(body);

describe("POST /api/governance/execution-attempts (#1899)", () => {
  it("creates a submitted execution attempt and returns it", async () => {
    const app = buildApp();
    const res = await postAttempt(app, {
      proposalId: "proposal-1",
      phase: "submitting",
    });

    expect(res.status).toBe(201);
    expect(res.body.attemptId).toBeDefined();
    expect(res.body.proposalId).toBe("proposal-1");
    expect(res.body.status).toBe("submitted");
    expect(res.body.phase).toBe("submitting");
    expect(res.body.attemptNumber).toBe(1);
    expect(res.body.createdAt).toBeDefined();
  });

  it("reports the same in-flight txHash without duplicating the attempt", async () => {
    const app = buildApp();
    const first = await postAttempt(app, {
      proposalId: "proposal-1",
      txHash: "abc123",
      status: "polling",
      phase: "polling",
    });

    const retry = await postAttempt(app, {
      proposalId: "proposal-1",
      txHash: "abc123",
      status: "failed",
      phase: "failure",
      error: "timeout",
    });

    expect(retry.status).toBe(201);
    expect(retry.body.attemptId).toBe(first.body.attemptId);
    expect(retry.body.status).toBe("failed");
    expect(retry.body.error).toBe("timeout");
    expect(countExecutionAttempts()).toBe(1);
  });

  it("increments the attempt number for a fresh attempt on the same proposal", async () => {
    const app = buildApp();
    await postAttempt(app, { proposalId: "proposal-1" });
    await postAttempt(app, { proposalId: "proposal-1" });
    const third = await postAttempt(app, { proposalId: "proposal-1" });

    expect(third.body.attemptNumber).toBe(3);
  });

  it("rejects a missing proposalId", async () => {
    const app = buildApp();
    const res = await postAttempt(app, { phase: "submitting" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MISSING_PROPOSAL_ID");
  });

  it("rejects an invalid status", async () => {
    const app = buildApp();
    const res = await postAttempt(app, {
      proposalId: "proposal-1",
      status: "not-a-status" as never,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_STATUS");
  });
});

describe("GET /api/governance/execution-attempts (#1899)", () => {
describe("GET /api/governance/execution-attempts (#1899)", () => {
  it("returns a single attempt by id", async () => {
    const app = buildApp();
    const created = await postAttempt(app, {
      proposalId: "proposal-1",
      txHash: "abc123",
      status: "polling",
    });

    const res = await request(app).get(
      `/api/governance/execution-attempts/${created.body.attemptId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.attemptId).toBe(created.body.attemptId);
    expect(res.body.txHash).toBe("abc123");
  });

  it("returns 404 for an unknown attempt id", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/governance/execution-attempts/missing");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("ATTEMPT_NOT_FOUND");
  });

  it("lists attempts for a proposal, newest first", async () => {
    const app = buildApp();
    const first = await postAttempt(app, { proposalId: "p-1" });
    await postAttempt(app, { proposalId: "p-2" });
    const latest = await postAttempt(app, { proposalId: "p-1" });

    const res = await request(app).get("/api/governance/execution-attempts?proposalId=p-1");

    expect(res.status).toBe(200);
    expect(res.body.proposalId).toBe("p-1");
    expect(res.body.attempts).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(res.body.attempts.map((a: { attemptId: string }) => a.attemptId)).toContain(
      first.body.attemptId,
    );
    expect(res.body.attempts.map((a: { attemptId: string }) => a.attemptId)).toContain(
      latest.body.attemptId,
    );
  });

  it("rejects a missing proposalId query parameter", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/governance/execution-attempts");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MISSING_PROPOSAL_ID");
  });
});

});

describe("terminal transitions (#1899)", () => {
  it("marks an attempt succeeded", async () => {
    const app = buildApp();
    const created = await postAttempt(app, {
      proposalId: "proposal-1",
      txHash: "abc123",
      status: "polling",
    });

    const res = await request(app)
      .post(`/api/governance/execution-attempts/${created.body.attemptId}/succeeded`)
      .send({ txHash: "abc123" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("succeeded");
    expect(res.body.phase).toBe("success");
  });

  it("marks an attempt failed", async () => {
    const app = buildApp();
    const created = await postAttempt(app, {
      proposalId: "proposal-1",
      txHash: "abc123",
    });

    const res = await request(app)
      .post(`/api/governance/execution-attempts/${created.body.attemptId}/failed`)
      .send({ error: "node timeout", failedAtPhase: "polling" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toBe("node timeout");
    expect(res.body.failedAtPhase).toBe("polling");
  });

  it("marks an attempt rolled back", async () => {
    const app = buildApp();
    const created = await postAttempt(app, {
      proposalId: "proposal-1",
      txHash: "abc123",
    });

    const res = await request(app)
      .post(`/api/governance/execution-attempts/${created.body.attemptId}/rolled-back`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rolled_back");
  });

  it("returns 404 for transitions on an unknown attempt", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/governance/execution-attempts/missing/succeeded")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("ATTEMPT_NOT_FOUND");
  });
});

describe("POST /api/governance/execution-attempts operationId (#1896)", () => {
  it("creates once and answers 200 with the same attempt on a retry", async () => {
    const app = buildApp();
    const first = await postAttempt(app, { proposalId: "proposal-1", operationId: "op-1" });
    const retry = await postAttempt(app, { proposalId: "proposal-1", operationId: "op-1" });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.attemptId).toBe(first.body.attemptId);
    expect(countExecutionAttempts()).toBe(1);
  });

  it("answers 409 and leaves the attempt alone when the operationId meets a different txHash", async () => {
    const app = buildApp();
    const first = await postAttempt(app, {
      proposalId: "proposal-1",
      operationId: "op-1",
      txHash: "abc123",
      status: "polling",
    });
    const clash = await postAttempt(app, {
      proposalId: "proposal-1",
      operationId: "op-1",
      txHash: "zzz999",
      status: "failed",
    });

    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("OPERATION_ID_CONFLICT");
    expect(clash.body.details.attemptId).toBe(first.body.attemptId);

    const stored = await request(app).get(
      `/api/governance/execution-attempts/${first.body.attemptId}`,
    );
    expect(stored.body.txHash).toBe("abc123");
    expect(stored.body.status).toBe("polling");
  });

  it("replays a finished attempt unchanged and flags the response", async () => {
    const app = buildApp();
    await postAttempt(app, {
      proposalId: "proposal-1",
      operationId: "op-1",
      txHash: "abc123",
      status: "succeeded",
      phase: "success",
    });
    const stale = await postAttempt(app, {
      proposalId: "proposal-1",
      operationId: "op-1",
      txHash: "abc123",
      status: "polling",
      phase: "polling",
    });

    expect(stale.status).toBe(200);
    expect(stale.headers["idempotent-replayed"]).toBe("true");
    expect(stale.body.status).toBe("succeeded");
    expect(countExecutionAttempts()).toBe(1);
  });

  it.each(["", "has space", "x".repeat(129), 42])(
    "rejects a malformed operationId (%p) and stores nothing",
    async (operationId) => {
      const res = await postAttempt(buildApp(), { proposalId: "proposal-1", operationId });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_OPERATION_ID");
      expect(countExecutionAttempts()).toBe(0);
    },
  );
});
