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
  markExecutionSucceeded,
  markExecutionFailed,
  markExecutionRolledBack,
  type ExecutionAttemptStatus,
  type GovernanceExecutionAttempt,
  type RecordExecutionAttemptInput,
} from "../services/governanceExecutionAttemptService";

const router = Router();

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

  const input: RecordExecutionAttemptInput = {
    proposalId: body.proposalId,
    operationId: body.operationId,
    txHash: body.txHash,
    status: body.status,
    phase: body.phase,
    attemptNumber: body.attemptNumber,
    error: body.error,
    failedAtPhase: body.failedAtPhase,
  };

  const { outcome, attempt } = recordExecutionAttemptOnce(input);
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
 * Mark an in-flight attempt as succeeded.
 */
router.post("/:attemptId/succeeded", (req: Request, res: Response) => {
  const { attemptId } = req.params;
  const { txHash } = req.body as { txHash?: string };

  const attempt = markExecutionSucceeded(attemptId, txHash);
  if (!attempt) {
    sendError(res, 404, "ATTEMPT_NOT_FOUND", "No execution attempt found for the given id.");
    return;
  }

  res.json(attempt);
});

/**
 * POST /api/governance/execution-attempts/:attemptId/failed
 * Mark an in-flight attempt as failed.
 *
 * Body: { error, failedAtPhase }
 */
router.post("/:attemptId/failed", (req: Request, res: Response) => {
  const { attemptId } = req.params;
  const { error, failedAtPhase } = req.body as {
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

  const attempt = markExecutionFailed(attemptId, error, failedAtPhase ?? "submitting");
  if (!attempt) {
    sendError(res, 404, "ATTEMPT_NOT_FOUND", "No execution attempt found for the given id.");
    return;
  }

  res.json(attempt);
});

/**
 * POST /api/governance/execution-attempts/:attemptId/rolled-back
 * Mark an in-flight attempt as rolled back (discarded without re-submission).
 */
router.post("/:attemptId/rolled-back", (req: Request, res: Response) => {
  const { attemptId } = req.params;

  const attempt = markExecutionRolledBack(attemptId);
  if (!attempt) {
    sendError(res, 404, "ATTEMPT_NOT_FOUND", "No execution attempt found for the given id.");
    return;
  }

  res.json(attempt);
});

export default router;
