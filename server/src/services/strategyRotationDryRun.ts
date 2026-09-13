import {
  DEFAULT_ROTATION_POLICY,
  evaluateRotation,
  type RotationCandidate,
  type RotationContext,
  type RotationDecision,
  type RotationPolicy,
} from "./strategyRotationService";

/**
 * Pure helpers backing the `strategy-rotation-dry-run` CLI.
 *
 * The CLI never writes to the rotation registry, never enqueues background
 * jobs, and never mutates any service state — it only invokes
 * `evaluateRotation` and formats the result. Anything that *would* require
 * mutation belongs in the regular rotation job, not here.
 *
 * Alongside the decision, a dry run now produces a structured diff of the
 * current versus proposed strategy state (`StrategyDiff`), so maintainers can
 * see exactly what executing the rotation would change — added or removed
 * strategies, changed weights, changed policy thresholds, and any incumbent
 * (current strategy) field changes — before allowing it to execute.
 */

export type DryRunOutputFormat = "json" | "text";

export interface DryRunInput {
  context: RotationContext;
  policy?: Partial<RotationPolicy>;
  /** ISO-8601 evaluation timestamp. Defaults to "now" when omitted. */
  now?: string;
  /**
   * Previously-known strategy weights used to compute the state delta.
   * When omitted, the current strategy set is assumed to equal the supplied
   * `context.candidates`, so the diff only surfaces incumbent and threshold
   * changes. Supply this when the dry run should also flag strategies that
   * were added, removed, or re-weighted relative to a prior snapshot.
   */
  currentStrategies?: StrategyWeight[];
}

export interface DryRunResult {
  decision: RotationDecision;
  policy: RotationPolicy;
  evaluatedAtMs: number;
  /** Structured delta between the current and proposed strategy state. */
  diff: StrategyDiff;
}

// ---------------------------------------------------------------------------
// Strategy state snapshots and diffs
// ---------------------------------------------------------------------------

/**
 * The weight (score and supporting factors) of a single strategy in a state
 * snapshot. `score` is the primary weight used by the rotation evaluator;
 * `volatility` and `confidence` are secondary factors that may also change.
 */
export interface StrategyWeight {
  id: string;
  name?: string;
  /** Risk-adjusted score (higher = stronger). */
  score: number;
  /** Optional stability proxy. Lower = more stable. */
  volatility?: number;
  /** Confidence in [0,1]. */
  confidence?: number;
}

/**
 * A point-in-time view of the strategy allocation state. The diff compares
 * two of these: the current (pre-run) state and the proposed (post-run) state.
 */
export interface StrategyStateSnapshot {
  /** The incumbent strategy id, or null when nothing is allocated yet. */
  currentId: string | null;
  /** The incumbent's score, or null when nothing is allocated yet. */
  currentScore: number | null;
  /** When the incumbent was last rotated into, or null. */
  lastRotatedAt: string | null;
  /** Every strategy under management with its weight. */
  strategies: StrategyWeight[];
  /** The policy thresholds in effect for this snapshot. */
  policy: RotationPolicy;
}

export type WeightField = "score" | "volatility" | "confidence";

/** A single changed weight field for a strategy present in both snapshots. */
export interface WeightChange {
  id: string;
  name?: string;
  field: WeightField;
  /** `null` means the field was absent in the current snapshot. */
  from: number | null;
  /** `null` means the field would be absent in the proposed snapshot. */
  to: number | null;
}

/** A single changed rotation policy threshold. */
export interface ThresholdChange {
  field: keyof RotationPolicy;
  from: number;
  to: number;
}

/** A single changed incumbent field (id / score / last-rotated timestamp). */
export interface IncumbentChange {
  field: "currentId" | "currentScore" | "lastRotatedAt";
  from: string | number | null;
  to: string | number | null;
}

/** Structured diff of current versus proposed strategy state. */
export interface StrategyDiff {
  /** True when the proposed state is identical to the current state. */
  noOp: boolean;
  /** Strategies present in the proposed snapshot but absent from current. */
  additions: StrategyWeight[];
  /** Strategies present in the current snapshot but absent from proposed. */
  removals: StrategyWeight[];
  /** Weight changes for strategies present in both snapshots. */
  weightChanges: WeightChange[];
  /** Policy threshold changes between the two snapshots. */
  thresholdChanges: ThresholdChange[];
  /** Incumbent (current strategy) field changes. */
  incumbentChanges: IncumbentChange[];
  /** Total number of individual change entries across all categories. */
  changeCount: number;
}

const WEIGHT_FIELDS: WeightField[] = ["score", "volatility", "confidence"];

const POLICY_FIELDS: (keyof RotationPolicy)[] = [
  "minScoreDifference",
  "cooldownMs",
  "maxDataAgeMs",
  "minConfidence",
];

