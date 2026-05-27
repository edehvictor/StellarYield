/**
 * Autonomous Strategy Rotation Job
 *
 * Runs the rotation evaluator on a fixed cadence and records every decision.
 * The job is purely orchestration: candidate sourcing and execution are
 * delegated to injected functions so the scheduler can be tested without
 * pulling in real protocol data or executing on-chain side effects.
 *
 * Default schedule: every 6 hours. This is conservative enough that no
 * rotation can happen more often than every cooldown window unless the
 * cooldown is shorter than the schedule.
 */

import cron from "node-cron";
import {
  rotationRegistry,
  type RotationCandidate,
  type RotationDecision,
} from "../services/strategyRotationService";

export interface RotationJobOptions {
  /** Cron expression. Defaults to every 6 hours. */
  schedule?: string;
  /** Async function returning the current rotation candidates. */
  fetchCandidates: () => Promise<RotationCandidate[]>;
  /** Optional side-effect hook called only when action === "rotate". */
  onRotation?: (decision: RotationDecision) => Promise<void> | void;
  /** Optional side-effect hook called for every decision (rotate or hold). */
  onDecision?: (decision: RotationDecision) => Promise<void> | void;
}

let jobHandle: ReturnType<typeof cron.schedule> | null = null;

export function startStrategyRotationJob(options: RotationJobOptions): void {
  if (jobHandle) return;

  const schedule = options.schedule ?? "0 */6 * * *";
  console.log(`Starting Strategy Rotation Job with schedule: ${schedule}`);

  jobHandle = cron.schedule(schedule, async () => {
    try {
      await runRotationCycle(options);
    } catch (error) {
      console.error("Strategy Rotation Job failed:", error);
    }
  });
}

export function stopStrategyRotationJob(): void {
  if (jobHandle) {
    jobHandle.stop();
    jobHandle = null;
    console.log("Strategy Rotation Job stopped");
  }
}

/**
 * Single rotation cycle. Exported so it can be invoked directly in tests
 * and from operator-triggered admin endpoints.
 */
export async function runRotationCycle(
  options: RotationJobOptions,
): Promise<RotationDecision> {
  const candidates = await options.fetchCandidates();
  const decision = rotationRegistry.evaluate(candidates);

  if (options.onDecision) {
    await options.onDecision(decision);
  }
  if (decision.action === "rotate" && options.onRotation) {
    await options.onRotation(decision);
  }

  console.log(
    `[StrategyRotationJob] action=${decision.action} reason=${decision.reason}` +
      ` from=${decision.fromId ?? "null"} to=${decision.toId ?? "null"}` +
      ` delta=${decision.scoreDelta ?? "n/a"}`,
  );
  return decision;
}
