/**
 * Governance Execution Attempt Routes (#1899)
 *
 * Records and queries governance proposal execution attempts so a failed or
 * interrupted operation can be resumed or rolled back predictably instead of
 * being blindly re-submitted.
 *
 * The client reports execution outcomes (submitted hash, polling result,
 * failure, rollback) to these endpoints. The store preserves enough state for
 * the UI to decide whether to resume polling a saved hash, start a fresh
 * attempt, or discard a failed one — without ever re-submitting the same
 * transaction twice.
 */

import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import { IDEMPOTENT_REPLAYED_HEADER } from "../middleware/idempotency";
import {
  recordExecutionAttemptOnce,
  getExecutionAttempt,
  listExecutionAttemptsForProposal,
  transitionExecutionAttempt,
  ExecutionAttemptVersionConflictError,
  type ExecutionAttemptStatus,
  type ExecutionTransition,
  type GovernanceExecutionAttempt,
  type RecordExecutionAttemptInput,
} from "../services/governanceExecutionAttemptService";

const router = Router();

// ── Optimistic concurrency (#1895) ──────────────────────────────────────────

class InvalidExpectedVersionError extends Error {}

/**
 * The attempt version a write expects, from `If-Match` (`"3"`, `W/"3"` or `3`)
 * or else `expectedVersion` in the JSON body. `undefined` when neither is sent,
 * which keeps the unconditional write.
 */
export function readExpectedVersion(req: Request): number | undefined {
  const header = req.headers["if-match"];
  const raw =
    typeof header === "string" && header.trim() !== ""
      ? header.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1")
      : (req.body as { expectedVersion?: unknown } | undefined)?.expectedVersion;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  const value = typeof raw === "number" ? raw : Number(text);
  if (text === "" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidExpectedVersionError(
      "If-Match / expectedVersion must be a non-negative integer version.",
    );
  }
  return value;
}

/** Parses the expected version, answering 400 itself when it is malformed. */
function expectedVersionOr400(
  req: Request,
  res: Response,
): { ok: true; value: number | undefined } | { ok: false } {
  try {
    return { ok: true, value: readExpectedVersion(req) };
  } catch (err) {
    if (err instanceof InvalidExpectedVersionError) {
      sendError(res, 400, "INVALID_EXPECTED_VERSION", err.message);
      return { ok: false };
    }
    throw err;
  }
}

function setVersionHeader(res: Response, attempt: GovernanceExecutionAttempt | undefined): void {
  res.setHeader("ETag", `"${attempt?.version ?? 0}"`);
}

/** Sends the 409 for a lost race, or returns false for any other error. */
function sendVersionConflict(res: Response, err: unknown): boolean {
  // Matched by code so the check also holds across module mocks.
  if ((err as { code?: unknown } | null)?.code !== "EXECUTION_ATTEMPT_VERSION_CONFLICT") {
    return false;
  }
  const conflict = err as ExecutionAttemptVersionConflictError;
  setVersionHeader(res, conflict.currentAttempt);
  sendError(
    res,
    409,
    "EXECUTION_ATTEMPT_VERSION_CONFLICT",
    "The execution attempt changed since you read it. Nothing was written; reload the attempt and retry.",
    {
      expectedVersion: conflict.expectedVersion,
      currentVersion: conflict.currentVersion,
      attempt: conflict.currentAttempt ?? null,
    },
  );
  return true;
}

/**
 * Apply one lifecycle transition and answer for every outcome. A transition
 * that would overwrite a finished attempt is 409 and writes nothing; repeating
 * a finished transition returns the stored attempt with `Idempotent-Replayed`.
 */
