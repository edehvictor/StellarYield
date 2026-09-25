/**
 * Risk Rule Engine for Strategy Allocation Changes (#1291)
 *
 * Evaluates a proposed change to strategy/vault allocation percentages against
 * a deterministic rule set before anything is submitted. Each rule produces a
 * typed verdict; any rule-level violation makes the change `allowed: false`
 * unless the caller explicitly downgrades it (`warnOnly`).
 *
 * Invalid or unsupported inputs surface as typed `RiskRuleEngineError`s — the
 * engine never parses raw provider messages.
 */

export type RiskRuleType =
  | "max_allocation"
  | "step_change"
  | "dust"
  | "new_strategy";

/** Severity of a single rule verdict. */
export type RiskVerdictSeverity = "info" | "warning" | "block";

export interface RiskRuleVerdict {
  rule: RiskRuleType;
  vaultId: string;
  severity: RiskVerdictSeverity;
  passed: boolean;
  /** One of the numeric rule codes below; callers branch on this. */
  code:
    | "OK"
    | "MAX_ALLOCATION_EXCEEDED"
    | "STEP_CHANGE_EXCEEDS_THRESHOLD"
    | "DUST_ALLOCATION"
    | "NEW_STRATEGY_WITHOUT_BASELINE";
  message: string;
  /** Triggered values for operator dashboards and tests. */
  meta: {
    beforePct: number;
    afterPct: number;
    threshold?: number;
  };
}

export type RiskRuleEngineErrorCode = "EMPTY_CHANGES" | "INVALID_PCT";

/** Typed engine error — never carries a raw provider message. */
export class RiskRuleEngineError extends Error {
  readonly code: RiskRuleEngineErrorCode;
  readonly meta: Record<string, unknown>;

  constructor(
    code: RiskRuleEngineErrorCode,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RiskRuleEngineError";
    this.code = code;
    this.meta = meta;
  }
}

export interface AllocationChange {
  vaultId: string;
  /** Allocation percentage before the change (0 when newly allocated). */
  beforePct: number;
  /** Proposed allocation percentage after the change. */
  afterPct: number;
}

export interface RiskRuleEngineConfig {
  /** Hard cap on any single allocation, in percentage points. Default 60. */
  maxAllocationPct?: number;
  /** Maximum allowed single-step change, in percentage points. Default 25. */
  maxStepChangePct?: number;
  /** Allocations below this (but non-zero) are dust. Default 0.01. */
  minNonZeroPct?: number;
  /** Treat concentration violations as warnings instead of blocks. */
  warnOnly?: boolean;
}

export interface RiskRuleEngineResult {
  allowed: boolean;
  verdicts: RiskRuleVerdict[];
}

export const DEFAULT_RISK_RULE_CONFIG: Required<RiskRuleEngineConfig> = {
  maxAllocationPct: 60,
  maxStepChangePct: 25,
  minNonZeroPct: 0.01,
  warnOnly: false,
};

/**
 * Evaluate a proposed allocation change against all active risk rules.
 *
 * @throws {RiskRuleEngineError} for invalid input (empty changes, non-finite
 *   or negative percentages). Callers handle this deterministically.
 */
export function evaluateAllocationChange(
  input: {
    changes: AllocationChange[];
    rules?: RiskRuleEngineConfig;
  },
): RiskRuleEngineResult {
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new RiskRuleEngineError(
      "EMPTY_CHANGES",
      "changes must be a non-empty array of allocation changes",
    );
  }

  for (const change of input.changes) {
    if (!Number.isFinite(change.beforePct) || !Number.isFinite(change.afterPct)) {
      throw new RiskRuleEngineError("INVALID_PCT", "allocation percentages must be finite numbers", {
        vaultId: change.vaultId,
      });
    }
    if (change.beforePct < 0 || change.afterPct < 0) {
      throw new RiskRuleEngineError("INVALID_PCT", "allocation percentages must not be negative", {
        vaultId: change.vaultId,
        beforePct: change.beforePct,
        afterPct: change.afterPct,
      });
    }
  }

  const config = { ...DEFAULT_RISK_RULE_CONFIG, ...input.rules };
  const verdicts: RiskRuleVerdict[] = [];

  for (const change of input.changes) {
    const { vaultId, beforePct, afterPct } = change;
    let triggered = false;

    // Rule 1 — new strategy with no baseline.
    if (beforePct === 0 && afterPct > 0) {
      triggered = true;
      verdicts.push({
        rule: "new_strategy",
        vaultId,
        severity: "warning",
        passed: true,
        code: "NEW_STRATEGY_WITHOUT_BASELINE",
        message: `New allocation of ${afterPct}% introduced without an existing baseline`,
        meta: { beforePct, afterPct },
      });
    }

    // Rule 2 — concentration cap.
    if (afterPct > config.maxAllocationPct) {
      triggered = true;
      verdicts.push({
        rule: "max_allocation",
        vaultId,
        severity: config.warnOnly ? "warning" : "block",
        passed: config.warnOnly,
        code: "MAX_ALLOCATION_EXCEEDED",
        message: `Allocation of ${afterPct}% exceeds the ${config.maxAllocationPct}% concentration cap`,
        meta: { beforePct, afterPct, threshold: config.maxAllocationPct },
      });
    }

    // Rule 3 — step-change magnitude.
    const step = Math.abs(afterPct - beforePct);
    if (step > config.maxStepChangePct) {
      triggered = true;
      verdicts.push({
        rule: "step_change",
        vaultId,
        severity: "block",
        passed: false,
        code: "STEP_CHANGE_EXCEEDS_THRESHOLD",
        message: `Single-step change of ${step}% exceeds the ${config.maxStepChangePct}% threshold`,
        meta: { beforePct, afterPct, threshold: config.maxStepChangePct },
      });
    }

    // Rule 4 — dust allocations.
    if (afterPct > 0 && afterPct < config.minNonZeroPct) {
      triggered = true;
      verdicts.push({
        rule: "dust",
        vaultId,
        severity: "block",
        passed: false,
        code: "DUST_ALLOCATION",
        message: `Allocation of ${afterPct}% is below the ${config.minNonZeroPct}% non-zero minimum`,
        meta: { beforePct, afterPct, threshold: config.minNonZeroPct },
      });
    }

    // No rule triggered — emit an explicit OK verdict so responses always
    // carry a per-change decision instead of an implicit silent success.
    if (!triggered) {
      verdicts.push({
        rule: "step_change",
        vaultId,
        severity: "info",
        passed: true,
        code: "OK",
        message: `Allocation change from ${beforePct}% to ${afterPct}% is within all risk limits`,
        meta: { beforePct, afterPct },
      });
    }
  }

  const blocked = verdicts.some((v) => v.severity === "block" && !v.passed);

  return { allowed: !blocked, verdicts };
}