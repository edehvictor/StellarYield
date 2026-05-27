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
 */

export type DryRunOutputFormat = "json" | "text";

export interface DryRunInput {
  context: RotationContext;
  policy?: Partial<RotationPolicy>;
  /** ISO-8601 evaluation timestamp. Defaults to "now" when omitted. */
  now?: string;
}

export interface DryRunResult {
  decision: RotationDecision;
  policy: RotationPolicy;
  evaluatedAtMs: number;
}

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

  return {
    context: {
      currentId: (ctx.currentId as string | null | undefined) ?? null,
      currentScore: (ctx.currentScore as number | null | undefined) ?? null,
      lastRotatedAt: (ctx.lastRotatedAt as string | null | undefined) ?? null,
      candidates: ctx.candidates as RotationCandidate[],
    },
    policy: policy as Partial<RotationPolicy> | undefined,
    now: now as string | undefined,
  };
}

/**
 * Run the rotation dry-run for an already-parsed input.
 *
 * This function never touches the singleton `rotationRegistry` and never
 * mutates the supplied context; it returns a fresh `RotationDecision` plus
 * the effective policy so the CLI can echo what it actually ran with.
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
  return { decision, policy, evaluatedAtMs: nowMs };
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
        evaluatedAt: new Date(result.evaluatedAtMs).toISOString(),
      },
      null,
      2,
    );
  }

  const { decision, policy } = result;
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
