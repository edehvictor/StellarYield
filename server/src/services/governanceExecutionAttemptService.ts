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
  /**
   * Client-chosen identity of the operation this attempt belongs to. Reporting
   * the same (proposalId, operationId) again resolves to this attempt instead
   * of creating another one, so a retried request cannot apply twice.
   */
  operationId?: string;
  /** Human-readable failure reason when status is "failed". */
  error?: string;
  /** Phase the attempt failed at, when applicable. */
  failedAtPhase?: TxPhase;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
}

// ── Public API ──────────────────────────────────────────────────────────────

export type RecordAttemptOutcome = "created" | "updated" | "replayed" | "conflict";

export interface RecordAttemptResult {
  outcome: RecordAttemptOutcome;
  attempt: GovernanceExecutionAttempt;
}

const TERMINAL_STATUSES: ReadonlySet<ExecutionAttemptStatus> = new Set([
  "succeeded",
  "failed",
  "rolled_back",
]);

function operationKey(proposalId: string, operationId: string): string {
  return JSON.stringify([proposalId, operationId]);
}

function applyUpdate(
  existing: GovernanceExecutionAttempt,
  patch: Omit<RecordExecutionAttemptInput, "proposalId" | "attemptNumber" | "operationId">,
): GovernanceExecutionAttempt {
  const { txHash, status, phase, error, failedAtPhase } = patch;
  const now = nowIso();
  const updated: GovernanceExecutionAttempt = {
    ...existing,
    ...(txHash !== undefined ? { txHash } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(failedAtPhase !== undefined ? { failedAtPhase } : {}),
    updatedAt: now,
    ...(status !== undefined && TERMINAL_STATUSES.has(status) ? { completedAt: now } : {}),
  };
  attemptStore.set(updated.attemptId, updated);
  return updated;
}

/**
 * Record (or update) an execution attempt and say what happened.
 *
 * Resolution order:
 * 1. `operationId` given and already known for this proposal: the request is a
 *    retry of that operation. A different txHash than the one already stored is
 *    a `conflict` and nothing is written. A request that would move a finished
 *    attempt (succeeded, failed, rolled back) to another status is a stale
 *    retry and is `replayed` without changing the attempt. Anything else
 *    updates that attempt in place (`updated`).
 * 2. `txHash` given and already known for this proposal: the attempt is
 *    updated in place (`updated`), as before.
 * 3. Otherwise a new attempt is created with the next attempt number
 *    (`created`).
 */
export function recordExecutionAttemptOnce(
  input: RecordExecutionAttemptInput,
): RecordAttemptResult {
  const { proposalId, txHash, status, phase, attemptNumber, error, failedAtPhase, operationId } = input;
  const now = nowIso();

  if (operationId !== undefined) {
    const knownId = byOperation.get(operationKey(proposalId, operationId));
    const known = knownId !== undefined ? attemptStore.get(knownId) : undefined;
    if (known) {
      if (txHash !== undefined && known.txHash !== undefined && known.txHash !== txHash) {
        return { outcome: "conflict", attempt: known };
      }
      if (TERMINAL_STATUSES.has(known.status) && status !== undefined && status !== known.status) {
        return { outcome: "replayed", attempt: known };
      }
      return {
        outcome: "updated",
        attempt: applyUpdate(known, { txHash, status, phase, error, failedAtPhase }),
      };
    }
  }

  const existingByHash =
    txHash !== undefined
      ? [...attemptStore.values()].find(
          (a) => a.proposalId === proposalId && a.txHash === txHash,
        )
      : undefined;

  if (existingByHash) {
    const updated = applyUpdate(existingByHash, { status, phase, error, failedAtPhase });
    if (operationId !== undefined && updated.operationId === undefined) {
      const withOperation = { ...updated, operationId };
      attemptStore.set(withOperation.attemptId, withOperation);
      byOperation.set(operationKey(proposalId, operationId), withOperation.attemptId);
      return { outcome: "updated", attempt: withOperation };
    }
    return { outcome: "updated", attempt: updated };
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
    ...(operationId !== undefined ? { operationId } : {}),
    createdAt: now,
    updatedAt: now,
    ...(status !== undefined && TERMINAL_STATUSES.has(status) ? { completedAt: now } : {}),
  };
  attemptStore.set(attemptId, attempt);
  const ids = byProposal.get(proposalId) ?? [];
  ids.push(attemptId);
  byProposal.set(proposalId, ids);
  if (operationId !== undefined) {
    byOperation.set(operationKey(proposalId, operationId), attemptId);
  }
  return { outcome: "created", attempt };
}

/** Record (or update) an execution attempt. See {@link recordExecutionAttemptOnce}. */
export function recordExecutionAttempt(
  input: RecordExecutionAttemptInput,
): GovernanceExecutionAttempt {
  return recordExecutionAttemptOnce(input).attempt;
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
  return applyUpdate(attempt, { txHash, status: "succeeded", phase: "success" });
}

/** Mark an in-flight attempt as failed. */
export function markExecutionFailed(
  attemptId: string,
  error: string,
  failedAtPhase: TxPhase,
): GovernanceExecutionAttempt | undefined {
  const attempt = attemptStore.get(attemptId);
  if (!attempt) return undefined;
  return applyUpdate(attempt, { status: "failed", phase: "failure", error, failedAtPhase });
}

/** Mark an in-flight attempt as rolled back (discarded without re-submission). */
export function markExecutionRolledBack(
  attemptId: string,
): GovernanceExecutionAttempt | undefined {
  const attempt = attemptStore.get(attemptId);
  if (!attempt) return undefined;
  if (attempt.status === "succeeded") return attempt;
  return applyUpdate(attempt, { status: "rolled_back", phase: attempt.phase });
}

/** Clear all attempts — for testing only. */
export function clearExecutionAttemptStore(): void {
  attemptStore.clear();
  byProposal.clear();
  byOperation.clear();
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
  /** Optional operation identity; see {@link GovernanceExecutionAttempt.operationId}. */
  operationId?: string;
}

// ── In-memory store (replace with DB persistence in production) ─────────────

const attemptStore = new Map<string, GovernanceExecutionAttempt>();
const byProposal = new Map<string, string[]>(); // proposalId -> attemptId[]
const byOperation = new Map<string, string>(); // [proposalId, operationId] -> attemptId

function nowIso(): string {
  return new Date().toISOString();
}

function nextAttemptNumber(proposalId: string): number {
  const ids = byProposal.get(proposalId) ?? [];
  return ids.length + 1;
}