function respondToTransition(
  req: Request,
  res: Response,
  attemptId: string,
  transition: ExecutionTransition,
): void {
  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;

  let result;
  try {
    result = transitionExecutionAttempt(attemptId, transition, {
      expectedVersion: expected.value,
    });
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
    throw err;
  }

  if (result.outcome === "not_found" || !result.attempt) {
    sendError(res, 404, "ATTEMPT_NOT_FOUND", "No execution attempt found for the given id.");
    return;
  }
  setVersionHeader(res, result.attempt);
  if (result.outcome === "state_conflict") {
    sendError(
      res,
      409,
      "EXECUTION_STATE_CONFLICT",
      `The attempt is already ${result.attempt.status}, so this report was ignored. The stored attempt was not changed.`,
      { attempt: result.attempt },
    );
    return;
  }
  if (result.outcome === "unchanged") res.set(IDEMPOTENT_REPLAYED_HEADER, "true");
  res.json(result.attempt);
}

function isTxPhase(value: unknown): value is "idle" | "building" | "simulating" | "waiting_for_wallet" | "submitting" | "polling" | "recovering" | "success" | "failure" {
  return typeof value === "string" && [
    "idle",
    "building",
    "simulating",
    "waiting_for_wallet",
    "submitting",
    "polling",
    "recovering",
    "success",
    "failure",
  ].includes(value);
}

function isExecutionAttemptStatus(value: unknown): value is ExecutionAttemptStatus {
  return typeof value === "string" && [
    "submitted",
    "polling",
    "succeeded",
    "failed",
    "rolled_back",
  ].includes(value);
}

/**
 * POST /api/governance/execution-attempts
 * Record or update a governance execution attempt.
 *
 * Body: { proposalId, operationId?, txHash?, status?, phase?, attemptNumber?, error?, failedAtPhase? }
 *
 * Reporting the same (proposalId, txHash) twice updates the existing attempt
 * rather than duplicating it, so client retries are safe.
 *
 * `operationId` is the identity of one logical operation, chosen by the client
 * and reused on every retry. A retry that carries it resolves to the attempt it
 * created (200) instead of creating another (201). Reusing it with a different
 * txHash is 409 OPERATION_ID_CONFLICT, and a stale retry never moves a finished
 * attempt to another status: the stored attempt is returned unchanged and the
 * response carries `Idempotent-Replayed: true`.
 *
 * Send the attempt `version` you last read as `If-Match: "<version>"` (or
 * `expectedVersion` in the body) to make an update conditional (#1895): if
 * another writer committed first the answer is 409
 * EXECUTION_ATTEMPT_VERSION_CONFLICT and nothing is written. `0` means "create
 * only". Without it the write is unconditional, as before.
 */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

router.post("/", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<RecordExecutionAttemptInput>;

  if (!body.proposalId || typeof body.proposalId !== "string") {
    sendError(res, 400, "MISSING_PROPOSAL_ID", "proposalId is required.");
    return;
  }

  if (body.txHash !== undefined && typeof body.txHash !== "string") {
    sendError(res, 400, "INVALID_TX_HASH", "txHash must be a string.");
    return;
  }
  if (body.status !== undefined && !isExecutionAttemptStatus(body.status)) {
    sendError(res, 400, "INVALID_STATUS", "status must be submitted, polling, succeeded, failed, or rolled_back.");
    return;
  }
  if (body.phase !== undefined && !isTxPhase(body.phase)) {
    sendError(res, 400, "INVALID_PHASE", "phase must be a valid transaction phase.");
    return;
  }
  if (body.attemptNumber !== undefined && (typeof body.attemptNumber !== "number" || !Number.isFinite(body.attemptNumber))) {
    sendError(res, 400, "INVALID_ATTEMPT_NUMBER", "attemptNumber must be a number.");
    return;
  }

  if (
    body.operationId !== undefined &&
    (typeof body.operationId !== "string" || !OPERATION_ID_PATTERN.test(body.operationId))
  ) {
    sendError(
      res,
      400,
      "INVALID_OPERATION_ID",
      "operationId must be 1-128 characters of A-Z, a-z, 0-9, '.', '_', ':' or '-'.",
    );
    return;
  }

  const expected = expectedVersionOr400(req, res);
  if (!expected.ok) return;

  const input: RecordExecutionAttemptInput = {
    expectedVersion: expected.value,
    proposalId: body.proposalId,
    operationId: body.operationId,
    txHash: body.txHash,
    status: body.status,
    phase: body.phase,
    attemptNumber: body.attemptNumber,
    error: body.error,
    failedAtPhase: body.failedAtPhase,
  };

  let result;
  try {
    result = recordExecutionAttemptOnce(input);
  } catch (err) {
    if (sendVersionConflict(res, err)) return;
    throw err;
  }
  const { outcome, attempt } = result;
  setVersionHeader(res, attempt);
  if (outcome === "conflict") {
    sendError(
      res,
      409,
      "OPERATION_ID_CONFLICT",
      "This operationId already belongs to an attempt with a different txHash. The stored attempt was not changed.",
      { attemptId: attempt.attemptId },
    );
    return;
  }
  if (outcome === "replayed") {
    res.set(IDEMPOTENT_REPLAYED_HEADER, "true");
    res.status(200).json(attempt);
    return;
  }
  res.status(outcome === "created" || !input.operationId ? 201 : 200).json(attempt);
});

