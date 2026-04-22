/**
 * Canonical phases for Soroban transaction UX (timeline + status callbacks).
 */
export type TxPhase =
  | "idle"
  | "building"
  | "simulating"
  | "waiting_for_wallet"
  | "submitting"
  | "polling"
  | "success"
  | "failure";

/** Ordered pipeline steps shown on the full timeline (non-terminal). */
export const TX_PHASE_PIPELINE: readonly Exclude<
  TxPhase,
  "idle" | "success" | "failure"
>[] = [
  "building",
  "simulating",
  "waiting_for_wallet",
  "submitting",
  "polling",
];

/** Governance “execute”: submit already-built multisig XDR, then poll. */
export const TX_PHASE_SUBMIT_POLL: readonly TxPhase[] = ["submitting", "polling"];

/** Wallet signature only (e.g. governance co-sign). */
export const TX_PHASE_WALLET_ONLY: readonly TxPhase[] = ["waiting_for_wallet"];

const TERMINAL: TxPhase[] = ["success", "failure"];

export function isTerminalPhase(phase: TxPhase): boolean {
  return TERMINAL.includes(phase);
}

/** Index of `phase` within `steps`, or -1 if idle / unknown. Success => past end. */
export function stepIndexIn(
  steps: readonly TxPhase[],
  phase: TxPhase,
): number {
  if (phase === "idle") return -1;
  if (phase === "success") return steps.length;
  if (phase === "failure") return -1;
  return steps.indexOf(phase);
}

/** Whether step at `stepIdx` is logically complete before `phase`. */
export function isStepCompleted(
  steps: readonly TxPhase[],
  phase: TxPhase,
  stepIdx: number,
): boolean {
  if (phase === "success") return stepIdx < steps.length;
  const active = stepIndexIn(steps, phase);
  if (active < 0) return false;
  return stepIdx < active;
}

/** Whether step at `stepIdx` matches the current non-terminal phase. */
export function isStepActive(
  steps: readonly TxPhase[],
  phase: TxPhase,
  stepIdx: number,
): boolean {
  if (phase === "idle" || phase === "success" || phase === "failure") return false;
  return steps[stepIdx] === phase;
}

export const TX_PHASE_LABELS: Record<TxPhase, string> = {
  idle: "Idle",
  building: "Building transaction",
  simulating: "Simulating",
  waiting_for_wallet: "Waiting for wallet",
  submitting: "Submitting",
  polling: "Confirming on network",
  success: "Success",
  failure: "Failed",
};