function toStrategyWeight(candidate: RotationCandidate): StrategyWeight {
  return {
    id: candidate.id,
    name: candidate.name,
    score: candidate.score,
    volatility: candidate.volatility,
    confidence: candidate.confidence,
  };
}

/**
 * Compute the structured delta between two strategy state snapshots.
 *
 * Pure function: never mutates either snapshot. Strategies are keyed by id;
 * weight fields are compared per strategy; policy thresholds and incumbent
 * fields are compared field by field. A snapshot pair that differs nowhere
 * yields `noOp: true` with empty change arrays.
 */
export function buildStrategyDiff(
  current: StrategyStateSnapshot,
  proposed: StrategyStateSnapshot,
): StrategyDiff {
  const additions: StrategyWeight[] = [];
  const removals: StrategyWeight[] = [];
  const weightChanges: WeightChange[] = [];
  const thresholdChanges: ThresholdChange[] = [];
  const incumbentChanges: IncumbentChange[] = [];

  const currentById = new Map(current.strategies.map((s) => [s.id, s]));
  const proposedById = new Map(proposed.strategies.map((s) => [s.id, s]));

  for (const strategy of proposed.strategies) {
    if (!currentById.has(strategy.id)) additions.push(strategy);
  }
  for (const strategy of current.strategies) {
    if (!proposedById.has(strategy.id)) removals.push(strategy);
  }

  for (const [id, before] of currentById) {
    const after = proposedById.get(id);
    if (!after) continue;
    for (const field of WEIGHT_FIELDS) {
      const from = before[field] ?? null;
      const to = after[field] ?? null;
      if (from === to) continue;
      weightChanges.push({
        id,
        name: after.name ?? before.name,
        field,
        from,
        to,
      });
    }
  }

  for (const field of POLICY_FIELDS) {
    const from = current.policy[field];
    const to = proposed.policy[field];
    if (from !== to) thresholdChanges.push({ field, from, to });
  }

  if (current.currentId !== proposed.currentId) {
    incumbentChanges.push({
      field: "currentId",
      from: current.currentId,
      to: proposed.currentId,
    });
  }
  if (current.currentScore !== proposed.currentScore) {
    incumbentChanges.push({
      field: "currentScore",
      from: current.currentScore,
      to: proposed.currentScore,
    });
  }
  if (current.lastRotatedAt !== proposed.lastRotatedAt) {
    incumbentChanges.push({
      field: "lastRotatedAt",
      from: current.lastRotatedAt,
      to: proposed.lastRotatedAt,
    });
  }

  const changeCount =
    additions.length +
    removals.length +
    weightChanges.length +
    thresholdChanges.length +
    incumbentChanges.length;

  return {
    noOp: changeCount === 0,
    additions,
    removals,
    weightChanges,
    thresholdChanges,
    incumbentChanges,
    changeCount,
  };
}

// ---------------------------------------------------------------------------
// Dry-run evaluation
// ---------------------------------------------------------------------------

/**
 * Parse and validate the JSON payload accepted by the dry-run CLI.
 *
 * Throws a `TypeError` describing the first problem encountered so the CLI
 * can surface a clean error message to the operator.
 */
