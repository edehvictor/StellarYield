import type { SignerQuorumProgress } from "./types";

interface SignerQuorumProgressProps {
  progress: SignerQuorumProgress;
  /** Optional list of extra signer public keys already shown as signature chips. */
  compact?: boolean;
}

function shortKey(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

/**
 * Visual multi-sig quorum progress bar for pending governance transactions
 * (#1310): signed/required counts, remaining signatures, progress %, and
 * per-signer status badges.
 */
export default function SignerQuorumProgress({
  progress,
  compact = false,
}: SignerQuorumProgressProps) {
  const pct = Math.max(0, Math.min(100, progress.progressPct));
  const statusText = progress.met
    ? "Quorum met"
    : `${progress.signed}/${progress.required} signed · ${progress.remaining} remaining`;

  return (
    <div
      className="space-y-2"
      data-testid="signer-quorum-progress"
      data-met={progress.met ? "true" : "false"}
      data-progress={pct}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Signer quorum progress"
    >
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{statusText}</span>
        <span className={progress.met ? "text-green-400" : "text-yellow-400"}>
          {pct}%
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-[#0f0f1e] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            progress.met ? "bg-green-500" : "bg-indigo-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!compact && progress.perSigner.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {progress.perSigner.map((s) => (
            <span
              key={s.address}
              title={s.address}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                s.signed
                  ? "bg-green-500/15 text-green-300 border-green-500/30"
                  : "bg-gray-500/10 text-gray-400 border-gray-500/20"
              }`}
            >
              {shortKey(s.address)} {s.signed ? "✓" : "…"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
