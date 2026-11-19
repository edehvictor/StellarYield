/**
 * Governance execution attempts: concurrent state changes (#1895).
 *
 * Covers optimistic concurrency (versions, If-Match), final-state protection,
 * unique attempt numbers, and safe retry, at the service and HTTP levels.
 */
import request from "supertest";
import express, { Express } from "express";
import governanceExecutionAttemptsRouter from "../routes/governanceExecutionAttempts";
import {
  clearExecutionAttemptStore,
  countExecutionAttempts,
  getExecutionAttempt,
  listExecutionAttemptsForProposal,
  recordExecutionAttemptOnce,
  transitionExecutionAttempt,
  markExecutionFailed,
  markExecutionRolledBack,
  markExecutionSucceeded,
  ExecutionAttemptVersionConflictError,
} from "../services/governanceExecutionAttemptService";

beforeEach(() => {
  clearExecutionAttemptStore();
});

const P = "proposal-1";

function snapshot(id: string) {
  return JSON.parse(JSON.stringify(getExecutionAttempt(id)));
}

describe("versions (service)", () => {
  it("starts at 1 and goes up by one per committed change", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    expect(attempt.version).toBe(1);

    const next = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", phase: "polling" });
    expect(next.attempt.version).toBe(2);

    const done = transitionExecutionAttempt(attempt.attemptId, { kind: "succeeded" });
    expect(done.attempt?.version).toBe(3);
  });

  it("attaching an operationId to an existing attempt is one commit", () => {
    recordExecutionAttemptOnce({ proposalId: P, txHash: "h1" });
    const withOp = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", operationId: "op-1" });
    expect(withOp.attempt.version).toBe(2);
  });

  it("does not bump the version for replays and unchanged transitions", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1" });
    transitionExecutionAttempt(attempt.attemptId, { kind: "succeeded" });
    const v = getExecutionAttempt(attempt.attemptId)!.version;

    transitionExecutionAttempt(attempt.attemptId, { kind: "succeeded" });
    recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    expect(getExecutionAttempt(attempt.attemptId)!.version).toBe(v);
  });
});

describe("optimistic concurrency (service)", () => {
  it("writes when the expected version is current", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    const res = recordExecutionAttemptOnce({
      proposalId: P,
      txHash: "h1",
      phase: "polling",
      expectedVersion: attempt.version,
    });
    expect(res.outcome).toBe("updated");
    expect(res.attempt.version).toBe(attempt.version + 1);
  });

  it("rejects a stale version and leaves the attempt exactly as it was", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", phase: "polling" }); // now v2
    const before = snapshot(attempt.attemptId);

    expect(() =>
      recordExecutionAttemptOnce({
        proposalId: P,
        txHash: "h1",
        status: "failed",
        phase: "failure",
        error: "late",
        expectedVersion: 1,
      }),
    ).toThrow(ExecutionAttemptVersionConflictError);

    expect(snapshot(attempt.attemptId)).toEqual(before);
    expect(countExecutionAttempts()).toBe(1);
  });

  it("the conflict names the expected and current versions and carries the current attempt", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1" });
    recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", phase: "polling" });
    try {
      recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", expectedVersion: 1 });
      throw new Error("expected a conflict");
    } catch (err) {
      const conflict = err as ExecutionAttemptVersionConflictError;
      expect(conflict.code).toBe("EXECUTION_ATTEMPT_VERSION_CONFLICT");
      expect(conflict.expectedVersion).toBe(1);
      expect(conflict.currentVersion).toBe(2);
      expect(conflict.currentAttempt?.attemptId).toBe(attempt.attemptId);
    }
  });

  it("of two writers holding the same version, exactly one commits", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    const seen = attempt.version;

    const writerA = () =>
      recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", phase: "polling", expectedVersion: seen });
    const writerB = () =>
      recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", phase: "recovering", expectedVersion: seen });

    expect(writerA().attempt.phase).toBe("polling");
    expect(writerB).toThrow(ExecutionAttemptVersionConflictError);
    expect(getExecutionAttempt(attempt.attemptId)!.phase).toBe("polling");
  });

  it("expecting an attempt that does not exist is a conflict and creates nothing", () => {
    expect(() =>
      recordExecutionAttemptOnce({ proposalId: P, txHash: "h9", expectedVersion: 3 }),
    ).toThrow(ExecutionAttemptVersionConflictError);
    expect(countExecutionAttempts()).toBe(0);
  });

  it("version 0 means create only", () => {
    const created = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", expectedVersion: 0 });
    expect(created.outcome).toBe("created");
    expect(() =>
      recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", expectedVersion: 0 }),
    ).toThrow(ExecutionAttemptVersionConflictError);
    expect(countExecutionAttempts()).toBe(1);
  });

  it("retrying a create-only request for the same operation replays it", () => {
    const first = recordExecutionAttemptOnce({ proposalId: P, operationId: "op-1", expectedVersion: 0 });
    const retry = recordExecutionAttemptOnce({ proposalId: P, operationId: "op-1", expectedVersion: 0 });

    expect(first.outcome).toBe("created");
    expect(retry.outcome).toBe("replayed");
    expect(retry.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(countExecutionAttempts()).toBe(1);
  });

  it("a version conflict does not consume the operation identity", () => {
    const first = recordExecutionAttemptOnce({ proposalId: P, operationId: "op-1", txHash: "h1" });
    recordExecutionAttemptOnce({ proposalId: P, operationId: "op-1", phase: "polling" }); // v2
    expect(() =>
      recordExecutionAttemptOnce({ proposalId: P, operationId: "op-1", phase: "recovering", expectedVersion: 1 }),
    ).toThrow(ExecutionAttemptVersionConflictError);

    const retry = recordExecutionAttemptOnce({
      proposalId: P,
      operationId: "op-1",
      phase: "recovering",
      expectedVersion: 2,
    });
    expect(retry.outcome).toBe("updated");
    expect(retry.attempt.attemptId).toBe(first.attempt.attemptId);
  });

  it("transitions honour expectedVersion", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", phase: "polling" }); // v2
    const before = snapshot(attempt.attemptId);

    expect(() =>
      transitionExecutionAttempt(attempt.attemptId, { kind: "rolled_back" }, { expectedVersion: 1 }),
    ).toThrow(ExecutionAttemptVersionConflictError);
    expect(snapshot(attempt.attemptId)).toEqual(before);

    const ok = transitionExecutionAttempt(attempt.attemptId, { kind: "rolled_back" }, { expectedVersion: 2 });
    expect(ok.outcome).toBe("updated");
    expect(ok.attempt?.status).toBe("rolled_back");
  });

  it("a retry of a finished transition is answered with the stored result, not a conflict", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    transitionExecutionAttempt(attempt.attemptId, { kind: "succeeded" }, { expectedVersion: 1 });

    const retry = transitionExecutionAttempt(attempt.attemptId, { kind: "succeeded" }, { expectedVersion: 1 });
    expect(retry.outcome).toBe("unchanged");
    expect(retry.attempt?.status).toBe("succeeded");
    expect(retry.attempt?.version).toBe(2);
  });
});