export function parseDryRunInput(raw: unknown): DryRunInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      "Dry-run input must be a JSON object with a `context` field.",
    );
  }
  const input = raw as Record<string, unknown>;
  const context = input.context;
  if (
    context === null ||
    typeof context !== "object" ||
    Array.isArray(context)
  ) {
    throw new TypeError("`context` must be an object.");
  }
  const ctx = context as Record<string, unknown>;
  if (!Array.isArray(ctx.candidates)) {
    throw new TypeError("`context.candidates` must be an array.");
  }
  for (const [index, candidate] of ctx.candidates.entries()) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new TypeError(`context.candidates[${index}] must be an object.`);
    }
    const c = candidate as Record<string, unknown>;
    if (typeof c.id !== "string" || c.id.length === 0) {
      throw new TypeError(
        `context.candidates[${index}].id must be a non-empty string.`,
      );
    }
    if (typeof c.score !== "number" || !Number.isFinite(c.score)) {
      throw new TypeError(
        `context.candidates[${index}].score must be a finite number.`,
      );
    }
    if (typeof c.fetchedAt !== "string") {
      throw new TypeError(
        `context.candidates[${index}].fetchedAt must be an ISO-8601 string.`,
      );
    }
  }

  if (
    ctx.currentId !== null &&
    ctx.currentId !== undefined &&
    typeof ctx.currentId !== "string"
  ) {
    throw new TypeError("`context.currentId` must be a string or null.");
  }
  if (
    ctx.currentScore !== null &&
    ctx.currentScore !== undefined &&
    (typeof ctx.currentScore !== "number" || !Number.isFinite(ctx.currentScore))
  ) {
    throw new TypeError(
      "`context.currentScore` must be a finite number or null.",
    );
  }
  if (
    ctx.lastRotatedAt !== null &&
    ctx.lastRotatedAt !== undefined &&
    typeof ctx.lastRotatedAt !== "string"
  ) {
    throw new TypeError("`context.lastRotatedAt` must be a string or null.");
  }

  const policy = input.policy;
  if (
    policy !== undefined &&
    (policy === null || typeof policy !== "object" || Array.isArray(policy))
  ) {
    throw new TypeError("`policy` must be an object when provided.");
  }
  const now = input.now;
  if (now !== undefined && typeof now !== "string") {
    throw new TypeError("`now` must be an ISO-8601 string when provided.");
  }

  let currentStrategies: StrategyWeight[] | undefined;
  if (input.currentStrategies !== undefined) {
    if (
      !Array.isArray(input.currentStrategies) ||
      input.currentStrategies.some(
        (s) => s === null || typeof s !== "object" || Array.isArray(s),
      )
    ) {
      throw new TypeError(
        "`currentStrategies` must be an array of strategy weight objects when provided.",
      );
    }
    currentStrategies = (input.currentStrategies as Record<string, unknown>[]).map(
      (entry, index) => {
        const prefix = `currentStrategies[${index}]`;
        if (typeof entry.id !== "string" || entry.id.length === 0) {
          throw new TypeError(`${prefix}.id must be a non-empty string.`);
        }
        if (typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
          throw new TypeError(`${prefix}.score must be a finite number.`);
        }
        if (
          entry.name !== undefined &&
          typeof entry.name !== "string"
        ) {
          throw new TypeError(`${prefix}.name must be a string when provided.`);
        }
        for (const optional of ["volatility", "confidence"] as const) {
          const value = entry[optional];
          if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
            throw new TypeError(
              `${prefix}.${optional} must be a finite number when provided.`,
            );
          }
        }
        return {
          id: entry.id,
          name: entry.name as string | undefined,
          score: entry.score,
          volatility: entry.volatility as number | undefined,
          confidence: entry.confidence as number | undefined,
        };
      },
    );
  }

  return {
    context: {
      currentId: (ctx.currentId as string | null | undefined) ?? null,
      currentScore: (ctx.currentScore as number | null | undefined) ?? null,
      lastRotatedAt: (ctx.lastRotatedAt as string | null | undefined) ?? null,
      candidates: ctx.candidates as RotationCandidate[],
    },
    policy: policy as Partial<RotationPolicy> | undefined,
    now: now as string | undefined,
    currentStrategies,
  };
}

/**
 * Run the rotation dry-run for an already-parsed input.
 *
 * This function never touches the singleton `rotationRegistry` and never
 * mutates the supplied context; it returns a fresh `RotationDecision` plus
 * the effective policy so the CLI can echo what it actually ran with.
 *
 * The returned `diff` compares the current state (the supplied context and,
 * when provided, `currentStrategies`) against the proposed state — i.e. what
 * the world would look like if the decision executed. A `hold` decision
 * produces an empty (no-op) diff; a `rotate` decision surfaces the incumbent
 * changes, and any supplied strategy-set or policy changes surface as
 * additions, removals, weight changes, and threshold changes.
 */
