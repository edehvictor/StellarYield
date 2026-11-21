import type { TxPhase } from "../../services/transactionPhase";

/**
 * Durable execution checkpoint for a governance proposal (#1899).
 *
 * The XDR and collected signer approvals live on the proposal. This state only
 * records how far the single execution attempt got, so a reload can resume
 * polling a submitted hash instead of submitting the same admin action twice.
 */
export type GovernanceExecutionStatus =
  | "submitting"
  | "polling"
  | "succeeded"
  | "failed";

export interface GovernanceExecutionState {
  status: GovernanceExecutionStatus;
  phase: TxPhase;
  attempt: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  txHash?: string;
  error?: string;
  failedAtPhase?: TxPhase;
}

export type GovernanceExecutionAction = "submit" | "poll";

export class GovernanceExecutionError extends Error {
  readonly code:
    | "PROPOSAL_NOT_READY"
    | "RESUME_REQUIRED"
    | "ATTEMPT_MISSING"
    | "INVALID_INPUT";
  readonly field?: string;

  constructor(
    code: GovernanceExecutionError["code"],
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "GovernanceExecutionError";
    this.code = code;
    this.field = field;
  }
}

export function startExecutionAttempt(
  previous: GovernanceExecutionState | undefined,
  now = Date.now(),
): GovernanceExecutionState {
  const txHash = previous?.txHash;
  return {
    status: txHash ? "polling" : "submitting",
    phase: txHash ? "polling" : "submitting",
    attempt: (previous?.attempt ?? 0) + 1,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    txHash,
  };
}

export function markExecutionSubmitted(
  state: GovernanceExecutionState,
  txHash: string,
  now = Date.now(),
): GovernanceExecutionState {
  return {
    ...state,
    status: "polling",
    phase: "polling",
    txHash,
    updatedAt: now,
    error: undefined,
    failedAtPhase: undefined,
  };
}

export function failExecutionAttempt(
  state: GovernanceExecutionState,
  error: string,
  failedAtPhase: TxPhase,
  now = Date.now(),
): GovernanceExecutionState {
  return {
    ...state,
    status: "failed",
    phase: "failure",
    updatedAt: now,
    error,
    failedAtPhase,
  };
}

export function completeExecutionAttempt(
  state: GovernanceExecutionState | undefined,
  txHash?: string,
  now = Date.now(),
): GovernanceExecutionState {
  return {
    status: "succeeded",
    phase: "success",
    attempt: state?.attempt ?? 1,
    startedAt: state?.startedAt ?? now,
    updatedAt: now,
    completedAt: now,
    txHash: txHash ?? state?.txHash,
  };
}

export function executionActionFor(
  state: GovernanceExecutionState | undefined,
): GovernanceExecutionAction {
  return state?.txHash ? "poll" : "submit";
}

export function canRollbackExecution(
  state: GovernanceExecutionState | undefined,
): boolean {
  return Boolean(state && state.status !== "succeeded" && !state.txHash);
}

export function isExecutionInterrupted(
  state: GovernanceExecutionState | undefined,
): boolean {
  if (!state) return false;
  return (
    state.status === "submitting" ||
    state.status === "polling" ||
    (state.status === "failed" && Boolean(state.txHash))
  );
}

export function executionPhaseFor(
  state: GovernanceExecutionState | undefined,
): TxPhase {
  if (!state) return "idle";
  if (state.status === "succeeded") return "success";
  if (state.status === "failed") return "failure";
  return state.status;
}