describe("final states are protected (service)", () => {
  function succeededAttempt() {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    transitionExecutionAttempt(attempt.attemptId, { kind: "succeeded" });
    return attempt.attemptId;
  }

  it("a late failure report does not overwrite a succeeded attempt", () => {
    const id = succeededAttempt();
    const before = snapshot(id);

    const res = transitionExecutionAttempt(id, { kind: "failed", error: "timeout", failedAtPhase: "polling" });
    expect(res.outcome).toBe("state_conflict");
    expect(snapshot(id)).toEqual(before);
    expect(getExecutionAttempt(id)!.error).toBeUndefined();
  });

  it("markExecutionFailed leaves a succeeded attempt unchanged", () => {
    const id = succeededAttempt();
    const attempt = markExecutionFailed(id, "timeout", "polling");
    expect(attempt?.status).toBe("succeeded");
    expect(attempt?.error).toBeUndefined();
  });

  it("a succeeded attempt cannot be rolled back", () => {
    const id = succeededAttempt();
    expect(transitionExecutionAttempt(id, { kind: "rolled_back" }).outcome).toBe("state_conflict");
    expect(markExecutionRolledBack(id)?.status).toBe("succeeded");
  });

  it("a rolled-back attempt cannot be marked failed, and repeating the rollback changes nothing", () => {
    const { attempt } = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling" });
    transitionExecutionAttempt(attempt.attemptId, { kind: "rolled_back" });
    const before = snapshot(attempt.attemptId);

    expect(
      transitionExecutionAttempt(attempt.attemptId, { kind: "failed", error: "x", failedAtPhase: "polling" }).outcome,
    ).toBe("state_conflict");
    expect(transitionExecutionAttempt(attempt.attemptId, { kind: "rolled_back" }).outcome).toBe("unchanged");
    expect(markExecutionSucceeded(attempt.attemptId)?.status).toBe("rolled_back");
    expect(snapshot(attempt.attemptId)).toEqual(before);
  });

  it("a failed attempt can still be confirmed or discarded", () => {
    const a = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1" }).attempt;
    transitionExecutionAttempt(a.attemptId, { kind: "failed", error: "x", failedAtPhase: "polling" });
    expect(transitionExecutionAttempt(a.attemptId, { kind: "succeeded" }).attempt?.status).toBe("succeeded");

    const b = recordExecutionAttemptOnce({ proposalId: P, txHash: "h2" }).attempt;
    transitionExecutionAttempt(b.attemptId, { kind: "failed", error: "x", failedAtPhase: "polling" });
    expect(transitionExecutionAttempt(b.attemptId, { kind: "rolled_back" }).attempt?.status).toBe("rolled_back");
  });

  it("a stale report by txHash does not move a finished attempt (no operationId)", () => {
    const id = succeededAttempt();
    const before = snapshot(id);

    const stale = recordExecutionAttemptOnce({ proposalId: P, txHash: "h1", status: "polling", phase: "polling" });
    expect(stale.outcome).toBe("replayed");
    expect(stale.attempt.status).toBe("succeeded");
    expect(snapshot(id)).toEqual(before);
    expect(countExecutionAttempts()).toBe(1);
  });
});

