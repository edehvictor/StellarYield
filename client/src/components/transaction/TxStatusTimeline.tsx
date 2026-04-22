import { CheckCircle2, Circle, Loader2, XCircle, Copy, RotateCcw } from "lucide-react";
import {
  TX_PHASE_LABELS,
  type TxPhase,
  isStepActive,
  isStepCompleted,
} from "../../services/transactionPhase";

function stepIsDone(
  steps: readonly TxPhase[],
  phase: TxPhase,
  stepIdx: number,
  failedAtPhase: TxPhase | null | undefined,
): boolean {
  if (phase === "success") return true;
  if (phase === "failure") {
    const fi =
      failedAtPhase != null && steps.includes(failedAtPhase)
        ? steps.indexOf(failedAtPhase)
        : steps.length - 1;
    return fi >= 0 && stepIdx < fi;
  }
  return isStepCompleted(steps, phase, stepIdx);
}

function stepIsActive(
  steps: readonly TxPhase[],
  phase: TxPhase,
  stepIdx: number,
): boolean {
  if (phase === "failure" || phase === "success") return false;
  return isStepActive(steps, phase, stepIdx);
}

function stepIsFailed(
  steps: readonly TxPhase[],
  phase: TxPhase,
  stepIdx: number,
  failedAtPhase: TxPhase | null | undefined,
): boolean {
  if (phase !== "failure") return false;
  const fi =
    failedAtPhase != null && steps.includes(failedAtPhase)
      ? steps.indexOf(failedAtPhase)
      : steps.length - 1;
  return fi >= 0 && stepIdx === fi;
}

export interface TxStatusTimelineProps {
  /** Ordered phases to show (e.g. full pipeline or submit/poll only). */
  steps: readonly TxPhase[];
  /** Current phase from the Soroban engine. */
  phase: TxPhase;
  errorMessage?: string | null;
  /** Successful transaction hash (explorer link left to caller). */
  txHash?: string | null;
  /** Where the flow failed (for highlighting the step). */
  failedAtPhase?: TxPhase | null;
  onRetry?: () => void;
  className?: string;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

export default function TxStatusTimeline({
  steps,
  phase,
  errorMessage,
  txHash,
  failedAtPhase,
  onRetry,
  className = "",
}: TxStatusTimelineProps) {
  const showTimeline = phase !== "idle";
  if (!showTimeline) return null;

  return (
    <div
      className={`rounded-xl border border-white/10 bg-white/5 p-4 space-y-3 ${className}`}
      role="status"
      aria-live="polite"
    >
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">
        Transaction status
      </p>
      <ol className="space-y-2">
        {steps.map((stepId, i) => {
          const label = TX_PHASE_LABELS[stepId];
          const complete = stepIsDone(steps, phase, i, failedAtPhase);
          const active = stepIsActive(steps, phase, i);
          const failedHere = stepIsFailed(steps, phase, i, failedAtPhase);

          return (
            <li key={`${stepId}-${i}`} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 shrink-0" aria-hidden>
                {complete && !failedHere ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : active ? (
                  <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                ) : failedHere ? (
                  <XCircle className="w-4 h-4 text-red-400" />
                ) : (
                  <Circle className="w-4 h-4 text-gray-600" />
                )}
              </span>
              <span
                className={
                  failedHere
                    ? "text-red-300"
                    : active
                      ? "text-white font-medium"
                      : complete
                        ? "text-gray-300"
                        : "text-gray-500"
                }
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {phase === "success" && txHash && (
        <p className="text-xs text-emerald-400/90 font-mono break-all pt-1">
          Hash: {txHash}
        </p>
      )}

      {phase === "failure" && errorMessage && (
        <div className="pt-2 border-t border-white/10 space-y-2">
          <p className="text-xs text-red-300 break-words">{errorMessage}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyText(errorMessage)}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-gray-200"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy error
            </button>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600/40 hover:bg-indigo-600/60 text-white"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