export function runDryRun(input: DryRunInput): DryRunResult {
  const policy: RotationPolicy = {
    ...DEFAULT_ROTATION_POLICY,
    ...(input.policy ?? {}),
  };

  const nowMs =
    input.now !== undefined && Number.isFinite(Date.parse(input.now))
      ? Date.parse(input.now)
      : Date.now();

  const decision = evaluateRotation(input.context, policy, nowMs);

  const currentSnapshot: StrategyStateSnapshot = {
    currentId: input.context.currentId,
    currentScore: input.context.currentScore,
    lastRotatedAt: input.context.lastRotatedAt,
    strategies:
      input.currentStrategies ?? input.context.candidates.map(toStrategyWeight),
    policy: DEFAULT_ROTATION_POLICY,
  };

  const winner =
    decision.toId !== null
      ? input.context.candidates.find((c) => c.id === decision.toId)
      : undefined;

  const proposedSnapshot: StrategyStateSnapshot = {
    currentId: decision.action === "rotate" ? decision.toId : decision.fromId,
    currentScore:
      decision.action === "rotate"
        ? (winner?.score ?? input.context.currentScore)
        : input.context.currentScore,
    lastRotatedAt:
      decision.action === "rotate"
        ? decision.evaluatedAt
        : input.context.lastRotatedAt,
    strategies: input.context.candidates.map(toStrategyWeight),
    policy,
  };

  const diff = buildStrategyDiff(currentSnapshot, proposedSnapshot);

  return { decision, policy, evaluatedAtMs: nowMs, diff };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmtScore = (value: number | null): string =>
  value === null ? "n/a" : value.toFixed(3);

function formatDiffText(diff: StrategyDiff): string[] {
  const lines: string[] = [];

  if (diff.noOp) {
    lines.push("State delta:");
    lines.push("  No changes — this dry-run is a no-op.");
    return lines;
  }

  lines.push(
    `State delta (${diff.changeCount} change${diff.changeCount === 1 ? "" : "s"}):`,
  );

  if (diff.incumbentChanges.length > 0) {
    lines.push("  Incumbent:");
    for (const change of diff.incumbentChanges) {
      if (change.field === "currentId") {
        lines.push(`    ~ ${change.field}: ${change.from ?? "(none)"} -> ${change.to ?? "(none)"}`);
      } else if (change.field === "currentScore") {
        lines.push(`    ~ ${change.field}: ${fmtScore(change.from as number | null)} -> ${fmtScore(change.to as number | null)}`);
      } else {
        lines.push(`    ~ ${change.field}: ${change.from ?? "(none)"} -> ${change.to ?? "(none)"}`);
      }
    }
  }

  if (diff.additions.length > 0) {
    lines.push("  Added strategies:");
    for (const strategy of diff.additions) {
      lines.push(
        `    + ${strategy.name ?? strategy.id} (id=${strategy.id}, score=${fmtScore(strategy.score)})`,
      );
    }
  }

  if (diff.removals.length > 0) {
    lines.push("  Removed strategies:");
    for (const strategy of diff.removals) {
      lines.push(
        `    - ${strategy.name ?? strategy.id} (id=${strategy.id}, score=${fmtScore(strategy.score)})`,
      );
    }
  }

  if (diff.weightChanges.length > 0) {
    lines.push("  Changed weights:");
    for (const change of diff.weightChanges) {
      lines.push(
        `    ~ ${change.name ?? change.id} ${change.field}: ${fmtScore(change.from)} -> ${fmtScore(change.to)}`,
      );
    }
  }

  if (diff.thresholdChanges.length > 0) {
    lines.push("  Changed thresholds:");
    for (const change of diff.thresholdChanges) {
      lines.push(
        `    ~ ${change.field}: ${change.from} -> ${change.to}`,
      );
    }
  }

  return lines;
}

/**
 * Render a dry-run result as either JSON or a human-readable text block.
 */
export function formatDryRunResult(
  result: DryRunResult,
  format: DryRunOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        decision: result.decision,
        policy: result.policy,
        diff: result.diff,
        evaluatedAt: new Date(result.evaluatedAtMs).toISOString(),
      },
      null,
      2,
    );
  }

  const { decision, policy, diff } = result;
  const lines: string[] = [];
  lines.push("Strategy Rotation Dry-Run");
  lines.push("=========================");
  lines.push(`Action:           ${decision.action.toUpperCase()}`);
  lines.push(`Reason:           ${decision.reason}`);
  lines.push(`From:             ${decision.fromId ?? "(none)"}`);
  lines.push(`To:               ${decision.toId ?? "(none)"}`);
  lines.push(
    `Score delta:      ${
      decision.scoreDelta === null
        ? "n/a"
        : decision.scoreDelta.toFixed(3)
    }`,
  );
  lines.push(`Evaluated at:     ${decision.evaluatedAt}`);
  lines.push(`Detail:           ${decision.detail}`);
  if (decision.confidenceBreakdown) {
    lines.push(
      `Confidence:       ${decision.confidenceBreakdown.label} (score=${decision.confidenceBreakdown.score.toFixed(
        3,
      )})`,
    );
  }
  if (decision.confidenceStrength) {
    lines.push(`Confidence band:  ${decision.confidenceStrength}`);
  }
  if (decision.confidenceWhy && decision.confidenceWhy.length > 0) {
    lines.push("Why:");
    for (const why of decision.confidenceWhy) {
      lines.push(`  - ${why}`);
    }
  }
  lines.push(...formatDiffText(diff));
  lines.push("");
  lines.push("Policy used:");
  lines.push(`  minScoreDifference: ${policy.minScoreDifference}`);
  lines.push(`  cooldownMs:         ${policy.cooldownMs}`);
  lines.push(`  maxDataAgeMs:       ${policy.maxDataAgeMs}`);
  lines.push(`  minConfidence:      ${policy.minConfidence}`);
  lines.push("");
  lines.push("No state was written and no jobs were enqueued.");
  return lines.join("\n");
}
