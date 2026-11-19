/**
 * Governance Execution Attempt Service (#1899)
 *
 * Durable record of governance proposal execution attempts so a failed or
 * interrupted operation can be resumed or rolled back predictably instead of
 * being blindly re-submitted.
 *
 * The client owns the actual signing/submission to the Soroban network and
 * reports the outcome here. This service persists just enough state
 * (proposal, transaction hash, phase, status, error) for the UI to decide
 * whether to resume polling a saved hash, start a fresh attempt, or discard
 * a failed one. Existing proposal state and balances are never mutated by
 * this service — it only observes execution lifecycle events.
 *
 * Security: only public proposal references and transaction hashes are stored;
 * no signatures or private material.
 */

import type { TxPhase } from "../../services/transactionPhase";

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecutionAttemptStatus =
  | "submitted"
  | "polling"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface GovernanceExecutionAttempt {
  /** Server-generated attempt id. */
  attemptId: string;
  /** Proposal the attempt belongs to. */
  proposalId: string;
  /** On-chain transaction hash once the attempt reached the network. */
  txHash?: string;
  status: ExecutionAttemptStatus;
  /** Last observed transaction phase. */
  phase: TxPhase;
  /** 1-based attempt number for this proposal (increments on every new attempt). */
  attemptNumber: number;
  /** Human-readable failure reason when status is "failed". */
  error?: string;
  /** Phase the attempt failed at, when applicable. */
  failedAtPhase?: TxPhase;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record (or update) an execution attempt.
 *
 * When `txHash` is provided and an attempt for the same (proposalId, txHash)
 * already exists, that attempt is updated in place — a client retry reporting
 * the same in-flight hash does not create a duplicate record. Otherwise a new
 * attempt is created with an incremented attempt number.
 */
export function recordExecutionAttempt(
  input: RecordExecutionAttemptInput,
): GovernanceExecutionAttempt {
  const { proposalId, txHash, status, phase, attemptNumber, error, failedAtPhase } = input;
  const now = nowIso();

  const existingByHash =
    txHash !== undefined
      ? [...attemptStore.values()].find(
          (a) => a.proposalId === proposalId && a.txHash === txHash,
        )
      : undefined;

  if (existingByHash) {
    const updated: GovernanceExecutionAttempt = {
      ...existingByHash,
      ...(status !== undefined ? { status } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(failedAtPhase !== undefined ? { failedAtPhase } : {}),
      updatedAt: now,
      ...(status === "succeeded" || status === "failed" || status === "rolled_back"
        ? { completedAt: now }
        : {}),
    };
    attemptStore.set(updated.attemptId, updated);
    return updated;
  }

  const attemptId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const number = attemptNumber ?? nextAttemptNumber(proposalId);
  const attempt: GovernanceExecutionAttempt = {
    attemptId,
    proposalId,
    txHash,
    status: status ?? (txHash ? "polling" : "submitted"),
    phase: phase ?? "submitting",
    attemptNumber: number,
    error,
    failedAtPhase,
    createdAt: now,
    updatedAt: now,
    ...(status === "succeeded" || status === "failed" || status === "rolled_back"
      ? { completedAt: now }
      : {}),
  };
  attemptStore.set(attemptId, attempt);
  const ids = byProposal.get(proposalId) ?? [];
  ids.push(attemptId);
  byProposal.set(proposalId, ids);
  return attempt;
}

/** Retrieve a single execution attempt by id. */
export function getExecutionAttempt(attemptId: string): GovernanceExecutionAttempt | undefined {
  return attemptStore.get(attemptId);
}

/** List all execution attempts for a proposal, newest first. */
export function listExecutionAttemptsForProposal(
  proposalId: string,
): GovernanceExecutionAttempt[] {
  const ids = byProposal.get(proposalId) ?? [];
  return ids
    .map((id) => attemptStore.get(id))
    .filter((a): a is GovernanceExecutionAttempt => !!a)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

/** Mark an in-flight attempt as succeeded. No-op if already terminal. */
export function markExecutionSucceeded(
  attemptId: string,
  txHash?: string,
): GovernanceExecutionAttempt | undefined {
  const attempt = attemptStore.get(attemptId);
  if (!attempt) return undefined;
  if (attempt.status === "succeeded" || attempt.status === "rolled_back") return attempt;
  return recordExecutionAttempt({
    proposalId: attempt.proposalId,
    txHash: txHash ?? attempt.txHash,
    status: "succeeded",
    phase: "success",
    attemptNumber: attempt.attemptNumber,
  });
}

/** Mark an in-flight attempt as failed. */
export function markExecutionFailed(
  attemptId: string,
  error: string,
  failedAtPhase: TxPhase,
): GovernanceExecutionAttempt | undefined {
  const attempt = attemptStore.get(attemptId);
  if (!attempt) return undefined;
  return recordExecutionAttempt({
    proposalId: attempt.proposalId,
    txHash: attempt.txHash,
    status: "failed",
    phase: "failure",
    attemptNumber: attempt.attemptNumber,
    error,
    failedAtPhase,
  });
}

/** Mark an in-flight attempt as rolled back (discarded without re-submission). */
export function markExecutionRolledBack(
  attemptId: string,
): GovernanceExecutionAttempt | undefined {
  const attempt = attemptStore.get(attemptId);
  if (!attempt) return undefined;
  if (attempt.status === "succeeded") return attempt;
  return recordExecutionAttempt({
    proposalId: attempt.proposalId,
    txHash: attempt.txHash,
    status: "rolled_back",
    phase: attempt.phase,
    attemptNumber: attempt.attemptNumber,
  });
}

/** Clear all attempts — for testing only. */
export function clearExecutionAttemptStore(): void {
  attemptStore.clear();
  byProposal.clear();
}

/** Total number of stored attempts (testing/helper). */
export function countExecutionAttempts(): number {
  return attemptStore.size;
}

export interface RecordExecutionAttemptInput {
  proposalId: string;
  txHash?: string;
  status?: ExecutionAttemptStatus;
  phase?: TxPhase;
  attemptNumber?: number;
  error?: string;
  failedAtPhase?: TxPhase;
}

// ── In-memory store (replace with DB persistence in production) ─────────────

const attemptStore = new Map<string, GovernanceExecutionAttempt>();
const byProposal = new Map<string, string[]>(); // proposalId -> attemptId[]

function nowIso(): string {
  return new Date().toISOString();
}

function nextAttemptNumber(proposalId: string): number {
  const ids = byProposal.get(proposalId) ?? [];
  return ids.length + 1;
}
