/**
 * Transaction Simulation Diff (#1290)
 *
 * Before a Soroban transaction is signed, surface a typed before/after diff of
 * the fields it will change. The diff is computed from two snapshots: a
 * baseline captured before simulation and the simulated post-transaction
 * state. Callers use the diff to drive a "verify before you sign" panel instead
 * of trusting the raw simulated XDR.
 *
 * All input handling is deterministic and typed:
 * - `{ status: "loading" }`  — baseline or simulation still pending
 * - `{ status: "empty" }`    — no baseline and/or no simulated state available
 * - `{ status: "ready" }`    — changes computed; use `changes`
 */

export interface TxSnapshot {
  [field: string]: string | number | null | undefined;
}

export interface TxDiffChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
  /** Directional hint for rendering ("increase" / "decrease" for numbers). */
  kind: "increase" | "decrease" | "new" | "removed" | "changed";
}

export type TransactionSimulationDiff =
  | { status: "loading" }
  | { status: "empty"; reason: "no_baseline" | "no_simulation" | "no_fields" }
  | { status: "ready"; changes: TxDiffChange[] };

/** Compare two snapshots and produce typed field changes. */
export function computeSnapshotDiff(
  before: TxSnapshot | null,
  after: TxSnapshot | null,
): TransactionSimulationDiff {
  if (before === null || before === undefined) {
    return { status: "empty", reason: "no_baseline" };
  }
  if (after === null || after === undefined) {
    return { status: "empty", reason: "no_simulation" };
  }

  const changes: TxDiffChange[] = [];
  const allFields = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const field of allFields) {
    const beforeValue = normalize(before[field]);
    const afterValue = normalize(after[field]);

    if (beforeValue === afterValue) continue;

    if (beforeValue === null && afterValue !== null) {
      changes.push({ field, before: null, after: afterValue, kind: "new" });
    } else if (afterValue === null && beforeValue !== null) {
      changes.push({ field, before: beforeValue, after: null, kind: "removed" });
    } else if (typeof beforeValue === "number" && typeof afterValue === "number") {
      changes.push({
        field,
        before: beforeValue,
        after: afterValue,
        kind: afterValue > beforeValue ? "increase" : "decrease",
      });
    } else {
      changes.push({ field, before: beforeValue, after: afterValue, kind: "changed" });
    }
  }

  if (changes.length === 0) {
    return { status: "empty", reason: "no_fields" };
  }

  return { status: "ready", changes };
}

function normalize(value: string | number | null | undefined): string | number | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    const coerced = Number(value);
    if (value.trim().length > 0 && Number.isFinite(coerced)) {
      return round(coerced);
    }
    return value;
  }
  if (typeof value === "number") return round(value);
  return null;
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export interface DepositDiffParams {
  amountUsd: number;
  expectedShares: number | null;
  sharesBefore: number | null;
}

/**
 * Build the vault deposit before/after diff from the intent and the simulated
 * expected shares. `expectedShares: null` represents a simulation that did not
 * produce a result yet (loading/failure) and yields an explicit empty state.
 */
export function buildDepositSimulationDiff(
  params: DepositDiffParams,
): TransactionSimulationDiff {
  const { amountUsd, expectedShares, sharesBefore } = params;

  if (expectedShares === null || sharesBefore === null) {
    return { status: "empty", reason: "no_simulation" };
  }

  return computeSnapshotDiff(
    {
      vaultShares: sharesBefore,
      inboundAmountUsd: amountUsd,
    },
    {
      vaultShares: expectedShares,
      inboundAmountUsd: 0,
    },
  );
}