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
 * Concurrency (#1895): every attempt carries a `version` that starts at 1 and
 * goes up by one with each committed change. A writer may pass the version it
 * read (`expectedVersion`); if another writer committed first the call throws
 * {@link ExecutionAttemptVersionConflictError} and nothing is written. Finished
 * attempts (succeeded, rolled back) are final, and a stale report can never
 * move one. Each read-check-write below runs in one synchronous step, so no
 * other request can interleave between the check and the write.
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
  /** Starts at 1; increases by one with every committed change (#1895). */
  version: number;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
}

/**
 * Thrown, with nothing written, when a write names a version that is no longer
 * current: another request changed the attempt first. `currentAttempt` is
 * undefined when the writer expected an attempt that does not exist.
 */
export class ExecutionAttemptVersionConflictError extends Error {
  readonly code = "EXECUTION_ATTEMPT_VERSION_CONFLICT";
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly currentAttempt: GovernanceExecutionAttempt | undefined,
  ) {
    super(
      `Execution attempt changed since version ${expectedVersion}; current version is ${currentVersion}. Reload and retry.`,
    );
    this.name = "ExecutionAttemptVersionConflictError";
  }
}

function assertExpectedVersion(
  known: GovernanceExecutionAttempt | undefined,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion === undefined) return;
  const current = known?.version ?? 0;
  if (current !== expectedVersion) {
    throw new ExecutionAttemptVersionConflictError(expectedVersion, current, known);
  }
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
    version: existing.version + 1,
    updatedAt: now,
    ...(status !== undefined && TERMINAL_STATUSES.has(status) ? { completedAt: now } : {}),
  };
  attemptStore.set(updated.attemptId, updated);
  return updated;
}

/**
 * A report that would move a finished attempt to another status is stale: the
 * attempt already reached its outcome, so the report must not change it.
 */