/**
 * GET /api/governance/execution-attempts/:attemptId
 * Retrieve a single execution attempt by id.
 */
router.get("/:attemptId", (req: Request, res: Response) => {
  const { attemptId } = req.params;
  const attempt = getExecutionAttempt(attemptId);

  if (!attempt) {
    sendError(res, 404, "ATTEMPT_NOT_FOUND", "No execution attempt found for the given id.");
    return;
  }

  setVersionHeader(res, attempt);
  res.json(attempt);
});

/**
 * GET /api/governance/execution-attempts
 * List execution attempts for a proposal. Query param: proposalId (required).
 * Results are newest first.
 */
router.get("/", (req: Request, res: Response) => {
  const { proposalId } = req.query as { proposalId?: string };

  if (!proposalId || typeof proposalId !== "string") {
    sendError(res, 400, "MISSING_PROPOSAL_ID", "proposalId query parameter is required.");
    return;
  }

  const attempts = listExecutionAttemptsForProposal(proposalId);
  res.json({ proposalId, attempts, count: attempts.length });
});

/**
 * POST /api/governance/execution-attempts/:attemptId/succeeded
 * Mark an in-flight attempt as succeeded. Repeating it, or sending it for an
 * attempt that is already final, returns the stored attempt unchanged.
 */
router.post("/:attemptId/succeeded", (req: Request, res: Response) => {
  const { txHash } = (req.body ?? {}) as { txHash?: string };
  respondToTransition(req, res, req.params.attemptId, { kind: "succeeded", txHash });
});

/**
 * POST /api/governance/execution-attempts/:attemptId/failed
 * Mark an in-flight attempt as failed. A succeeded or rolled-back attempt is
 * final: the report is 409 EXECUTION_STATE_CONFLICT and nothing is written.
 *
 * Body: { error, failedAtPhase }
 */
router.post("/:attemptId/failed", (req: Request, res: Response) => {
  const { error, failedAtPhase } = (req.body ?? {}) as {
    error?: string;
    failedAtPhase?: string;
  };

  if (!error || typeof error !== "string") {
    sendError(res, 400, "MISSING_ERROR", "error is required.");
    return;
  }
  if (failedAtPhase !== undefined && !isTxPhase(failedAtPhase)) {
    sendError(res, 400, "INVALID_PHASE", "failedAtPhase must be a valid transaction phase.");
    return;
  }

  respondToTransition(req, res, req.params.attemptId, {
    kind: "failed",
    error,
    failedAtPhase: failedAtPhase ?? "submitting",
  });
});

/**
 * POST /api/governance/execution-attempts/:attemptId/rolled-back
 * Mark an in-flight attempt as rolled back (discarded without re-submission).
 * A succeeded attempt cannot be rolled back (409 EXECUTION_STATE_CONFLICT).
 */
router.post("/:attemptId/rolled-back", (req: Request, res: Response) => {
  respondToTransition(req, res, req.params.attemptId, { kind: "rolled_back" });
});

export default router;