describe("attempt numbers (service)", () => {
  it("assigns the next free number when a client proposes one that is taken", () => {
    recordExecutionAttemptOnce({ proposalId: P }); // 1
    const second = recordExecutionAttemptOnce({ proposalId: P, attemptNumber: 2 });
    const clash = recordExecutionAttemptOnce({ proposalId: P, attemptNumber: 2 });

    expect(second.attempt.attemptNumber).toBe(2);
    expect(clash.attempt.attemptNumber).toBe(3);
    const numbers = listExecutionAttemptsForProposal(P).map((a) => a.attemptNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("honours a free proposed number and ignores unusable ones", () => {
    expect(recordExecutionAttemptOnce({ proposalId: P, attemptNumber: 5 }).attempt.attemptNumber).toBe(5);
    expect(recordExecutionAttemptOnce({ proposalId: P, attemptNumber: 0 }).attempt.attemptNumber).toBe(6);
    expect(recordExecutionAttemptOnce({ proposalId: P, attemptNumber: 1.5 }).attempt.attemptNumber).toBe(7);
  });
});

// ── HTTP ────────────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/governance/execution-attempts", governanceExecutionAttemptsRouter);
  return app;
}

const BASE = "/api/governance/execution-attempts";

async function create(app: Express, body: Record<string, unknown> = {}) {
  const res = await request(app).post(BASE).send({ proposalId: P, txHash: "h1", status: "polling", ...body });
  expect(res.status).toBe(201);
  return res.body as { attemptId: string; version: number };
}

describe("HTTP: versions and If-Match", () => {
  it("returns the version in the body and as an ETag on create and read", async () => {
    const app = buildApp();
    const res = await request(app).post(BASE).send({ proposalId: P, txHash: "h1" });
    expect(res.body.version).toBe(1);
    expect(res.headers.etag).toBe('"1"');

    const got = await request(app).get(`${BASE}/${res.body.attemptId}`);
    expect(got.headers.etag).toBe('"1"');
    expect(got.body.version).toBe(1);
  });

  it("accepts the version as If-Match or as expectedVersion in the body", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);

    const viaHeader = await request(app)
      .post(BASE)
      .set("If-Match", '"1"')
      .send({ proposalId: P, txHash: "h1", phase: "polling" });
    // Without an operationId the route answers 201 for updates too (unchanged).
    expect(viaHeader.status).toBe(201);
    expect(viaHeader.headers.etag).toBe('"2"');
    expect(viaHeader.body.attemptId).toBe(attemptId);

    const viaBody = await request(app)
      .post(BASE)
      .send({ proposalId: P, txHash: "h1", phase: "recovering", expectedVersion: 2 });
    expect(viaBody.status).toBe(201);
    expect(viaBody.body.version).toBe(3);
  });

  it("answers 409 with the current state when the version is stale, and writes nothing", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);
    await request(app).post(BASE).send({ proposalId: P, txHash: "h1", phase: "polling" }); // v2

    const res = await request(app)
      .post(BASE)
      .set("If-Match", '"1"')
      .send({ proposalId: P, txHash: "h1", status: "failed", phase: "failure", error: "late" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("EXECUTION_ATTEMPT_VERSION_CONFLICT");
    expect(res.body.details.expectedVersion).toBe(1);
    expect(res.body.details.currentVersion).toBe(2);
    expect(res.body.details.attempt.attemptId).toBe(attemptId);
    expect(res.headers.etag).toBe('"2"');

    const stored = await request(app).get(`${BASE}/${attemptId}`);
    expect(stored.body.status).toBe("polling");
    expect(stored.body.version).toBe(2);
  });

  it("rejects a malformed version with 400 and writes nothing", async () => {
    const app = buildApp();
    const res = await request(app).post(BASE).set("If-Match", "banana").send({ proposalId: P, txHash: "h1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_EXPECTED_VERSION");
    expect(countExecutionAttempts()).toBe(0);
  });

  it("is 409 for an unknown attempt when a version is expected", async () => {
    const app = buildApp();
    const res = await request(app).post(`${BASE}/exec_missing/succeeded`).set("If-Match", '"2"').send({});
    expect(res.status).toBe(409);
    expect(res.body.details.currentVersion).toBe(0);
    expect(res.body.details.attempt).toBeNull();

    const plain = await request(app).post(`${BASE}/exec_missing/succeeded`).send({});
    expect(plain.status).toBe(404);
  });

  it("applies If-Match to the transition endpoints", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);

    const stale = await request(app).post(`${BASE}/${attemptId}/rolled-back`).set("If-Match", '"7"').send({});
    expect(stale.status).toBe(409);
    expect((await request(app).get(`${BASE}/${attemptId}`)).body.status).toBe("polling");

    const ok = await request(app).post(`${BASE}/${attemptId}/rolled-back`).set("If-Match", '"1"').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("rolled_back");
    expect(ok.headers.etag).toBe('"2"');
  });
});