function isStaleReport(
  known: GovernanceExecutionAttempt,
  status: ExecutionAttemptStatus | undefined,
): boolean {
  return TERMINAL_STATUSES.has(known.status) && status !== undefined && status !== known.status;
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
  const {
    proposalId,
    txHash,
    status,
    phase,
    attemptNumber,
    error,
    failedAtPhase,
    operationId,
    expectedVersion,
  } = input;
  const now = nowIso();

  if (operationId !== undefined) {
    const knownId = byOperation.get(operationKey(proposalId, operationId));
    const known = knownId !== undefined ? attemptStore.get(knownId) : undefined;
    if (known) {
      if (txHash !== undefined && known.txHash !== undefined && known.txHash !== txHash) {
        return { outcome: "conflict", attempt: known };
      }
      if (isStaleReport(known, status)) {
        return { outcome: "replayed", attempt: known };
      }
      // "Create only" (version 0) for an operation that already created its
      // attempt is a retry of that creation, not a conflict.
      if (expectedVersion === 0) {
        return { outcome: "replayed", attempt: known };
      }
      assertExpectedVersion(known, expectedVersion);
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
    if (isStaleReport(existingByHash, status)) {
      return { outcome: "replayed", attempt: existingByHash };
    }
    assertExpectedVersion(existingByHash, expectedVersion);
    const updated = applyUpdate(existingByHash, { status, phase, error, failedAtPhase });
    if (operationId !== undefined && updated.operationId === undefined) {
      // Same commit as `updated`: the version was already bumped once.
      const withOperation = { ...updated, operationId };
      attemptStore.set(withOperation.attemptId, withOperation);
      byOperation.set(operationKey(proposalId, operationId), withOperation.attemptId);
      return { outcome: "updated", attempt: withOperation };
    }
    return { outcome: "updated", attempt: updated };
  }

  // Nothing matched, so this call creates. A writer that expected an existing
  // attempt at some version is looking at state that is gone.
  assertExpectedVersion(undefined, expectedVersion);

  const attemptId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const number = pickAttemptNumber(proposalId, attemptNumber);
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
    version: 1,
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

export type ExecutionTransition =
  | { kind: "succeeded"; txHash?: string }
  | { kind: "failed"; error: string; failedAtPhase: TxPhase }
  | { kind: "rolled_back" };

export type TransitionOutcome = "updated" | "unchanged" | "state_conflict" | "not_found";

export interface TransitionResult {
  outcome: TransitionOutcome;
  attempt?: GovernanceExecutionAttempt;
}

/**
 * Apply a lifecycle transition to an attempt and say what happened.
 *
 * - `succeeded` and `rolled_back` attempts are final. Repeating the same
 *   transition, or `succeeded` on a rolled-back attempt, changes nothing
 *   (`unchanged`); a `failed` report or a rollback on a succeeded attempt, or
 *   a `failed` report on a rolled-back one, is a `state_conflict` and nothing
 *   is written.
 * - A `failed` attempt may still be confirmed (`succeeded`) or discarded
 *   (`rolled_back`).
 * - `expectedVersion`, when given, must match the stored version or
 *   {@link ExecutionAttemptVersionConflictError} is thrown with nothing written.
 */
export function transitionExecutionAttempt(
  attemptId: string,
  transition: ExecutionTransition,
  options: { expectedVersion?: number } = {},
): TransitionResult {
  const attempt = attemptStore.get(attemptId);
  if (!attempt) {
    if (options.expectedVersion !== undefined) assertExpectedVersion(undefined, options.expectedVersion);
    return { outcome: "not_found" };
  }

  // Decided before the version check so a retry of a finished transition is
  // answered with the stored result rather than a version conflict.
  if (transition.kind === "succeeded") {
    if (attempt.status === "succeeded" || attempt.status === "rolled_back") {
      return { outcome: "unchanged", attempt };
    }
  } else if (transition.kind === "rolled_back") {
    if (attempt.status === "rolled_back") return { outcome: "unchanged", attempt };
    if (attempt.status === "succeeded") return { outcome: "state_conflict", attempt };
  } else if (attempt.status === "succeeded" || attempt.status === "rolled_back") {
    return { outcome: "state_conflict", attempt };
  }

  assertExpectedVersion(attempt, options.expectedVersion);

  if (transition.kind === "succeeded") {
    return {
      outcome: "updated",
      attempt: applyUpdate(attempt, { txHash: transition.txHash, status: "succeeded", phase: "success" }),
    };
  }
  if (transition.kind === "failed") {
    return {
      outcome: "updated",
      attempt: applyUpdate(attempt, {
        status: "failed",
        phase: "failure",
        error: transition.error,
        failedAtPhase: transition.failedAtPhase,
      }),
    };
  }
  return {
    outcome: "updated",
    attempt: applyUpdate(attempt, { status: "rolled_back", phase: attempt.phase }),
  };
}

/** Mark an in-flight attempt as succeeded. No-op if already terminal. */
export function markExecutionSucceeded(
  attemptId: string,
  txHash?: string,
): GovernanceExecutionAttempt | undefined {
  return transitionExecutionAttempt(attemptId, { kind: "succeeded", txHash }).attempt;
}

/** Mark an in-flight attempt as failed. A succeeded or rolled-back attempt is left unchanged. */
export function markExecutionFailed(
  attemptId: string,
  error: string,
  failedAtPhase: TxPhase,
): GovernanceExecutionAttempt | undefined {
  return transitionExecutionAttempt(attemptId, { kind: "failed", error, failedAtPhase }).attempt;
}

/** Mark an in-flight attempt as rolled back (discarded without re-submission). */
export function markExecutionRolledBack(
  attemptId: string,
): GovernanceExecutionAttempt | undefined {
  return transitionExecutionAttempt(attemptId, { kind: "rolled_back" }).attempt;
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
  /**
   * Version of the attempt this write was based on (#1895). `0` means "create
   * only". Omit for an unconditional write.
   */
  expectedVersion?: number;
}

// ── In-memory store (replace with DB persistence in production) ─────────────

const attemptStore = new Map<string, GovernanceExecutionAttempt>();
const byProposal = new Map<string, string[]>(); // proposalId -> attemptId[]
const byOperation = new Map<string, string>(); // [proposalId, operationId] -> attemptId

function nowIso(): string {
  return new Date().toISOString();
}

function attemptNumbersFor(proposalId: string): number[] {
  return (byProposal.get(proposalId) ?? [])
    .map((id) => attemptStore.get(id)?.attemptNumber)
    .filter((n): n is number => typeof n === "number");
}

/**
 * The number for a new attempt. A number the client proposes is used only if
 * no attempt of this proposal has it yet, so two tabs that both start "attempt
 * 2" cannot end up with the same number; otherwise the next free one is used.
 */
function pickAttemptNumber(proposalId: string, proposed: number | undefined): number {
  const taken = attemptNumbersFor(proposalId);
  if (
    proposed !== undefined &&
    Number.isSafeInteger(proposed) &&
    proposed >= 1 &&
    !taken.includes(proposed)
  ) {
    return proposed;
  }
  return Math.max(0, ...taken) + 1;
}