describe("HTTP: concurrent requests", () => {
  it("of many writers holding the same version, exactly one commits", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(app)
          .post(BASE)
          .set("If-Match", '"1"')
          .send({ proposalId: P, txHash: "h1", error: `writer-${i}` }),
      ),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(11);
    const stored = (await request(app).get(`${BASE}/${attemptId}`)).body;
    expect(stored.version).toBe(2);
    expect(listExecutionAttemptsForProposal(P)).toHaveLength(1);
  });

  it("a success report and a failure report racing can never leave the attempt failed", async () => {
    const app = buildApp();
    for (let round = 0; round < 10; round += 1) {
      const { attemptId } = await create(app, { proposalId: `race-${round}`, txHash: `hash-${round}` });
      const [a, b] = await Promise.all([
        request(app).post(`${BASE}/${attemptId}/failed`).send({ error: "poll timeout", failedAtPhase: "polling" }),
        request(app).post(`${BASE}/${attemptId}/succeeded`).send({}),
      ]);
      expect([200, 409]).toContain(a.status);
      expect(b.status).toBe(200);
      const stored = (await request(app).get(`${BASE}/${attemptId}`)).body;
      expect(stored.status).toBe("succeeded");
    }
  });

  it("concurrent creates for one proposal get distinct attempt numbers", async () => {
    const app = buildApp();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post(BASE).send({ proposalId: P, attemptNumber: 2 })),
    );
    const numbers = responses.map((r) => r.body.attemptNumber);
    expect(new Set(numbers).size).toBe(8);
  });

  it("repeating a finished transition is a safe retry", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);

    const first = await request(app).post(`${BASE}/${attemptId}/succeeded`).send({});
    const retries = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`${BASE}/${attemptId}/succeeded`).send({})),
    );

    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    for (const r of retries) {
      expect(r.status).toBe(200);
      expect(r.headers["idempotent-replayed"]).toBe("true");
      expect(r.body.version).toBe(first.body.version);
    }
  });
});

describe("HTTP: failures preserve state", () => {
  it("a failure report for a succeeded attempt is 409 and the attempt is unchanged", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);
    const done = await request(app).post(`${BASE}/${attemptId}/succeeded`).send({});

    const res = await request(app)
      .post(`${BASE}/${attemptId}/failed`)
      .send({ error: "stale tab", failedAtPhase: "polling" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("EXECUTION_STATE_CONFLICT");
    expect(res.body.details.attempt.status).toBe("succeeded");

    const stored = (await request(app).get(`${BASE}/${attemptId}`)).body;
    expect(stored).toEqual(done.body);
    expect(stored.error).toBeUndefined();
  });

  it("rolling back a succeeded attempt is 409 and the attempt is unchanged", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);
    await request(app).post(`${BASE}/${attemptId}/succeeded`).send({});

    const res = await request(app).post(`${BASE}/${attemptId}/rolled-back`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("EXECUTION_STATE_CONFLICT");
    expect((await request(app).get(`${BASE}/${attemptId}`)).body.status).toBe("succeeded");
  });

  it("invalid input is rejected before anything is read or written", async () => {
    const app = buildApp();
    const { attemptId } = await create(app);
    const before = (await request(app).get(`${BASE}/${attemptId}`)).body;

    const noError = await request(app).post(`${BASE}/${attemptId}/failed`).send({});
    const badPhase = await request(app)
      .post(`${BASE}/${attemptId}/failed`)
      .send({ error: "x", failedAtPhase: "nope" });
    expect(noError.status).toBe(400);
    expect(badPhase.status).toBe(400);
    expect((await request(app).get(`${BASE}/${attemptId}`)).body).toEqual(before);
  });
});
